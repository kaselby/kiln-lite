/**
 * Default-harness composition.
 *
 * `installDefaultHarness(pi)` wires together every kiln-lite building block
 * exactly as the original monolithic index.ts did. The default-harness file
 * (`extensions/kiln-lite/index.ts`) becomes a one-line call to this
 * function, and a custom harness — Cal's, eventually — can either:
 *
 *   1. Drop-in with `installDefaultHarness(pi)`, then add its own
 *      handlers / tools / commands on top.
 *   2. Copy-paste the body of this file as a starting point and override
 *      specific pieces (the prompt assembly, the cleanup template, the
 *      agent-id resolution policy, etc.).
 *
 * Behavior is intended to be byte-for-byte equivalent to the pre-refactor
 * index.ts. See the inline comments for the load-bearing ordering rules
 * the extraction preserves.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { resolveAgentHomeDetailed, loadAgentConfig } from "../config.ts";
import { applyTemplate } from "../template.ts";
import { buildEnv, applyEnv } from "../env.ts";
import { composeSystemPrompt, preloadStaticInjection } from "../prompt.ts";
import { discoverTools, renderToolIndex } from "../tools.ts";
import { startInboxWatcher, type InboxWatcher } from "../inbox.ts";
import { createCleanupDispatcher, registerExitCommands } from "../cleanup.ts";
import { ensureScaffold } from "../bootstrap.ts";
import { buildMessageTool } from "../message-tool.ts";
import { buildWrapupTool } from "../wrapup-tool.ts";
import { registerSpawnCommand } from "../spawn.ts";
import { createSessionStateHook, type SessionStateHook } from "../session-state.ts";
import { loadCommandGates, applyCommandGates, type CompiledGate } from "../gates.ts";
import {
	readMeta,
	writeMeta,
	type SnapshotMeta,
} from "../snapshot.ts";
import type { SessionState } from "../types.ts";
import { expandPlaceholders, buildBasePlaceholders } from "../placeholders.ts";
import { DaemonClient } from "../../../src/client/index.ts";

import { resolveAgentId } from "./resolve-agent-id.ts";
import { loadOrCreateSnapshotWriter, type SnapshotWriter } from "./snapshot-writer.ts";
import { runAgentEndOrdered } from "./agent-end.ts";
import { composeToolResultSuffix, appendTextToContent } from "./formatting.ts";

/**
 * Handle returned by installDefaultHarness, exposing live references to
 * internal state. Getters return null before session_start completes and
 * after session_shutdown tears down — callers must handle the null case.
 */
export interface HarnessHandle {
	getDaemon: () => DaemonClient | null;
	getDispatcher: () => ReturnType<typeof createCleanupDispatcher> | null;
	getState: () => SessionState | null;
	getWatcher: () => InboxWatcher | null;
}

/**
 * Mount the default kiln-lite handlers, tools, and slash commands onto an
 * ExtensionAPI. Returns a handle with getters for internal state so a custom
 * harness can layer additional behavior on top without forking the composition.
 *
 * Safe to call alongside additional `pi.on(...)` / `pi.registerTool(...)`
 * calls from a custom harness; Pi composes handlers across all registrations.
 * If a custom harness wants to REPLACE behavior (e.g. its own prompt
 * assembly), it should NOT call this — instead, compose the building blocks
 * from `kiln-lite/lib` (or copy this function as a template).
 */
export function installDefaultHarness(pi: ExtensionAPI): HarnessHandle {
	let state: SessionState | null = null;
	let watcher: InboxWatcher | null = null;
	let toolIndexBlock = "";
	let daemon: DaemonClient | null = null;
	let sessionState: SessionStateHook | null = null;
	let gates: CompiledGate[] = [];
	let snapshotWriter: SnapshotWriter | null = null;

	const dispatcherRef: { current: ReturnType<typeof createCleanupDispatcher> | null } = { current: null };

	// Tool registration must happen at extension load time so Pi's loader
	// picks them up. The execute closures read live mutable state lazily
	// via getter callbacks, since neither the daemon nor the dispatcher
	// exist until session_start.
	pi.registerTool(buildMessageTool({ getDaemon: () => daemon }));
	pi.registerTool(buildWrapupTool({ getDispatcher: () => dispatcherRef.current }));
	registerSpawnCommand(pi);

	// --- session_start ---
	pi.on("session_start", async (_event, ctx) => {
		const warn = (msg: string) => {
			console.warn(msg);
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		};

		const { path: agentHome, explicit: explicitHome } = resolveAgentHomeDetailed();

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

		// Apply template if KL_TEMPLATE is set (from `kl --template <name>`).
		const templateName = process.env.KL_TEMPLATE;
		let appliedTemplate: string | null = null;
		if (templateName && templateName.trim()) {
			appliedTemplate = applyTemplate(config, agentHome, templateName.trim(), warn);
		}

		const sessionUuid = inferSessionUuid(ctx);

		const { agentId } = resolveAgentId({
			agentHome,
			envAgentId: process.env.AGENT_ID,
			sessionUuid,
			namePrefix: config.name,
			warn,
		});

		const env = buildEnv({ agentHome, agentId, sessionUuid, config });
		// Hoist env onto process.env so Pi's built-in bash tool inherits them
		// when invoking shell tools from $AGENT_HOME/<tools_dir>. applyEnv
		// also prepends the tools dir to PATH so bare names resolve.
		applyEnv(env, config.tools_dir);

		// Load or create the snapshot writer. If a snapshot exists, this
		// is a resumed session — replay verbatim on every before_agent_start.
		// If not, before_agent_start composes normally and writes the
		// snapshot on first compose.
		const { writer, existing } = loadOrCreateSnapshotWriter({
			agentHome,
			agentId,
			warn,
		});
		snapshotWriter = writer;

		state = {
			agentHome,
			agentId,
			sessionUuid,
			config,
			env,
			staticInjection: new Map(),
			systemPromptBase: null,
			cachedSystemPrompt: existing,
			snapshotWritten: writer.isWritten(),
			template: appliedTemplate ?? undefined,
			vars: buildBasePlaceholders({ agentId, agentHome, sessionUuid }),
		};

		// Persist / refresh the snapshot meta. Best-effort; never blocks startup.
		updateSnapshotMeta(state, ctx, warn);

		preloadStaticInjection(state, warn);

		try {
			mkdirSync(join(agentHome, config.inbox_dir, agentId), { recursive: true });
		} catch (err) {
			warn(`kiln-lite: failed to create inbox dir: ${(err as Error).message}`);
		}

		// Daemon registration is best-effort: a missing daemon must not block
		// session startup. Channel / DM routing degrades but prompt assembly,
		// tools, inbox file watching continue to work.
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

		// Tool discovery must run AFTER applyEnv (PATH dependency for shell
		// scripts). Tools are not registered as pi tools — they're scripts
		// the agent runs via the bash tool, with PATH prepended.
		const userToolsDir = join(agentHome, config.tools_dir);
		const headers = discoverTools([userToolsDir], warn);
		toolIndexBlock = renderToolIndex(headers);

		dispatcherRef.current = createCleanupDispatcher(pi, state, warn);
		registerExitCommands(pi, dispatcherRef.current);

		// Inbox watcher MUST start last so it doesn't miss messages that
		// land during startup. Comment preserved from original index.ts.
		watcher = startInboxWatcher({
			inboxDir: join(agentHome, config.inbox_dir, agentId),
			pi,
			isIdle: () => ctx.isIdle(),
			warn,
		});

		sessionState = createSessionStateHook({
			getDaemon: () => daemon,
			getAgentId: () => state?.agentId ?? null,
			getWatcher: () => watcher,
			interval: config.session_state_interval,
		});

		gates = loadCommandGates(join(agentHome, ".."), warn);

		for (const cmd of config.startup) {
			await runStartupCommand(cmd, env, ctx.cwd, warn);
		}

		if (ctx.hasUI) {
			// Keyed footer status, not notify(): notify() routes to pi's
			// coalescing status line, so another extension firing an info
			// notify at session_start (e.g. a health banner) overwrites this
			// one in place. A keyed setStatus owns its own footer slot and
			// can't be clobbered, and keeps the agent-id pinned for the session.
			ctx.ui.setStatus("kiln-lite", `online as ${agentId}`);
		}
	});

	// --- tool_call: command gates from guardrails.yml ---
	pi.on("tool_call", async (event, ctx) => {
		if (gates.length === 0) return;
		return applyCommandGates(gates, event.toolName, event.input as Record<string, unknown>, ctx);
	});

	// --- before_agent_start: assemble (or replay) the system prompt ---
	pi.on("before_agent_start", async (event, ctx) => {
		if (!state || !snapshotWriter) return;
		const warn = (msg: string) => console.warn(msg);
		if (state.cachedSystemPrompt !== null) {
			return { systemPrompt: state.cachedSystemPrompt };
		}
		const modelId = ctx.model?.id;
		let composed = composeSystemPrompt(state, event.systemPromptOptions, modelId, toolIndexBlock, warn);
		// Expand {key} placeholders before snapshotting — bakes resolved values.
		composed = expandPlaceholders(composed, state.vars);
		// The writer enforces write-once internally; safe to call every turn.
		const wasUnwritten = !snapshotWriter.isWritten();
		snapshotWriter.writeOnce(composed);
		state.snapshotWritten = snapshotWriter.isWritten();
		if (wasUnwritten && modelId) {
			// First-compose: re-stamp meta with the model id now that we know it.
			const existing = readMeta(state.agentHome, state.agentId, warn);
			if (existing && existing.model !== modelId) {
				writeMeta(state.agentHome, { ...existing, model: modelId }, warn);
			}
		}
		return { systemPrompt: composed };
	});

	// --- tool_result: Read-marker tracking + state suffix + inbox suffix ---
	pi.on("tool_result", async (event, ctx) => {
		if (!watcher) return;

		if (event.toolName === "read" && !event.isError) {
			const filePath = typeof event.input.path === "string" ? event.input.path : "";
			if (filePath) watcher.handleReadOfPath(filePath);
		}

		const stateBlock = sessionState ? await sessionState.maybeBuildSuffix(ctx) : "";
		const inboxSuffix = watcher.midTurnSuffix();

		// State block first, then notifications. State is ambient framing;
		// notifications are event-triggered content. Stable order makes the
		// LLM's mental model cleaner.
		const suffix = composeToolResultSuffix([stateBlock, inboxSuffix]);
		if (suffix === null) return;

		return {
			content: appendTextToContent(event.content, suffix),
			details: event.details,
			isError: event.isError,
		};
	});

	// --- agent_end: cleanup-sentinel check, THEN inbox drain ---
	// Ordering enforced by runAgentEndOrdered — see lib/agent-end.ts for the
	// reasoning. Do not inline this without understanding the silent-sweep
	// regression it prevents (commit ca82822).
	pi.on("agent_end", async (event, ctx) => {
		if (!state) return;
		runAgentEndOrdered({
			dispatcher: dispatcherRef.current,
			watcher,
			ctx,
			messages: event.messages,
		});
	});

	// --- resources_discover: register $AGENT_HOME/skills ---
	pi.on("resources_discover", async (_event, _ctx) => {
		if (!state) return;
		const skillsDir = join(state.agentHome, "skills");
		return { skillPaths: [skillsDir] };
	});

	// --- session_shutdown: tear down watcher + daemon (with timeout race) ---
	pi.on("session_shutdown", async (_event, _ctx) => {
		if (watcher) {
			watcher.stop();
			watcher = null;
		}
		if (daemon) {
			// 500ms budget — don't block exit on an unhealthy daemon. The
			// daemon's reconcile loop prunes us within ~60s if deregister fails.
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
		snapshotWriter = null;
	});

	return {
		getDaemon: () => daemon,
		getDispatcher: () => dispatcherRef.current,
		getState: () => state,
		getWatcher: () => watcher,
	};
}

/**
 * Pi doesn't expose the session UUID directly via ExtensionContext. Derive
 * it from the session file path (which is <uuid>.jsonl under the session
 * dir) when possible, falling back to a fresh string for ephemeral sessions.
 */
export function inferSessionUuid(ctx: { sessionManager: { getSessionFile(): string | undefined } }): string {
	const file = ctx.sessionManager.getSessionFile();
	if (file) {
		const m = file.match(/([0-9a-fA-F-]{20,})\.jsonl$/);
		if (m) return m[1];
	}
	return `ephemeral-${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * Persist or refresh the snapshot meta.json for this session. Best-effort:
 * any failure is warned but does not block startup. Called once per
 * session_start. The system-prompt.txt is written separately at first
 * compose (see the before_agent_start handler).
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
		template: state.template ?? existing?.template,
		created_at: existing?.created_at ?? nowIso,
		last_seen: nowIso,
	};
	if (existing) {
		for (const [k, v] of Object.entries(existing)) {
			if (!(k in meta)) meta[k] = v;
		}
	}
	writeMeta(state.agentHome, meta, warn);
}

function runStartupCommand(
	cmd: string,
	env: Record<string, string>,
	cwd: string,
	warn: (msg: string) => void,
): Promise<void> {
	return new Promise<void>((resolve) => {
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
