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
