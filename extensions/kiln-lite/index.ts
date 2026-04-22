/**
 * kiln-lite — the extension entry point.
 *
 * Wires together agent.yml loading, identity generation, system prompt assembly,
 * startup commands, shell tool registration, inbox watching, and the cleanup flow.
 *
 * See ./types.ts for the shared SessionState shape, and the design spec at
 * https://github.com/.../kiln-lite/blob/main/docs/design-spec-v1.md.
 */

import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

import { resolveAgentHome, loadAgentConfig } from "./config.ts";
import { generateAgentId } from "./identity.ts";
import { buildEnv, applyEnv } from "./env.ts";
import { composeSystemPrompt, preloadStaticInjection } from "./prompt.ts";
import { discoverTools, registerShellTools, renderToolIndex } from "./tools.ts";
import { startInboxWatcher, type InboxWatcher } from "./inbox.ts";
import { createCleanupDispatcher, registerExitCommands } from "./cleanup.ts";
import type { SessionState } from "./types.ts";

export default function (pi: ExtensionAPI): void {
	let state: SessionState | null = null;
	let watcher: InboxWatcher | null = null;
	let toolIndexBlock = "";

	const dispatcherRef: { current: ReturnType<typeof createCleanupDispatcher> | null } = { current: null };

	// --- session_start ---
	pi.on("session_start", async (_event, ctx) => {
		const warn = (msg: string) => {
			console.warn(msg);
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		};

		const agentHome = resolveAgentHome();
		try {
			mkdirSync(agentHome, { recursive: true });
		} catch (err) {
			warn(`kiln-lite: failed to create agent home ${agentHome}: ${(err as Error).message}`);
		}

		const config = loadAgentConfig(agentHome, warn);
		const sessionUuid = inferSessionUuid(ctx);
		const agentId = generateAgentId(config.name, sessionUuid);
		const env = buildEnv({ agentHome, agentId, sessionUuid, config });
		// Hoist env vars onto process.env so ALL child processes inherit them —
		// including Pi's built-in `bash` tool when the agent invokes scripts
		// that aren't registered as pi tools (e.g. the messaging skill's script).
		applyEnv(env);

		state = {
			agentHome,
			agentId,
			sessionUuid,
			config,
			env,
			staticInjection: new Map(),
			systemPromptBase: null,
		};

		// Preload static injection content.
		preloadStaticInjection(state, warn);

		// Write the session ID file for cross-process address lookup.
		try {
			const idDir = join(agentHome, config.sessions_dir);
			mkdirSync(idDir, { recursive: true });
			writeFileSync(join(idDir, `${sessionUuid}.id`), agentId, "utf8");
		} catch (err) {
			warn(`kiln-lite: failed to write session id file: ${(err as Error).message}`);
		}

		// Ensure inbox dir exists.
		try {
			mkdirSync(join(agentHome, config.inbox_dir, agentId), { recursive: true });
		} catch (err) {
			warn(`kiln-lite: failed to create inbox dir: ${(err as Error).message}`);
		}

		// Discover + register shell tools. We scan the user's $AGENT_HOME/<tools_dir>
		// first (so user tools can override bundled ones by shared name) and then
		// the kiln-lite package's own tools/ directory (shipped with the package).
		const userToolsDir = join(agentHome, config.tools_dir);
		const bundledToolsDir = resolveBundledToolsDir();
		const headers = discoverTools([userToolsDir, bundledToolsDir], warn);
		registerShellTools(pi, headers, env);
		toolIndexBlock = renderToolIndex(headers);

		// Cleanup dispatcher + slash commands.
		dispatcherRef.current = createCleanupDispatcher(pi, state, warn);
		registerExitCommands(pi, dispatcherRef.current);

		// Inbox watcher — start last so we don't miss messages that land during startup.
		watcher = startInboxWatcher({
			inboxDir: join(agentHome, config.inbox_dir, agentId),
			pi,
			isIdle: () => ctx.isIdle(),
			warn,
		});

		// Run startup commands sequentially.
		for (const cmd of config.startup) {
			await runStartupCommand(cmd, env, ctx.cwd, warn);
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`kiln-lite: online as ${agentId}`, "info");
		}
	});

	// --- before_agent_start: assemble the system prompt ---
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state) return;
		const warn = (msg: string) => console.warn(msg);
		const composed = composeSystemPrompt(state, event.systemPrompt, toolIndexBlock, warn);
		return { systemPrompt: composed };
	});

	// --- tool_result: mid-turn inbox pings ---
	pi.on("tool_result", async (event, _ctx) => {
		if (!watcher) return;
		const suffix = watcher.midTurnSuffix();
		if (!suffix) return;
		const patched = appendTextToContent(event.content, suffix);
		return { content: patched, details: event.details, isError: event.isError };
	});

	// --- agent_end: check for cleanup sentinel + mark inbox as seen ---
	pi.on("agent_end", async (event, ctx) => {
		if (dispatcherRef.current && state) {
			dispatcherRef.current.handleAgentEnd(ctx, event.messages);
		}
		// After each turn the agent has seen whatever mid-turn pings we added —
		// clear the unread queue so we don't re-ping next turn.
		if (watcher) watcher.markAllSeen();
	});

	// --- session_shutdown: cleanup ---
	pi.on("session_shutdown", async (_event, _ctx) => {
		if (watcher) {
			watcher.stop();
			watcher = null;
		}
		if (state) {
			try {
				unlinkSync(join(state.agentHome, state.config.sessions_dir, `${state.sessionUuid}.id`));
			} catch {
				// already gone — fine
			}
		}
	});
}

/**
 * Resolve the path to the kiln-lite package's bundled `tools/` directory.
 * We locate it relative to this file: extensions/kiln-lite/index.ts -> ../../tools.
 * Falls back to "" (skipped by scanner) if URL parsing fails.
 */
function resolveBundledToolsDir(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return resolve(here, "..", "..", "tools");
	} catch {
		return "";
	}
}

/**
 * Pi doesn't expose the session UUID directly via ExtensionContext. We derive
 * it from the session file path (which is <uuid>.jsonl under the session dir)
 * when possible, falling back to a fresh UUID for ephemeral sessions.
 */
function inferSessionUuid(ctx: { sessionManager: { getSessionFile(): string | undefined } }): string {
	const file = ctx.sessionManager.getSessionFile();
	if (file) {
		const m = file.match(/([0-9a-fA-F-]{20,})\.jsonl$/);
		if (m) return m[1];
	}
	// Ephemeral — synth a stable-within-process UUID.
	return `ephemeral-${Math.random().toString(36).slice(2, 14)}`;
}

async function runStartupCommand(
	cmd: string,
	env: Record<string, string>,
	cwd: string,
	warn: (msg: string) => void,
): Promise<void> {
	await new Promise<void>((resolve) => {
		const child = spawn(cmd, {
			shell: true,
			env: { ...process.env, ...env },
			cwd,
			stdio: ["ignore", "inherit", "inherit"],
		});
		child.on("error", (err) => {
			warn(`kiln-lite: startup command failed to spawn (${cmd}): ${err.message}`);
			resolve();
		});
		child.on("close", (code) => {
			if (code !== 0) {
				warn(`kiln-lite: startup command exited ${code}: ${cmd}`);
			}
			resolve();
		});
	});
}

/**
 * Append a text suffix to the last text content item in an array, or push a
 * new text item if none exist. Non-text content (images etc.) is preserved.
 */
function appendTextToContent(
	content: (TextContent | ImageContent)[],
	suffix: string,
): (TextContent | ImageContent)[] {
	const out = [...content];
	for (let i = out.length - 1; i >= 0; i--) {
		const item = out[i];
		if (item.type === "text") {
			out[i] = { ...item, text: item.text + suffix };
			return out;
		}
	}
	out.push({ type: "text", text: suffix.trimStart() });
	return out;
}
