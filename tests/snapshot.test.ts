import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	readMeta,
	writeMeta,
	readPromptSnapshot,
	writePromptSnapshot,
	findAgentIdForUuid,
	uniquifyAgentId,
	metaPath,
	promptPath,
	type SnapshotMeta,
} from "../extensions/kiln-lite/snapshot.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "kl-snapshot-test-"));
}

function cleanup(home: string) {
	rmSync(home, { recursive: true, force: true });
}

function fixtureMeta(id: string, uuid: string): SnapshotMeta {
	return {
		agent_id: id,
		pi_session_uuid: uuid,
		created_at: "2026-01-01T00:00:00.000Z",
		last_seen: "2026-01-01T00:00:00.000Z",
	};
}

test("writeMeta + readMeta round-trips", () => {
	const home = makeHome();
	try {
		const meta = fixtureMeta("beth-bright-bear", "uuid-1");
		writeMeta(home, meta);
		const read = readMeta(home, "beth-bright-bear");
		assert.deepEqual(read, meta);
	} finally {
		cleanup(home);
	}
});

test("readMeta returns null for missing snapshot", () => {
	const home = makeHome();
	try {
		assert.equal(readMeta(home, "nonexistent"), null);
	} finally {
		cleanup(home);
	}
});

test("readMeta returns null and warns for malformed json", () => {
	const home = makeHome();
	try {
		const dir = join(home, "state", "sessions", "beth-broken-bear");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "meta.json"), "{not json");
		const warnings: string[] = [];
		const result = readMeta(home, "beth-broken-bear", (m) => warnings.push(m));
		assert.equal(result, null);
		assert.ok(warnings.length === 1, "exactly one warning expected");
		assert.match(warnings[0], /failed to read snapshot meta/);
	} finally {
		cleanup(home);
	}
});

test("readMeta returns null for json without agent_id", () => {
	const home = makeHome();
	try {
		const dir = join(home, "state", "sessions", "beth-no-id");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ pi_session_uuid: "x" }));
		const warnings: string[] = [];
		const result = readMeta(home, "beth-no-id", (m) => warnings.push(m));
		assert.equal(result, null);
		assert.match(warnings[0], /not a valid record/);
	} finally {
		cleanup(home);
	}
});

test("writeMeta preserves unknown fields when overlaid manually", () => {
	const home = makeHome();
	try {
		const meta = fixtureMeta("beth-bright-bear", "uuid-1");
		(meta as Record<string, unknown>).extension_field = "preserve-me";
		writeMeta(home, meta);
		const read = readMeta(home, "beth-bright-bear");
		assert.equal(read?.extension_field, "preserve-me");
	} finally {
		cleanup(home);
	}
});

test("writePromptSnapshot + readPromptSnapshot round-trips verbatim", () => {
	const home = makeHome();
	try {
		const prompt = "System prompt with\nmultiple\nlines\nand special chars: <>&\"'";
		writePromptSnapshot(home, "beth-bright-bear", prompt);
		const read = readPromptSnapshot(home, "beth-bright-bear");
		assert.equal(read, prompt);
	} finally {
		cleanup(home);
	}
});

test("readPromptSnapshot returns null for missing", () => {
	const home = makeHome();
	try {
		assert.equal(readPromptSnapshot(home, "nonexistent"), null);
	} finally {
		cleanup(home);
	}
});

test("findAgentIdForUuid finds existing", () => {
	const home = makeHome();
	try {
		writeMeta(home, fixtureMeta("beth-bright-bear", "uuid-1"));
		writeMeta(home, fixtureMeta("beth-quiet-elk", "uuid-2"));
		assert.equal(findAgentIdForUuid(home, "uuid-1"), "beth-bright-bear");
		assert.equal(findAgentIdForUuid(home, "uuid-2"), "beth-quiet-elk");
	} finally {
		cleanup(home);
	}
});

test("findAgentIdForUuid returns null when no match", () => {
	const home = makeHome();
	try {
		writeMeta(home, fixtureMeta("beth-bright-bear", "uuid-1"));
		assert.equal(findAgentIdForUuid(home, "uuid-missing"), null);
	} finally {
		cleanup(home);
	}
});

test("findAgentIdForUuid returns null when sessions dir absent", () => {
	const home = makeHome();
	try {
		assert.equal(findAgentIdForUuid(home, "uuid-1"), null);
	} finally {
		cleanup(home);
	}
});

test("uniquifyAgentId returns desired when no collision", () => {
	const home = makeHome();
	try {
		assert.equal(uniquifyAgentId(home, "beth-bright-bear", "uuid-1"), "beth-bright-bear");
	} finally {
		cleanup(home);
	}
});

test("uniquifyAgentId returns desired when collision is the SAME uuid (resume case)", () => {
	const home = makeHome();
	try {
		writeMeta(home, fixtureMeta("beth-bright-bear", "uuid-1"));
		// Same uuid -> we ARE the same session, return the id as-is.
		assert.equal(uniquifyAgentId(home, "beth-bright-bear", "uuid-1"), "beth-bright-bear");
	} finally {
		cleanup(home);
	}
});

test("uniquifyAgentId appends -2 on different-uuid collision", () => {
	const home = makeHome();
	try {
		writeMeta(home, fixtureMeta("beth-bright-bear", "uuid-1"));
		assert.equal(uniquifyAgentId(home, "beth-bright-bear", "uuid-DIFFERENT"), "beth-bright-bear-2");
	} finally {
		cleanup(home);
	}
});

test("uniquifyAgentId increments past existing suffixes", () => {
	const home = makeHome();
	try {
		writeMeta(home, fixtureMeta("beth-bright-bear", "uuid-1"));
		writeMeta(home, fixtureMeta("beth-bright-bear-2", "uuid-2"));
		writeMeta(home, fixtureMeta("beth-bright-bear-3", "uuid-3"));
		assert.equal(uniquifyAgentId(home, "beth-bright-bear", "uuid-NEW"), "beth-bright-bear-4");
	} finally {
		cleanup(home);
	}
});

test("metaPath and promptPath compose to known layout", () => {
	const home = "/tmp/xyz";
	assert.equal(metaPath(home, "beth-bright-bear"), "/tmp/xyz/state/sessions/beth-bright-bear/meta.json");
	assert.equal(promptPath(home, "beth-bright-bear"), "/tmp/xyz/state/sessions/beth-bright-bear/system-prompt.txt");
});

test("snapshot dirs are created on first write (idempotent)", () => {
	const home = makeHome();
	try {
		writePromptSnapshot(home, "fresh-id", "prompt");
		assert.ok(existsSync(metaPath(home, "fresh-id").replace("/meta.json", "")));
		// Second write should not fail
		writePromptSnapshot(home, "fresh-id", "prompt v2");
		assert.equal(readFileSync(promptPath(home, "fresh-id"), "utf8"), "prompt v2");
	} finally {
		cleanup(home);
	}
});
