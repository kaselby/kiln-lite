/**
 * The daemon socket lives under the kl root, so two kl roots get two daemons;
 * a root whose socket path is too long falls back to /tmp/kiln-lite-<hash>.sock.
 * Every daemon here runs in a child process under a temp KL_ROOT and HOME.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { DaemonClient } from "../src/client/index.ts";
import { socketPath } from "../src/sessions/paths.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];

after(async () => {
	for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
	await delay(200);
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempRoot(suffix = ""): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "kl-sock-")));
	dirs.push(d);
	return suffix ? join(d, suffix) : d;
}

/** Start a daemon for `root` (no --socket: it picks its own path) and wait for its socket. */
async function startDaemon(root: string): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["--import", "tsx", join(repo, "src/daemon/index.ts")], {
		cwd: repo,
		env: { ...process.env, KL_ROOT: root, HOME: root },
		stdio: "ignore",
	});
	children.push(child);
	const sock = socketPath(root);
	for (let i = 0; i < 100 && !existsSync(sock); i++) await delay(50);
	assert.ok(existsSync(sock), `daemon socket never appeared at ${sock}`);
	return child;
}

async function statusVia(root: string): Promise<Record<string, unknown>> {
	const prev = process.env.KL_ROOT;
	process.env.KL_ROOT = root;
	try {
		const c = new DaemonClient({ requester: { agent: "human", session: "status" }, autostart: false });
		return await c.getStatus();
	} finally {
		if (prev === undefined) delete process.env.KL_ROOT;
		else process.env.KL_ROOT = prev;
	}
}

test("each kl root gets its own daemon at <root>/daemon/kiln-lite.sock", async () => {
	const a = tempRoot();
	const b = tempRoot();
	assert.equal(socketPath(a), join(a, "daemon", "kiln-lite.sock"));
	await startDaemon(a);
	await startDaemon(b);
	const sa = await statusVia(a);
	const sb = await statusVia(b);
	assert.equal(sa.socket_path, join(a, "daemon", "kiln-lite.sock"));
	assert.equal(sb.socket_path, join(b, "daemon", "kiln-lite.sock"));
	assert.notEqual(sa.pid, sb.pid);
});

test("a kl root too long for a socket path falls back to /tmp/kiln-lite-<hash>.sock", async () => {
	const long = tempRoot("x".repeat(120));
	const other = tempRoot("y".repeat(120));
	const sock = socketPath(long);
	assert.match(sock, /^\/tmp\/kiln-lite-[0-9a-f]{12}\.sock$/);
	assert.equal(socketPath(long), sock, "stable for the same root");
	assert.notEqual(socketPath(other), sock, "different roots, different sockets");
	await startDaemon(long);
	const s = await statusVia(long);
	assert.equal(s.socket_path, sock);
});
