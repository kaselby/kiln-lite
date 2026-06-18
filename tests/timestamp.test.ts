import { test } from "node:test";
import assert from "node:assert/strict";

import {
	formatElapsed,
	formatTimestamp,
	createTimestampInjector,
	createPeriodicTimestamp,
} from "../extensions/kiln-lite/timestamp.ts";

// --- formatElapsed ---

test("formatElapsed clamps zero / negative / sub-second to 0s", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(-5000), "0s");
	assert.equal(formatElapsed(500), "0s");
});

test("formatElapsed renders seconds, minutes, hours, days", () => {
	assert.equal(formatElapsed(45_000), "45s");
	assert.equal(formatElapsed(7 * 60_000), "7m");
	assert.equal(formatElapsed((21 * 3600 + 37 * 60) * 1000), "21h 37m");
	assert.equal(formatElapsed((3 * 86400 + 4 * 3600) * 1000), "3d 4h");
});

// --- formatTimestamp ---

test("formatTimestamp reports session start when no prior time", () => {
	const line = formatTimestamp(new Date("2026-06-18T19:42:00Z"), null);
	assert.ok(line.startsWith("[time: "));
	assert.ok(line.endsWith("]"));
	assert.ok(line.includes("2026"));
	assert.ok(line.includes("session start"));
});

test("formatTimestamp reports elapsed since prior time", () => {
	const prev = new Date("2026-06-18T17:29:00Z");
	const now = new Date("2026-06-18T19:42:00Z");
	const line = formatTimestamp(now, prev);
	assert.ok(line.includes("2h 13m since last timestamp"));
});

// --- createTimestampInjector ---

test("injector reports session start on first stamp, elapsed after", () => {
	const inj = createTimestampInjector();
	const first = inj.stamp(new Date("2026-06-18T12:00:00Z"));
	assert.ok(first.includes("session start"));

	const second = inj.stamp(new Date("2026-06-18T12:05:00Z"));
	assert.ok(second.includes("5m since last timestamp"));

	const third = inj.stamp(new Date("2026-06-18T13:05:00Z"));
	assert.ok(third.includes("1h 0m since last timestamp"));
});

test("msSinceLast is null before first stamp, then tracks the clock", () => {
	const inj = createTimestampInjector();
	assert.equal(inj.msSinceLast(new Date("2026-06-18T12:00:00Z")), null);
	inj.stamp(new Date("2026-06-18T12:00:00Z"));
	assert.equal(inj.msSinceLast(new Date("2026-06-18T12:00:30Z")), 30_000);
});

// --- createPeriodicTimestamp ---

test("periodic fires after everyCalls tool calls", () => {
	const inj = createTimestampInjector();
	const p = createPeriodicTimestamp(inj, { everyCalls: 3, everyMs: 0 });
	const t = new Date("2026-06-18T12:00:00Z");
	assert.equal(p.maybeSuffix(t), "");
	assert.equal(p.maybeSuffix(t), "");
	assert.ok(p.maybeSuffix(t).startsWith("[time: "));
	// counter resets after firing
	assert.equal(p.maybeSuffix(t), "");
});

test("periodic fires on elapsed time before the call count is hit", () => {
	const inj = createTimestampInjector();
	inj.stamp(new Date("2026-06-18T12:00:00Z")); // seed the shared clock
	const p = createPeriodicTimestamp(inj, { everyCalls: 100, everyMs: 60_000 });
	assert.equal(p.maybeSuffix(new Date("2026-06-18T12:00:30Z")), "");
	assert.ok(p.maybeSuffix(new Date("2026-06-18T12:01:05Z")).includes("1m since last timestamp"));
});

test("periodic with everyMs=0 never fires on time alone", () => {
	const inj = createTimestampInjector();
	inj.stamp(new Date("2026-06-18T12:00:00Z"));
	const p = createPeriodicTimestamp(inj, { everyCalls: 0, everyMs: 0 });
	assert.equal(p.maybeSuffix(new Date("2026-06-18T18:00:00Z")), "");
});

test("reset() restarts the tool-call cadence (user-message interjection)", () => {
	const inj = createTimestampInjector();
	const p = createPeriodicTimestamp(inj, { everyCalls: 3, everyMs: 0 });
	const t = new Date("2026-06-18T12:00:00Z");
	assert.equal(p.maybeSuffix(t), ""); // 1
	assert.equal(p.maybeSuffix(t), ""); // 2
	p.reset(); // user message arrives
	assert.equal(p.maybeSuffix(t), ""); // 1 again, not the 3rd
	assert.equal(p.maybeSuffix(t), ""); // 2
	assert.ok(p.maybeSuffix(t).startsWith("[time: ")); // 3 -> fires
});
