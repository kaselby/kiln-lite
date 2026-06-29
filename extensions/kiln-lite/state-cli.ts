/**
 * state-cli — a small command-line front-end over the session snapshot store
 * (snapshot.ts), invoked by `bin/kl` via tsx.
 *
 * It exists so the shell never re-implements a JSON parser. `bin/kl` used to
 * pluck fields out of meta.json with `awk -F'"'`, which (a) spawned one awk
 * process per field per file — ~2,240 subprocesses for `kl history` over ~450
 * sessions, ~12s — and (b) split on quotes, so any value containing a quote
 * (a cwd path legally can) parsed wrong, which could resume in the wrong
 * directory. This CLI reads through the same module that WRITES the data
 * (real JSON.parse), so reader and writer can't drift.
 *
 * Subcommands:
 *
 *   history --home <h> [--home <h> …] [--limit N] [--all]
 *       Recent sessions across the given agent homes. Default reads the
 *       per-home recency journal (rebuilding it from meta files if missing),
 *       dedupes to the latest record per agent, sorts newest-first, and emits
 *       the top N. `--all` ignores the journal and does an EXACT scan of every
 *       meta.json (the never-drops-a-row recovery view) — allowed to be slow.
 *       Output: TSV, one row per line, fields sanitized of tab/CR/LF:
 *           last_seen \t agent_id \t model \t cwd \t home
 *
 *   resolve <agent-id> --home <h>
 *       Resolve a single session for `kl resume`. Reads the agent's meta.json
 *       fresh (never the journal — recovery must be exact). Output is
 *       NUL-separated so it survives any character a path can contain
 *       (paths cannot contain NUL):
 *           <pi_session_jsonl> \0 <cwd> \0
 *       Exits non-zero if the session has no meta.
 *
 *   rebuild-journal --home <h> [--home <h> …]
 *       Force-rebuild each home's journal from its meta files. For
 *       maintenance/tests; normal operation self-heals on read.
 */

import {
	type SnapshotMeta,
	type JournalRecord,
	journalTsValue,
	readJournal,
	readMeta,
	rebuildJournal,
	scanAllMeta,
} from "./snapshot.ts";

interface Row {
	agent_id: string;
	last_seen: string;
	model?: string;
	cwd?: string;
	home: string;
}

function fail(msg: string): never {
	process.stderr.write(`state-cli: ${msg}\n`);
	process.exit(2);
}

/** Strip the field separators we use for the table transport. History is a
 * human display, so collapsing literal tabs/newlines to spaces is fine. */
function tsv(s: string | undefined): string {
	return (s ?? "").replace(/[\t\r\n]+/g, " ");
}

interface ParsedArgs {
	homes: string[];
	limit?: number;
	all: boolean;
	positional: string[];
}

function parseArgs(rest: string[]): ParsedArgs {
	const homes: string[] = [];
	let limit: number | undefined;
	let all = false;
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--home") {
			const v = rest[++i];
			if (v === undefined) fail("--home requires a value");
			homes.push(v);
		} else if (a === "--limit") {
			const v = rest[++i];
			const n = Number(v);
			if (v === undefined || !Number.isInteger(n) || n < 0) fail(`--limit requires a non-negative integer (got ${v})`);
			limit = n;
		} else if (a === "--all") {
			all = true;
		} else if (a.startsWith("--")) {
			fail(`unknown flag: ${a}`);
		} else {
			positional.push(a);
		}
	}
	return { homes, limit, all, positional };
}

function rowFromMeta(meta: SnapshotMeta, home: string): Row {
	return { agent_id: meta.agent_id, last_seen: meta.last_seen, model: meta.model, cwd: meta.cwd, home };
}

function rowFromRecord(rec: JournalRecord, home: string): Row {
	return { agent_id: rec.agent_id, last_seen: rec.last_seen, model: rec.model, cwd: rec.cwd, home };
}

function cmdHistory(rest: string[]): void {
	const { homes, limit, all } = parseArgs(rest);
	if (homes.length === 0) fail("history: at least one --home is required");

	const rows: Row[] = [];
	for (const home of homes) {
		if (all) {
			// Exact recovery view: authoritative meta scan, ignore the journal.
			for (const meta of scanAllMeta(home)) rows.push(rowFromMeta(meta, home));
		} else {
			// Fast view: read the journal; self-heal if it's missing, empty, or
			// all-corrupt by rebuilding once from the meta files.
			let recs = readJournal(home);
			if (recs.length === 0) {
				rebuildJournal(home);
				recs = readJournal(home);
			}
			for (const rec of recs) rows.push(rowFromRecord(rec, home));
		}
	}

	// Newest first. Records are deduped per-home in readJournal; we do NOT
	// dedupe across homes — distinct homes can legitimately surface the same
	// bare agent_id, and the home column disambiguates.
	rows.sort((a, b) => journalTsValue(b.last_seen) - journalTsValue(a.last_seen));

	const selected = all ? rows : rows.slice(0, limit ?? rows.length);
	const lines = selected.map((r) =>
		[tsv(r.last_seen), tsv(r.agent_id), tsv(r.model), tsv(r.cwd), tsv(r.home)].join("\t"),
	);
	process.stdout.write(lines.length ? `${lines.join("\n")}\n` : "");
}

function cmdResolve(rest: string[]): void {
	const { homes, positional } = parseArgs(rest);
	const agentId = positional[0];
	if (!agentId) fail("resolve: <agent-id> is required");
	if (homes.length !== 1) fail("resolve: exactly one --home is required");

	const meta = readMeta(homes[0], agentId);
	if (!meta) fail(`resolve: no snapshot meta for '${agentId}' under ${homes[0]}`);

	// NUL-separated so tabs/newlines/quotes/spaces in cwd survive intact.
	process.stdout.write(`${meta.pi_session_jsonl ?? ""}\0${meta.cwd ?? ""}\0`);
}

function cmdRebuildJournal(rest: string[]): void {
	const { homes } = parseArgs(rest);
	if (homes.length === 0) fail("rebuild-journal: at least one --home is required");
	for (const home of homes) rebuildJournal(home, (m) => process.stderr.write(`${m}\n`));
}

function main(): void {
	const [sub, ...rest] = process.argv.slice(2);
	switch (sub) {
		case "history":
			return cmdHistory(rest);
		case "resolve":
			return cmdResolve(rest);
		case "rebuild-journal":
			return cmdRebuildJournal(rest);
		default:
			fail(`unknown subcommand '${sub ?? ""}' (expected: history | resolve | rebuild-journal)`);
	}
}

main();
