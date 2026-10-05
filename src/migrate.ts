/**
 * `kl migrate [agent-home…]`: convert an old kiln-lite agent home to the
 * current schema, in place (migrate the data, keep no compat
 * code). With no arguments, every agent under $KL_AGENTS_DIR.
 *
 * agent.yml (a copy goes to agent.yml.bak first):
 *   context_injection → sections ({name: slug of label, path}); `dynamic` dropped (warn)
 *   startup, tools_dir, sessions_dir, inbox_dir → removed (warn)
 *   system_prompt → removed if the file it names is missing (warn), else kept
 *   cleanup → {summary_path} becomes memory/sessions/<date>-<session name>.md
 *             wording; any other {placeholder} warns (kl expands none)
 * Files: harness/pre-launch → hooks/pre-launch.
 *
 * Edits are line-based so comments elsewhere survive: a removed key takes
 * its own lines, its indented body and the comment block directly above it.
 * Prints one line per key saying what it became.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import yaml from "js-yaml";

import { RESERVED_SECTIONS, SECTION_NAME } from "../extensions/kiln-lite/config.ts";
import { agentsDir, listAgents } from "./sessions/agents.ts";

const DROPPED: Record<string, string> = {
	startup: "kl runs no startup commands; use <home>/hooks/pre-launch or an extension",
	tools_dir: "kl no longer discovers shell tools",
	sessions_dir: "session ids live in the kl registry; summaries go to memory/sessions/",
	inbox_dir: "inboxes live at <kl root>/run/inbox/<uuid>/",
};

export const SUMMARY_WORDING = "memory/sessions/<date>-<session name>.md (date as YYYY-MM-DD)";

export interface MigrateResult {
	home: string;
	changed: boolean;
	/** One line per key or file: what it became. */
	report: string[];
	warnings: string[];
	backup?: string;
}

export function slugify(label: string): string {
	let s = label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
	if (!/^[a-z]/.test(s)) s = `s-${s}`.replace(/-+$/, "");
	return s;
}

/** Line ranges [start, end) of each top-level key, start including the comment block directly above. */
function keyBlocks(lines: string[]): Map<string, [number, number]> {
	const out = new Map<string, [number, number]>();
	for (let i = 0; i < lines.length; i++) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(lines[i]);
		if (!m) continue;
		let start = i;
		while (start > 0 && /^#/.test(lines[start - 1])) start--;
		let end = i + 1;
		// Body: indented lines; blank lines count only if more indented lines follow.
		while (end < lines.length) {
			if (/^[ \t]/.test(lines[end])) end++;
			else if (lines[end].trim() === "") {
				let j = end;
				while (j < lines.length && lines[j].trim() === "") j++;
				if (j < lines.length && /^[ \t]/.test(lines[j])) end = j;
				else break;
			} else break;
		}
		out.set(m[1], [start, end]);
	}
	return out;
}

function dumpKey(key: string, value: unknown): string[] {
	return yaml.dump({ [key]: value }, { lineWidth: -1 }).replace(/\n$/, "").split("\n");
}

/** Rewrite {summary_path}; return the new text and any other placeholders. */
export function migrateCleanupText(text: string): { text: string; others: string[] } {
	const out = text.replace(/\{summary_path\}/g, SUMMARY_WORDING);
	const others = [...new Set(out.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? [])];
	return { text: out, others };
}

export function migrateHome(homeArg: string, opts: { dryRun?: boolean } = {}): MigrateResult {
	const home = resolve(homeArg);
	const res: MigrateResult = { home, changed: false, report: [], warnings: [] };
	const ymlPath = join(home, "agent.yml");
	if (!existsSync(ymlPath)) {
		res.warnings.push(`no agent.yml in ${home}`);
		return res;
	}
	const original = readFileSync(ymlPath, "utf8");
	let doc: Record<string, unknown>;
	try {
		const raw = yaml.load(original);
		doc = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	} catch (e) {
		res.warnings.push(`agent.yml is not valid YAML, not touched: ${(e as Error).message}`);
		return res;
	}

	let lines = original.split("\n");
	// Edits keyed by top-level key: null = remove, string[] = replace with these lines.
	const edits = new Map<string, string[] | null>();
	let appendSections: string[] | null = null;

	// context_injection → sections
	if ("context_injection" in doc) {
		const ci = Array.isArray(doc.context_injection) ? doc.context_injection : [];
		const existing = Array.isArray(doc.sections) ? (doc.sections as Array<Record<string, unknown>>) : [];
		const taken = new Set(existing.map((s) => String(s?.name ?? "")));
		const added: Array<{ name: string; path: string }> = [];
		for (const [i, e] of ci.entries()) {
			const entry = (e ?? {}) as Record<string, unknown>;
			const path = typeof entry.path === "string" ? entry.path : "";
			if (!path) {
				res.warnings.push(`context_injection[${i}] has no path: dropped`);
				continue;
			}
			const label = typeof entry.label === "string" && entry.label.trim() ? entry.label : path.replace(/\.[^/.]+$/, "").split("/").pop()!;
			let name = slugify(label);
			if (RESERVED_SECTIONS.has(name) || !SECTION_NAME.test(name)) name = `${name}-file`;
			let n = name;
			for (let k = 2; taken.has(n); k++) n = `${name}-${k}`;
			taken.add(n);
			if (entry.dynamic) res.warnings.push(`context_injection '${label}': dynamic dropped (sections render once at session start)`);
			added.push({ name: n, path });
		}
		if (added.length === 0) {
			res.report.push(ci.length === 0 ? "context_injection: [] → removed (nothing to inject)" : "context_injection → removed (no usable entries)");
			edits.set("context_injection", null);
		} else {
			const merged = [...existing, ...added];
			res.report.push(`context_injection → sections: ${added.map((a) => `${a.name} (${a.path})`).join(", ")}`);
			if ("sections" in doc) {
				edits.set("sections", dumpKey("sections", merged));
				edits.set("context_injection", null);
			} else {
				edits.set("context_injection", null);
				appendSections = dumpKey("sections", merged);
			}
		}
	}

	for (const [key, why] of Object.entries(DROPPED)) {
		if (!(key in doc)) continue;
		edits.set(key, null);
		res.report.push(`${key} → removed`);
		const v = doc[key];
		const empty = v === null || v === undefined || (Array.isArray(v) && v.length === 0);
		if (!empty || key !== "startup") res.warnings.push(`${key} dropped (${JSON.stringify(v)}): ${why}`);
	}

	if (typeof doc.system_prompt === "string") {
		const p = isAbsolute(doc.system_prompt) ? doc.system_prompt : join(home, doc.system_prompt);
		if (existsSync(p)) res.report.push(`system_prompt: ${doc.system_prompt} → kept (file exists)`);
		else {
			edits.set("system_prompt", null);
			res.report.push(`system_prompt → removed`);
			res.warnings.push(`system_prompt dropped: ${p} does not exist (Pi's default prompt applies)`);
		}
	}

	if ("cleanup" in doc) {
		const c = doc.cleanup;
		if (typeof c === "string") {
			const { text, others } = migrateCleanupText(c);
			if (text !== c) {
				edits.set("cleanup", dumpKey("cleanup", text));
				res.report.push(`cleanup: {summary_path} → "${SUMMARY_WORDING}"`);
			} else res.report.push("cleanup → kept");
			if (others.length) res.warnings.push(`cleanup still has ${others.join(" ")}: kl expands no placeholders; reword them`);
		} else if (c && typeof c === "object" && typeof (c as { path?: unknown }).path === "string") {
			const file = resolve(home, (c as { path: string }).path);
			if (existsSync(file)) {
				const before = readFileSync(file, "utf8");
				const { text, others } = migrateCleanupText(before);
				if (text !== before) {
					if (!opts.dryRun) {
						copyFileSync(file, `${file}.bak`);
						writeFileSync(file, text);
					}
					res.changed = true;
					res.report.push(`cleanup file ${file}: {summary_path} rewritten (backup ${file}.bak)`);
				} else res.report.push(`cleanup: path ${file} → kept`);
				if (others.length) res.warnings.push(`${file} still has ${others.join(" ")}: kl expands no placeholders; reword them`);
			} else res.report.push(`cleanup: path ${file} → kept (file missing; kl will warn)`);
		}
	}

	if (edits.size > 0 || appendSections) {
		const blocks = keyBlocks(lines);
		// Apply bottom-up so earlier ranges stay valid.
		const ordered = [...edits.entries()]
			.filter(([k]) => blocks.has(k))
			.sort((a, b) => blocks.get(b[0])![0] - blocks.get(a[0])![0]);
		for (const [key, repl] of ordered) {
			const [start, end] = blocks.get(key)!;
			const keyLine = lines.slice(start, end).findIndex((l) => l.startsWith(key)) + start;
			// Replacements keep the comment block above the key; removals take it.
			if (repl === null) lines.splice(start, end - start);
			else {
				lines.splice(keyLine, end - keyLine, ...repl);
				// Drop comment lines above it that document the old placeholders.
				for (let i = keyLine - 1; i >= start; i--) if (/template vars|\{summary_path\}/.test(lines[i])) lines.splice(i, 1);
			}
		}
		let out = lines.join("\n").replace(/\n{3,}/g, "\n\n");
		if (appendSections) out = `${out.replace(/\n*$/, "\n")}\n# Files rendered into the system prompt at session start (kl migrate).\n${appendSections.join("\n")}\n`;
		// Must still parse, and every edit must have taken.
		const check = yaml.load(out) as Record<string, unknown>;
		for (const [k, v] of edits) if (v === null && k in (check ?? {})) throw new Error(`migrate: failed to remove ${k} from ${ymlPath}`);
		if (!opts.dryRun) {
			let bak = `${ymlPath}.bak`;
			for (let i = 1; existsSync(bak); i++) bak = `${ymlPath}.bak.${i}`;
			copyFileSync(ymlPath, bak);
			writeFileSync(ymlPath, out);
			res.backup = bak;
		}
		res.changed = true;
	}

	const oldHook = join(home, "harness", "pre-launch");
	if (existsSync(oldHook)) {
		const newHook = join(home, "hooks", "pre-launch");
		if (existsSync(newHook)) res.warnings.push(`both ${oldHook} and ${newHook} exist; left both, only hooks/pre-launch runs`);
		else {
			if (!opts.dryRun) {
				mkdirSync(dirname(newHook), { recursive: true });
				renameSync(oldHook, newHook);
			}
			res.changed = true;
			res.report.push("harness/pre-launch → hooks/pre-launch");
		}
	}

	if (!res.changed && res.report.length === 0) res.report.push("nothing to migrate");
	return res;
}

function main(argv: string[]): number {
	const dryRun = argv.includes("--dry-run") || argv.includes("-n");
	const args = argv.filter((a) => a !== "--dry-run" && a !== "-n");
	if (args.some((a) => a === "-h" || a === "--help")) {
		process.stdout.write("usage: kl migrate [--dry-run] [agent-home…]   (default: every agent in $KL_AGENTS_DIR)\n");
		return 0;
	}
	const homes = args.length ? args : listAgents().map((a) => join(agentsDir(), a.name));
	if (homes.length === 0) {
		process.stderr.write(`kl migrate: no agents in ${agentsDir()}\n`);
		return 1;
	}
	let failed = 0;
	for (const h of homes) {
		try {
			const r = migrateHome(h, { dryRun });
			process.stdout.write(`${r.home}${dryRun ? " (dry run)" : ""}\n`);
			for (const l of r.report) process.stdout.write(`  ${l}\n`);
			for (const w of r.warnings) process.stdout.write(`  warning: ${w}\n`);
			if (r.backup) process.stdout.write(`  backup: ${r.backup}\n`);
		} catch (e) {
			failed++;
			process.stderr.write(`kl migrate: ${h}: ${(e as Error).message}\n`);
		}
	}
	return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	process.exitCode = main(process.argv.slice(2));
}
