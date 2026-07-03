/**
 * Default-harness composition.
 *
 * `installDefaultHarness(pi)` wires together every kiln-lite building block
 * exactly as the original monolithic index.ts did. The default-harness file
 * (`extensions/kiln-lite/index.ts`) becomes a one-line call to this
 * function, and a custom harness — Scout's, eventually — can either:
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
import { basename, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getReadmePath, getDocsPath, getExamplesPath } from "@earendil-works/pi-coding-agent";

import { resolveAgentHomeDetailed, loadAgentConfig, resolveKlRoot } from "../config.ts";
import { applyTemplate } from "../template.ts";
import { buildEnv, applyEnv } from "../env.ts";
import { composeSystemPrompt, preloadStaticInjection } from "../prompt.ts";
import { discoverTools, renderToolIndex } from "../tools.ts";
import { startInboxWatcher, type InboxWatcher } from "../inbox.ts";
import { createCleanupDispatcher, registerExitCommands } from "../cleanup.ts";
import { ensureScaffold } from "../bootstrap.ts";
import { buildMessageTool } from "../message-tool.ts";
import { buildExitSessionTool } from "../exit-session-tool.ts";
import type { ContinuationConfig } from "../exit-session.ts";
import { handoffTmuxClient, buildContinuationArgs, persistHandoff } from "../exit-session.ts";
import { buildPlanToolKit } from "../plan-tool.ts";
import { registerSpawnCommand } from "../spawn.ts";
import { createSessionStateHook, type SessionStateHook } from "../session-state.ts";
import { createTimestampInjector, createPeriodicTimestamp } from "../timestamp.ts";
import { loadCommandGates, applyCommandGates, type CompiledGate } from "../gates.ts";
import {
	readMeta,
	writeMeta,
	writePromptSnapshot,
	resolveForkInheritedPrompt,
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
	const timestamps = createTimestampInjector();
	// Periodic clock for long autonomous stretches: stamp the passage of time
	// every ~20 tool calls or ~10 minutes, whichever comes first. Shares the
	// per-turn clock so "since last" reads continuously.
	const periodicTime = createPeriodicTimestamp(timestamps, {
		everyCalls: 20,
		everyMs: 10 * 60 * 1000,
	});
	let gates: CompiledGate[] = [];
	let snapshotWriter: SnapshotWriter | null = null;
	// One-shot latch: the fork/resume orientation reminder is injected on the
	// first before_agent_start of the process only.
	let originReminderSent = false;

	const dispatcherRef: { current: ReturnType<typeof createCleanupDispatcher> | null } = { current: null };
	const continuationRef: { current: ContinuationConfig | null } = { current: null };

	// Tool registration must happen at extension load time so Pi's loader
	// picks them up. The execute closures read live mutable state lazily
	// via getter callbacks, since neither the daemon nor the dispatcher
	// exist until session_start.
	pi.registerTool(buildMessageTool({ getDaemon: () => daemon }));
	pi.registerTool(buildExitSessionTool({
		getDispatcher: () => dispatcherRef.current,
		setContinuation: (config) => { continuationRef.current = config; },
		getTemplate: () => state?.template,
	}));
	const planKit = buildPlanToolKit({
		getAgentHome: () => state?.agentHome ?? null,
		getAgentId: () => state?.agentId ?? null,
	});
	pi.registerTool(planKit.tool);
	registerSpawnCommand(pi);

	// --- session_start ---
	pi.on("session_start", async (event, ctx) => {
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
		const { writer, existing: existingSnapshot } = loadOrCreateSnapshotWriter({
			agentHome,
			agentId,
			warn,
		});
		let existing = existingSnapshot;
		// Fork inheritance: a forked session has no snapshot under its own
		// (fresh) agent-id, so it would recompose from current state and lose
		// the parent's launch-time handoff. Inherit the parent's frozen prompt
		// verbatim (matching resume) and persist it under THIS agent-id so later
		// resumes of the fork stay consistent. Guarded on reason==="fork";
		// falls back to a fresh compose when the parent has no snapshot.
		if (existing === null && event.reason === "fork") {
			const inherited = resolveForkInheritedPrompt(agentHome, event.previousSessionFile, warn);
			if (inherited !== null) {
				writePromptSnapshot(agentHome, agentId, inherited, warn);
				writer.markExisting();
				existing = inherited;
			}
		}
		snapshotWriter = writer;

		// Classify how this session was launched so the first turn can carry a
		// one-time orientation reminder. A fork (`/spawn`) and a resume
		// (`kl resume`) both boot as a fresh `pi --session` process — reason
		// "startup", not "resume"/"fork" (those only fire for pi's in-process
		// slash-command switches). Discriminate on durable signals:
		//   * resume  → a snapshot already existed for this agent-id at boot.
		//   * fork    → the session header carries a parentSession and no
		//               snapshot exists yet (a fresh fork's first boot).
		// Guard on reason so an in-process /reload (which re-emits session_start
		// with a snapshot already on disk) isn't mistaken for a resume.
		let sessionOrigin: SessionState["sessionOrigin"];
		const freshBoot = event.reason === "startup";
		if (event.reason === "resume" || (freshBoot && existing !== null)) {
			sessionOrigin = { kind: "resume" };
		} else if (event.reason === "fork" || (freshBoot && existing === null)) {
			const header = ctx.sessionManager.getHeader?.();
			if (header?.parentSession) {
				// KL_PARENT names the parent only for a fresh-boot fork (`/spawn`
				// passes --parent). An in-process /fork leaves KL_PARENT pointing at
				// THIS session's own parent, so don't trust it there.
				const parentAgentId = freshBoot ? process.env.KL_PARENT || undefined : undefined;
				sessionOrigin = { kind: "fork", parentAgentId };
			}
		}

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
			sessionOrigin,
			vars: buildBasePlaceholders({ agentId, agentHome, sessionUuid, piPaths: resolvePiPaths() }),
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
		registerExitCommands(pi, dispatcherRef.current, {
			onForceExit: () => { continuationRef.current = null; },
		});

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

		gates = loadCommandGates(resolveKlRoot(), warn);

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

	// --- before_agent_start: inject the per-turn wall-clock timestamp ---
	// One `display:false` custom message per user turn carrying the `[time: ...]`
	// line. pi persists it and feeds it to the model (custom → user), so the
	// model sees the passage of time across the whole conversation — but it's
	// hidden from the UI and is a separate message, never the user's own input,
	// so it never renders as an artifact or leaks into the input box on
	// rewind/cancel. (Replaces the old `input` transform, which baked the line
	// into the stored user message itself.) Also restarts the autonomous-work
	// cadence since a user turn just arrived.
	pi.on("before_agent_start", async () => {
		periodicTime.reset();
		return {
			message: {
				customType: "kiln-timestamp",
				content: `<system-reminder>${timestamps.stamp()}</system-reminder>`,
				display: false,
			},
		};
	});

	// --- before_agent_start: one-time fork/resume orientation reminder ---
	// When this process was launched as a fork (`/spawn`) or resume
	// (`kl resume`), inject a single hidden `<system-reminder>` on the first
	// turn so the model knows its context was branched/reconstituted. Composes
	// with the timestamp message above — the runner collects every handler's
	// `message` return — so neither clobbers the other.
	pi.on("before_agent_start", async () => {
		if (originReminderSent || !state?.sessionOrigin) return;
		originReminderSent = true;
		return {
			message: {
				customType: "kiln-session-origin",
				content: buildOriginReminder(state.sessionOrigin, state.agentId),
				display: false,
			},
		};
	});

	// --- tool_call: command gates from guardrails.yml ---
	pi.on("tool_call", async (event, ctx) => {		if (gates.length === 0) return;
		return applyCommandGates(gates, event.toolName, event.input as Record<string, unknown>, ctx, {
			agentId: state?.agentId ?? "agent",
		});
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
		const planSuffix = planKit.maybeSuffix();
		const inboxSuffix = watcher.midTurnSuffix();
		const timeSuffix = periodicTime.maybeSuffix();

		// State block first, then plan reminder, then notifications. State
		// and plan are ambient framing; notifications are event-triggered.
		// Stable order makes the LLM's mental model cleaner.
		const suffix = composeToolResultSuffix([stateBlock, planSuffix, inboxSuffix, timeSuffix]);
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

	// --- session_shutdown: tear down watcher + daemon, then spawn continuation ---
	pi.on("session_shutdown", async (_event, _ctx) => {
		// Capture continuation config before tearing down state — the ref
		// outlives teardown but state is nulled below.
		const continuation = continuationRef.current;
		const agentHome = state?.agentHome;
		// Capture our own session id too — if a client is attached to this
		// session's tmux window we hand it off to the continuation below.
		const priorAgentId = state?.agentId;
		continuationRef.current = null;

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
		dispatcherRef.current = null;
		state = null;
		snapshotWriter = null;

		// Spawn continuation after all teardown is complete.
		if (continuation && agentHome) {
			await spawnContinuation(continuation, agentHome, priorAgentId, (msg) =>
				console.warn(msg),
			);
		}
	});

	return {
		getDaemon: () => daemon,
		getDispatcher: () => dispatcherRef.current,
		getState: () => state,
		getWatcher: () => watcher,
	};
}

/**
 * Build the one-time orientation `<system-reminder>` for a forked or resumed
 * session. Forks name both the new and (when known) parent agent-id; resumes
 * note the fresh process + possible time gap. Kept as plain string assembly so
 * the exact wording lives in one place.
 */
function buildOriginReminder(
	origin: NonNullable<SessionState["sessionOrigin"]>,
	agentId: string,
): string {
	if (origin.kind === "fork") {
		const from = origin.parentAgentId
			? `parent session ${origin.parentAgentId}`
			: "a parent session";
		return (
			`<system-reminder>You are a new session (${agentId}) forked via /spawn from ${from} ` +
			`at this point in the conversation. Context above this point is shared with the parent; ` +
			`from here the two diverge independently.</system-reminder>`
		);
	}
	return (
		`<system-reminder>This session was resumed via \`kl resume\` in a fresh process; ` +
		`time may have passed since the last message. You continue as the same agent (${agentId}).</system-reminder>`
	);
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
		parent: process.env.KL_PARENT || existing?.parent,
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

/**
 * Resolve pi's bundled doc paths (README / docs / examples) for the
 * `{pi_readme}` `{pi_docs}` `{pi_examples}` placeholders. Resolving against
 * the installed pi package keeps the scaffold's default identity portable
 * across machines/install prefixes. Defensive: on any failure the paths come
 * back empty and the placeholders expand to nothing.
 */
function resolvePiPaths(): { readme: string; docs: string; examples: string } {
	try {
		return { readme: getReadmePath(), docs: getDocsPath(), examples: getExamplesPath() };
	} catch {
		return { readme: "", docs: "", examples: "" };
	}
}

/**
 * Spawn a continuation session via `kl --detach`.
 *
 * The handoff content is first persisted to a durable file under
 * `<agentHome>/handoffs/` and that file *path* is passed as the
 * `--append-system-prompt` value. kl forwards it to pi through tmux's execvp
 * path; pi treats an existing path as a file and reads its contents lazily at
 * startup, so the handoff lands as orienting context in the continuation's
 * system prompt — never a turn-1 user message.
 *
 * Passing a path rather than the content is what keeps this robust for large
 * handoffs: `tmux new-session` aborts with "command too long" once the total
 * command string exceeds ~16 KB (well under ARG_MAX), so inlining a multi-KB
 * handoff silently dropped the continuation. A short path never trips that
 * cap. The file is never deleted by us, so pi's lazy read can't race a cleanup.
 *
 * When `config.autonomous` is set, a fixed turn-1 ping is appended as a
 * positional message so the continuation's agent loop kicks off unattended.
 * Otherwise no startup prompt is sent: the session spawns idle with the
 * handoff as context and waits for the human handed the terminal. The launch
 * arg shape is built by `buildContinuationArgs` (pure, unit-tested).
 *
 * `priorAgentId` is this (exiting) session's id. If a tmux client is attached
 * to it — i.e. someone is watching interactively — the client is handed off
 * to the continuation so the terminal follows along instead of being dropped
 * to a bare shell. Autonomous (detached) sessions have no client, so nothing
 * is handed off and the continuation simply keeps running detached.
 */
async function spawnContinuation(
	config: ContinuationConfig,
	agentHome: string,
	priorAgentId: string | undefined,
	warn: (msg: string) => void,
): Promise<void> {
	let handoffPath: string | undefined;
	if (config.handoff) {
		try {
			handoffPath = persistHandoff(agentHome, basename(agentHome), config.handoff);
		} catch (err) {
			warn(
				`kiln-lite: failed to persist handoff (${(err as Error).message}) — continuation will spawn without it`,
			);
		}
	}
	const args = buildContinuationArgs({
		handoffPath,
		template: config.template,
		autonomous: config.autonomous,
	});

	try {
		const stdout = execFileSync("kl", args, {
			env: { ...process.env, AGENT_HOME: agentHome },
			timeout: 5000,
		});
		const agentId = stdout.toString().trim();
		console.log(`kiln-lite: continuation spawned → ${agentId}`);
		// Carry an attached terminal forward to the continuation (interactive
		// case); a no-op for detached/autonomous runs.
		const moved = handoffTmuxClient(priorAgentId, agentId, { warn });
		if (moved > 0) {
			console.log(`kiln-lite: handed ${moved} tmux client(s) off ${priorAgentId} → ${agentId}`);
		}
	} catch (err) {
		warn(`kiln-lite: failed to spawn continuation: ${(err as Error).message}`);
	}
}
