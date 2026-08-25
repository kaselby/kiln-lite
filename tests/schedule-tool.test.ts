import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("../tools/schedule", import.meta.url));
const homes: TestHome[] = [];

interface TestHome {
	root: string;
	home: string;
	deliveries: string;
	env: NodeJS.ProcessEnv;
}

function makeHome(): TestHome {
	const root = mkdtempSync(join(tmpdir(), "kl-schedule-test-"));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const deliveries = join(root, "deliveries");
	spawnSync("mkdir", ["-p", home, bin, deliveries]);

	const mock = join(bin, "kl-msg");
	writeFileSync(
		mock,
		`#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  deliver-self)
    if [ "\${MOCK_LEGACY:-0}" != 0 ]; then
      echo "kl-msg: unknown subcommand: deliver-self" >&2
      exit 2
    fi
    ;;
  send) ;;
  *) echo "unexpected command: $*" >&2; exit 2 ;;
esac
out="$MOCK_DELIVERIES/delivery-$$-$(date +%s)"
printf '%s\\n' "$*" > "$out"
cat >> "$out"
`,
	);
	chmodSync(mock, 0o755);

	const result: TestHome = {
		root,
		home,
		deliveries,
		env: {
			...process.env,
			AGENT_HOME: home,
			AGENT_ID: "test-bright-fox",
			AGENT_NAME: "test",
			MOCK_DELIVERIES: deliveries,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
		},
	};
	homes.push(result);
	return result;
}

function run(ctx: TestHome, args: string[], input?: string) {
	return spawnSync(tool, args, {
		env: ctx.env,
		encoding: "utf8",
		input,
		timeout: 5_000,
	});
}

function wakeId(stdout: string): string {
	const match = stdout.match(/Wake (wake-[0-9]+-[0-9a-f]{8})/);
	assert.ok(match, `missing wake id in output: ${stdout}`);
	return match[1];
}

async function waitForDelivery(ctx: TestHome, timeoutMs = 5_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const files = readdirSync(ctx.deliveries);
		if (files.length > 0) return readFileSync(join(ctx.deliveries, files[0]), "utf8");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("timed out waiting for scheduled delivery");
}

afterEach(() => {
	for (const ctx of homes.splice(0)) {
		const stateDir = join(ctx.home, "state", "scheduled", "test-bright-fox");
		if (existsSync(stateDir)) {
			for (const name of readdirSync(stateDir)) {
				if (!name.endsWith(".record")) continue;
				run(ctx, ["cancel", name.slice(0, -".record".length)]);
			}
		}
		rmSync(ctx.root, { recursive: true, force: true });
	}
});

test("at wake delivers stdin note through daemon self-delivery and cleans state", async () => {
	const ctx = makeHome();
	const scheduled = run(ctx, ["at", "--delay", "1s"], "Check the build.\nInspect /tmp/build.log.\n");
	assert.equal(scheduled.status, 0, scheduled.stderr);
	const id = wakeId(scheduled.stdout);

	const listed = run(ctx, ["list"]);
	assert.equal(listed.status, 0, listed.stderr);
	assert.match(listed.stdout, new RegExp(id));
	assert.match(listed.stdout, /watcher alive/);

	const delivery = await waitForDelivery(ctx);
	assert.match(delivery, /^deliver-self Scheduled wake --body-stdin\n/);
	assert.match(delivery, /Check the build\.\nInspect \/tmp\/build\.log\./);

	const after = run(ctx, ["list"]);
	assert.equal(after.stdout.trim(), "No pending wakes.");
});

test("legacy kl-msg falls back to an ordinary self-DM during rolling upgrade", async () => {
	const ctx = makeHome();
	ctx.env.MOCK_LEGACY = "1";
	const scheduled = run(ctx, ["at", "--delay", "1s", "--note", "Legacy wake"]);
	assert.equal(scheduled.status, 0, scheduled.stderr);

	const delivery = await waitForDelivery(ctx);
	assert.match(delivery, /^send test-bright-fox Scheduled wake --body-stdin\n/);
	assert.match(delivery, /Legacy wake/);
});

test("watch fires after its PID exits", async () => {
	const ctx = makeHome();
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], {
		stdio: "ignore",
	});
	assert.ok(child.pid);

	const scheduled = run(ctx, ["watch", "--pid", String(child.pid), "--note", "Process finished"]);
	assert.equal(scheduled.status, 0, scheduled.stderr);

	const delivery = await waitForDelivery(ctx);
	assert.match(delivery, new RegExp(`^deliver-self Watched process ${child.pid} exited --body-stdin\\n`));
	assert.match(delivery, /Process finished/);
});

test("cancel removes an armed wake and invalid inputs are rejected", () => {
	const ctx = makeHome();
	const scheduled = run(ctx, ["at", "--delay", "30s", "--note", "Do not fire"]);
	assert.equal(scheduled.status, 0, scheduled.stderr);
	const id = wakeId(scheduled.stdout);

	const cancelled = run(ctx, ["cancel", id]);
	assert.equal(cancelled.status, 0, cancelled.stderr);
	assert.match(cancelled.stdout, /cancelled/);
	assert.equal(run(ctx, ["list"]).stdout.trim(), "No pending wakes.");

	const badPid = run(ctx, ["watch", "--pid", "-1"]);
	assert.notEqual(badPid.status, 0);
	assert.match(badPid.stderr, /positive integer/);

	const conflicting = run(ctx, ["at", "--delay", "1m", "--time", "2030-01-01T00:00:00Z"]);
	assert.notEqual(conflicting.status, 0);
	assert.match(conflicting.stderr, /either --delay or --time/);

	const traversal = run(ctx, ["cancel", "../../victim"]);
	assert.notEqual(traversal.status, 0);
	assert.match(traversal.stderr, /invalid wake ID/);
});
