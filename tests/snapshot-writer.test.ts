import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createSnapshotWriter,
	loadOrCreateSnapshotWriter,
} from "../extensions/kiln-lite/lib/snapshot-writer.ts";
import {
	readPromptSnapshot,
	writePromptSnapshot,
	promptPath,
} from "../extensions/kiln-lite/snapshot.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "kl-writer-test-"));
}

function cleanup(home: string) {
	rmSync(home, { recursive: true, force: true });
}

test("createSnapshotWriter starts unwritten", () => {
	const home = makeHome();
	try {
		const w = createSnapshotWriter({ agentHome: home, agentId: "beth-bright-bear" });
		assert.equal(w.isWritten(), false);
	} finally {
		cleanup(home);
	}
});

test("writeOnce writes the snapshot on first call", () => {
	const home = makeHome();
	try {
		const w = createSnapshotWriter({ agentHome: home, agentId: "beth-bright-bear" });
		w.writeOnce("prompt content");
		assert.equal(w.isWritten(), true);
		assert.equal(readPromptSnapshot(home, "beth-bright-bear"), "prompt content");
	} finally {
		cleanup(home);
	}
});

test("writeOnce is a no-op after first call (write-once invariant)", () => {
	const home = makeHome();
	try {
		const w = createSnapshotWriter({ agentHome: home, agentId: "beth-bright-bear" });
		w.writeOnce("first");
		w.writeOnce("second"); // must not overwrite
		w.writeOnce("third");
		assert.equal(readPromptSnapshot(home, "beth-bright-bear"), "first");
	} finally {
		cleanup(home);
	}
});

test("markExisting prevents future writes (replay-mode guard)", () => {
	const home = makeHome();
	try {
		writePromptSnapshot(home, "beth-resumed", "originally-captured");
		const w = createSnapshotWriter({ agentHome: home, agentId: "beth-resumed" });
		w.markExisting();
		assert.equal(w.isWritten(), true);
		// before_agent_start might still call writeOnce — must NOT overwrite
		w.writeOnce("would-overwrite-but-shouldnt");
		assert.equal(readPromptSnapshot(home, "beth-resumed"), "originally-captured");
	} finally {
		cleanup(home);
	}
});

test("loadOrCreateSnapshotWriter detects existing and marks written", () => {
	const home = makeHome();
	try {
		writePromptSnapshot(home, "beth-resumed", "originally-captured");
		const { writer, existing } = loadOrCreateSnapshotWriter({
			agentHome: home,
			agentId: "beth-resumed",
		});
		assert.equal(existing, "originally-captured");
		assert.equal(writer.isWritten(), true);
	} finally {
		cleanup(home);
	}
});

test("loadOrCreateSnapshotWriter returns null existing for fresh session", () => {
	const home = makeHome();
	try {
		const { writer, existing } = loadOrCreateSnapshotWriter({
			agentHome: home,
			agentId: "beth-fresh",
		});
		assert.equal(existing, null);
		assert.equal(writer.isWritten(), false);
		// And a subsequent writeOnce works
		writer.writeOnce("fresh-prompt");
		assert.equal(readPromptSnapshot(home, "beth-fresh"), "fresh-prompt");
	} finally {
		cleanup(home);
	}
});

test("writeOnce creates the directory if absent", () => {
	const home = makeHome();
	try {
		const w = createSnapshotWriter({ agentHome: home, agentId: "beth-fresh" });
		assert.equal(existsSync(promptPath(home, "beth-fresh")), false);
		w.writeOnce("x");
		assert.equal(existsSync(promptPath(home, "beth-fresh")), true);
	} finally {
		cleanup(home);
	}
});
