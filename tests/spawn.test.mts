import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ESM file: pi-coding-agent exports only an "import" condition.
import { SessionManager } from "@earendil-works/pi-coding-agent";

// fork.ts loads as CJS here (no "type": "module"); take the namespace off the default export.
import fork from "../extensions/kiln-lite/fork.ts";
const { writeForkedSession } = fork as typeof import("../extensions/kiln-lite/fork.ts");


const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }) as any;
const assistant = (text: string) =>
	({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }) as any;

test("writeForkedSession: new transcript holds everything before the picked message; original untouched", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kl-spawn-test-"));
	const sm = SessionManager.create(dir, dir);
	sm.appendMessage(user("ONE"));
	sm.appendMessage(assistant("REPLY-ONE"));
	const second = sm.appendMessage(user("TWO"));
	sm.appendMessage(assistant("REPLY-TWO"));
	const original = sm.getSessionFile()!;
	const before = readFileSync(original, "utf8");

	const fork = writeForkedSession(SessionManager.open(original), second);
	assert.ok(fork && fork !== original);
	const lines = readFileSync(fork!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(lines[0].type, "session");
	assert.equal(lines[0].parentSession, original);
	assert.notEqual(lines[0].id, sm.getSessionId());
	const texts = lines.slice(1).map((e) => e.message?.content?.[0]?.text);
	assert.deepEqual(texts, ["ONE", "REPLY-ONE"]);
	assert.equal(readFileSync(original, "utf8"), before);

	const first = sm.getEntries()[0].id;
	assert.equal(writeForkedSession(SessionManager.open(original), first), null);
});
