/**
 * kl core harness.
 *
 * Everything a kl agent needs: config, session id + env, prompt composition
 *, timestamps, messaging (daemon, inbox, message tool), /spawn,
 * plan tool, command gates, and the lifecycle (cleanup turn, /exit, /fq,
 * exit_session, in-session reset; ../lifecycle.ts).
 *
 * There is no persistence code: a "persistent" agent is one whose
 * folder `kl init --full` scaffolded with a cleanup prompt and memory
 * sections. The cleanup turn runs only when `cleanup:` is configured.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveAgentHomeDetailed, loadConfig, resolveKlRoot } from "../config.ts";
import { buildEnv, applyEnv } from "../env.ts";
import {
	applyPrompt,
	loadBaseline,
	loadIdentity,
	renderSections,
	type PromptParts,
} from "../prompt.ts";
import { startInboxWatcher, type InboxWatcher } from "../inbox.ts";
import { buildMessageTool } from "../message-tool.ts";
import { buildPlanToolKit } from "../plan-tool.ts";
import { registerSpawnCommand } from "../spawn.ts";
import { createSessionStateHook, type SessionStateHook } from "../session-state.ts";
import { createTimestampInjector, createPeriodicTimestamp, type PeriodicTimestamp } from "../timestamp.ts";
import { loadCommandGates, applyCommandGates, type CompiledGate } from "../gates.ts";
import { readMeta, writeMeta, type SnapshotMeta } from "../snapshot.ts";
import { installLifecycle } from "../lifecycle.ts";
import type { SessionState } from "../types.ts";
import { DaemonClient } from "../../../src/client/index.ts";

import { resolveAgentId } from "./resolve-agent-id.ts";
import { composeToolResultSuffix, appendTextToContent } from "./formatting.ts";

export interface CoreHandle {
	getState: () => SessionState | null;
	getDaemon: () => DaemonClient | null;
	getWatcher: () => InboxWatcher | null;
}

export function installCore(pi: ExtensionAPI): CoreHandle {
	let state: SessionState | null = null;
	let promptParts: PromptParts | null = null;
	let watcher: InboxWatcher | null = null;
	let daemon: DaemonClient | null = null;
	let sessionState: SessionStateHook | null = null;
	let gates: CompiledGate[] = [];
	let originReminderSent = false;
	const timestamps = createTimestampInjector();
	let periodicTime: PeriodicTimestamp | null = null;

	// Tools register at load time; their closures read live state lazily.
	pi.registerTool(buildMessageTool({ getDaemon: () => daemon }));
	const planKit = buildPlanToolKit({
		getAgentHome: () => state?.agentHome ?? null,
		getAgentId: () => state?.agentId ?? null,
	});
	pi.registerTool(planKit.tool);
	registerSpawnCommand(pi);
	const lifecycle = installLifecycle(pi);

	pi.on("session_start", async (event, ctx) => {
		const warn = (msg: string) => {
			console.warn(msg);
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		};

		const { path: agentHome } = resolveAgentHomeDetailed();
		try {
			mkdirSync(agentHome, { recursive: true });
		} catch (err) {
			warn(`kiln-lite: failed to create agent home ${agentHome}: ${(err as Error).message}`);
		}

		const config = loadConfig({ agentHome, warn });
		const sessionUuid = inferSessionUuid(ctx);
		const { agentId } = resolveAgentId({
			agentHome,
			envAgentId: process.env.AGENT_ID,
			sessionUuid,
			namePrefix: config.name,
			warn,
		});
		const env = buildEnv({ agentHome, agentId, sessionUuid, config });
		applyEnv(env);

		// One-time orientation for forks (/spawn) and resumes (`kl resume`).
		let sessionOrigin: SessionState["sessionOrigin"];
		const freshBoot = event.reason === "startup";
		const existingMeta = readMeta(agentHome, agentId, () => {});
		if (event.reason === "resume" || (freshBoot && existingMeta !== null)) {
			sessionOrigin = { kind: "resume" };
		} else if (event.reason === "fork" || freshBoot) {
			const header = ctx.sessionManager.getHeader?.();
			if (header?.parentSession) {
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
			sessionOrigin,
			vars: { agent_id: agentId, agent_home: agentHome },
		};
		updateSnapshotMeta(state, ctx, warn);
		lifecycle.start(state, warn);

		// Prompt parts: read once, cached for the session. Warnings surface now,
		// at startup, where the user can see them.
		promptParts = {
			identity: loadIdentity(config, warn),
			baseline: loadBaseline(warn),
			sections: renderSections(config.sections, env, warn),
			projectContext: config.project_context,
		};

		periodicTime =
			config.timestamps === false
				? null
				: createPeriodicTimestamp(timestamps, {
						everyCalls: config.timestamps.every_calls,
						everyMs: config.timestamps.every_minutes * 60 * 1000,
					});

		const inboxDir = join(agentHome, config.inbox_dir, agentId);
		try {
			mkdirSync(inboxDir, { recursive: true });
		} catch (err) {
			warn(`kiln-lite: failed to create inbox dir: ${(err as Error).message}`);
		}

		// Daemon registration is best-effort: a missing daemon must not block startup.
		daemon = new DaemonClient({
			requester: { agent: config.name, session: agentId, inbox_path: join(agentHome, config.inbox_dir) },
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
		watcher = startInboxWatcher({ inboxDir, pi, isIdle: () => ctx.isIdle(), warn, transcriptEntries });

		sessionState = createSessionStateHook({
			getDaemon: () => daemon,
			getAgentId: () => state?.agentId ?? null,
			getWatcher: () => watcher,
			interval: config.session_state_interval,
		});

		gates = loadCommandGates(resolveKlRoot(), warn);

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
			{ agentName: state.config.name, sessionId: state.agentId, model, home: state.agentHome },
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

	pi.on("tool_call", async (event, ctx) => {
		if (gates.length === 0) return;
		return applyCommandGates(gates, event.toolName, event.input as Record<string, unknown>, ctx, {
			agentId: state?.agentId ?? "agent",
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!watcher) return;
		if (event.toolName === "read" && !event.isError) {
			const filePath = typeof event.input.path === "string" ? event.input.path : "";
			if (filePath) watcher.handleReadOfPath(filePath);
		}
		const stateBlock = sessionState ? await sessionState.maybeBuildSuffix(ctx) : "";
		const planSuffix = planKit.maybeSuffix();
		const inboxSuffix = watcher.midTurnSuffix();
		const timeSuffix = periodicTime?.maybeSuffix() ?? "";
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
	// commit ca82822). After a reset it runs; the messages land post-reset.
	pi.on("agent_end", async (event, ctx) => {
		if (!state) return;
		if (lifecycle.handleAgentEnd(ctx, event.messages)) return;
		watcher?.dispatchIdle();
	});

	pi.on("session_shutdown", async () => {
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
		gates = [];
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

/** Session UUID from the transcript file name (<ts>_<uuid>.jsonl). Transcript-only. */
export function inferSessionUuid(ctx: { sessionManager: { getSessionFile(): string | undefined } }): string {
	const file = ctx.sessionManager.getSessionFile();
	if (file) {
		const m = file.match(/([0-9a-fA-F-]{20,})\.jsonl$/);
		if (m) return m[1];
	}
	return `ephemeral-${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * Refresh state/sessions/<id>/meta.json, which `kl resume` / `kl history`
 * read. Interim: the registry slice replaces this with ~/.kl/run.
 */
function updateSnapshotMeta(
	state: SessionState,
	ctx: { sessionManager: { getSessionFile(): string | undefined }; cwd: string; model?: { id?: string } },
	warn: (msg: string) => void,
): void {
	const nowIso = new Date().toISOString();
	const existing = readMeta(state.agentHome, state.agentId, warn);
	const meta: SnapshotMeta = {
		...(existing ?? {}),
		agent_id: state.agentId,
		pi_session_uuid: state.sessionUuid,
		pi_session_jsonl: ctx.sessionManager.getSessionFile() ?? existing?.pi_session_jsonl,
		cwd: ctx.cwd ?? existing?.cwd,
		model: ctx.model?.id ?? existing?.model,
		parent: process.env.KL_PARENT || existing?.parent,
		created_at: existing?.created_at ?? nowIso,
		last_seen: nowIso,
	};
	writeMeta(state.agentHome, meta, warn);
}
