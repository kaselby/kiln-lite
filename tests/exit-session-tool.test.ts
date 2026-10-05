import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveHandoff } from "../extensions/kiln-lite/exit-session-tool.ts";
import { installLifecycle, resetEntry, RESET_SOURCE } from "../extensions/kiln-lite/lifecycle.ts";
import { defaultConfig } from "../extensions/kiln-lite/config.ts";
import type { PromptSource, SessionState } from "../extensions/kiln-lite/types.ts";

function makeTmpDir(): string {
	const dir = join(tmpdir(), `exit-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// --- resolveHandoff ---

test("resolveHandoff returns raw text for plain strings", () => {
	assert.equal(resolveHandoff("continue working on the feature"), "continue working on the feature");
});

test("resolveHandoff returns raw text for strings that look like paths but don't exist", () => {
	assert.equal(
		resolveHandoff("/nonexistent/path/that/does/not/exist.md"),
		"/nonexistent/path/that/does/not/exist.md",
	);
});

test("resolveHandoff reads file contents for existing absolute paths", () => {
	const dir = makeTmpDir();
	const file = join(dir, "handoff.md");
	writeFileSync(file, "# Handoff\n\nPick up where I left off.");

	const result = resolveHandoff(file);
	assert.equal(result, "# Handoff\n\nPick up where I left off.");

	rmSync(dir, { recursive: true });
});

test("resolveHandoff expands ~/ to home directory", () => {
	// Create a temp file in a known location under home
	const subdir = join(homedir(), `.kl-test-${Date.now()}`);
	mkdirSync(subdir, { recursive: true });
	const file = join(subdir, "handoff.md");
	writeFileSync(file, "home-relative content");

	const tildeRef = `~/.kl-test-${Date.now().toString().slice(-13)}`; // won't match
	// Use the actual subdir name for a reliable test
	const basename = subdir.split("/").pop()!;
	const result = resolveHandoff(`~/${basename}/handoff.md`);
	assert.equal(result, "home-relative content");

	rmSync(subdir, { recursive: true });
});

test("resolveHandoff trims whitespace before path detection", () => {
	const dir = makeTmpDir();
	const file = join(dir, "handoff.md");
	writeFileSync(file, "trimmed content");

	// Leading/trailing whitespace around a valid path
	const result = resolveHandoff(`  ${file}  `);
	assert.equal(result, "trimmed content");

	rmSync(dir, { recursive: true });
});

test("resolveHandoff preserves original text (not trimmed) for non-path strings", () => {
	// Raw text with leading whitespace should be returned as-is (original, not trimmed)
	assert.equal(resolveHandoff("  some text  "), "  some text  ");
});

test("resolveHandoff handles multiline handoff text", () => {
	const text = "Line 1\nLine 2\n\n## Section\n\nMore content.";
	assert.equal(resolveHandoff(text), text);
});

test("resolveHandoff handles file with special characters in content", () => {
	const dir = makeTmpDir();
	const file = join(dir, "special.md");
	const content = "Backticks: `code`\nQuotes: \"hello\" 'world'\nDollars: $VAR\nNewlines:\n\n\nDone.";
	writeFileSync(file, content);

	assert.equal(resolveHandoff(file), content);

	rmSync(dir, { recursive: true });
});

test("resolveHandoff returns raw text for relative-looking paths", () => {
	// ./relative paths are not supported — only absolute and ~/
	assert.equal(resolveHandoff("./some/file.md"), "./some/file.md");
});

// --- lifecycle: exit_session, cleanup turn, in-session reset ---

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Minimal fake Pi: records tools, commands, handlers and sent user messages. */
function fakePi() {
	const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const pi = {
		registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => tools.set(t.name, t),
		registerCommand: (name: string, c: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
			commands.set(name, c),
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		sendUserMessage: (text: string) => sent.push(text),
	} as unknown as ExtensionAPI;
	return { pi, tools, commands, handlers, sent };
}

function fakeCtx() {
	let shutdowns = 0;
	const ctx = { shutdown: () => shutdowns++, hasUI: false } as unknown as ExtensionContext;
	return { ctx, shutdowns: () => shutdowns };
}

function lifecycleState(home: string, cleanup: PromptSource): SessionState {
	return {
		agentHome: home,
		agentId: "scout-test-agent",
		sessionUuid: "uuid",
		config: { ...defaultConfig(home), name: "scout", cleanup },
		env: {},
		vars: { agent_id: "scout-test-agent", agent_home: home },
	};
}

async function settle(f: ReturnType<typeof fakePi>, ctx: ExtensionContext) {
	return (f.handlers.get("agent_before_settle") ?? [])[0]?.({ type: "agent_before_settle" }, ctx);
}

async function callExit(f: ReturnType<typeof fakePi>, ctx: ExtensionContext, params: Record<string, unknown>) {
	return f.tools.get("exit_session")!.execute("id", params, undefined, undefined, ctx);
}

test("resetEntry: compaction that keeps nothing, handoff as summary, tagged kl-reset", () => {
	assert.deepEqual(resetEntry("carry on with X"), {
		type: "compaction",
		summary: "carry on with X",
		firstKeptEntryId: null,
		details: { source: RESET_SOURCE },
	});
	assert.match(resetEntry("  ").summary, /without a handoff/);
});

test("lifecycle: no cleanup prompt → exit_session shuts down plainly", async () => {
	const home = makeTmpDir();
	const f = fakePi();
	const lc = installLifecycle(f.pi);
	lc.start(lifecycleState(home, ""), () => {});
	const { ctx, shutdowns } = fakeCtx();
	await callExit(f, ctx, {});
	assert.equal(shutdowns(), 1);
	assert.equal(f.sent.length, 0);
	assert.equal(lc.handleAgentEnd(ctx, []), true, "drain skipped: shutting down");
	assert.equal(await settle(f, ctx), undefined, "no reset");
	rmSync(home, { recursive: true });
});

test("lifecycle: continue + skip_cleanup → no shutdown; next settle appends the reset", async () => {
	const home = makeTmpDir();
	const f = fakePi();
	const lc = installLifecycle(f.pi);
	lc.start(lifecycleState(home, "wrap up"), () => {});
	const { ctx, shutdowns } = fakeCtx();
	await callExit(f, ctx, { continue: true, skip_cleanup: true, handoff: "HANDOFF-1" });
	assert.equal(shutdowns(), 0);
	assert.equal(f.sent.length, 0, "cleanup skipped");
	assert.equal(lc.handleAgentEnd(ctx, []), false, "drain allowed after a reset");
	assert.deepEqual(await settle(f, ctx), { entries: [resetEntry("HANDOFF-1")], continue: false });
	assert.equal(await settle(f, ctx), undefined, "reset is one-shot");
	rmSync(home, { recursive: true });
});

test("lifecycle: continue with a cleanup prompt → cleanup turn first, then reset (autonomous continues)", async () => {
	const home = makeTmpDir();
	const f = fakePi();
	const lc = installLifecycle(f.pi);
	lc.start(lifecycleState(home, "wrap up"), () => {});
	const { ctx, shutdowns } = fakeCtx();
	await callExit(f, ctx, { continue: true, autonomous: true, handoff: "H2" });
	assert.equal(f.sent.length, 1);
	assert.match(f.sent[0], /^wrap up/);
	assert.equal(await settle(f, ctx), undefined, "no reset before the cleanup turn ends");
	// A run that ends without the cleanup sentinel: exit pending, drain skipped.
	assert.equal(lc.handleAgentEnd(ctx, [{ role: "user", content: "other" }]), true);
	// The cleanup turn's run ends.
	assert.equal(lc.handleAgentEnd(ctx, [{ role: "user", content: f.sent[0] }]), false);
	assert.equal(shutdowns(), 0);
	assert.deepEqual(await settle(f, ctx), { entries: [resetEntry("H2")], continue: true });
	rmSync(home, { recursive: true });
});

test("lifecycle: cleanup prompt without continue → cleanup turn, then shutdown", async () => {
	const home = makeTmpDir();
	const f = fakePi();
	const lc = installLifecycle(f.pi);
	lc.start(lifecycleState(home, "wrap up"), () => {});
	const { ctx, shutdowns } = fakeCtx();
	await f.commands.get("exit")!.handler("", ctx);
	assert.equal(f.sent.length, 1);
	assert.equal(shutdowns(), 0);
	assert.equal(lc.handleAgentEnd(ctx, [{ role: "user", content: f.sent[0] }]), true);
	assert.equal(shutdowns(), 1);
	assert.equal(await settle(f, ctx), undefined);
	rmSync(home, { recursive: true });
});

test("lifecycle: /fq during a continue's cleanup turn shuts down and drops the reset", async () => {
	const home = makeTmpDir();
	const f = fakePi();
	const lc = installLifecycle(f.pi);
	lc.start(lifecycleState(home, "wrap up"), () => {});
	const { ctx, shutdowns } = fakeCtx();
	await callExit(f, ctx, { continue: true, handoff: "H3" });
	await f.commands.get("fq")!.handler("", ctx);
	assert.equal(shutdowns(), 1);
	assert.equal(await settle(f, ctx), undefined);
	rmSync(home, { recursive: true });
});
