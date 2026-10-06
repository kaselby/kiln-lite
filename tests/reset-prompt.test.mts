import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ESM file: pi-coding-agent exports only an "import" condition.
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

// kl modules load as CJS here (no "type": "module"); take the namespace off the default export.
import lifecycleMod from "../extensions/kiln-lite/lifecycle.ts";
import configMod from "../extensions/kiln-lite/config.ts";
const { installLifecycle, RESET_KICKOFF } = lifecycleMod as typeof import("../extensions/kiln-lite/lifecycle.ts");
const { defaultConfig } = configMod as typeof import("../extensions/kiln-lite/config.ts");

// A real Pi session on the faux model, with kl's lifecycle and a stand-in for
// core's prompt handling: the identity is read from a file at start and again
// in onReset, and applied in before_agent_start.
test("Pi integration: an autonomous reset's first request carries the prompt rebuilt from changed files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kl-reset-prompt-"));
	const identityFile = join(dir, "IDENTITY.md");
	writeFileSync(identityFile, "IDENTITY-BEFORE");

	const faux = fauxProvider();
	const prompts: string[] = [];
	const lastUser: string[] = [];
	const record = (context: { systemPrompt?: string; messages: Array<{ role: string; content: unknown }> }) => {
		const sys = context.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m)).join("\n");
		prompts.push((context.systemPrompt ?? "") + sys);
		lastUser.push(JSON.stringify(context.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""));
	};
	faux.setResponses([
		(context: any) => {
			record(context);
			// The agent rewrites its files before resetting (as a cleanup turn would).
			writeFileSync(identityFile, "IDENTITY-AFTER");
			return fauxAssistantMessage(
				[fauxToolCall("exit_session", { continue: true, autonomous: true, skip_cleanup: true, handoff: "HANDOFF-X" })],
				{ stopReason: "toolUse" },
			);
		},
		() => fauxAssistantMessage("reset requested"),
		(context: any) => {
			record(context);
			return fauxAssistantMessage("after reset");
		},
	]);

	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);

	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				let identity = "";
				const lifecycle = installLifecycle(pi, {
					onReset: () => {
						identity = readFileSync(identityFile, "utf8");
						return [{ type: "custom", customType: "test-prompt", data: identity }];
					},
				});
				pi.on("session_start", async () => {
					identity = readFileSync(identityFile, "utf8");
					lifecycle.start(
						{ agentHome: dir, agentId: "t", sessionUuid: "u", config: { ...defaultConfig(dir), name: "t", cleanup: "" }, env: {} },
						() => {},
					);
				});
				pi.on("before_agent_start", async (event) => {
					event.systemPromptOptions.customPrompt = identity;
				});
			},
		],
	});
	await resourceLoader.reload();

	const sessionManager = SessionManager.inMemory(dir);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
	});
	await session.bindExtensions({});
	try {
		await session.prompt("start");
		await session.waitForIdle();

		assert.equal(prompts.length, 2, "two model requests: before and after the reset");
		assert.match(prompts[0], /IDENTITY-BEFORE/);
		assert.match(prompts[1], /IDENTITY-AFTER/, "post-reset request sees the rebuilt prompt");
		assert.match(lastUser[1], new RegExp(RESET_KICKOFF.slice(0, 30).replace(/[<>]/g, ".")));
		const entries = sessionManager.getBranch();
		const reset = entries.findIndex((e) => e.type === "compaction");
		const recorded = entries.findIndex((e) => e.type === "custom" && (e as { customType?: string }).customType === "test-prompt");
		assert.ok(reset >= 0 && recorded > reset, "onReset's entries are appended after the reset");
	} finally {
		session.dispose();
	}
});
