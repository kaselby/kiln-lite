/**
 * Where the session registry lives. Everything is a
 * plain file under <kl root>/run so agents and humans can ls/cat it. Each
 * session has one folder, so `ls run/<uuid>` shows all of it and
 * `rm -r run/<uuid>` deletes it:
 *
 *   run/<uuid>/session.yml    registry entry, written by the session's process at each start
 *   run/<uuid>/lease.json     liveness, written by the running pi process
 *   run/<uuid>/inbox/*.md     mail, keyed by UUID so a reused name can't read old mail
 *   run/<uuid>/plan.json      the plan tool's plan
 *   run/<uuid>/status.json    optional "what I'm doing" ({summary, detail}); kl only reads it
 *   run/<uuid>/schedule/      pending wakes (src/schedule.ts)
 *   run/<uuid>/wake.lock/     mkdir lock for waking this session
 *   run/names.lock/           mkdir lock for drawing names (holder pid inside)
 *   run/<uuid>/config.yml     runtime overrides for this session (kl config; extensions/kiln-lite/runtime-config.ts)
 *   daemon/                   the daemon's state: subscriptions/, channels/<name>/history.jsonl
 *   daemon/kiln-lite.sock     the daemon's socket (see socketPath for the long-path fallback)
 *
 * kl root = $KL_ROOT, else ~/.kl (same rule as extensions/kiln-lite/config.ts).
 */

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function klRoot(): string {
	const fromEnv = process.env.KL_ROOT;
	if (fromEnv && fromEnv.trim()) return resolve(fromEnv);
	return resolve(join(homedir(), ".kl"));
}

export function runDir(root = klRoot()): string {
	return join(root, "run");
}

/** One session's folder. Every per-session path below is built from it. */
export function sessionDir(uuid: string, root = klRoot()): string {
	if (!UUID_RE.test(uuid)) throw new Error(`not a session uuid: ${uuid}`);
	return join(runDir(root), uuid);
}

/** UUIDs of every session folder under run/. */
export function sessionUuids(root = klRoot()): string[] {
	try {
		return readdirSync(runDir(root)).filter((f) => UUID_RE.test(f));
	} catch {
		return [];
	}
}

export function entryPath(uuid: string, root = klRoot()): string {
	return join(sessionDir(uuid, root), "session.yml");
}

export function leasePath(uuid: string, root = klRoot()): string {
	return join(sessionDir(uuid, root), "lease.json");
}

export function inboxDir(uuid: string, root = klRoot()): string {
	return join(sessionDir(uuid, root), "inbox");
}

export function planPath(uuid: string, root = klRoot()): string {
	return join(sessionDir(uuid, root), "plan.json");
}

/** Optional status file: anyone may write it; kl only reads it (kl sessions shows it). */
export function statusPath(uuid: string, root = klRoot()): string {
	return join(sessionDir(uuid, root), "status.json");
}

export function scheduleDir(uuid: string, root = klRoot()): string {
	return join(sessionDir(uuid, root), "schedule");
}

export function wakeLockPath(uuid: string, root = klRoot()): string {
	return join(sessionDir(uuid, root), "wake.lock");
}

/** The daemon's state dir: subscriptions/, channels/, known-sessions.json, the log. */
export function daemonDir(root = klRoot()): string {
	return join(root, "daemon");
}

/**
 * The daemon's socket: <kl root>/daemon/kiln-lite.sock, so each kl root has
 * its own daemon. Unix socket paths are capped (104 bytes with the NUL on
 * macOS, 108 on Linux); when that path is too long, /tmp/kiln-lite-<hash of
 * the kl root>.sock. The daemon and every client use this.
 */
export function socketPath(root = klRoot()): string {
	const path = join(daemonDir(root), "kiln-lite.sock");
	const max = process.platform === "darwin" ? 104 : 108;
	if (Buffer.byteLength(path) < max) return path;
	const hash = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12);
	return `/tmp/kiln-lite-${hash}.sock`;
}

/** Per-session runtime overrides (timestamps, session_state_interval); kl config writes it. */
export function sessionConfigPath(uuid: string, root = klRoot()): string {
	return join(sessionDir(uuid, root), "config.yml");
}

export function namesLockPath(root = klRoot()): string {
	return join(runDir(root), "names.lock");
}

/** Pi session UUIDs are hex + dashes. Guards every path built from one. */
export const UUID_RE = /^[0-9a-f][0-9a-f-]{7,63}$/i;
