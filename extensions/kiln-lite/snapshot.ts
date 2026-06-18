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
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
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
	}
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
