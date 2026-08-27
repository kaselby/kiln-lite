import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createCleanupDispatcher } from "../extensions/kiln-lite/cleanup.ts";
import type { PromptSource, SessionState } from "../extensions/kiln-lite/types.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "kl-cleanup-test-"));
}

function makeState(home: string, cleanup: PromptSource): SessionState {
	return {
		agentHome: home,
		agentId: "scout-test-agent",
		sessionUuid: "session-uuid",
		config: {
			name: "scout",
			context_injection: [],
			startup: [],
			cleanup,
			tools_dir: "tools",
			inbox_dir: "inbox",
			sessions_dir: "sessions",
			skills_dirs: ["active"],
			session_state_interval: 15,
		},
		env: {},
		staticInjection: new Map(),
		systemPromptBase: null,
		cachedSystemPrompt: null,
		snapshotWritten: false,
		vars: {
			agent_id: "scout-test-agent",
			session_uuid: "session-uuid",
		},
	};
}

test("cleanup dispatcher reads a file-backed prompt and expands placeholders", () => {
	const home = makeHome();
	try {
		mkdirSync(join(home, "prompts"));
		writeFileSync(
			join(home, "prompts", "cleanup.md"),
			"Wrap {agent_id}; write {summary_path}.",
		);
		const sent: Array<{ prompt: string; options: unknown }> = [];
		const pi = {
			sendUserMessage(prompt: string, options: unknown) {
				sent.push({ prompt, options });
			},
		} as unknown as ExtensionAPI;
		let shutdowns = 0;
		const ctx = { shutdown: () => shutdowns++ } as unknown as ExtensionContext;
		const warnings: string[] = [];
		const dispatcher = createCleanupDispatcher(
			pi,
			makeState(home, { path: "prompts/cleanup.md" }),
			(m) => warnings.push(m),
		);

		dispatcher.dispatch(ctx);

		assert.equal(shutdowns, 0);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0].options, { deliverAs: "followUp" });
		assert.match(sent[0].prompt, /Wrap scout-test-agent; write .*scout-test-agent\.md\./);
		assert.match(sent[0].prompt, /<!-- kiln-lite:cleanup:/);
		assert.deepEqual(warnings, []);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("cleanup dispatcher exits normally when the configured file is missing", () => {
	const home = makeHome();
	try {
		let sends = 0;
		const pi = {
			sendUserMessage() {
				sends++;
			},
		} as unknown as ExtensionAPI;
		let shutdowns = 0;
		const ctx = { shutdown: () => shutdowns++ } as unknown as ExtensionContext;
		const warnings: string[] = [];
		const dispatcher = createCleanupDispatcher(
			pi,
			makeState(home, { path: "prompts/missing.md" }),
			(m) => warnings.push(m),
		);

		dispatcher.dispatch(ctx);

		assert.equal(sends, 0);
		assert.equal(shutdowns, 1);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /cleanup prompt file not found/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("cleanup dispatcher retains inline prompt compatibility", () => {
	const home = makeHome();
	try {
		let prompt = "";
		const pi = {
			sendUserMessage(value: string) {
				prompt = value;
			},
		} as unknown as ExtensionAPI;
		const ctx = { shutdown: () => assert.fail("should not shut down before cleanup") } as unknown as ExtensionContext;
		const dispatcher = createCleanupDispatcher(pi, makeState(home, "Inline {agent_id}"), () => {});

		dispatcher.dispatch(ctx);

		assert.match(prompt, /^Inline scout-test-agent/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
