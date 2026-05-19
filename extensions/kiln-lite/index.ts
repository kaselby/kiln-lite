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
import { buildWrapupTool } from "./wrapup-tool.ts";
import { registerSpawnCommand } from "./spawn.ts";
import { createSessionStateHook, type SessionStateHook } from "./session-state.ts";
import { loadCommandGates, applyCommandGates, type CompiledGate } from "./gates.ts";
import {
	findAgentIdForUuid,
	readMeta,
	readPromptSnapshot,
	uniquifyAgentId,
	writeMeta,
	writePromptSnapshot,
	type SnapshotMeta,
} from "./snapshot.ts";
import type { SessionState } from "./types.ts";
import { DaemonClient } from "../../src/client/index.ts";

export default function (pi: ExtensionAPI): void {
	let state: SessionState | null = null;
	let watcher: InboxWatcher | null = null;
	let toolIndexBlock = "";
	let daemon: DaemonClient | null = null;
	let sessionState: SessionStateHook | null = null;
	let gates: CompiledGate[] = [];

	const dispatcherRef: { current: ReturnType<typeof createCleanupDispatcher> | null } = { current: null };

	// Register the builtin `message` tool once, at extension load. Its execute
	// closure reads the live DaemonClient lazily via getDaemon() — the client
	// isn't built until session_start, but registration must happen here for
	// Pi's loader to pick it up.
	pi.registerTool(buildMessageTool({ getDaemon: () => daemon }));
	pi.registerTool(buildWrapupTool({ getDispatcher: () => dispatcherRef.current }));

	// /spawn — fork session into a new tmux window. Registered at load time;
	// the handler reads session state from ctx at invocation time.
	registerSpawnCommand(pi);

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
		// Agent-id resolution order:
		//   1. Explicit AGENT_ID env (set by `kl run` / `kl resume`).
		//      Uniquified against the snapshot store if a prior session with
		//      the same name already bound a different pi-session-uuid.
		//   2. Reverse-lookup of pi-session-uuid in the snapshot store. This
		//      is the resume path for plain `pi --continue` / `pi --resume`
		//      / pi's /resume slash command, where AGENT_ID isn't set but the
		//      session UUID matches a prior recorded session.
		//   3. Deterministic UUID-derivation (legacy default).
		const envAgentId = process.env.AGENT_ID;
		let agentId: string;
		if (envAgentId && /^[a-z0-9_-]+$/i.test(envAgentId)) {
			agentId = uniquifyAgentId(agentHome, envAgentId, sessionUuid);
			if (agentId !== envAgentId) {
				warn(
					`kiln-lite: AGENT_ID '${envAgentId}' is already bound to a different pi session — using '${agentId}' instead`,
				);
			}
		} else {
			const recovered = findAgentIdForUuid(agentHome, sessionUuid, warn);
			agentId = recovered ?? generateAgentId(config.name, sessionUuid);
		}
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
			cachedSystemPrompt: null,
			snapshotWritten: false,
		};

		// Load any existing system-prompt snapshot for this agent-id. If one
		// exists, this is a resumed session — replay it verbatim on every
		// before_agent_start. If not, we'll render normally and write the
		// snapshot at first compose (see before_agent_start handler).
		const existingSnapshot = readPromptSnapshot(agentHome, agentId, warn);
		if (existingSnapshot !== null) {
			state.cachedSystemPrompt = existingSnapshot;
			state.snapshotWritten = true;
		}

		// Persist / refresh the snapshot meta record. Created on first launch,
		// last_seen bumped on every subsequent session_start. Best-effort —
		// any write failure is logged and does not block startup.
		updateSnapshotMeta(state, ctx, warn);

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

		// Session state hook — periodic `[Session state] ...` line on tool
		// results. Closes over mutable locals (daemon, agentId, watcher) via
		// getters so it sees the live values, not the session_start snapshot.
		sessionState = createSessionStateHook({
			getDaemon: () => daemon,
			getAgentId: () => state?.agentId ?? null,
			getWatcher: () => watcher,
			interval: config.session_state_interval,
		});

		// Command gates from ~/.kl/guardrails.yml.
		gates = loadCommandGates(join(agentHome, ".."), warn);

		// Run startup commands sequentially.
		for (const cmd of config.startup) {
			await runStartupCommand(cmd, env, ctx.cwd, warn);
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`kiln-lite: online as ${agentId}`, "info");
		}
	});

	// --- tool_call: command gates from guardrails.yml ---
	pi.on("tool_call", async (event, ctx) => {
		if (gates.length === 0) return;
		return applyCommandGates(gates, event.toolName, event.input as Record<string, unknown>, ctx);
	});

	// --- before_agent_start: assemble the system prompt ---
	//
	// Two modes:
	//   1. Resumed session (state.cachedSystemPrompt set from snapshot at
	//      session_start) — return the snapshot verbatim. The original
	//      session's prompt is what the model already saw in the JSONL we're
	//      replaying, so anything else would be inconsistent.
	//   2. Fresh session — compose normally. The first time through, also
	//      write the rendered prompt to disk so a future resume can replay it.
	//      Subsequent turns of the same live process keep re-rendering (so
	//      e.g. the date in the Session block tracks real time).
	pi.on("before_agent_start", async (event, ctx) => {
		if (!state) return;
		const warn = (msg: string) => console.warn(msg);
		if (state.cachedSystemPrompt !== null) {
			return { systemPrompt: state.cachedSystemPrompt };
		}
		const modelId = ctx.model?.id;
		const composed = composeSystemPrompt(state, event.systemPromptOptions, modelId, toolIndexBlock, warn);
		if (!state.snapshotWritten) {
			writePromptSnapshot(state.agentHome, state.agentId, composed, warn);
			state.snapshotWritten = true;
			// Re-stamp meta with the model id now that we know it (it isn't
			// always available at session_start).
			if (modelId) {
				const existing = readMeta(state.agentHome, state.agentId, warn);
				if (existing && existing.model !== modelId) {
					writeMeta(state.agentHome, { ...existing, model: modelId }, warn);
				}
			}
		}
		return { systemPrompt: composed };
	});

	// --- tool_result: mid-turn inbox pings + Read-as-read tracking + periodic state ---
	//
	// Three responsibilities in one handler:
	//   1. When the agent Reads an inbox .md via Pi's Read tool, touch the
	//      `.read` marker so the watcher doesn't re-deliver that message
	//      between turns. Idempotent with markers from mid-turn pings.
	//   2. Append a per-pending [Notification | …] suffix (and touch markers
	//      as we go, matching kiln's hook pattern). Applies to EVERY tool
	//      result, including Read — which is fine, the flush is cheap.
	//   3. Every Nth call (configurable via session_state_interval), append a
	//      `[Session state] ...` status line mirroring kiln's hook. Skipped
	//      entirely when the hook reports empty content (disabled, or not an
	//      emission boundary, or all ambient fields are empty).
	//
	// Order: state block first, then notification blocks. State is ambient
	// framing; notifications are event-triggered content. Reading state
	// before event makes the LLM's mental model cleaner.
	pi.on("tool_result", async (event, ctx) => {
		if (!watcher) return;

		if (event.toolName === "read" && !event.isError) {
			const filePath = typeof event.input.path === "string" ? event.input.path : "";
			if (filePath) watcher.handleReadOfPath(filePath);
		}

		const stateBlock = sessionState ? await sessionState.maybeBuildSuffix(ctx) : "";
		const inboxSuffix = watcher.midTurnSuffix();

		const parts = [stateBlock, inboxSuffix].filter((s) => s.length > 0);
		if (parts.length === 0) return;

		// inboxSuffix already starts with "\n\n"; stateBlock is bare text.
		// Normalize so the final suffix is exactly one blank-line separator
		// between the last existing text and the first block, and one between
		// blocks.
		const suffix = `\n\n${parts.map((s) => s.replace(/^\n+/, "")).join("\n\n")}`;
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
		gates = [];
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

/**
 * Persist or refresh the snapshot meta.json for this session. Best-effort:
 * any failure is warned but does not block startup. Called once per
 * session_start. The system-prompt.txt is written separately at first
 * compose (see before_agent_start) so we capture the actual rendered
 * prompt rather than guessing it ahead of time.
 */
function updateSnapshotMeta(
	state: SessionState,
	ctx: { sessionManager: { getSessionFile(): string | undefined }; cwd: string; model?: { id?: string } },
	warn: (msg: string) => void,
): void {
	const nowIso = new Date().toISOString();
	const existing = readMeta(state.agentHome, state.agentId, warn);
	const meta: SnapshotMeta = {
		agent_id: state.agentId,
		pi_session_uuid: state.sessionUuid,
		pi_session_jsonl: ctx.sessionManager.getSessionFile() ?? existing?.pi_session_jsonl,
		cwd: ctx.cwd ?? existing?.cwd,
		model: ctx.model?.id ?? existing?.model,
		created_at: existing?.created_at ?? nowIso,
		last_seen: nowIso,
	};
	// Preserve any unknown fields a future schema may add.
	if (existing) {
		for (const [k, v] of Object.entries(existing)) {
			if (!(k in meta)) meta[k] = v;
		}
	}
	writeMeta(state.agentHome, meta, warn);
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
