import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleDeliverSelf, handleSendDirect } from "../src/daemon/handlers.ts";
import { DaemonState, type SessionRecord } from "../src/daemon/state.ts";
import * as proto from "../src/daemon/protocol.ts";
import { selfLease, writeLease } from "../src/sessions/lease.ts";
import { writeEntry, type RegistryEntry } from "../src/sessions/registry.ts";

interface StubDaemon {
	state: DaemonState;
	config: { channelsDir: string; klRoot: string };
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

function registerOffline(session: string): void {
	daemon.state.knownSessions.upsert(record(session));
}

function requester(session: string) {
	return { agent: session.split("-")[0], session, inbox_path: inboxRootFor(session) };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kl-dm-"));
	const state = new DaemonState(join(dir, "daemon"));
	daemon = {
		state,
		config: { channelsDir: join(dir, "daemon", "channels"), klRoot: dir },
		cancelShutdown: () => {},
		maybeScheduleShutdown: () => {},
	};
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const UA = "0aaa0d7c-d216-74b9-910c-aea077fe8fd5";
const UB = "0bbb0d7c-d216-74b9-910c-aea077fe8fd5";
const UC = "0ccc0d7c-d216-74b9-910c-aea077fe8fd5";

function regEntry(uuid: string, name: string, bound: string): RegistryEntry {
	return {
		uuid,
		agent: "rev",
		name,
		names: [{ name, bound }],
		home: "/h/rev",
		transcript: join(dir, `${uuid}.jsonl`),
		cwd: "/w",
		created: bound,
		wake: "park",
		launch: {},
	};
}

function sendByName(to: string): proto.Message {
	return proto.sendDirect(to, "hi", "body", "normal", {
		agent: "rev",
		session: UA,
		name: "rev-calm-fox",
		inbox_path: join(dir, "run", "inbox"),
	});
}

function inboxFiles(uuid: string): string[] {
	const d = join(dir, "run", "inbox", uuid);
	return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : [];
}

describe("handleSendDirect: name resolution, parking", () => {
	it("delivers to a live session by name, from: is the sender's name", async () => {
		writeEntry(regEntry(UA, "rev-calm-fox", "2026-10-05T09:00:00Z"), dir);
		writeEntry(regEntry(UB, "rev-red-owl", "2026-10-05T10:00:00Z"), dir);
		writeLease(selfLease(UB, "rev-red-owl", "rev-red-owl"), dir);
		const res = await handleSendDirect(sendByName("rev-red-owl"), daemon as never);
		assert.equal(res.type, proto.ACK);
		assert.equal(res.data.message, "sent to rev-red-owl");
		const files = inboxFiles(UB);
		assert.equal(files.length, 1);
		const text = readFileSync(join(dir, "run", "inbox", UB, files[0]), "utf8");
		assert.match(text, /^from: rev-calm-fox$/m);
		assert.match(text, new RegExp(`^from_session: ${UA}$`, "m"));
		assert.match(text, /^to: rev-red-owl$/m);
	});

	it("a sender that is no registered session (kl-msg by a human) gets no from_session", async () => {
		writeEntry(regEntry(UB, "rev-red-owl", "2026-10-05T10:00:00Z"), dir);
		const msg = proto.sendDirect("rev-red-owl", "hi", "body", "normal", { agent: "human", session: "human-sam", name: "sam" });
		const res = await handleSendDirect(msg, daemon as never);
		assert.equal(res.type, proto.ACK);
		const text = readFileSync(join(dir, "run", "inbox", UB, inboxFiles(UB)[0]), "utf8");
		assert.match(text, /^from: sam$/m);
		assert.doesNotMatch(text, /^from_session:/m);
		assert.equal(daemon.state.presence.get("human-sam"), undefined, "no presence for a human sender");
	});

	it("parks for a registered session with no live lease, and says how to wake it", async () => {
		writeEntry(regEntry(UB, "rev-red-owl", "2026-10-05T10:00:00Z"), dir);
		writeFileSync(join(dir, `${UB}.jsonl`), "{}\n");
		const res = await handleSendDirect(sendByName("rev-red-owl"), daemon as never);
		assert.equal(res.type, proto.ACK);
		assert.match(
			String(res.data.message),
			/^parked: rev-red-owl is not running \(last seen \d{4}-\d\d-\d\d \d\d:\d\d\); kl resume rev-red-owl to wake$/,
		);
		assert.equal(inboxFiles(UB).length, 1, "parked mail is written");
	});

	it("errors loudly for an unknown name and writes nothing", async () => {
		const res = await handleSendDirect(sendByName("ghost-x-9"), daemon as never);
		assert.equal(res.type, proto.ERROR);
		assert.equal(res.data.code, "unknown_recipient");
		assert.match(String(res.data.message), /unknown session 'ghost-x-9'/);
		assert.ok(!existsSync(join(dir, "run", "inbox")));
	});

	it("a reused name goes to the most recent binding with a note; name@prefix reaches the other", async () => {
		writeEntry(regEntry(UB, "rev-red-owl", "2026-10-01T10:00:00Z"), dir);
		writeEntry(regEntry(UC, "rev-red-owl", "2026-10-05T10:00:00Z"), dir);
		const res = await handleSendDirect(sendByName("rev-red-owl"), daemon as never);
		assert.equal(res.data.session, UC);
		assert.match(String(res.data.message), /most recent of 2 sessions named rev-red-owl/);
		assert.equal(inboxFiles(UC).length, 1);
		const res2 = await handleSendDirect(sendByName("rev-red-owl@0bbb"), daemon as never);
		assert.equal(res2.data.session, UB);
		assert.equal(inboxFiles(UB).length, 1);
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
		assert.doesNotMatch(readFileSync(join(inbox, files[0]), "utf8"), /^from_session:/m, "a self-wake is not agent mail");
	});

	it("headers carry the session name, not the uuid (uuid in from_session)", async () => {
		const msg = proto.deliverSelf("Scheduled wake", "body", "normal", {
			agent: "rev",
			session: UA,
			name: "rev-calm-fox",
			inbox_path: join(dir, "run", "inbox"),
		});
		assert.equal((await handleDeliverSelf(msg, daemon as never)).type, proto.ACK);
		const files = inboxFiles(UA);
		assert.equal(files.length, 1);
		const text = readFileSync(join(dir, "run", "inbox", UA, files[0]), "utf8");
		assert.match(text, /^from: rev-calm-fox$/m);
		assert.match(text, new RegExp(`^from_session: ${UA}$`, "m"));
		assert.match(text, /^to: rev-calm-fox$/m);
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
