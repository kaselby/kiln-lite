/**
 * kl core harness.
 *
 * Everything a kl agent needs: config, session id + env, prompt composition
 *, timestamps, messaging (daemon, inbox, message tool), /spawn,
 * the subagent and schedule tools, and the lifecycle (cleanup turn, /cleanup,
 * exit_session; ../lifecycle.ts).
 *
 * There is no persistence code: a "persistent" agent is one whose
 * folder `kl init --full` scaffolded with a cleanup prompt and memory
 * sections. The cleanup turn runs only when `cleanup:` is configured.
 */

import { mkdirSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveAgentHomeDetailed, loadConfig } from "../config.ts";
import { buildEnv, applyEnv } from "../env.ts";
import { applyPrompt, loadPromptParts, type PromptParts } from "../prompt.ts";
import { startInboxWatcher, type InboxWatcher } from "../inbox.ts";
import { buildMessageTool } from "../message-tool.ts";
import { buildSessionsTool } from "../sessions-tool.ts";
import { registerSpawnCommand } from "../spawn.ts";
import { createSessionStateHook, type SessionStateHook } from "../session-state.ts";
import { createTimestampInjector, createPeriodicTimestamp, type PeriodicTimestamp } from "../timestamp.ts";
import { claimSession, releaseSession, setLeaseState, NAME_ENTRY, type BoundSession } from "../session.ts";
import { installLifecycle } from "../lifecycle.ts";
import { installSubagent } from "../subagent.ts";
import { registerScheduleTool } from "../schedule.ts";
import type { SessionState } from "../types.ts";
import { DaemonClient } from "../../../src/client/index.ts";

import { inboxDir as sessionInboxDir, inboxRoot, klRoot } from "../../../src/sessions/paths.ts";
import { composeToolResultSuffix, appendTextToContent } from "./formatting.ts";
import { buildPlanToolKit } from "../plan-tool.ts";

export interface CoreHandle {
	getState: () => SessionState | null;
	getDaemon: () => DaemonClient | null;
	getWatcher: () => InboxWatcher | null;
}

export function installCore(pi: ExtensionAPI): CoreHandle {
	let state: SessionState | null = null;
	let bound: BoundSession | null = null;
	let promptParts: PromptParts | null = null;
	let watcher: InboxWatcher | null = null;
	let daemon: DaemonClient | null = null;
	let sessionState: SessionStateHook | null = null;
	let originReminderSent = false;
	let warn: (msg: string) => void = console.warn;
	const timestamps = createTimestampInjector();
	let periodicTime: PeriodicTimestamp | null = null;

	// Tools register at load time; their closures read live state lazily.
	pi.registerTool(buildMessageTool({ getDaemon: () => daemon }));
	pi.registerTool(buildSessionsTool({ getSelf: () => state?.sessionUuid ?? null }));
	const planKit = buildPlanToolKit({
		getKlRoot: () => (state ? klRoot() : null),
		getSessionUuid: () => state?.sessionUuid ?? null,
	});
	pi.registerTool(planKit.tool);
	registerSpawnCommand(pi);
	const lifecycle = installLifecycle(pi);
	let cwd = process.cwd();
	installSubagent(pi, {
		getSelf: () => (state ? { uuid: state.sessionUuid, name: state.agentId, inboxDir: state.env.KL_INBOX, cwd } : null),
		exiting: () => lifecycle.exiting(),
	});
	registerScheduleTool(pi, { getDaemon: () => daemon, getUuid: () => state?.sessionUuid ?? null });

	pi.on("session_start", async (event, ctx) => {
		warn = (msg: string) => {
			console.warn(msg);
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		};

		cwd = ctx.cwd;
		const { path: agentHome } = resolveAgentHomeDetailed();
		try {
			mkdirSync(agentHome, { recursive: true });
		} catch (err) {
			warn(`kiln-lite: failed to create agent home ${agentHome}: ${(err as Error).message}`);
		}

		const config = loadConfig({ agentHome, warn });
		// Registry entry, lease, name. Refuses a second process on a
		// transcript whose lease is live.
		const priorName = bound?.name;
		const claim = claimSession({
			reason: event.reason,
			agent: config.name,
			home: agentHome,
			ctx,
			currentName: event.reason === "reload" ? priorName : undefined,
			warn,
		});
		if (!claim.ok) {
			warn(`kiln-lite: ${claim.reason}`);
			bound = null;
			ctx.shutdown();
			return;
		}
		bound = claim.session;
		if (bound.rebound) {
			try {
				pi.appendEntry(NAME_ENTRY, { name: bound.name, agent: config.name, home: agentHome });
			} catch (err) {
				warn(`kiln-lite: could not append ${NAME_ENTRY} entry: ${(err as Error).message}`);
			}
		}
		const agentId = bound.name;
		const sessionUuid = bound.uuid;
		const inboxDir = sessionInboxDir(sessionUuid);
		const env = buildEnv({ agentHome, agentId, sessionUuid, config, inboxDir });
		applyEnv(env);

		// One-time orientation for forks (/spawn) and resumes. A resume is a
		// start on a transcript that already had a registry entry.
		let sessionOrigin: SessionState["sessionOrigin"];
		const resumed = bound.entry.created !== bound.entry.names[bound.entry.names.length - 1]?.bound;
		if (event.reason === "resume" || (event.reason === "startup" && resumed)) {
			sessionOrigin = { kind: "resume" };
		} else if (event.reason === "fork" || event.reason === "startup") {
			const header = ctx.sessionManager.getHeader?.();
			if (header?.parentSession) sessionOrigin = { kind: "fork" };
		}

		state = {
			agentHome,
			agentId,
			sessionUuid,
			config,
			env,
			sessionOrigin,
		};
		lifecycle.start(state, warn);

		// Prompt parts, read from the files now (warnings surface at startup).
		// On a resume Pi compares the prompt built from them with the one in the
		// transcript and appends only what changed.
		promptParts = loadPromptParts(config, env, warn);

		periodicTime =
			config.timestamps === false
				? null
				: createPeriodicTimestamp(timestamps, {
						everyCalls: config.timestamps.every_calls,
						everyMs: config.timestamps.every_minutes * 60 * 1000,
					});

		try {
			mkdirSync(inboxDir, { recursive: true });
		} catch (err) {
			warn(`kiln-lite: failed to create inbox dir: ${(err as Error).message}`);
		}

		// Daemon registration is best-effort: a missing daemon must not block startup.
		daemon = new DaemonClient({
			requester: { agent: config.name, session: sessionUuid, name: agentId, inbox_path: inboxRoot() },
		});
		void daemon.register().catch((err) => warn(`kiln-lite: daemon register failed: ${(err as Error).message}`));

		// Inbox watcher starts last so it can't miss messages landing during startup.
		// transcriptEntries: ids already in the transcript count as delivered
		// (the transcript is the delivery ledger; .read markers are a cache).
		let transcriptEntries: readonly unknown[] = [];
		try {
			transcriptEntries = ctx.sessionManager.getEntries();
		} catch (err) {
			warn(`kiln-lite: could not read transcript entries for inbox ledger: ${(err as Error).message}`);
		}
		watcher = startInboxWatcher({ inboxDir, pi, isIdle: () => ctx.isIdle(), warn, transcriptEntries, selfSession: sessionUuid });

		sessionState = createSessionStateHook({
			getUnread: () => watcher?.unreadCount() ?? null,
			interval: config.session_state_interval,
		});

		if (ctx.hasUI) ctx.ui.setStatus("kiln-lite", `online as ${agentId}`);
	});

	// --- before_agent_start: prompt composition (never returns systemPrompt) ---
	pi.on("before_agent_start", async (event, ctx) => {
		if (!state || !promptParts) return;
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		let active: string[] | undefined;
		try {
			active = pi.getActiveTools();
		} catch {
			active = undefined;
		}
		applyPrompt(
			event.systemPromptOptions,
			promptParts,
			{
				agentName: state.config.name,
				sessionId: state.agentId,
				model,
				home: state.agentHome,
				inbox: state.env.KL_INBOX,
			},
			active,
		);
		return;
	});

	// --- before_agent_start: per-turn timestamp (hidden custom message) ---
	pi.on("before_agent_start", async () => {
		if (!state || state.config.timestamps === false) return;
		periodicTime?.reset();
		if (!state.config.timestamps.per_turn) return;
		return {
			message: {
				customType: "kiln-timestamp",
				content: `<system-reminder>${timestamps.stamp()}</system-reminder>`,
				display: false,
			},
		};
	});

	// --- before_agent_start: one-time fork/resume orientation ---
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

	pi.on("tool_result", async (event, ctx) => {
		if (!watcher) return;
		if (event.toolName === "read" && !event.isError) {
			const filePath = typeof event.input.path === "string" ? event.input.path : "";
			if (filePath) watcher.handleReadOfPath(filePath);
		}
		const stateBlock = sessionState ? sessionState.maybeBuildSuffix(ctx) : "";
		const inboxSuffix = watcher.midTurnSuffix();
		const timeSuffix = periodicTime?.maybeSuffix() ?? "";
		const planSuffix = planKit.maybeSuffix();
		const suffix = composeToolResultSuffix([stateBlock, planSuffix, inboxSuffix, timeSuffix]);
		if (suffix === null) return;
		return { content: appendTextToContent(event.content, suffix), details: event.details, isError: event.isError };
	});

	// --- message_end: an inbox batch counts as delivered once it lands ---
	pi.on("message_end", async (event) => {
		watcher?.handleMessageEnd(event.message);
	});

	// --- agent_end: cleanup-turn completion, then drain the inbox into user turns ---
	// The drain is skipped when shutdown is imminent (cleanup in flight or just
	// finished): the queued turns would never run (the silent-sweep bug,
	// commit ca82822).
	pi.on("agent_end", async (event, ctx) => {
		if (!state) return;
		if (lifecycle.handleAgentEnd(ctx, event.messages)) return;
		watcher?.dispatchIdle();
	});

	// Lease mirrors busy/idle so `kl sessions` (and later a reaper) can tell.
	pi.on("agent_start", async () => {
		if (bound) setLeaseState(bound, "busy");
	});
	pi.on("agent_settled", async () => {
		if (bound) setLeaseState(bound, "idle");
	});

	pi.on("session_shutdown", async () => {
		releaseSession(bound);
		bound = null;
		if (watcher) {
			watcher.stop();
			watcher = null;
		}
		if (daemon) {
			try {
				await Promise.race([daemon.deregister(), new Promise((r) => setTimeout(r, 500))]);
			} catch {
				// reconcile prunes us
			}
			daemon = null;
		}
		lifecycle.stop();
		state = null;
		promptParts = null;
	});

	return { getState: () => state, getDaemon: () => daemon, getWatcher: () => watcher };
}

function buildOriginReminder(origin: NonNullable<SessionState["sessionOrigin"]>, agentId: string): string {
	if (origin.kind === "fork") {
		const from = origin.parentAgentId ? `parent session ${origin.parentAgentId}` : "a parent session";
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
