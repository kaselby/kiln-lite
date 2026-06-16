/**
 * Exit-session pure logic — types and helpers with no pi dependency.
 *
 * The pi-dependent tool wrapper lives in exit-session-tool.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ContinuationConfig {
	handoff: string;
	template?: string;
}

/** Runs a tmux subcommand and returns its stdout. Injectable for tests. */
export type TmuxRunner = (args: string[]) => string;

const defaultTmuxRunner: TmuxRunner = (args) =>
	execFileSync("tmux", args, { timeout: 2000 }).toString();

/**
 * Move any tmux client attached to `priorId` (the exiting session) onto
 * `newId` (the continuation), and return how many clients were moved.
 *
 * Only acts when running inside tmux and a client is actually attached to the
 * exiting session — the interactive case where someone is watching. The
 * switch happens while both sessions are alive (during session_shutdown,
 * before pi exits), so when the old session is auto-destroyed on exit its
 * client has already moved and is never dropped to a bare shell.
 * Detached/autonomous sessions have no attached client, so this is a no-op
 * (returns 0) and the continuation simply keeps running in the background.
 *
 * Fire-and-forget by design: a failed handoff must never break exit. On any
 * error we warn and return 0, falling back to the old behavior (old session
 * dies, client detaches).
 */
export function handoffTmuxClient(
	priorId: string | undefined,
	newId: string,
	opts?: { tmux?: TmuxRunner; inTmux?: boolean; warn?: (msg: string) => void },
): number {
	const inTmux = opts?.inTmux ?? Boolean(process.env.TMUX);
	const tmux = opts?.tmux ?? defaultTmuxRunner;
	const warn = opts?.warn ?? (() => {});
	if (!inTmux || !priorId || !newId) return 0;
	try {
		const raw = tmux(["list-clients", "-t", priorId, "-F", "#{client_name}"]).trim();
		if (!raw) return 0; // no attached client — autonomous run, leave detached
		const clients = raw.split("\n").filter(Boolean);
		for (const client of clients) {
			tmux(["switch-client", "-c", client, "-t", newId]);
		}
		return clients.length;
	} catch (err) {
		warn(
			`kiln-lite: tmux client handoff failed (${(err as Error).message}) — continuation runs detached`,
		);
		return 0;
	}
}

/**
 * Resolve a handoff value to text. If it looks like a file path (absolute or
 * ~/...) and the file exists, read its contents. Otherwise return as-is.
 */
export function resolveHandoff(raw: string): string {
	let path = raw.trim();
	if (path.startsWith("~/")) {
		path = join(homedir(), path.slice(2));
	}
	if (path.startsWith("/") && existsSync(path)) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			// Read failed — fall through to raw text
		}
	}
	return raw;
}
