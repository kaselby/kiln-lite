import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	deliveredIdsFromEntries,
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
	marker(id: string): boolean;
	flush(): void;
}

function writeMsg(dir: string, id: string, body: string): void {
	writeFileSync(join(dir, `${id}.md`), `---\nfrom: tester\nsummary: "${body}"\n---\n\n${body}\n`);
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
	const watcher = startInboxWatcher({
		inboxDir: dir,
		pi,
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

test("arrival while idle but a batch is in flight is deferred, then sent at the next drain", async (t) => {
	const r = rig(["msg-a"], { idle: true });
	t.after(() => r.watcher.stop());
	assert.equal(r.sent.length, 1);
	writeMsg(r.dir, "msg-b", "late");
	// Wait for fs.watch to see msg-b (idle → it tries to dispatch; must defer).
	const start = Date.now();
	while (r.watcher.unreadCount() < 2 && Date.now() - start < 2000) await new Promise((res) => setTimeout(res, 20));
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
	const dir = mkdtempSync(join(tmpdir(), "kl-inbox-test-"));
	const pi = { sendUserMessage() {}, appendEntry() {} } as unknown as ExtensionAPI;
	const w = startInboxWatcher({ inboxDir: dir, pi, isIdle: () => false, warn: () => {} });
	t.after(() => w.stop());
	writeMsg(dir, "msg-m", "mid");
	// Not enqueued without fs.watch; poll briefly for the watcher event.
	return new Promise<void>((res, rej) => {
		const start = Date.now();
		const tick = () => {
			const s = w.midTurnSuffix();
			if (s) {
				try {
					assert.match(s, /\[Notification \| AGENT MESSAGE from tester/);
					assert.equal(existsSync(join(dir, "msg-m.read")), true);
					res();
				} catch (e) {
					rej(e);
				}
				return;
			}
			if (Date.now() - start > 2000) return rej(new Error("watcher never saw the file"));
			setTimeout(tick, 20);
		};
		tick();
	});
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
