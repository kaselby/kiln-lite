/**
 * Exit-session pure logic — types and helpers with no pi dependency.
 *
 * The pi-dependent tool wrapper lives in exit-session-tool.ts.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface ContinuationConfig {
	/**
	 * Resolved handoff *content* (text). Orienting context for the
	 * continuation. The content is persisted to a file at spawn time
	 * ({@link persistHandoff}); the continuation is then handed the file *path*
	 * (via `--handoff`, exported as `KL_HANDOFF`) and injects a one-time pointer
	 * to it on its first turn — the session reads the file itself to orient.
	 * The handoff content is deliberately NOT baked into the continuation's
	 * system prompt.
	 */
	handoff: string;
	template?: string;
	/**
	 * Model id the continuation should launch with (e.g.
	 * `anthropic/claude-opus-4-8`). Captured from the exiting session's live
	 * model so a continuation inherits the model actually in use — including a
	 * mid-session `/model` switch — rather than silently reverting to the
	 * `agent.yml` default (or pi's default) that a bare `kl --detach` resolves.
	 * When unset, the launch falls back to that default.
	 */
	model?: string;
	/**
	 * When true, the continuation is started unattended: a fixed turn-1 ping is
	 * sent so its agent loop kicks off on its own. When false (the default),
	 * no startup prompt is sent — the continuation spawns idle with the handoff
	 * as context and waits for the human who is handed the terminal.
	 */
	autonomous?: boolean;
}

/** Runs a tmux subcommand and returns its stdout. Injectable for tests. */
export type TmuxRunner = (args: string[]) => string;

/**
 * Turn-1 message sent to an autonomous continuation so its agent loop starts
 * without a human. The substantive context lives in the handoff file, which
 * the continuation is pointed at by a first-turn reminder; this is only a
 * neutral kick-off, deliberately free of fresh directives so the continuation
 * resumes the prior work rather than treating the ping as a new task.
 */
export const CONTINUATION_STARTUP_PING =
	"You are an autonomous continuation of a prior session. Your orienting context — what the " +
	"prior session was doing and where it left off — is in a handoff file that a first-turn " +
	"reminder points you at. Read that file, pick up from there and continue the work; no new " +
	"instructions are coming.";

/** Options for {@link buildContinuationArgs}. */
export interface ContinuationArgsOptions {
	/**
	 * Path to a file holding the handoff content. Passed as the `--handoff`
	 * value, which `kl` exports as `KL_HANDOFF` for the continuation. The
	 * extension detects that env var at session_start and injects a one-time
	 * pointer to the file on the first turn (see the origin-reminder path in
	 * install.ts) — the handoff is NOT read into the system prompt. Passing a
	 * path rather than the content also keeps the argv element short, so a large
	 * handoff never trips tmux's ~16 KB command-length cap.
	 */
	handoffPath?: string;
	template?: string;
	/**
	 * Model id to launch the continuation with. Passed through to `kl` as
	 * `--model <id>`; kl forwards it to pi and, seeing an explicit `--model`,
	 * skips prepending the `agent.yml` default. Omitted → kl's default
	 * resolution applies.
	 */
	model?: string;
	autonomous?: boolean;
}

/**
 * Build the `kl --detach` argument list for a continuation. Pure (no I/O) so
 * the launch shape is unit-testable.
 *
 * The handoff file path rides `--handoff` (exported by kl as `KL_HANDOFF`), so
 * the continuation is pointed at the file via a one-time first-turn reminder
 * rather than having the handoff baked into its system prompt. When `model` is
 * set it rides `--model`, so the continuation inherits the exiting session's
 * model instead of kl's default. When `autonomous` is set, a fixed startup ping is appended as a positional message
 * so the loop kicks off unattended; otherwise no startup prompt is sent and the
 * session spawns idle for the human handed the terminal.
 */
export function buildContinuationArgs(opts: ContinuationArgsOptions): string[] {
	const args = ["--detach"];
	if (opts.template) {
		args.push("--template", opts.template);
	}
	if (opts.model) {
		// Not a kl flag — falls through to pi_args, where kl's has-model check
		// sees it and skips the agent.yml default. pi parses it as an option
		// ahead of any positional startup ping.
		args.push("--model", opts.model);
	}
	if (opts.handoffPath) {
		args.push("--handoff", opts.handoffPath);
	}
	if (opts.autonomous) {
		args.push(CONTINUATION_STARTUP_PING);
	}
	return args;
}

/**
 * Filesystem-safe handoff file name: `<agentName>-<timestamp>-<shortuuid>.md`.
 * Pure (now/uuid injectable) so it's unit-testable. The ISO timestamp's colons
 * and dots are swapped for dashes so the name is portable across filesystems.
 */
export function handoffFileName(
	agentName: string,
	when: Date = new Date(),
	uuid: string = randomUUID(),
): string {
	const stamp = when.toISOString().replace(/[:.]/g, "-");
	return `${agentName}-${stamp}-${uuid.slice(0, 8)}.md`;
}

/**
 * Persist handoff content to a durable file under `<agentHome>/handoffs/` and
 * return its absolute path. Every continuation handoff is captured here — both
 * to give the continuation a short path to point at (see
 * {@link buildContinuationArgs}) and to leave a durable record of what each
 * session handed off. The file is never cleaned up by us, so the continuation's
 * read of it at startup can't race a deletion.
 */
export function persistHandoff(
	agentHome: string,
	agentName: string,
	content: string,
	opts?: { when?: Date; uuid?: string },
): string {
	const path = join(agentHome, "handoffs", handoffFileName(agentName, opts?.when, opts?.uuid));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
	return path;
}

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
