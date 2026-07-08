/**
 * Session snapshot store.
 *
 * Persists a stable binding between agent-id and pi-session-uuid plus a
 * verbatim copy of the rendered system prompt, so that:
 *
 *   1. Resuming a session with `kl resume <agent-id>` (or plain
 *      `pi --continue` / `pi --resume`) recovers the original agent-id even
 *      when AGENT_ID isn't pre-set in the env. We reverse-look-up
 *      pi-session-uuid → agent-id from meta.json.
 *
 *   2. The system prompt sent to the model on resume is byte-identical to
 *      what was sent originally, regardless of how the on-disk memory /
 *      skills / tools / identity files have drifted in the meantime. The
 *      snapshot is written exactly once, at the first compose of a fresh
 *      session, and replayed verbatim on every subsequent turn after a
 *      resume. (Within the same live process, turns continue to re-render
 *      from current state — the snapshot only takes over once the process
 *      has died and another one resumes.)
 *
 * Layout under $AGENT_HOME:
 *
 *   state/sessions/<agent-id>/
 *     meta.json           — JSON record (see SnapshotMeta below)
 *     system-prompt.txt   — verbatim system prompt string
 *
 * meta.json shape is treated as additive — unknown fields are preserved on
 * read/rewrite. Anything written here is best-effort: failures warn but
 * never block session startup.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface SnapshotMeta {
	/** Agent id (also the directory name). */
	agent_id: string;
	/** Pi session UUID. */
	pi_session_uuid: string;
	/** Absolute path to pi's session JSONL, when known. */
	pi_session_jsonl?: string;
	/** Working directory at session start. */
	cwd?: string;
	/** Model id at session start (best-effort — pi sets this lazily). */
	model?: string;
	/** Agent-id that launched this session, from KL_PARENT (--parent). Unset for direct launches. */
	parent?: string;
	/** ISO-8601 timestamp of first observation. */
	created_at: string;
	/** ISO-8601 timestamp of most recent session_start for this agent-id. */
	last_seen: string;
	/** Reserved for future fields — additive shape. */
	[key: string]: unknown;
}

/** Resolve the per-agent snapshot directory. Does NOT create it. */
export function snapshotDir(agentHome: string, agentId: string): string {
	return join(agentHome, "state", "sessions", agentId);
}

/** Resolve the parent dir that contains all per-agent snapshot dirs. */
export function snapshotsRoot(agentHome: string): string {
	return join(agentHome, "state", "sessions");
}

/** Path to the meta.json for a given agent-id. */
export function metaPath(agentHome: string, agentId: string): string {
	return join(snapshotDir(agentHome, agentId), "meta.json");
}

/** Path to the system-prompt.txt for a given agent-id. */
export function promptPath(agentHome: string, agentId: string): string {
	return join(snapshotDir(agentHome, agentId), "system-prompt.txt");
}

/**
 * Read meta.json for the given agent-id. Returns null if missing or
 * unreadable. Malformed JSON is treated as missing (warned).
 */
export function readMeta(
	agentHome: string,
	agentId: string,
	warn?: (msg: string) => void,
): SnapshotMeta | null {
	const path = metaPath(agentHome, agentId);
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && typeof parsed.agent_id === "string") {
			return parsed as SnapshotMeta;
		}
		warn?.(`kiln-lite: snapshot meta at ${path} is not a valid record — treating as missing`);
		return null;
	} catch (err) {
		warn?.(`kiln-lite: failed to read snapshot meta at ${path}: ${(err as Error).message}`);
		return null;
	}
}

/**
 * Write meta.json for the given agent-id. Creates the directory if needed.
 * Best-effort — failures warn but do not throw.
 */
export function writeMeta(
	agentHome: string,
	meta: SnapshotMeta,
	warn?: (msg: string) => void,
): void {
	const dir = snapshotDir(agentHome, meta.agent_id);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(metaPath(agentHome, meta.agent_id), `${JSON.stringify(meta, null, 2)}\n`);
	} catch (err) {
		warn?.(`kiln-lite: failed to write snapshot meta for ${meta.agent_id}: ${(err as Error).message}`);
		return;
	}
	// Mirror into the recency journal so `kl history` never has to open a
	// single meta.json on the common path. Best-effort: appendJournal
	// swallows its own errors, so a journal hiccup never affects the meta
	// write we just succeeded at.
	appendJournal(agentHome, meta, warn);
}

// ---------------------------------------------------------------------------
// Recency journal
//
// `kl history` needs a fast "what was I recently doing" view. Opening and
// JSON-parsing every meta.json on every invocation is O(total sessions ever)
// and was measured at ~12s for ~450 sessions. The journal is an append-only
// denormalized index of just the fields history displays: one line is
// written on every writeMeta() (the single chokepoint for meta writes), so
// the reader tails one file instead of stat+opening hundreds of dirs.
//
// Properties:
//   * Append-only — no atomic-rewrite dance on the hot path; a torn final
//     line is one skippable parse on read.
//   * Self-healing — if the journal is missing/empty the reader rebuilds it
//     from the authoritative meta files (see rebuildJournal).
//   * Denormalized — rows may go stale after manual meta surgery until the
//     next writeMeta()/rebuild. That's acceptable for a recent-glance view;
//     the EXACT recovery path (`--all`, resume) always reads fresh meta.
//   * No compaction yet — growth is ~sessions/resumes, not turns, so the
//     file stays small for a long time; lazy compaction can come later.
// ---------------------------------------------------------------------------

/** One line of the recency journal — a projection of the SnapshotMeta
 * fields `kl history` displays plus what `resolve` would need. */
export interface JournalRecord {
	agent_id: string;
	last_seen: string;
	model?: string;
	cwd?: string;
	parent?: string;
	pi_session_jsonl?: string;
	created_at?: string;
}

/** Path to the per-agent-home recency journal. */
export function journalPath(agentHome: string): string {
	return join(snapshotsRoot(agentHome), ".journal.jsonl");
}

function journalRecordFromMeta(meta: SnapshotMeta): JournalRecord {
	return {
		agent_id: meta.agent_id,
		last_seen: meta.last_seen,
		model: meta.model,
		cwd: meta.cwd,
		parent: meta.parent,
		pi_session_jsonl: meta.pi_session_jsonl,
		created_at: meta.created_at,
	};
}

/** Parse an ISO timestamp to a comparable number; missing/invalid sort
 * oldest (so they never crowd out genuine recent rows). */
export function journalTsValue(ts: string | undefined): number {
	if (!ts) return -1;
	const t = Date.parse(ts);
	return Number.isNaN(t) ? -1 : t;
}

/** Append one record for `meta`. Best-effort: warns but never throws, so a
 * journal failure can't break the meta write that triggered it. */
export function appendJournal(
	agentHome: string,
	meta: SnapshotMeta,
	warn?: (msg: string) => void,
): void {
	try {
		mkdirSync(snapshotsRoot(agentHome), { recursive: true });
		appendFileSync(journalPath(agentHome), `${JSON.stringify(journalRecordFromMeta(meta))}\n`);
	} catch (err) {
		warn?.(`kiln-lite: failed to append recency journal for ${meta.agent_id}: ${(err as Error).message}`);
	}
}

/** Read the journal, skipping corrupt lines, deduped to the latest record
 * per agent_id (by last_seen; ties resolve to the later line). Returns []
 * if the journal is missing or unreadable — the caller decides whether to
 * rebuild. Records are NOT sorted. */
export function readJournal(
	agentHome: string,
	warn?: (msg: string) => void,
): JournalRecord[] {
	const path = journalPath(agentHome);
	if (!existsSync(path)) return [];
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		warn?.(`kiln-lite: failed to read recency journal ${path}: ${(err as Error).message}`);
		return [];
	}
	const latest = new Map<string, JournalRecord>();
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let rec: JournalRecord;
		try {
			const parsed = JSON.parse(trimmed);
			if (!parsed || typeof parsed.agent_id !== "string") continue;
			rec = parsed as JournalRecord;
		} catch {
			continue; // torn/corrupt line — skip silently (normal for an append log)
		}
		const prev = latest.get(rec.agent_id);
		// >= so a later line with an equal (or both-invalid) timestamp wins.
		if (!prev || journalTsValue(rec.last_seen) >= journalTsValue(prev.last_seen)) {
			latest.set(rec.agent_id, rec);
		}
	}
	return [...latest.values()];
}

/** Enumerate every snapshot meta.json under an agent home. The exact,
 * journal-independent source of truth — backs the `--all` recovery view and
 * journal rebuild. Linear scan; fine for O(hundreds–thousands). */
export function scanAllMeta(
	agentHome: string,
	warn?: (msg: string) => void,
): SnapshotMeta[] {
	const root = snapshotsRoot(agentHome);
	if (!existsSync(root)) return [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch (err) {
		warn?.(`kiln-lite: failed to scan snapshot dir ${root}: ${(err as Error).message}`);
		return [];
	}
	const out: SnapshotMeta[] = [];
	for (const name of entries) {
		if (name.startsWith(".")) continue; // skip .journal.jsonl and friends
		const full = join(root, name);
		try {
			if (!statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		const meta = readMeta(agentHome, name, warn);
		if (meta) out.push(meta);
	}
	return out;
}

/** Rebuild the journal from the authoritative meta files. Temp + rename so a
 * concurrent reader never observes a half-written journal. Returns the
 * records written. Best-effort: warns but never throws. */
export function rebuildJournal(
	agentHome: string,
	warn?: (msg: string) => void,
): JournalRecord[] {
	const records = scanAllMeta(agentHome, warn).map(journalRecordFromMeta);
	const path = journalPath(agentHome);
	const tmp = `${path}.tmp.${process.pid}`;
	try {
		mkdirSync(snapshotsRoot(agentHome), { recursive: true });
		writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
		renameSync(tmp, path);
	} catch (err) {
		warn?.(`kiln-lite: failed to rebuild recency journal ${path}: ${(err as Error).message}`);
		try {
			if (existsSync(tmp)) rmSync(tmp);
		} catch {
			/* ignore cleanup failure */
		}
	}
	return records;
}

/**
 * Read the cached system prompt for the given agent-id. Returns null if no
 * snapshot exists or the file is unreadable.
 */
export function readPromptSnapshot(
	agentHome: string,
	agentId: string,
	warn?: (msg: string) => void,
): string | null {
	const path = promptPath(agentHome, agentId);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		warn?.(`kiln-lite: failed to read system prompt snapshot at ${path}: ${(err as Error).message}`);
		return null;
	}
}

/**
 * Write the system prompt snapshot for the given agent-id. Creates the
 * directory if needed. Best-effort — failures warn but do not throw.
 */
export function writePromptSnapshot(
	agentHome: string,
	agentId: string,
	prompt: string,
	warn?: (msg: string) => void,
): void {
	const dir = snapshotDir(agentHome, agentId);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(promptPath(agentHome, agentId), prompt);
	} catch (err) {
		warn?.(`kiln-lite: failed to write system prompt snapshot for ${agentId}: ${(err as Error).message}`);
	}
}

/**
 * Reverse-look-up: given a pi-session-uuid, find the agent-id whose
 * snapshot meta.json points at it. Returns null if no match.
 *
 * Linear scan over all agent dirs under state/sessions/. For O(hundreds)
 * of historical sessions this is comfortably fast (<10ms typical).
 */
export function findAgentIdForUuid(
	agentHome: string,
	piSessionUuid: string,
	warn?: (msg: string) => void,
): string | null {
	const root = snapshotsRoot(agentHome);
	if (!existsSync(root)) return null;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch (err) {
		warn?.(`kiln-lite: failed to scan snapshot dir ${root}: ${(err as Error).message}`);
		return null;
	}
	for (const name of entries) {
		const full = join(root, name);
		try {
			if (!statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		const meta = readMeta(agentHome, name);
		if (meta?.pi_session_uuid === piSessionUuid) return name;
	}
	return null;
}

/**
 * Fork inheritance.
 *
 * A forked session (via `/spawn` or `pi --fork`) gets a fresh pi-session-uuid
 * and therefore a fresh agent-id with no snapshot of its own. Left alone it
 * would recompose the system prompt from current on-disk state — dropping
 * anything injected at the PARENT's launch, e.g. content appended via
 * `--append-system-prompt` (which is never persisted in the session JSONL). Resume doesn't have this problem because it keeps the same
 * uuid → same agent-id → same snapshot.
 *
 * Given the parent's session file (from `SessionStartEvent.previousSessionFile`),
 * resolve the parent's frozen system-prompt snapshot so the fork can replay it
 * verbatim, matching resume semantics. The caller is responsible for writing
 * the result under the FORK's own agent-id so later resumes of the fork stay
 * consistent.
 *
 * Returns null when there's no parent file, the uuid can't be parsed, the
 * parent has no recorded agent-id, or the parent has no snapshot — in every
 * such case the caller falls back to a fresh compose. Best-effort: never
 * throws.
 */
export function resolveForkInheritedPrompt(
	agentHome: string,
	previousSessionFile: string | undefined,
	warn?: (msg: string) => void,
): string | null {
	if (!previousSessionFile) return null;
	// Same shape as inferSessionUuid: the uuid is the basename before .jsonl.
	const m = previousSessionFile.match(/([0-9a-fA-F-]{20,})\.jsonl$/);
	if (!m) return null;
	const parentAgentId = findAgentIdForUuid(agentHome, m[1], warn);
	if (!parentAgentId) return null;
	return readPromptSnapshot(agentHome, parentAgentId, warn);
}

/**
 * Pick a non-colliding agent-id given a desired one. If the desired id
 * is free OR already bound to the same pi-session-uuid, return it as-is.
 * Otherwise append "-2", "-3", … until we find a free slot. Used at
 * session_start when AGENT_ID is set but its meta.json points at a
 * different pi-session-uuid (very rare, but possible with the small
 * adj/noun pool over time).
 */
export function uniquifyAgentId(
	agentHome: string,
	desired: string,
	piSessionUuid: string,
): string {
	const tryFree = (id: string): boolean => {
		const meta = readMeta(agentHome, id);
		if (!meta) return true;
		return meta.pi_session_uuid === piSessionUuid;
	};
	if (tryFree(desired)) return desired;
	for (let n = 2; n < 1000; n++) {
		const candidate = `${desired}-${n}`;
		if (tryFree(candidate)) return candidate;
	}
	// Astronomically unlikely. Fall back to a random suffix to avoid a hang.
	return `${desired}-${Math.random().toString(36).slice(2, 6)}`;
}
