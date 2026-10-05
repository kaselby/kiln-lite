import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { launchNew, preLaunchHookPath } from "../src/sessions/launch.ts";
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
