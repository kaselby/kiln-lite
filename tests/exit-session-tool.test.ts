import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { installLifecycle } from "../extensions/kiln-lite/lifecycle.ts";
import { defaultConfig } from "../extensions/kiln-lite/config.ts";
import type { PromptSource, SessionState } from "../extensions/kiln-lite/types.ts";

function makeTmpDir(): string {
	const dir = join(tmpdir(), `exit-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// --- lifecycle: exit_session, cleanup turn ---

/** Minimal fake Pi: records tools, commands and sent user messages. */
function fakePi() {
	const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const sent: string[] = [];
	const pi = {
		registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => tools.set(t.name, t),
		registerCommand: (name: string, c: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
			commands.set(name, c),
		sendUserMessage: (text: string) => sent.push(text),
	} as unknown as ExtensionAPI;
	return { pi, tools, commands, sent };
}

function fakeCtx() {
	let shutdowns = 0;
	const ctx = { shutdown: () => shutdowns++, hasUI: false, ui: { notify: () => {} } } as unknown as ExtensionContext;
	return { ctx, shutdowns: () => shutdowns };
}

function lifecycleState(home: string, cleanup: PromptSource): SessionState {
	return {
		agentHome: home,
		agentId: "scout-test-agent",
		sessionUuid: "uuid",
		config: { ...defaultConfig(home), name: "scout", cleanup },
		env: {},
	};
}

function setup(cleanup: PromptSource) {
	const home = makeTmpDir();
	const f = fakePi();
	const lc = installLifecycle(f.pi);
	lc.start(lifecycleState(home, cleanup), () => {});
	const { ctx, shutdowns } = fakeCtx();
	const exit = (params: Record<string, unknown> = {}) => f.tools.get("exit_session")!.execute("id", params, undefined, undefined, ctx);
	return { f, lc, ctx, shutdowns, exit, done: () => rmSync(home, { recursive: true }) };
}

test("exit_session without a cleanup prompt shuts down at once", async () => {
	const t = setup("");
	await t.exit();
	assert.equal(t.shutdowns(), 1);
	assert.equal(t.f.sent.length, 0);
	assert.equal(t.lc.exiting(), true);
	assert.equal(t.lc.handleAgentEnd(t.ctx, []), true, "drain skipped: shutting down");
	t.done();
});

test("exit_session with a cleanup prompt: cleanup turn first, shutdown when its run ends", async () => {
	const t = setup("wrap up");
	await t.exit();
	assert.equal(t.f.sent.length, 1);
	assert.match(t.f.sent[0], /^wrap up/);
	assert.equal(t.shutdowns(), 0);
	assert.equal(t.lc.exiting(), true);
	// A run that ends without the cleanup sentinel: exit pending, drain skipped.
	assert.equal(t.lc.handleAgentEnd(t.ctx, [{ role: "user", content: "other" }]), true);
	assert.equal(t.shutdowns(), 0);
	// The cleanup turn's run ends.
	assert.equal(t.lc.handleAgentEnd(t.ctx, [{ role: "user", content: t.f.sent[0] }]), true);
	assert.equal(t.shutdowns(), 1);
	t.done();
});

test("exit_session skip_cleanup exits without the cleanup turn", async () => {
	const t = setup("wrap up");
	await t.exit({ skip_cleanup: true });
	assert.equal(t.f.sent.length, 0);
	assert.equal(t.shutdowns(), 1);
	t.done();
});

test("exit_session while a cleanup turn is in flight is an error", async () => {
	const t = setup("wrap up");
	await t.exit();
	await assert.rejects(t.exit(), /already in progress/);
	assert.equal(t.f.sent.length, 1);
	assert.equal(t.shutdowns(), 0);
	t.done();
});

test("no exit under way: agent_end lets the inbox drain", () => {
	const t = setup("wrap up");
	assert.equal(t.lc.exiting(), false);
	assert.equal(t.lc.handleAgentEnd(t.ctx, []), false);
	t.done();
});

test("/cleanup: cleanup turn, then quit when its run ends", async () => {
	const t = setup("wrap up");
	await t.f.commands.get("cleanup")!.handler("", t.ctx);
	assert.equal(t.f.sent.length, 1);
	assert.equal(t.shutdowns(), 0);
	assert.equal(t.lc.handleAgentEnd(t.ctx, [{ role: "user", content: t.f.sent[0] }]), true);
	assert.equal(t.shutdowns(), 1);
	t.done();
});

test("/cleanup without a cleanup prompt quits at once", async () => {
	const t = setup("");
	await t.f.commands.get("cleanup")!.handler("", t.ctx);
	assert.equal(t.f.sent.length, 0);
	assert.equal(t.shutdowns(), 1);
	t.done();
});

test("a second /cleanup while the cleanup turn runs quits at once", async () => {
	const t = setup("wrap up");
	await t.f.commands.get("cleanup")!.handler("", t.ctx);
	await t.f.commands.get("cleanup")!.handler("", t.ctx);
	assert.equal(t.f.sent.length, 1, "no second cleanup prompt");
	assert.equal(t.shutdowns(), 1);
	// The abandoned cleanup turn's run ending doesn't shut down again.
	t.lc.handleAgentEnd(t.ctx, [{ role: "user", content: t.f.sent[0] }]);
	assert.equal(t.shutdowns(), 1);
	t.done();
});
