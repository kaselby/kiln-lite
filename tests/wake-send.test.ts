import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { send } from "../src/client/send.ts";
import { writeEntry } from "../src/sessions/registry.ts";

// npm test runs from the repo root.
const REPO = resolve(".");
const UUID = "01a10d7c-d216-74b9-910c-aea077fe8fd5";

/**
 * A stopped session of `rev` and a fake pi that counts its starts, writes
 * the session's lease (so it is live) and stays up until tmux is killed.
 */
function setup() {
	const root = mkdtempSync(join(tmpdir(), "kl-wake-"));
	process.env.KL_ROOT = root;
	const sock = `kl-test-wake-${process.pid}`;
	process.env.KL_TMUX_SOCKET = sock;
	const home = join(root, "agents", "rev");
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "agent.yml"), "name: rev\n");

	const piMain = join(root, "fake-pi.ts");
	writeFileSync(
		piMain,
		`import { selfLease, writeLease } from ${JSON.stringify(join(REPO, "src/sessions/lease.ts"))};\n` +
			`writeLease(selfLease(${JSON.stringify(UUID)}, process.env.KL_NAME!, process.env.KL_NAME!), process.env.KL_ROOT);\n` +
			`setTimeout(() => {}, 30000);\n`,
	);
	const fakePi = join(root, "fake-pi");
	writeFileSync(fakePi, `#!/bin/sh\necho start >> "${join(root, "pi-starts")}"\ncd "${REPO}" && exec node --import tsx "${piMain}"\n`);
	chmodSync(fakePi, 0o755);
	process.env.KL_PI = fakePi;

	const transcript = join(root, "t.jsonl");
	writeFileSync(transcript, "");
	const bound = "2026-10-01T00:00:00Z";
	writeEntry({ uuid: UUID, agent: "rev", name: "rev-calm-fox", names: [{ name: "rev-calm-fox", bound }], home, transcript, cwd: root, created: bound }, root);

	const cleanup = () => {
		spawnSync("tmux", ["-L", sock, "kill-server"]);
		rmSync(root, { recursive: true, force: true });
	};
	return { root, cleanup };
}

/** A daemon client whose DMs to rev-calm-fox are parked (the session is stopped). */
function parkingClient() {
	const calls = { sendDirect: 0, publish: 0 };
	const client = {
		sendDirect: async () => {
			calls.sendDirect++;
			return { message: "parked", session: UUID, name: "rev-calm-fox", live: false };
		},
		publish: async () => (calls.publish++, 0),
	};
	return { client: client as never, calls };
}

test("two concurrent waking sends to a stopped session start pi once", async (t) => {
	const { root, cleanup } = setup();
	t.after(cleanup);
	const { client, calls } = parkingClient();
	const opts = { wake: true, root, wakeTimeoutMs: 15000 };
	const [a, b] = await Promise.all([send(client, "rev-calm-fox", "s", "b", opts), send(client, "rev-calm-fox", "s", "b", opts)]);
	assert.equal(calls.sendDirect, 2, "both messages were sent");
	assert.ok(a.ok && b.ok);
	const starts = existsSync(join(root, "pi-starts")) ? readFileSync(join(root, "pi-starts"), "utf8").trim().split("\n") : [];
	assert.equal(starts.length, 1);
});

test("a send without wake to a stopped session starts nothing", async (t) => {
	const { root, cleanup } = setup();
	t.after(cleanup);
	const { client } = parkingClient();
	const r = await send(client, "rev-calm-fox", "s", "b", { root });
	assert.ok(r.ok);
	await new Promise((r) => setTimeout(r, 300));
	assert.ok(!existsSync(join(root, "pi-starts")));
});

test("wake on a channel send is an error and nothing is published", async (t) => {
	const { root, cleanup } = setup();
	t.after(cleanup);
	const { client, calls } = parkingClient();
	await assert.rejects(send(client, "#dev", "s", "b", { wake: true, root }));
	assert.equal(calls.publish, 0);
});
