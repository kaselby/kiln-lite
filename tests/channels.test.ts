import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleDeregister, handlePublish, handleRegister, handleSubscribe, handleUnsubscribe } from "../src/daemon/handlers.ts";
import { DaemonState } from "../src/daemon/state.ts";
import { reconcile } from "../src/daemon/reconcile.ts";
import * as proto from "../src/daemon/protocol.ts";
import { sendChannel } from "../src/client/send.ts";
import { inboxDir } from "../src/sessions/paths.ts";
import { selfLease, writeLease } from "../src/sessions/lease.ts";
import { writeEntry } from "../src/sessions/registry.ts";

let dir: string;
let daemon: {
	state: DaemonState;
	config: { channelsDir: string; klRoot: string };
	cancelShutdown: () => void;
	maybeScheduleShutdown: () => void;
};

const UB = "0bbb0d7c-d216-74b9-910c-aea077fe8fd5";
const SAM: proto.Requester = { agent: "human", session: "human-sam", name: "sam" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kl-chan-"));
	daemon = {
		state: new DaemonState(join(dir, "daemon")),
		config: { channelsDir: join(dir, "daemon", "channels"), klRoot: dir },
		cancelShutdown: () => {},
		maybeScheduleShutdown: () => {},
	};
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A kl session with a registry entry, registered with the daemon as running. */
async function runningSession(uuid: string): Promise<proto.Requester> {
	const bound = "2026-10-05T10:00:00Z";
	writeEntry(
		{ uuid, agent: "rev", name: "rev-red-owl", names: [{ name: "rev-red-owl", bound }], home: "/h/rev", transcript: join(dir, `${uuid}.jsonl`), cwd: "/w", created: bound },
		dir,
	);
	const req: proto.Requester = { agent: "rev", session: uuid, name: "rev-red-owl", inbox_path: inboxDir(uuid, dir) };
	assert.equal((await handleRegister(proto.register(req, { pid: process.pid }), daemon as never)).type, proto.ACK);
	return req;
}

function inboxCount(uuid: string): number {
	const d = inboxDir(uuid, dir);
	return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")).length : 0;
}

const subFile = (session: string) => join(dir, "daemon", "subscriptions", `${session}.json`);
const publish = (channel: string) => handlePublish(proto.publish(channel, "hi", "body", SAM), daemon as never);

describe("subscriptions outlive the session", () => {
	it("a stopped subscriber keeps its subscription and gets channel mail parked; unsubscribe ends it", async () => {
		const b = await runningSession(UB);
		await handleSubscribe(proto.subscribe("dev", b), daemon as never);
		await handleDeregister(proto.deregister(b), daemon as never);

		assert.equal(daemon.state.presence.get(UB), undefined, "not running");
		assert.ok(existsSync(subFile(UB)), "subscription file kept");
		const restarted = new DaemonState(join(dir, "daemon"));
		restarted.loadFromFiles();
		assert.ok(restarted.channels.subscribers("dev").has(UB), "a restarted daemon still has the subscription");

		await publish("dev");
		assert.equal(inboxCount(UB), 1, "copy parked in the stopped session's inbox");

		await handleUnsubscribe(proto.unsubscribe("dev", b), daemon as never);
		assert.ok(!existsSync(subFile(UB)), "unsubscribe removes the file");
		await publish("dev");
		assert.equal(inboxCount(UB), 1, "no copy after unsubscribe");
	});

	it("reconcile dropping a dead session's presence keeps its subscription", async () => {
		const b = await runningSession(UB);
		await handleSubscribe(proto.subscribe("dev", b), daemon as never);
		daemon.state.presence.get(UB)!.pid = 0; // no pid, and no lease
		reconcile(daemon.state, dir);
		assert.equal(daemon.state.presence.get(UB), undefined);
		assert.ok(daemon.state.channels.subscribers("dev").has(UB));
		await publish("dev");
		assert.equal(inboxCount(UB), 1);
	});
});

describe("channel names", () => {
	it("'#dev' and 'dev' are the same channel", async () => {
		const b = await runningSession(UB);
		await handleSubscribe(proto.subscribe("#dev", b), daemon as never);
		await publish("dev");
		await publish("#dev");
		assert.equal(inboxCount(UB), 2);
		assert.deepEqual(readdirSync(daemon.config.channelsDir), ["dev"]);
	});

	it("'../x' is rejected by subscribe and publish, and nothing is written outside channels/", async () => {
		const b = await runningSession(UB);
		for (const bad of ["../x", "#../x", "a/b", ".hidden", ""]) {
			assert.equal((await handleSubscribe(proto.subscribe(bad, b), daemon as never)).type, proto.ERROR, `subscribe ${bad}`);
			assert.equal((await publish(bad)).type, proto.ERROR, `publish ${bad}`);
		}
		assert.ok(!existsSync(join(dir, "daemon", "x")));
		assert.ok(!existsSync(join(dir, "x")));
		assert.ok(!existsSync(daemon.config.channelsDir) || readdirSync(daemon.config.channelsDir).length === 0);
		assert.ok(!existsSync(subFile(UB)));
	});

	it("the client rejects a bad channel before calling the daemon", async () => {
		let calls = 0;
		const client = { publish: async () => (calls++, 0) };
		await assert.rejects(sendChannel(client as never, "#../x", "s", "b"));
		assert.equal(calls, 0);
	});
});

describe("reconcile: presence with no pid", () => {
	it("drops a pid-0 record with no live lease", () => {
		daemon.state.presence.register({
			session_id: UB, agent_name: "rev", inbox_path: inboxDir(UB, dir), pid: 0,
			first_seen_at: "", last_seen_at: "", status: "unknown",
		});
		reconcile(daemon.state, dir);
		assert.equal(daemon.state.presence.get(UB), undefined);
	});

	it("keeps a pid-0 record whose session has a live lease, and takes the lease's pid", () => {
		writeLease(selfLease(UB, "rev-red-owl", "rev-red-owl"), dir);
		daemon.state.presence.register({
			session_id: UB, agent_name: "rev", inbox_path: inboxDir(UB, dir), pid: 0,
			first_seen_at: "", last_seen_at: "", status: "unknown",
		});
		reconcile(daemon.state, dir);
		assert.equal(daemon.state.presence.get(UB)?.pid, process.pid);
	});
});
