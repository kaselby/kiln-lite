import { test } from "node:test";
import assert from "node:assert/strict";

import { generateAgentId } from "../extensions/kiln-lite/identity.ts";

test("generateAgentId is deterministic", () => {
	const uuid = "11111111-1111-1111-1111-111111111111";
	assert.equal(generateAgentId("beth", uuid), generateAgentId("beth", uuid));
});

test("generateAgentId returns the documented shape", () => {
	const id = generateAgentId("beth", "abc");
	const m = id.match(/^([a-z]+)-([a-z]+)-([a-z]+)$/);
	assert.ok(m, `id '${id}' must match name-adj-noun`);
	assert.equal(m[1], "beth");
});

test("generateAgentId varies with UUID", () => {
	const a = generateAgentId("beth", "11111111-1111-1111-1111-111111111111");
	const b = generateAgentId("beth", "22222222-2222-2222-2222-222222222222");
	// Astronomically unlikely to collide; if it ever does, change the seeds.
	assert.notEqual(a, b);
});

test("generateAgentId varies with name prefix", () => {
	const uuid = "11111111-1111-1111-1111-111111111111";
	const a = generateAgentId("beth", uuid);
	const b = generateAgentId("cal", uuid);
	assert.notEqual(a, b);
	assert.ok(a.startsWith("beth-"));
	assert.ok(b.startsWith("cal-"));
});
