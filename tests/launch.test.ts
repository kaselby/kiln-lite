import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { launchNew, wake } from "../src/sessions/launch.ts";
import { writeEntry } from "../src/sessions/registry.ts";
import { sleepMs } from "../src/sessions/fsutil.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "kl-launch-"));
	process.env.KL_ROOT = root;
	const sock = `kl-test-launch-${process.pid}`;
	process.env.KL_TMUX_SOCKET = sock;
	const home = join(root, "agents", "rev");
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "agent.yml"), "name: rev\n");
	// Fake pi: record that it ran, then exit (tmux session ends with it).
	const fakePi = join(root, "fake-pi");
	writeFileSync(fakePi, `#!/bin/sh\necho "$KL_NAME" > "${join(root, "pi-ran")}"\n`);
	chmodSync(fakePi, 0o755);
	process.env.KL_PI = fakePi;
	const cleanup = () => spawnSync("tmux", ["-L", sock, "kill-server"]);
	return { root, home, cleanup };
}

function waitFor(path: string): boolean {
	for (let i = 0; i < 50 && !existsSync(path); i++) sleepMs(100);
	return existsSync(path);
}

test("launchNew starts pi in tmux under the drawn name", (t) => {
	const { root, home, cleanup } = setup();
	t.after(cleanup);
	const name = launchNew({ home, piArgs: [], cwd: root });
	assert.ok(waitFor(join(root, "pi-ran")));
	assert.equal(readFileSync(join(root, "pi-ran"), "utf8").trim(), name);
});

/** A registry entry for a stopped session of `rev`, with a transcript on disk. */
function stoppedSession(root: string, home: string): string {
	const uuid = "01a10d7c-d216-74b9-910c-aea077fe8fd5";
	const transcript = join(root, "t.jsonl");
	writeFileSync(transcript, "");
	const bound = "2026-10-01T00:00:00Z";
	writeEntry(
		{ uuid, agent: "rev", name: "rev-calm-fox", names: [{ name: "rev-calm-fox", bound }], home, transcript, cwd: root, created: bound },
		root,
	);
	return uuid;
}

test("wake (resume/attach) starts pi under the session's last name", async (t) => {
	const { root, home, cleanup } = setup();
	t.after(cleanup);
	const uuid = stoppedSession(root, home);
	// The fake pi writes no lease, so wake times out after starting it.
	await assert.rejects(wake(uuid, { root, timeoutMs: 300 }), /wrote no lease/);
	assert.ok(waitFor(join(root, "pi-ran")));
	assert.equal(readFileSync(join(root, "pi-ran"), "utf8").trim(), "rev-calm-fox");
});

test("wake on a session with no transcript: 'never started a conversation', pi never starts", async (t) => {
	const { root, home, cleanup } = setup();
	t.after(cleanup);
	const uuid = stoppedSession(root, home);
	rmSync(join(root, "t.jsonl"));
	await assert.rejects(wake(uuid, { root, timeoutMs: 300 }), /^Error: rev-calm-fox never started a conversation; nothing to resume$/);
	sleepMs(200);
	assert.ok(!existsSync(join(root, "pi-ran")));
});
