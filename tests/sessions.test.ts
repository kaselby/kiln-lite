import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { acquireLock } from "../src/sessions/fsutil.ts";
import { leaseIsLive, liveLease, readLease, releaseLease, selfLease, writeLease } from "../src/sessions/lease.ts";
import { ADJECTIVES, NOUNS, drawName, nameState } from "../src/sessions/names.ts";
import { namesLockPath } from "../src/sessions/paths.ts";
import { bindName, formatEntry, parseEntry, readEntry, writeEntry, type RegistryEntry } from "../src/sessions/registry.ts";
import { ResolveError, resolveTarget, shortId } from "../src/sessions/resolve.ts";

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "kl-sessions-"));
	process.env.KL_ROOT = root;
	process.env.KL_TMUX_SOCKET = `kl-test-nonexistent-${process.pid}`; // no server: no tmux names held
	return root;
}

const U1 = "01a10d7c-d216-74b9-910c-aea077fe8fd5";
const U2 = "02b20d7c-d216-74b9-910c-aea077fe8fd5";
const U3 = "03c30d7c-d216-74b9-910c-aea077fe8fd5";

function entry(uuid: string, name: string, bound: string, extra: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		uuid,
		agent: "rev",
		name,
		names: [{ name, bound }],
		home: "/h/rev",
		transcript: `/t/${uuid}.jsonl`,
		cwd: "/w",
		created: bound,
		wake: "park",
		launch: { model: "p/m", thinking: "medium" },
		...extra,
	};
}

/** A pid that is certainly dead: a child that already exited. */
function deadPid(): number {
	const r = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
	return Number(r.stdout.trim());
}

test("registry: write/read round trip keeps strings, parent, launch", () => {
	const root = freshRoot();
	const e = entry(U1, "rev-calm-fox", "2026-10-05T19:14:06Z", { parent: U2, cwd: "/w/with: colon" });
	writeEntry(e, root);
	const back = readEntry(U1, root);
	assert.deepEqual(back, e);
	assert.equal(parseEntry(formatEntry(e))?.names[0].bound, "2026-10-05T19:14:06Z");
});

test("registry: bindName refreshes bound time without duplicating", () => {
	const e = entry(U1, "rev-calm-fox", "2026-10-01T00:00:00Z");
	const e2 = bindName(bindName(e, "rev-red-owl", "2026-10-02T00:00:00Z"), "rev-calm-fox", "2026-10-03T00:00:00Z");
	assert.equal(e2.name, "rev-calm-fox");
	assert.deepEqual(e2.names, [
		{ name: "rev-red-owl", bound: "2026-10-02T00:00:00Z" },
		{ name: "rev-calm-fox", bound: "2026-10-03T00:00:00Z" },
	]);
});

test("lease: own lease is live; wrong start time, dead pid are not; release only removes ours", () => {
	const root = freshRoot();
	const l = selfLease(U1, "rev-calm-fox", "rev-calm-fox");
	writeLease(l, root);
	assert.ok(leaseIsLive(readLease(U1, root)!));
	assert.equal(liveLease(U1, root)?.name, "rev-calm-fox");
	assert.equal(leaseIsLive({ ...l, started: "2001-01-01T00:00:00Z" }), false, "pid reuse: start time mismatch");
	assert.equal(leaseIsLive({ ...l, pid: deadPid() }), false, "dead pid");
	assert.equal(leaseIsLive({ ...l, boot_id: "other-boot" }), false, "other boot");
	assert.equal(releaseLease(U1, l.pid + 1, root), false);
	assert.equal(releaseLease(U1, l.pid, root), true);
	assert.equal(readLease(U1, root), null);
});

test("names: draw avoids held always and recent when possible", () => {
	let i = 0;
	const seq = [0, 0, 0, 0, 1, 1]; // first draw clashes (held), second recent... then free
	const rand = () => seq[i++ % seq.length];
	const held = new Set([`rev-${ADJECTIVES[0]}-${NOUNS[0]}`]);
	const recent = new Set<string>();
	assert.equal(drawName({ agent: "rev", held, recent, rand }), `rev-${ADJECTIVES[1]}-${NOUNS[1]}`);
	// Everything recent except held: falls back to a recent-but-free name, never a held one.
	const allRecent = new Set(ADJECTIVES.flatMap((a) => NOUNS.map((n) => `rev-${a}-${n}`)));
	const n = drawName({ agent: "rev", held, recent: allRecent });
	assert.ok(!held.has(n));
	assert.throws(() => drawName({ agent: "rev", held: allRecent, recent }), /no free session name/);
	assert.throws(() => drawName({ agent: "Bad-Name", held, recent }), /must match/);
});

test("names: nameState holds live lease names, marks names bound <3 weeks recent", () => {
	const root = freshRoot();
	writeLease(selfLease(U1, "rev-live-one", ""), root);
	writeLease({ ...selfLease(U2, "rev-dead-one", ""), pid: deadPid() }, root);
	const now = Date.parse("2026-10-05T00:00:00Z");
	writeEntry(entry(U2, "rev-old-one", "2026-09-01T00:00:00Z"), root);
	writeEntry(entry(U3, "rev-new-one", "2026-10-01T00:00:00Z"), root);
	const s = nameState({ root, now });
	assert.ok(s.held.has("rev-live-one"));
	assert.ok(!s.held.has("rev-dead-one"), "stale lease does not hold its name");
	assert.ok(s.recent.has("rev-new-one"));
	assert.ok(!s.recent.has("rev-old-one"));
});

test("lock: a dead holder's lock is broken; a live holder's times out", () => {
	const root = freshRoot();
	const lock = namesLockPath(root);
	mkdirSync(lock, { recursive: true });
	writeFileSync(join(lock, "pid"), String(deadPid()));
	let broke = false;
	const release = acquireLock(lock, { onBreak: () => (broke = true) });
	assert.ok(broke);
	assert.ok(existsSync(lock));
	assert.throws(() => acquireLock(lock, { timeoutMs: 150 }), /still held by pid/);
	release();
	assert.ok(!existsSync(lock));
});

test("resolve: live wins, else most recent bound with a note, name@prefix exact, unknown loud", () => {
	const root = freshRoot();
	writeEntry(entry(U1, "rev-calm-fox", "2026-09-20T00:00:00Z"), root);
	writeEntry(entry(U2, "rev-calm-fox", "2026-10-01T00:00:00Z"), root);
	writeEntry(entry(U3, "rev-red-owl", "2026-10-02T00:00:00Z"), root);

	const r = resolveTarget("rev-calm-fox", { root });
	assert.equal(r.uuid, U2, "most recently bound");
	assert.equal(r.lease, null);
	assert.match(r.note ?? "", /most recent of 2/);

	assert.equal(resolveTarget("rev-calm-fox@01a1", { root }).uuid, U1, "name@prefix reaches the older one");
	assert.equal(resolveTarget("@02b2", { root }).uuid, U2);
	assert.throws(() => resolveTarget("rev-red-owl@01a1", { root }), ResolveError, "prefix must carry the name");
	assert.throws(() => resolveTarget("rev-nobody", { root }), /unknown session/);
	assert.throws(() => resolveTarget("@0", { root }), /at least 4/);

	// U1 comes back live under the name: live beats most-recent-bound.
	writeLease(selfLease(U1, "rev-calm-fox", "rev-calm-fox"), root);
	const live = resolveTarget("rev-calm-fox", { root });
	assert.equal(live.uuid, U1);
	assert.ok(live.lease);
	assert.match(live.note ?? "", /live session/);
	assert.equal(resolveTarget("rev-red-owl", { root }).note, undefined, "single match: no note");
});

test("shortId: shortest unique prefix among known sessions, at least 8; notes use it", () => {
	const A = "01a10da3-0001-7aaa-8000-000000000001";
	const B = "01a10da3-0002-7bbb-8000-000000000002";
	const C = "0f0f0f0f-0003-7ccc-8000-000000000003";
	assert.equal(shortId(C, [A, B, C]), "0f0f0f0f");
	assert.equal(shortId(A, [A, B, C]), "01a10da30001", "shares 01a10da3000 with B");
	assert.equal(shortId(A, [A]), "01a10da3");
	const root = freshRoot();
	writeEntry(entry(A, "rev-calm-fox", "2026-10-01T10:00:00Z"), root);
	writeEntry(entry(B, "rev-calm-fox", "2026-10-02T10:00:00Z"), root);
	const r = resolveTarget("rev-calm-fox", { root });
	assert.equal(r.uuid, B);
	assert.match(r.note ?? "", /\(01a10da30002\); use rev-calm-fox@<id> for another: 01a10da30001$/);
	assert.equal(resolveTarget("rev-calm-fox@01a10da30001", { root }).uuid, A);
	assert.throws(() => resolveTarget("@01a10da3", { root }), /ambiguous: 01a10da30001, 01a10da30002/);
});
