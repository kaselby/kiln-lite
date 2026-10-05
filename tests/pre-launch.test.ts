import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { launchNew, preLaunchHookPath, wake } from "../src/sessions/launch.ts";
import { writeEntry } from "../src/sessions/registry.ts";
import { sleepMs } from "../src/sessions/fsutil.ts";

function setup(hookBody: string | null) {
	const root = mkdtempSync(join(tmpdir(), "kl-prelaunch-"));
	process.env.KL_ROOT = root;
	const sock = `kl-test-prelaunch-${process.pid}`;
	process.env.KL_TMUX_SOCKET = sock;
	const home = join(root, "agents", "rev");
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "agent.yml"), "name: rev\n");
	// Fake pi: record that it ran, then exit (tmux session ends with it).
	const fakePi = join(root, "fake-pi");
	writeFileSync(fakePi, `#!/bin/sh\necho "$KL_NAME" > "${join(root, "pi-ran")}"\n`);
	chmodSync(fakePi, 0o755);
	process.env.KL_PI = fakePi;
	if (hookBody !== null) {
		const hook = preLaunchHookPath(home);
		mkdirSync(join(home, "hooks"), { recursive: true });
		writeFileSync(hook, `#!/bin/sh\n${hookBody}\n`);
		chmodSync(hook, 0o755);
	}
	const cleanup = () => spawnSync("tmux", ["-L", sock, "kill-server"]);
	return { root, home, cleanup };
}

function waitFor(path: string): boolean {
	for (let i = 0; i < 50 && !existsSync(path); i++) sleepMs(100);
	return existsSync(path);
}

test("launchNew runs <home>/hooks/pre-launch after the name is drawn, with AGENT_NAME/KL_NAME/AGENT_HOME", (t) => {
	const { root, home, cleanup } = setup(`echo "$AGENT_NAME|$KL_NAME|$AGENT_HOME" > "$AGENT_HOME/../../hook-env"`);
	t.after(cleanup);
	const name = launchNew({ home, piArgs: [], cwd: root });
	assert.equal(readFileSync(join(root, "hook-env"), "utf8").trim(), `rev|${name}|${home}`);
	assert.ok(waitFor(join(root, "pi-ran")), "pi started after the hook");
	assert.equal(readFileSync(join(root, "pi-ran"), "utf8").trim(), name);
});

test("a failing pre-launch hook rejects the launch with its output; pi never starts", (t) => {
	const { root, home, cleanup } = setup(`echo "no launches today" >&2; exit 3`);
	t.after(cleanup);
	assert.throws(() => launchNew({ home, piArgs: [], cwd: root }), /pre-launch hook rejected the launch \(exit 3\): no launches today/);
	sleepMs(300);
	assert.equal(existsSync(join(root, "pi-ran")), false);
});

test("no hook: launch proceeds", (t) => {
	const { root, home, cleanup } = setup(null);
	t.after(cleanup);
	launchNew({ home, piArgs: [], cwd: root });
	assert.ok(waitFor(join(root, "pi-ran")));
});

/** A registry entry for a stopped session of `rev`, with a transcript on disk. */
function stoppedSession(root: string, home: string): string {
	const uuid = "01a10d7c-d216-74b9-910c-aea077fe8fd5";
	const transcript = join(root, "t.jsonl");
	writeFileSync(transcript, "");
	const bound = "2026-10-01T00:00:00Z";
	writeEntry(
		{ uuid, agent: "rev", name: "rev-calm-fox", names: [{ name: "rev-calm-fox", bound }], home, transcript, cwd: root, created: bound, wake: "park", launch: {} },
		root,
	);
	return uuid;
}

test("wake (resume/attach) runs the pre-launch hook too, with the same env", (t) => {
	const { root, home, cleanup } = setup(`echo "$AGENT_NAME|$KL_NAME|$AGENT_HOME" > "$AGENT_HOME/../../hook-env"`);
	t.after(cleanup);
	const uuid = stoppedSession(root, home);
	// The fake pi writes no lease, so wake times out after starting it.
	assert.throws(() => wake(uuid, { root, timeoutMs: 300 }), /wrote no lease/);
	assert.equal(readFileSync(join(root, "hook-env"), "utf8").trim(), `rev|rev-calm-fox|${home}`);
	assert.ok(waitFor(join(root, "pi-ran")), "pi started after the hook");
});

test("a failing pre-launch hook rejects a wake; pi never starts", (t) => {
	const { root, home, cleanup } = setup(`echo "not now" >&2; exit 4`);
	t.after(cleanup);
	const uuid = stoppedSession(root, home);
	assert.throws(() => wake(uuid, { root, timeoutMs: 300 }), /pre-launch hook rejected the launch \(exit 4\): not now/);
	sleepMs(300);
	assert.equal(existsSync(join(root, "pi-ran")), false);
});
