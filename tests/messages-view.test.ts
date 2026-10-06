import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { followHistory, formatHistory, listChannels, readHistory, resolveHistoryTarget, type MessageRecord } from "../src/client/messages.ts";
import { writeInboxMessage, appendChannelHistory } from "../src/daemon/inbox.ts";
import { daemonDir, inboxRoot, statusPath } from "../src/sessions/paths.ts";
import { writeEntry, type RegistryEntry } from "../src/sessions/registry.ts";
import { guardDetach } from "../src/sessions/tmux.ts";
import { doingLine, formatSessionDetail, listSessions, sessionDetail } from "../src/sessions/view.ts";
import { writePlan } from "../extensions/kiln-lite/plan.ts";

const U1 = "01a10d7c-d216-74b9-910c-aea077fe8fd5";
const U2 = "02b20d7c-d216-74b9-910c-aea077fe8fd5";

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "kl-msgview-"));
	process.env.KL_ROOT = root;
	process.env.KL_TMUX_SOCKET = `kl-test-nonexistent-${process.pid}`;
	return root;
}

function entry(root: string, uuid: string, name: string, extra: Partial<RegistryEntry> = {}): RegistryEntry {
	const transcript = join(root, `${uuid}.jsonl`);
	writeFileSync(transcript, "{}\n"); // has a transcript: listed
	const e: RegistryEntry = {
		uuid, agent: "rev", name, names: [{ name, bound: "2026-10-05T10:00:00Z" }], home: "/h/rev",
		transcript, cwd: "/w", created: "2026-10-05T10:00:00Z", wake: "park", launch: {}, ...extra,
	};
	writeEntry(e, root);
	return e;
}

function subscribe(root: string, uuid: string, channels: string[]): void {
	const dir = join(daemonDir(root), "subscriptions");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${uuid}.json`), JSON.stringify({ version: 1, agent: "rev", session: uuid, channels }));
}

test("channels: every channel (subscribed or with history), names not uuids, self mark", () => {
	const root = freshRoot();
	entry(root, U1, "rev-calm-fox");
	entry(root, U2, "rev-red-owl");
	subscribe(root, U1, ["build", "ops"]);
	subscribe(root, U2, ["build"]);
	const channelsDir = join(daemonDir(root), "channels");
	appendChannelHistory({ channelsDir, channel: "build", sender: "rev-calm-fox", senderSession: U1, summary: "s1", body: "b1" });
	appendChannelHistory({ channelsDir, channel: "old", sender: "sam", summary: "gone", body: "" }); // no subscribers left
	const list = listChannels({ root, self: U2 });
	assert.deepEqual(list.map((c) => c.name), ["build", "old", "ops"]);
	const build = list[0];
	assert.deepEqual(build.subscribers, ["rev-calm-fox", "rev-red-owl"]);
	assert.equal(build.subscriber_count, 2);
	assert.equal(build.messages, 1);
	assert.equal(build.subscribed, true);
	assert.equal(list[2].subscribed, false);
	assert.equal(list[1].subscriber_count, 0);
});

test("history: channel (#name) and a session's inbox by name, last N, read flags", () => {
	const root = freshRoot();
	entry(root, U1, "rev-calm-fox");
	const channelsDir = join(daemonDir(root), "channels");
	for (const n of [1, 2, 3]) appendChannelHistory({ channelsDir, channel: "build", sender: "rev-red-owl", summary: `m${n}`, body: `body ${n}` });
	const ch = resolveHistoryTarget("#build", { root });
	assert.deepEqual(readHistory(ch, { root, limit: 2 }).map((m) => m.summary), ["m2", "m3"]);

	const p1 = writeInboxMessage({ inboxRoot: inboxRoot(root), recipient: U1, recipientName: "rev-calm-fox", sender: "sam", summary: 'say "hi"', body: "line1\nline2" });
	writeFileSync(p1.replace(/\.md$/, ".read"), "");
	writeInboxMessage({ inboxRoot: inboxRoot(root), recipient: U1, recipientName: "rev-calm-fox", sender: "rev-red-owl", senderSession: U2, summary: "chan copy", body: "x", channel: "build" });
	const s = resolveHistoryTarget("rev-calm-fox", { root });
	assert.equal(s.kind, "session");
	const msgs = readHistory(s, { root });
	assert.equal(msgs.length, 2);
	assert.equal(msgs[0].summary, 'say "hi"');
	assert.equal(msgs[0].body, "line1\nline2");
	assert.equal(msgs[0].to, "rev-calm-fox");
	assert.equal(msgs[0].read, true);
	assert.equal(msgs[1].read, false);
	assert.equal(msgs[1].channel, "build");
	assert.equal(msgs[1].from_session, U2);
	assert.match(formatHistory(s, msgs), /rev-red-owl -> rev-calm-fox \[#build, new\]: chan copy/);
	assert.throws(() => resolveHistoryTarget("#../x", { root }));
	assert.throws(() => resolveHistoryTarget("nobody-here", { root }));
});

test("history follow: streams only messages written after it starts", async () => {
	const root = freshRoot();
	entry(root, U1, "rev-calm-fox");
	const channelsDir = join(daemonDir(root), "channels");
	appendChannelHistory({ channelsDir, channel: "build", sender: "a", summary: "before", body: "" });
	writeInboxMessage({ inboxRoot: inboxRoot(root), recipient: U1, sender: "a", summary: "before", body: "" });
	const got: MessageRecord[] = [];
	const stops = [
		followHistory(resolveHistoryTarget("#build", { root }), (m) => got.push(m), { root, intervalMs: 20 }),
		followHistory(resolveHistoryTarget("rev-calm-fox", { root }), (m) => got.push(m), { root, intervalMs: 20 }),
	];
	appendChannelHistory({ channelsDir, channel: "build", sender: "b", summary: "after-chan", body: "" });
	writeInboxMessage({ inboxRoot: inboxRoot(root), recipient: U1, sender: "b", summary: "after-dm", body: "" });
	// a partial line is not emitted until it is complete
	appendFileSync(join(channelsDir, "build", "history.jsonl"), '{"ts":"2026-10-06T00:00:00Z","from":"c","summ');
	await new Promise((r) => setTimeout(r, 120));
	appendFileSync(join(channelsDir, "build", "history.jsonl"), 'ary":"late","body":""}\n');
	await new Promise((r) => setTimeout(r, 120));
	for (const s of stops) s();
	assert.deepEqual(got.map((m) => m.summary).sort(), ["after-chan", "after-dm", "late"]);
	assert.equal(got.find((m) => m.summary === "late")?.id, "build:3");
});

test("sessions: doing = plan goal + progress; a status file overrides it; detail shows both", () => {
	const root = freshRoot();
	entry(root, U1, "rev-calm-fox");
	entry(root, U2, "rev-red-owl", { parent: U1 });
	writePlan(root, U2, {
		goal: "review the s3 branch",
		project: "kl",
		worktree: "~/src/webapp-wt",
		tasks: [
			{ description: "read the diff", status: "done" },
			{ description: "run tests", status: "in_progress" },
			{ description: "report", status: "pending" },
		],
		updated_at: "2026-10-06T10:00:00Z",
	});
	let rows = listSessions({ root, self: U1 }).rows;
	assert.deepEqual(rows.map((r) => [r.name, r.depth, r.doing, r.self]), [
		["rev-calm-fox", 0, "", true],
		["rev-red-owl", 1, "review the s3 branch 1/3", false],
	]);
	assert.equal(doingLine(null, { goal: "x".repeat(100), tasks: [{ description: "a", status: "done" }], updated_at: "" }).length, 60);

	mkdirSync(join(root, "run", "status"), { recursive: true });
	writeFileSync(statusPath(U2, root), JSON.stringify({ summary: "fixing the login bug", detail: "from the tracker\nline 2" }));
	rows = listSessions({ root }).rows;
	assert.equal(rows[1].doing, "fixing the login bug");

	const d = sessionDetail("rev-red-owl", { root });
	assert.equal(d.parent?.name, "rev-calm-fox");
	assert.equal(sessionDetail("rev-calm-fox", { root }).children[0].name, "rev-red-owl");
	const text = formatSessionDetail(d);
	assert.match(text, /parent: +rev-calm-fox/);
	assert.match(text, /status: fixing the login bug\n  from the tracker\n  line 2/);
	assert.match(text, /plan: review the s3 branch\n  progress: +1\/3 done, 1 in progress/);
	assert.match(text, /project: +kl\n  worktree: +~\/src\/webapp-wt\n  \[x\] read the diff\n  \[>\] run tests\n  \[ \] report/);
	assert.ok(text.indexOf("status:") < text.indexOf("plan:"), "status detail sits above the plan");
});

test("detach guard: forced inside a kl session, untouched in a human shell", () => {
	assert.deepEqual(guardDetach(false, {}), { detach: false });
	assert.deepEqual(guardDetach(true, { SESSION_UUID: U1 }), { detach: true });
	const g = guardDetach(false, { SESSION_UUID: U1 });
	assert.equal(g.detach, true);
	assert.match(g.note ?? "", /SESSION_UUID/);
});
