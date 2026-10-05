import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	cancelWake,
	createWake,
	listWakes,
	parseDelay,
	runWorker,
	scheduleDir,
	type Deliver,
} from "../src/schedule.ts";
import type { Requester } from "../src/daemon/protocol.ts";

const UUID = "0123abcd-1111-2222-3333-444455556666";
const roots: string[] = [];
const requester: Requester = { agent: "test", session: UUID, name: "test-bright-fox", inbox_path: "/tmp/x" };

function root(): string {
	const r = mkdtempSync(join(tmpdir(), "kl-schedule-test-"));
	roots.push(r);
	return r;
}

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Start the worker in-process; resolves with its exit code. */
function inProcess(deliver: Deliver, extra: { retryMs?: number; pollMs?: number } = {}) {
	let done: Promise<number> = Promise.resolve(-1);
	const startWorker = (dir: string, id: string) => {
		done = runWorker({ dir, id, creatorPid: process.pid, deliver, ...extra });
		return process.pid;
	};
	return { startWorker, done: () => done };
}

test("parseDelay accepts s/m/h/d and rejects the rest", () => {
	assert.equal(parseDelay("30s"), 30);
	assert.equal(parseDelay("10m"), 600);
	assert.equal(parseDelay("2h"), 7200);
	assert.equal(parseDelay("1d"), 86400);
	for (const bad of ["0s", "10", "5w", "-1m", "1.5h", ""]) assert.throws(() => parseDelay(bad), bad);
});

test("at wake delivers its note as the session and cleans up", async () => {
	const r = root();
	const got: Array<[Requester, string, string]> = [];
	const w = inProcess(async (req, summary, body) => void got.push([req, summary, body]));
	const rec = createWake({ uuid: UUID, requester, kind: "at", target: Date.now() + 150, note: "Check the build", root: r, startWorker: w.startWorker });
	assert.match(listWakes(UUID, r), new RegExp(`${rec.id} \\[at\\]`));
	assert.equal(await w.done(), 0);
	assert.deepEqual(got, [[requester, "Scheduled wake", "Check the build"]]);
	assert.deepEqual(readdirSync(scheduleDir(UUID, r)), []);
	assert.equal(listWakes(UUID, r), "No pending wakes.");
});

test("an empty note gets the default reminder", async () => {
	const r = root();
	let body = "";
	const w = inProcess(async (_r, _s, b) => void (body = b));
	createWake({ uuid: UUID, requester, kind: "at", target: Date.now() + 50, note: "  ", root: r, startWorker: w.startWorker });
	await w.done();
	assert.match(body, /scheduled wake fired/);
});

test("watch fires after its PID exits", async () => {
	const r = root();
	const child = spawn("sleep", ["0.3"], { stdio: "ignore" });
	let summary = "";
	const w = inProcess(async (_r, s) => void (summary = s), { pollMs: 50 });
	createWake({ uuid: UUID, requester, kind: "watch", target: child.pid!, root: r, startWorker: w.startWorker });
	assert.equal(await w.done(), 0);
	assert.equal(summary, `Watched process ${child.pid} exited`);
});

test("failed delivery retries three times, then leaves the wake with an error that list shows", async () => {
	const r = root();
	let calls = 0;
	const w = inProcess(
		async () => {
			calls++;
			throw new Error("daemon down");
		},
		{ retryMs: 10 },
	);
	const rec = createWake({ uuid: UUID, requester, kind: "at", target: Date.now() + 20, root: r, startWorker: w.startWorker });
	assert.equal(await w.done(), 1);
	assert.equal(calls, 3);
	assert.ok(existsSync(join(scheduleDir(UUID, r), `${rec.id}.error`)));
	assert.match(listWakes(UUID, r), /error: delivery failed after 3 attempts .*daemon down/);
});

test("cancel removes an armed wake; the worker then exits without delivering", async () => {
	const r = root();
	let delivered = false;
	const w = inProcess(async () => void (delivered = true));
	const rec = createWake({ uuid: UUID, requester, kind: "at", target: Date.now() + 300, root: r, startWorker: w.startWorker });
	assert.equal(cancelWake(UUID, rec.id, r), `Wake ${rec.id} cancelled.`);
	assert.equal(await w.done(), 0);
	assert.equal(delivered, false);
	assert.deepEqual(readdirSync(scheduleDir(UUID, r)), []);
});

test("invalid inputs are rejected", () => {
	const r = root();
	const startWorker = () => assert.fail("worker must not start");
	assert.throws(() => cancelWake(UUID, "nope", r), /invalid wake id/);
	assert.throws(() => cancelWake(UUID, "wake-1-abcdef01", r), /no such wake/);
	assert.throws(() => createWake({ uuid: UUID, requester, kind: "at", target: Date.now() - 1000, root: r, startWorker }), /past/);
	assert.throws(() => createWake({ uuid: UUID, requester, kind: "watch", target: 999999, root: r, startWorker }), /not alive/);
	assert.throws(() => createWake({ uuid: UUID, requester, kind: "watch", target: 0, root: r, startWorker }), /positive integer/);
	assert.throws(() => scheduleDir("../etc", r), /not a session uuid/);
});

test("a worker whose creator dies before arming gives up", async () => {
	const r = root();
	const dir = scheduleDir(UUID, r);
	// Record but no .armed, creator pid dead.
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "wake-1-abcdef01.json"), "{}");
	assert.equal(await runWorker({ dir, id: "wake-1-abcdef01", creatorPid: 999999, deliver: async () => assert.fail() }), 1);
});
