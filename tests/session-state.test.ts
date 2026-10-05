import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSessionStateLine, createSessionStateHook } from "../extensions/kiln-lite/session-state.ts";

test("session-state line is context % and inbox count only", () => {
	assert.equal(buildSessionStateLine({ tokens: 97_400, contextWindow: 200_000 }, 2), "[Session state] context: 97k/200k | inbox: 2 unread");
	assert.equal(buildSessionStateLine({ tokens: 5_000, contextWindow: 200_000 }, 0), "[Session state] context: 5k/200k");
	assert.equal(buildSessionStateLine({ tokens: null, contextWindow: 200_000 }, null), "");
	assert.equal(buildSessionStateLine(undefined, 3), "[Session state] inbox: 3 unread");
});

test("session-state hook emits every Nth call; 0 disables", () => {
	const ctx = { getContextUsage: () => ({ tokens: 1000, contextWindow: 10_000 }) };
	const hook = createSessionStateHook({ getUnread: () => 0, interval: 3 });
	assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => hook.maybeBuildSuffix(ctx)), ["", "", "[Session state] context: 1k/10k", "", "", "[Session state] context: 1k/10k"]);
	const off = createSessionStateHook({ getUnread: () => 9, interval: 0 });
	assert.equal(off.maybeBuildSuffix(ctx), "");
});
