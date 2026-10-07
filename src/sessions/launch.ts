/**
 * Starting pi in tmux: a new session (`kl run`) or an existing one
 * (`wake`, used by `kl resume` and `kl attach`).
 *
 * wake(uuid): wake lock → re-check lease → reserve a name (the session's
 * last name unless something live holds it) → `tmux new-session -d` with
 * `pi --session <transcript>` → hold the
 * lock until the new process has written its lease. Pi restores the
 * session's latest model and thinking level from the transcript; the rest
 * is re-derived from home + agent.yml.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { plan, REPO_ROOT } from "../launcher.ts";
import { acquireLockAsync } from "./fsutil.ts";
import { liveLease, type Lease } from "./lease.ts";
import { drawName, reserveName } from "./names.ts";
import { klRoot, wakeLockPath } from "./paths.ts";
import { readEntry, type RegistryEntry } from "./registry.ts";
import { tmux } from "./tmux.ts";
import { spawnSync } from "node:child_process";

export function resolvePiBin(): string {
	const env = process.env.KL_PI?.trim();
	if (env) return env;
	const local = join(REPO_ROOT, "node_modules", ".bin", "pi");
	if (existsSync(local)) return local;
	const r = spawnSync("sh", ["-c", "command -v pi"], { encoding: "utf8" });
	const p = (r.stdout ?? "").trim();
	if (!p) throw new Error("pi not found: install @earendil-works/pi-coding-agent >= 1.0.3 or set KL_PI");
	return p;
}

function tmuxEnv(vars: Record<string, string | undefined>): string[] {
	const out: string[] = [];
	for (const [k, v] of Object.entries(vars)) if (v !== undefined && v !== "") out.push("-e", `${k}=${v}`);
	return out;
}

/**
 * Env every kl-launched pi gets. KL_ROOT (which also places the daemon
 * socket) and KL_TMUX_SOCKET are forwarded: a running tmux server doesn't
 * see the caller's env.
 */
function baseEnv(home: string, piDir: string, name: string): Record<string, string | undefined> {
	return {
		AGENT_HOME: home,
		_KL: "1",
		PI_CODING_AGENT_DIR: piDir,
		KL_ROOT: process.env.KL_ROOT,
		KL_TMUX_SOCKET: process.env.KL_TMUX_SOCKET,
		KL_NAME: name,
	};
}

export interface LaunchOptions {
	home: string;
	/** User pi args (prompt included). */
	piArgs: string[];
	/** Parent session UUID. */
	parent?: string;
	cwd?: string;
	warn?: (msg: string) => void;
}

/**
 * `kl run` and the subagent tool: draw a name and
 * start pi in a detached tmux session named after it. Returns the name.
 */
export function launchNew(opts: LaunchOptions): string {
	const p = plan({ agentHome: opts.home, userArgs: opts.piArgs });
	for (const w of p.warnings) opts.warn?.(w);
	const pi = resolvePiBin();
	const cwd = opts.cwd ?? process.cwd();
	return reserveName(
		(state) => drawName({ agent: p.agentName, held: state.held, recent: state.recent }),
		(name) => {
			const env = { ...baseEnv(opts.home, p.piDir, name), KL_PARENT: opts.parent };
			const r = tmux(["new-session", "-d", "-s", name, "-c", cwd, ...tmuxEnv(env), pi, ...p.args]);
			if (!r.ok) throw new Error(`tmux new-session failed for ${name}: ${r.stderr.trim()}`);
			return name;
		},
	);
}

export interface WakeResult {
	name: string;
	/** false = it was already live. */
	started: boolean;
	lease: Lease | null;
}

export interface WakeOptions {
	root?: string;
	/** How long to wait for the new process's lease. Default 20000. */
	timeoutMs?: number;
	log?: (msg: string) => void;
}

export function neverStarted(entry: RegistryEntry): string {
	return `${entry.name} never started a conversation; nothing to resume`;
}

/**
 * Start a stopped session detached; does nothing if it is running. At most
 * one process per session: concurrent callers serialise on the wake lock and
 * the later ones find the lease. Waits without blocking the event loop, so
 * the message tool can call it inside pi.
 */
export async function wake(uuid: string, opts: WakeOptions = {}): Promise<WakeResult> {
	const root = opts.root ?? klRoot();
	const log = opts.log ?? (() => {});
	const entry = readEntry(uuid, root);
	if (!entry) throw new Error(`no registry entry for ${uuid}`);
	const already = liveLease(uuid, root);
	if (already) return { name: already.name, started: false, lease: already };
	// Pi writes the transcript on the first message; no file = nothing to resume.
	// (pi --session on a missing path would start a NEW session there.)
	if (!existsSync(entry.transcript)) throw new Error(neverStarted(entry));

	const release = await acquireLockAsync(wakeLockPath(uuid, root), {
		timeoutMs: (opts.timeoutMs ?? 20000) + 5000,
		onWait: (pid) => log(`wake ${entry.name}: another waker (pid ${pid}) holds the lock, waiting`),
		onBreak: (pid) => log(`wake ${entry.name}: broke stale wake lock (holder ${pid || "unknown"})`),
	});
	try {
		// Someone may have woken it while we waited.
		const now = liveLease(uuid, root);
		if (now) return { name: now.name, started: false, lease: now };
		const name = startProcess(entry, root);
		const deadline = Date.now() + (opts.timeoutMs ?? 20000);
		while (Date.now() < deadline) {
			const l = liveLease(uuid, root);
			if (l) return { name: l.name, started: true, lease: l };
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(
			`woke ${name} but it wrote no lease within ${opts.timeoutMs ?? 20000}ms (tmux session '${name}' may be stuck; attach to look)`,
		);
	} finally {
		release();
	}
}

function startProcess(entry: RegistryEntry, root: string): string {
	if (!existsSync(entry.transcript)) throw new Error(neverStarted(entry));
	if (!existsSync(entry.home)) throw new Error(`agent home for ${entry.name} is gone: ${entry.home}`);
	// No --model/--thinking: pi restores the transcript's latest
	// model_change and thinking_level_change.
	const p = plan({ agentHome: entry.home, userArgs: ["--session", entry.transcript], resume: true });
	const pi = resolvePiBin();
	const cwd = entry.cwd && existsSync(entry.cwd) ? entry.cwd : entry.home;
	return reserveName(
		(state) => (state.held.has(entry.name) ? drawName({ agent: entry.agent, held: state.held, recent: state.recent }) : entry.name),
		(name) => {
			const r = tmux(["new-session", "-d", "-s", name, "-c", cwd, ...tmuxEnv(baseEnv(entry.home, p.piDir, name)), pi, ...p.args]);
			if (!r.ok) throw new Error(`tmux new-session failed for ${name}: ${r.stderr.trim()}`);
			return name;
		},
		{ root, excludeUuid: entry.uuid },
	);
}
