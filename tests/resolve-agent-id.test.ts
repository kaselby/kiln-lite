import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAgentId } from "../extensions/kiln-lite/lib/resolve-agent-id.ts";
import { writeMeta, type SnapshotMeta } from "../extensions/kiln-lite/snapshot.ts";
import { generateAgentId } from "../extensions/kiln-lite/identity.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "kl-resolve-test-"));
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

test("env undefined falls through to derive", () => {
	const home = makeHome();
	try {
		const result = resolveAgentId({
			agentHome: home,
			envAgentId: undefined,
			sessionUuid: "uuid-x",
			namePrefix: "scout",
		});
		assert.equal(result.source, "derived");
		assert.equal(result.agentId, generateAgentId("scout", "uuid-x"));
	} finally {
		cleanup(home);
	}
});

test("env empty string falls through to derive", () => {
	const home = makeHome();
	try {
		const result = resolveAgentId({
			agentHome: home,
			envAgentId: "",
			sessionUuid: "uuid-x",
			namePrefix: "scout",
		});
		assert.equal(result.source, "derived");
	} finally {
		cleanup(home);
	}
});

test("env with invalid chars (spaces) falls through to derive", () => {
	const home = makeHome();
	try {
		const result = resolveAgentId({
			agentHome: home,
			envAgentId: "bad id with spaces",
			sessionUuid: "uuid-x",
			namePrefix: "scout",
		});
		assert.equal(result.source, "derived");
	} finally {
		cleanup(home);
	}
});

test("env valid + no collision returns env verbatim", () => {
	const home = makeHome();
	try {
		const result = resolveAgentId({
			agentHome: home,
			envAgentId: "scout-bright-bear",
			sessionUuid: "uuid-1",
			namePrefix: "scout",
		});
		assert.equal(result.source, "env");
		assert.equal(result.agentId, "scout-bright-bear");
	} finally {
		cleanup(home);
	}
});

test("env valid + same-uuid collision returns env (resume case)", () => {
	const home = makeHome();
	try {
		writeMeta(home, fixtureMeta("scout-bright-bear", "uuid-1"));
		const result = resolveAgentId({
			agentHome: home,
			envAgentId: "scout-bright-bear",
			sessionUuid: "uuid-1",
			namePrefix: "scout",
		});
		assert.equal(result.source, "env");
		assert.equal(result.agentId, "scout-bright-bear");
	} finally {
		cleanup(home);
	}
});

test("env valid + different-uuid collision returns suffixed id and warns", () => {
	const home = makeHome();
	try {
		writeMeta(home, fixtureMeta("scout-bright-bear", "uuid-1"));
		const warnings: string[] = [];
		const result = resolveAgentId({
			agentHome: home,
			envAgentId: "scout-bright-bear",
			sessionUuid: "uuid-DIFFERENT",
			namePrefix: "scout",
			warn: (m) => warnings.push(m),
		});
		assert.equal(result.source, "env-collision");
		assert.equal(result.agentId, "scout-bright-bear-2");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /already bound to a different pi session/);
	} finally {
		cleanup(home);
	}
});

test("env unset + reverse-lookup hit returns recovered id", () => {
	const home = makeHome();
	try {
		writeMeta(home, fixtureMeta("scout-quiet-elk", "uuid-resumed"));
		const result = resolveAgentId({
			agentHome: home,
			envAgentId: undefined,
			sessionUuid: "uuid-resumed",
			namePrefix: "scout",
		});
		assert.equal(result.source, "recovered");
		assert.equal(result.agentId, "scout-quiet-elk");
	} finally {
		cleanup(home);
	}
});

test("env unset + reverse-lookup miss falls through to derive", () => {
	const home = makeHome();
	try {
		writeMeta(home, fixtureMeta("scout-quiet-elk", "uuid-other"));
		const result = resolveAgentId({
			agentHome: home,
			envAgentId: undefined,
			sessionUuid: "uuid-fresh",
			namePrefix: "scout",
		});
		assert.equal(result.source, "derived");
		assert.equal(result.agentId, generateAgentId("scout", "uuid-fresh"));
	} finally {
		cleanup(home);
	}
});

test("env priority beats reverse-lookup", () => {
	// Even if the uuid matches a recovered id, an explicit AGENT_ID wins.
	const home = makeHome();
	try {
		writeMeta(home, fixtureMeta("scout-quiet-elk", "uuid-x"));
		const result = resolveAgentId({
			agentHome: home,
			envAgentId: "scout-different-id",
			sessionUuid: "uuid-x",
			namePrefix: "scout",
		});
		assert.equal(result.source, "env");
		assert.equal(result.agentId, "scout-different-id");
	} finally {
		cleanup(home);
	}
});
