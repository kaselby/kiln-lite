/**
 * tmux helpers. Exact-match targets only (`-t =name`): plain `-t name`
 * prefix-matches (spike finding). $KL_TMUX_SOCKET selects a private server
 * (`tmux -L <socket>`), used for isolated test runs.
 */

import { execFileSync, spawnSync } from "node:child_process";

export function tmuxBaseArgs(): string[] {
	const sock = process.env.KL_TMUX_SOCKET?.trim();
	return sock ? ["-L", sock] : [];
}

export function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const r = spawnSync("tmux", [...tmuxBaseArgs(), ...args], { encoding: "utf8" });
	return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
}

export function tmuxSessionNames(): string[] {
	try {
		const out = execFileSync("tmux", [...tmuxBaseArgs(), "list-sessions", "-F", "#{session_name}"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.split("\n").filter(Boolean);
	} catch {
		return []; // no server
	}
}

export function tmuxHasSession(name: string): boolean {
	return tmux(["has-session", "-t", `=${name}`]).ok;
}

/** Rename the tmux session this process runs in (via $TMUX_PANE). */
export function renameOwnTmuxSession(newName: string): { ok: boolean; from: string; error?: string } {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return { ok: false, from: "", error: "not in tmux" };
	// Our own server: $TMUX is "<socket path>,<pid>,<n>"; -S targets it exactly.
	const sock = process.env.TMUX.split(",")[0];
	const cur = spawnSync("tmux", ["-S", sock, "display-message", "-p", "-t", pane, "#{session_name}"], { encoding: "utf8" });
	const from = (cur.stdout ?? "").trim();
	if (!from) return { ok: false, from, error: cur.stderr || "could not read tmux session name" };
	if (from === newName) return { ok: true, from };
	const r = spawnSync("tmux", ["-S", sock, "rename-session", "-t", `=${from}`, newName], { encoding: "utf8" });
	return r.status === 0 ? { ok: true, from } : { ok: false, from, error: (r.stderr ?? "").trim() };
}

/** Name of the tmux session this process runs in, or "". */
export function ownTmuxSession(): string {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return "";
	const sock = process.env.TMUX.split(",")[0];
	const cur = spawnSync("tmux", ["-S", sock, "display-message", "-p", "-t", pane, "#{session_name}"], { encoding: "utf8" });
	return (cur.stdout ?? "").trim();
}

/**
 * Inside a kl session (SESSION_UUID set, inherited by everything an agent
 * runs) attaching would take over the agent's own terminal: force detach
 * and say so. A human's shell has no SESSION_UUID, so attaching still works.
 */
export function guardDetach(detach: boolean, env: NodeJS.ProcessEnv = process.env): { detach: boolean; note?: string } {
	if (detach || !env.SESSION_UUID) return { detach };
	return { detach: true, note: "inside a kl session (SESSION_UUID is set): acting as --detach; attach from your own terminal" };
}

/** How to attach to `name` by hand (honours $KL_TMUX_SOCKET). */
export function attachHint(name: string): string {
	return ["tmux", ...tmuxBaseArgs(), "attach", "-t", `=${name}`].join(" ");
}

type TmuxRun = (args: string[], inherit: boolean) => { status: number | null; stderr: string };

const runTmux: TmuxRun = (args, inherit) => {
	const r = spawnSync("tmux", [...tmuxBaseArgs(), ...args], {
		stdio: inherit ? "inherit" : ["inherit", "inherit", "pipe"],
		encoding: "utf8",
	});
	return { status: r.status, stderr: r.stderr ?? "" };
};

/**
 * Switch (inside tmux) or attach to an exact session name. Returns the exit code.
 * Inside tmux from a pane nobody is viewing (an agent's pane), switch-client
 * fails with "no current client": that isn't an error, the session is up, so
 * print its name and how to attach, and return 0.
 */
export function enter(name: string, opts: { inTmux?: boolean; run?: TmuxRun; out?: (s: string) => void } = {}): number {
	const inTmux = opts.inTmux ?? !!process.env.TMUX;
	const run = opts.run ?? runTmux;
	if (!inTmux) return run(["attach-session", "-t", `=${name}`], true).status ?? 1;
	const r = run(["switch-client", "-t", `=${name}`], false);
	if (r.status === 0) return 0;
	if (/no current client/i.test(r.stderr)) {
		(opts.out ?? ((s) => process.stdout.write(s)))(`${name}\n`);
		process.stderr.write(`kl: no tmux client to switch; attach with: ${attachHint(name)}\n`);
		return 0;
	}
	process.stderr.write(r.stderr);
	return r.status ?? 1;
}
