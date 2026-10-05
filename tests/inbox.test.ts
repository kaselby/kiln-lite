import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	AGENT_MESSAGE_DISCLAIMER,
	deliveredIdsFromEntries,
	isAgentMail,
	extractMessageIds,
	formatDrainBody,
	messageText,
	startInboxWatcher,
	type InboxWatcher,
} from "../extensions/kiln-lite/inbox.ts";
import { DaemonClient } from "../src/client/index.ts";

interface Rig {
	dir: string;
	sent: Array<{ body: string; options: unknown }>;
	warnings: string[];
	deferred: Array<() => void>;
	idle: { value: boolean };
	throwOnSend: { value: boolean };
	watcher: InboxWatcher;
	/** Write a message and deliver its watch event synchronously (no fs.watch). */
	arrive(id: string, body: string, fromSession?: string): void;
	marker(id: string): boolean;
	flush(): void;
}

const SELF = "0fff0d7c-d216-74b9-910c-aea077fe8fd5";
const PEER = "0eee0d7c-d216-74b9-910c-aea077fe8fd5";

function writeMsg(dir: string, id: string, body: string, fromSession = PEER): void {
	const fs = fromSession ? `from_session: ${fromSession}\n` : "";
	writeFileSync(join(dir, `${id}.md`), `---\nfrom: tester\n${fs}summary: "${body}"\n---\n\n${body}\n`);
}

function rig(
	ids: string[],
	opts: { transcriptEntries?: unknown[]; inFlightTimeoutMs?: number; idle?: boolean; preMarked?: string[] } = {},
): Rig {
	const dir = mkdtempSync(join(tmpdir(), "kl-inbox-test-"));
	for (const id of ids) writeMsg(dir, id, `body of ${id}`);
	for (const id of opts.preMarked ?? []) writeFileSync(join(dir, `${id}.read`), "");
	const sent: Rig["sent"] = [];
	const warnings: string[] = [];
	const deferred: Array<() => void> = [];
	const idle = { value: opts.idle ?? false };
	const throwOnSend = { value: false };
	const pi = {
		sendUserMessage(body: string, options: unknown) {
			if (throwOnSend.value) throw new Error("boom");
			sent.push({ body, options });
		},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	let onFile: ((f: string) => void) | null = null;
	const watcher = startInboxWatcher({
		inboxDir: dir,
		pi,
		selfSession: SELF,
		watch: (_d, cb) => {
			onFile = cb;
			return { close() {} };
		},
		isIdle: () => idle.value,
		warn: (m) => warnings.push(m),
		transcriptEntries: opts.transcriptEntries,
		inFlightTimeoutMs: opts.inFlightTimeoutMs,
		defer: (fn) => deferred.push(fn),
	});
	return {
		dir,
		sent,
		warnings,
		deferred,
		idle,
		throwOnSend,
		watcher,
		arrive(id, body, fromSession) {
			writeMsg(dir, id, body, fromSession);
			onFile!(`${id}.md`);
		},
		marker: (id) => existsSync(join(dir, `${id}.read`)),
		flush() {
			for (const fn of deferred.splice(0)) fn();
		},
	};
}

const userMsg = (text: string, asParts = false) => ({
	role: "user",
	content: asParts ? [{ type: "text", text }] : text,
});

test("three messages waiting at startup go out as ONE user turn, each with its id line", (t) => {
	const r = rig(["msg-a", "msg-b", "msg-c"]);
	t.after(() => r.watcher.stop());
	assert.equal(r.sent.length, 1);
	assert.deepEqual(extractMessageIds(r.sent[0].body).sort(), ["msg-a", "msg-b", "msg-c"]);
	assert.match(r.sent[0].body, /kl-msg-id: msg-a\n---\nfrom: tester/);
	assert.deepEqual(r.sent[0].options, { deliverAs: "followUp" });
});

test("nothing is marked at send time; markers appear only after the turn lands (deferred)", (t) => {
	const r = rig(["msg-a", "msg-b"]);
	t.after(() => r.watcher.stop());
	assert.equal(r.marker("msg-a"), false);
	assert.equal(r.marker("msg-b"), false);
	r.watcher.handleMessageEnd(userMsg(r.sent[0].body));
	// Marker write is deferred past Pi's own persistence of the message.
	assert.equal(r.marker("msg-a"), false);
	r.flush();
	assert.equal(r.marker("msg-a"), true);
	assert.equal(r.marker("msg-b"), true);
});

test("arrival while idle but a batch is in flight is deferred, then sent at the next drain", (t) => {
	const r = rig(["msg-a"], { idle: true });
	t.after(() => r.watcher.stop());
	assert.equal(r.sent.length, 1);
	r.arrive("msg-b", "late"); // idle → it tries to dispatch; must defer
	assert.equal(r.watcher.unreadCount(), 2, "msg-a in flight + msg-b queued");
	assert.equal(r.sent.length, 1, "no second sendUserMessage while in flight");
	r.watcher.handleMessageEnd(userMsg(r.sent[0].body));
	r.watcher.dispatchIdle(); // agent_end
	assert.equal(r.sent.length, 2);
	assert.deepEqual(extractMessageIds(r.sent[1].body), ["msg-b"]);
});

test("ids already in a transcript user message are not re-sent and their markers are healed", (t) => {
	const entries = [
		{ type: "session" },
		{ type: "message", message: userMsg(formatDrainBody([{ id: "msg-a", text: "x" }]), true) },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "kl-msg-id: msg-b" }] } },
	];
	const r = rig(["msg-a", "msg-b"], { transcriptEntries: entries });
	t.after(() => r.watcher.stop());
	assert.equal(r.marker("msg-a"), true, "marker healed from the transcript ledger");
	assert.equal(r.sent.length, 1);
	assert.deepEqual(extractMessageIds(r.sent[0].body), ["msg-b"], "assistant text is not a ledger");
});

test("a batch that never lands is re-sent after the timeout once the agent is idle", async (t) => {
	const r = rig(["msg-a", "msg-b"], { inFlightTimeoutMs: 30, idle: true });
	t.after(() => r.watcher.stop());
	assert.equal(r.sent.length, 1);
	await new Promise((res) => setTimeout(res, 80));
	assert.ok(r.sent.length >= 2, `expected a re-send, got ${r.sent.length}`);
	assert.deepEqual(extractMessageIds(r.sent[1].body), ["msg-a", "msg-b"]);
	assert.ok(r.warnings.some((w) => w.includes("did not land")));
});

test("a batch is not re-sent on timeout while the agent is busy (likely queued as followUp)", async (t) => {
	const r = rig(["msg-a"], { inFlightTimeoutMs: 20, idle: false });
	t.after(() => r.watcher.stop());
	await new Promise((res) => setTimeout(res, 70));
	assert.equal(r.sent.length, 1);
	r.watcher.handleMessageEnd(userMsg(r.sent[0].body));
	r.flush();
	assert.equal(r.marker("msg-a"), true);
});

test("a synchronous send failure keeps everything queued and unmarked", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "kl-inbox-test-"));
	writeMsg(dir, "msg-a", "a");
	let calls = 0;
	const pi = {
		sendUserMessage() {
			calls++;
			if (calls === 1) throw new Error("boom");
		},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	const w = startInboxWatcher({ inboxDir: dir, pi, isIdle: () => false, warn: () => {}, defer: (fn) => fn() });
	t.after(() => w.stop());
	assert.equal(existsSync(join(dir, "msg-a.read")), false);
	assert.equal(w.unreadCount(), 1);
	w.dispatchIdle();
	assert.equal(calls, 2);
});

test("pre-marked messages are skipped at startup", (t) => {
	const r = rig(["msg-a", "msg-b"], { preMarked: ["msg-a"] });
	t.after(() => r.watcher.stop());
	assert.deepEqual(extractMessageIds(r.sent[0].body), ["msg-b"]);
});

test("non-user message_end and user messages without ids are ignored", (t) => {
	const r = rig(["msg-a"]);
	t.after(() => r.watcher.stop());
	r.watcher.handleMessageEnd({ role: "toolResult", content: [{ type: "text", text: "kl-msg-id: msg-a" }] });
	r.watcher.handleMessageEnd(userMsg("hello"));
	r.flush();
	assert.equal(r.marker("msg-a"), false);
	assert.equal(r.watcher.unreadCount(), 1, "still in flight");
});

test("mid-turn ping path is unchanged: marks at ping time", (t) => {
	const r = rig([], { idle: false });
	t.after(() => r.watcher.stop());
	r.arrive("msg-m", "mid");
	assert.equal(r.sent.length, 0, "busy: queued, not sent");
	const s = r.watcher.midTurnSuffix();
	assert.match(s, /\[Notification \| AGENT MESSAGE from tester/);
	assert.ok(s.includes(AGENT_MESSAGE_DISCLAIMER), "mail from a peer session carries the disclaimer");
	assert.equal(r.marker("msg-m"), true);
});

test("disclaimer only for mail from another session: not for self-wakes or human sends", (t) => {
	const r = rig([], { idle: false });
	t.after(() => r.watcher.stop());
	r.arrive("msg-self", "wake", SELF);
	r.arrive("msg-human", "from sam", "");
	const s = r.watcher.midTurnSuffix();
	assert.match(s, /msg-self\.md/);
	assert.match(s, /msg-human\.md/);
	assert.ok(!s.includes(AGENT_MESSAGE_DISCLAIMER));

	const self = "---\nfrom: x\nfrom_session: S\n---\n\nb";
	const peer = "---\nfrom: y\nfrom_session: P\n---\n\nb";
	const human = "---\nfrom: sam\n---\n\nb";
	assert.ok(!formatDrainBody([{ id: "a", text: self }, { id: "b", text: human }], "S").includes(AGENT_MESSAGE_DISCLAIMER));
	assert.ok(formatDrainBody([{ id: "a", text: self }, { id: "c", text: peer }], "S").startsWith(AGENT_MESSAGE_DISCLAIMER));
	assert.equal(isAgentMail(peer, "S"), true);
	assert.equal(isAgentMail(self, "S"), false);
	assert.equal(isAgentMail(human, "S"), false);
});

test("idle drain of a peer message is headed by the disclaimer", (t) => {
	const r = rig(["msg-a"], { idle: true });
	t.after(() => r.watcher.stop());
	assert.ok(r.sent[0].body.startsWith(AGENT_MESSAGE_DISCLAIMER));
});

test("helpers: id extraction, text parts, transcript ledger", () => {
	assert.deepEqual(extractMessageIds("kl-msg-id: a\nx\n\nkl-msg-id: b\n  kl-msg-id: c\nkl-msg-id: ../d"), ["a", "b"]);
	assert.equal(messageText({ content: [{ type: "text", text: "p1" }, { type: "image" }, { type: "text", text: "p2" }] }), "p1\n\np2");
	assert.deepEqual(
		[...deliveredIdsFromEntries([{ type: "message", message: userMsg("kl-msg-id: z\nhi") }, { type: "custom" }, null])],
		["z"],
	);
});

test("daemon client state dir follows KL_ROOT", () => {
	const prev = process.env.KL_ROOT;
	try {
		process.env.KL_ROOT = "/tmp/kl-root-test";
		const c = new DaemonClient({ requester: { agent: "a", session: "s", inbox_path: "/tmp/x" }, autostart: false });
		assert.equal(c.stateDir, "/tmp/kl-root-test/daemon");
		delete process.env.KL_ROOT;
		const c2 = new DaemonClient({ requester: { agent: "a", session: "s", inbox_path: "/tmp/x" }, autostart: false });
		assert.match(c2.stateDir, /\/\.kl\/daemon$/);
	} finally {
		if (prev === undefined) delete process.env.KL_ROOT;
		else process.env.KL_ROOT = prev;
	}
});
