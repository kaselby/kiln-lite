/**
 * kiln-lite — the extension entry point.
 *
 * Wires together agent.yml loading, identity generation, system prompt assembly,
 * startup commands, shell tool registration, inbox watching, and the cleanup flow.
 *
 * See ./types.ts for the shared SessionState shape, and docs/extension.md
 * for the lifecycle wiring in prose.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

import { resolveAgentHomeDetailed, loadAgentConfig } from "./config.ts";
import { generateAgentId } from "./identity.ts";
import { buildEnv, applyEnv } from "./env.ts";
import { composeSystemPrompt, preloadStaticInjection } from "./prompt.ts";
import { discoverTools, renderToolIndex } from "./tools.ts";
import { startInboxWatcher, type InboxWatcher } from "./inbox.ts";
import { createCleanupDispatcher, registerExitCommands } from "./cleanup.ts";
import { ensureScaffold } from "./bootstrap.ts";
import { buildMessageTool } from "./message-tool.ts";
import type { SessionState } from "./types.ts";
import { DaemonClient } from "../../src/client/index.ts";

export default function (pi: ExtensionAPI): void {
	let state: SessionState | null = null;
	let watcher: InboxWatcher | null = null;
	let toolIndexBlock = "";
	let daemon: DaemonClient | null = null;

	const dispatcherRef: { current: ReturnType<typeof createCleanupDispatcher> | null } = { current: null };

	// Register the builtin `message` tool once, at extension load. Its execute
	// closure reads the live DaemonClient lazily via getDaemon() — the client
	// isn't built until session_start, but registration must happen here for
	// Pi's loader to pick it up.
	pi.registerTool(buildMessageTool({ getDaemon: () => daemon }));

	// --- session_start ---
	pi.on("session_start", async (_event, ctx) => {
		const warn = (msg: string) => {
			console.warn(msg);
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		};

		const { path: agentHome, explicit: explicitHome } = resolveAgentHomeDetailed();

		// First-run auto-scaffold: if AGENT_HOME is set explicitly and lacks an
		// agent.yml, invoke bootstrap.sh. This is a no-op on subsequent launches.
		await ensureScaffold({
			agentHome,
			explicitHome,
			ui: ctx.hasUI
				? {
						notify: ctx.ui.notify.bind(ctx.ui),
						setWorkingMessage: ctx.ui.setWorkingMessage.bind(ctx.ui),
						confirm: ctx.ui.confirm.bind(ctx.ui),
					}
				: undefined,
			warn,
		});

		try {
			mkdirSync(agentHome, { recursive: true });
		} catch (err) {
			warn(`kiln-lite: failed to create agent home ${agentHome}: ${(err as Error).message}`);
		}

		const config = loadAgentConfig(agentHome, warn);
		const sessionUuid = inferSessionUuid(ctx);
		// Prefer an explicit AGENT_ID from env (set by `kl` when launching) over
		// deterministic UUID-derivation. This keeps the tmux session name, the
		// extension's agent-id, and the agent-home inbox directory all in sync
		// from spawn time. Raw `pi` launches (no kl) still derive from the Pi
		// session UUID — /resume then recovers the same id.
		const envAgentId = process.env.AGENT_ID;
		const agentId =
			envAgentId && /^[a-z0-9_-]+$/i.test(envAgentId)
				? envAgentId
				: generateAgentId(config.name, sessionUuid);
		const env = buildEnv({ agentHome, agentId, sessionUuid, config });
		// Hoist env vars onto process.env so ALL child processes inherit them —
		// including Pi's built-in `bash` tool when the agent invokes shell tools
		// (which are just scripts in $AGENT_HOME/<tools_dir>, not registered
		// as pi tools). applyEnv also prepends the tools dir to PATH so the
		// agent can call them by bare name.
		applyEnv(env, config.tools_dir);

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

		// Ensure inbox dir exists.
		try {
			mkdirSync(join(agentHome, config.inbox_dir, agentId), { recursive: true });
		} catch (err) {
			warn(`kiln-lite: failed to create inbox dir: ${(err as Error).message}`);
		}

		// Register with the kiln-lite daemon. Best-effort — a missing daemon
		// should not block session startup. The daemon autostarts on first
		// client call if it isn't already running. Channel + DM routing
		// remains broken until registration succeeds, but everything else
		// (prompt assembly, tools, inbox file watching) still works.
		daemon = new DaemonClient({
			requester: {
				agent: config.name,
				session: agentId,
				inbox_path: join(agentHome, config.inbox_dir),
			},
		});
		void daemon
			.register()
			.catch((err) => warn(`kiln-lite: daemon register failed: ${(err as Error).message}`));

		// Discover shell tools in $AGENT_HOME/<tools_dir> and render the tool
		// index for the system prompt. Scripts are NOT registered as pi tools —
		// they are plain executables invoked by the agent through the built-in
		// `bash` tool. env.ts prepends the tools dir to PATH so bare names work.
		const userToolsDir = join(agentHome, config.tools_dir);
		const headers = discoverTools([userToolsDir], warn);
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
	pi.on("before_agent_start", async (event, ctx) => {
		if (!state) return;
		const warn = (msg: string) => console.warn(msg);
		const modelId = ctx.model?.id;
		const composed = composeSystemPrompt(state, event.systemPromptOptions, modelId, toolIndexBlock, warn);
		return { systemPrompt: composed };
	});

	// --- tool_result: mid-turn inbox pings + Read-as-read tracking ---
	//
	// Two responsibilities in one handler:
	//   1. When the agent Reads an inbox .md via Pi's Read tool, touch the
	//      `.read` marker so the watcher doesn't re-deliver that message
	//      between turns. Idempotent with markers from mid-turn pings.
	//   2. Append a per-pending [Notification | …] suffix (and touch markers
	//      as we go, matching kiln's hook pattern). Applies to EVERY tool
	//      result, including Read — which is fine, the flush is cheap.
	pi.on("tool_result", async (event, _ctx) => {
		if (!watcher) return;

		if (event.toolName === "read" && !event.isError) {
			const filePath = typeof event.input.path === "string" ? event.input.path : "";
			if (filePath) watcher.handleReadOfPath(filePath);
		}

		const suffix = watcher.midTurnSuffix();
		if (!suffix) return;
		const patched = appendTextToContent(event.content, suffix);
		return { content: patched, details: event.details, isError: event.isError };
	});

	// --- agent_end: check for cleanup sentinel + drain un-notified inbox ---
	//
	// Ordering matters. `handleAgentEnd` returns true iff this agent_end is
	// the cleanup-sentinel turn — i.e. shutdown is imminent. In that case
	// we skip the inbox drain: sendUserMessage-ing pending messages here
	// would queue turns that never run, and we'd have already touched their
	// markers → silent swallow. Leaving them unmarked means the NEXT session's
	// initial drain (dispatchIdle at session_start, which is idle) picks
	// them up as real user turns.
	//
	// On a normal (non-cleanup) agent_end, the queue at this point contains
	// messages that arrived mid-turn but produced no tool_result (text-only
	// turn) — exactly the set midTurnSuffix never surfaced. The agent is
	// transitioning to idle, so dispatchIdle is the correct consumer.
	pi.on("agent_end", async (event, ctx) => {
		let wasCleanup = false;
		if (dispatcherRef.current && state) {
			wasCleanup = dispatcherRef.current.handleAgentEnd(ctx, event.messages);
		}
		if (!wasCleanup && watcher) watcher.dispatchIdle();
	});

	// --- resources_discover: register $AGENT_HOME/skills as a skill path ---
	// Pi fires this event at session_start and on /reload. We point it at the
	// user's agent-home skills dir so Pi loads every SKILL.md under it. The
	// bootstrap script copies kiln-lite's bundled skills (messaging, etc.)
	// into this directory, making agent-home the single source of truth.
	pi.on("resources_discover", async (_event, _ctx) => {
		if (!state) return;
		const skillsDir = join(state.agentHome, "skills");
		return { skillPaths: [skillsDir] };
	});

	// --- session_shutdown: cleanup ---
	pi.on("session_shutdown", async (_event, _ctx) => {
		if (watcher) {
			watcher.stop();
			watcher = null;
		}
		if (daemon) {
			// Best-effort deregister with a short budget so we don't block exit
			// if the daemon is unhealthy. Success here lets the daemon drop this
			// session's presence record immediately; on failure the reconcile
			// loop will prune us within ~60s anyway.
			try {
				await Promise.race([
					daemon.deregister(),
					new Promise((resolve) => setTimeout(resolve, 500)),
				]);
			} catch {
				// swallow — reconcile will clean up
			}
			daemon = null;
		}
		state = null;
	});
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
