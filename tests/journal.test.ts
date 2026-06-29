import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	writeMeta,
	readMeta,
	appendJournal,
	readJournal,
	rebuildJournal,
	scanAllMeta,
	journalPath,
	journalTsValue,
	type SnapshotMeta,
} from "../extensions/kiln-lite/snapshot.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "kl-journal-test-"));
}
function cleanup(home: string) {
	rmSync(home, { recursive: true, force: true });
}
function meta(id: string, lastSeen: string, extra: Partial<SnapshotMeta> = {}): SnapshotMeta {
	return {
		agent_id: id,
		pi_session_uuid: `uuid-${id}`,
		created_at: "2026-01-01T00:00:00.000Z",
		last_seen: lastSeen,
		...extra,
	};
}

test("writeMeta mirrors into the journal automatically (single chokepoint)", () => {
	const home = makeHome();
	try {
		writeMeta(home, meta("scout-one-fox", "2026-06-01T00:00:00.000Z"));
		assert.ok(existsSync(journalPath(home)), "journal file created by writeMeta");
		const recs = readJournal(home);
		assert.equal(recs.length, 1);
		assert.equal(recs[0].agent_id, "scout-one-fox");
		assert.equal(recs[0].last_seen, "2026-06-01T00:00:00.000Z");
	} finally {
		cleanup(home);
	}
});

test("readJournal dedupes to the latest record per agent_id", () => {
	const home = makeHome();
	try {
		appendJournal(home, meta("scout-x", "2026-06-01T00:00:00.000Z", { model: "old" }));
		appendJournal(home, meta("scout-x", "2026-06-09T00:00:00.000Z", { model: "new" }));
		appendJournal(home, meta("scout-y", "2026-06-05T00:00:00.000Z"));
		const recs = readJournal(home);
		assert.equal(recs.length, 2, "two distinct agents");
		const x = recs.find((r) => r.agent_id === "scout-x");
		assert.equal(x?.model, "new", "latest by last_seen wins");
	} finally {
		cleanup(home);
	}
});

test("readJournal: on equal last_seen, the later line wins", () => {
	const home = makeHome();
	try {
		const ts = "2026-06-01T00:00:00.000Z";
		appendJournal(home, meta("scout-z", ts, { model: "first" }));
		appendJournal(home, meta("scout-z", ts, { model: "second" }));
		const recs = readJournal(home);
		assert.equal(recs.length, 1);
		assert.equal(recs[0].model, "second");
	} finally {
		cleanup(home);
	}
});

test("readJournal skips corrupt/torn lines without throwing", () => {
	const home = makeHome();
	try {
		appendJournal(home, meta("scout-good", "2026-06-01T00:00:00.000Z"));
		// Simulate a torn append + garbage line.
		appendFileSync(journalPath(home), '{"agent_id":"scout-broken","last_se\n');
		appendFileSync(journalPath(home), "not json at all\n");
		appendJournal(home, meta("scout-good2", "2026-06-02T00:00:00.000Z"));
		const recs = readJournal(home);
		const ids = recs.map((r) => r.agent_id).sort();
		assert.deepEqual(ids, ["scout-good", "scout-good2"], "valid lines survive, corrupt skipped");
	} finally {
		cleanup(home);
	}
});

test("readJournal returns [] when the journal is absent", () => {
	const home = makeHome();
	try {
		assert.deepEqual(readJournal(home), []);
	} finally {
		cleanup(home);
	}
});

test("rebuildJournal reconstructs from authoritative meta files, atomically", () => {
	const home = makeHome();
	try {
		// Write three sessions (each mirrors a line), then corrupt the journal.
		writeMeta(home, meta("scout-a", "2026-06-01T00:00:00.000Z"));
		writeMeta(home, meta("scout-b", "2026-06-02T00:00:00.000Z"));
		writeMeta(home, meta("scout-c", "2026-06-03T00:00:00.000Z"));
		writeFileSync(journalPath(home), "totally corrupt\n{bad\n");
		assert.deepEqual(readJournal(home), [], "corrupt journal reads empty");

		const rebuilt = rebuildJournal(home);
		assert.equal(rebuilt.length, 3);
		const recs = readJournal(home);
		assert.deepEqual(
			recs.map((r) => r.agent_id).sort(),
			["scout-a", "scout-b", "scout-c"],
			"journal rebuilt from meta files",
		);
		// No temp files left behind.
		assert.ok(!existsSync(`${journalPath(home)}.tmp.${process.pid}`));
	} finally {
		cleanup(home);
	}
});

test("scanAllMeta enumerates meta dirs and ignores the .journal dotfile", () => {
	const home = makeHome();
	try {
		writeMeta(home, meta("scout-a", "2026-06-01T00:00:00.000Z"));
		writeMeta(home, meta("scout-b", "2026-06-02T00:00:00.000Z"));
		const metas = scanAllMeta(home);
		assert.equal(metas.length, 2, "two meta dirs, .journal.jsonl not counted");
	} finally {
		cleanup(home);
	}
});

test("cwd with quote/tab/newline round-trips through writeMeta+readMeta (the awk bug)", () => {
	const home = makeHome();
	try {
		const nasty = '/tmp/has"quote/and\ttab/and\nnewline';
		writeMeta(home, meta("scout-nasty", "2026-06-01T00:00:00.000Z", { cwd: nasty, pi_session_jsonl: "/tmp/s.jsonl" }));
		const back = readMeta(home, "scout-nasty");
		assert.equal(back?.cwd, nasty, "JSON.parse preserves every byte; awk -F'\"' did not");
	} finally {
		cleanup(home);
	}
});

test("journalTsValue: missing/invalid sort oldest, valid parse", () => {
	assert.equal(journalTsValue(undefined), -1);
	assert.equal(journalTsValue("not-a-date"), -1);
	assert.ok(journalTsValue("2026-06-01T00:00:00.000Z") > 0);
	assert.ok(
		journalTsValue("2026-06-02T00:00:00.000Z") > journalTsValue("2026-06-01T00:00:00.000Z"),
	);
});
