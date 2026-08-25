import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleDeliverSelf, handleSendDirect } from "../src/daemon/handlers.ts";
import { DaemonState, type SessionRecord } from "../src/daemon/state.ts";
import * as proto from "../src/daemon/protocol.ts";

interface StubDaemon {
	state: DaemonState;
	config: { channelsDir: string };
	cancelShutdown: () => void;
	maybeScheduleShutdown: () => void;
}

let dir: string;
let daemon: StubDaemon;

// Each session gets its OWN inbox root (multi-home shape), so a misdelivery
// into the sender's tree is observable.
function inboxRootFor(session: string): string {
	return join(dir, "homes", session, "inbox");
}

function record(session: string): SessionRecord {
	const now = new Date().toISOString();
	return {
		session_id: session,
		agent_name: session.split("-")[0],
		inbox_path: inboxRootFor(session),
		pid: 0,
		first_seen_at: now,
		last_seen_at: now,
		status: "running",
	};
}

// Live: in presence + known. Offline: known only (registered before, gone).
function registerLive(session: string): void {
	const rec = record(session);
	daemon.state.presence.register(rec);
	daemon.state.knownSessions.upsert(rec);
}
function registerOffline(session: string): void {
	daemon.state.knownSessions.upsert(record(session));
}

function requester(session: string) {
	return { agent: session.split("-")[0], session, inbox_path: inboxRootFor(session) };
}

function dmMsg(to: string, from: string): proto.Message {
	return proto.sendDirect(to, `from ${from}`, "body", "normal", requester(from));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kl-dm-"));
	const state = new DaemonState(join(dir, "daemon"));
	daemon = {
		state,
		config: { channelsDir: join(dir, "daemon", "channels") },
		cancelShutdown: () => {},
		maybeScheduleShutdown: () => {},
	};
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("handleSendDirect — live-only delivery", () => {
	it("delivers to a live recipient's own inbox", async () => {
		registerLive("a-x-1");
		registerLive("b-x-2");
		const res = await handleSendDirect(dmMsg("b-x-2", "a-x-1"), daemon as never);
		assert.equal(res.type, proto.ACK);
		// Landed in b's inbox under b's recipient subdir — not a's tree.
		const bInbox = join(inboxRootFor("b-x-2"), "b-x-2");
		assert.ok(existsSync(bInbox), "message should land in b's inbox");
		assert.equal(readdirSync(bInbox).filter((f) => f.endsWith(".md")).length, 1);
		assert.ok(!existsSync(inboxRootFor("a-x-1")), "nothing should land in sender's tree");
	});

	it("fails for a known-but-offline recipient (no parked write)", async () => {
		registerLive("a-x-1");
		registerOffline("b-x-2");
		const res = await handleSendDirect(dmMsg("b-x-2", "a-x-1"), daemon as never);
		assert.equal(res.type, proto.ERROR);
		assert.equal(res.data.code, "recipient_not_live");
		// No write anywhere — not into b's inbox, not into the sender's tree.
		assert.ok(!existsSync(inboxRootFor("b-x-2")), "no parked write for offline recipient");
		assert.ok(!existsSync(inboxRootFor("a-x-1")), "no misdelivery into sender's tree");
	});

	it("fails for an unknown recipient instead of writing into the sender's inbox", async () => {
		registerLive("a-x-1");
		const res = await handleSendDirect(dmMsg("ghost-x-9", "a-x-1"), daemon as never);
		assert.equal(res.type, proto.ERROR);
		assert.equal(res.data.code, "recipient_not_live");
		// The old fallback wrote <sender_inbox>/<recipient>/… — assert it didn't.
		assert.ok(!existsSync(inboxRootFor("a-x-1")), "no black-hole write into sender's tree");
	});
});

describe("handleDeliverSelf — detached self-delivery", () => {
	it("writes to the requester's own inbox without creating presence", async () => {
		const from = "a-x-1";
		const msg = proto.deliverSelf("Scheduled wake", "check the build", "normal", requester(from));
		const res = await handleDeliverSelf(msg, daemon as never);

		assert.equal(res.type, proto.ACK);
		assert.equal(daemon.state.presence.get(from), undefined, "detached delivery must not register presence");
		const inbox = join(inboxRootFor(from), from);
		const files = readdirSync(inbox).filter((f) => f.endsWith(".md"));
		assert.equal(files.length, 1);
	});

	it("rejects a requester without an inbox path", async () => {
		const msg = proto.deliverSelf("Scheduled wake", "body", "normal", {
			agent: "a",
			session: "a-x-1",
		});
		const res = await handleDeliverSelf(msg, daemon as never);
		assert.equal(res.type, proto.ERROR);
		assert.ok(!existsSync(inboxRootFor("a-x-1")));
	});

	it("rejects unsafe session IDs and paths that conflict with known state", async () => {
		const unsafe = proto.deliverSelf("Scheduled wake", "body", "normal", {
			agent: "a",
			session: "../../escape",
			inbox_path: join(dir, "inbox"),
		});
		assert.equal((await handleDeliverSelf(unsafe, daemon as never)).type, proto.ERROR);

		registerOffline("a-x-1");
		const conflicting = proto.deliverSelf("Scheduled wake", "body", "normal", {
			agent: "a",
			session: "a-x-1",
			inbox_path: join(dir, "different-home", "inbox"),
		});
		assert.equal((await handleDeliverSelf(conflicting, daemon as never)).type, proto.ERROR);
		assert.ok(!existsSync(join(dir, "different-home")));
	});
});
