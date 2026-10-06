/**
 * Where the session registry lives. Everything is a
 * plain file under <kl root>/run so agents and humans can ls/cat it:
 *
 *   run/sessions/<uuid>.yml   registry entry, written by the session's process at each start
 *   run/leases/<uuid>.json    liveness, written by the running pi process
 *   run/inbox/<uuid>/*.md     mail, keyed by UUID so a reused name can't read old mail
 *   run/names.lock/           mkdir lock for drawing names (holder pid inside)
 *   run/wake/<uuid>.lock/     mkdir lock for waking one session
 *   run/status/<uuid>.json    optional "what I'm doing" ({summary, detail}); kl only reads it
 *   daemon/                   the daemon's state: subscriptions/, channels/<name>/history.jsonl
 *
 * kl root = $KL_ROOT, else ~/.kl (same rule as extensions/kiln-lite/config.ts).
 */

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

export function sessionsDir(root = klRoot()): string {
	return join(runDir(root), "sessions");
}

export function leasesDir(root = klRoot()): string {
	return join(runDir(root), "leases");
}

/** Root that holds one inbox dir per session UUID. */
export function inboxRoot(root = klRoot()): string {
	return join(runDir(root), "inbox");
}

export function inboxDir(uuid: string, root = klRoot()): string {
	return join(inboxRoot(root), uuid);
}

/** Optional status file: anyone may write it; kl only reads it (kl sessions shows it). */
export function statusPath(uuid: string, root = klRoot()): string {
	if (!UUID_RE.test(uuid)) throw new Error(`not a session uuid: ${uuid}`);
	return join(runDir(root), "status", `${uuid}.json`);
}

/** The daemon's state dir: subscriptions/, channels/, known-sessions.json, the log. */
export function daemonDir(root = klRoot()): string {
	return join(root, "daemon");
}

export function namesLockPath(root = klRoot()): string {
	return join(runDir(root), "names.lock");
}

export function wakeLockPath(uuid: string, root = klRoot()): string {
	return join(runDir(root), "wake", `${uuid}.lock`);
}

/** Pi session UUIDs are hex + dashes. Guards every path built from one. */
export const UUID_RE = /^[0-9a-f][0-9a-f-]{7,63}$/i;
