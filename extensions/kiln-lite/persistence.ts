/**
 * kl persistence entry point — a separate Pi extension from core.
 *
 * Holds the persistent-agent rituals: the cleanup turn (/exit, /fq), the
 * exit_session tool, and continuation spawning + handoff markers. `kl`
 * loads this file (with -e, after core) only for agents whose config uses
 * it (today: a non-empty `cleanup:`). A simple agent runs with none of this
 * loaded. Core never imports this file; the only coupling is the
 * CLEANUP_EVENT notice on Pi's shared event bus.
 *
 * This file only re-homes the existing wiring from the old lib/install.ts;
 * the persistence slice will rework it (continuation becomes an
 * in-session reset).
 */

import { basename } from "node:path";
import { execFileSync } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { resolveAgentHomeDetailed, loadConfig } from "./config.ts";
import { createCleanupDispatcher, registerExitCommands, type CleanupDispatcher } from "./cleanup.ts";
import { buildExitSessionTool } from "./exit-session-tool.ts";
import {
	handoffTmuxClient,
	buildContinuationArgs,
	persistHandoff,
	type ContinuationConfig,
} from "./exit-session.ts";
import type { SessionState } from "./types.ts";

/** Must match CLEANUP_EVENT in lib/core.ts (not imported, by design). */
const CLEANUP_EVENT = "kl:cleanup";

export default function (pi: ExtensionAPI): void {
	let state: SessionState | null = null;
	let dispatcher: CleanupDispatcher | null = null;
	let continuation: ContinuationConfig | null = null;
	let handoffReminderPending = false;

	pi.registerTool(
		buildExitSessionTool({
			getDispatcher: () => dispatcher,
			setContinuation: (config) => {
				continuation = config;
			},
			getTemplate: () => undefined,
		}),
	);

	pi.on("session_start", async (event, ctx) => {
		const warn = (msg: string) => {
			console.warn(msg);
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		};
		const { path: agentHome } = resolveAgentHomeDetailed();
		const config = loadConfig({ agentHome, warn: () => {} }); // core already warned
		const agentId = process.env.AGENT_ID?.trim() || basename(agentHome);
		const handoffPath = event.reason === "startup" ? process.env.KL_HANDOFF?.trim() || undefined : undefined;
		state = {
			agentHome,
			agentId,
			sessionUuid: "",
			config,
			env: {},
			sessionOrigin: handoffPath ? { kind: "handoff", handoffPath } : undefined,
			vars: { agent_id: agentId, agent_home: agentHome },
		};

		const inner = createCleanupDispatcher(pi, state, warn);
		dispatcher = {
			...inner,
			dispatch: (c) => {
				inner.dispatch(c);
				pi.events.emit(CLEANUP_EVENT, { inFlight: inner.inProgress() });
			},
			forceExit: (c) => {
				pi.events.emit(CLEANUP_EVENT, { inFlight: false });
				inner.forceExit(c);
			},
		};
		registerExitCommands(pi, dispatcher, { onForceExit: () => (continuation = null) });

		if (handoffPath) {
			handoffReminderPending = true;
			try {
				ctx.ui?.setStatus?.("kiln-handoff", ctx.ui.theme.fg("accent", "⇄ handoff"));
				ctx.ui?.setWidget?.("kiln-handoff", (_tui, theme) => ({
					render: (width: number) => [
						theme.fg("accent", "⇄ Continuation session — picks up from a handoff"),
						truncateToWidth(theme.fg("muted", `  handoff notes: ${handoffPath}`), width),
					],
					invalidate: () => {},
				}));
			} catch (err) {
				warn(`kiln-lite: failed to set handoff markers (${(err as Error).message})`);
			}
		}
	});

	pi.on("before_agent_start", async () => {
		if (!handoffReminderPending || state?.sessionOrigin?.kind !== "handoff") return;
		handoffReminderPending = false;
		return {
			message: {
				customType: "kiln-session-origin",
				content:
					`<system-reminder>You have received a handoff from a previous session. ` +
					`Read \`${state.sessionOrigin.handoffPath}\` to orient yourself — it holds what the prior ` +
					`session was doing and where it left off — then continue that work as ` +
					`agent ${state.agentId}.</system-reminder>`,
				display: false,
			},
		};
	});

	// Runs after core's agent_end (core is loaded first), which skipped its
	// inbox drain because CLEANUP_EVENT said a cleanup turn was in flight.
	pi.on("agent_end", async (event, ctx) => {
		dispatcher?.handleAgentEnd(ctx, event.messages);
	});

	pi.on("session_shutdown", async () => {
		const pending = continuation;
		const agentHome = state?.agentHome;
		const priorAgentId = state?.agentId;
		continuation = null;
		dispatcher = null;
		state = null;
		if (pending && agentHome) spawnContinuation(pending, agentHome, priorAgentId);
	});
}

function spawnContinuation(config: ContinuationConfig, agentHome: string, priorAgentId: string | undefined): void {
	const warn = (msg: string) => console.warn(msg);
	let handoffPath: string | undefined;
	if (config.handoff) {
		try {
			handoffPath = persistHandoff(agentHome, basename(agentHome), config.handoff);
		} catch (err) {
			warn(`kiln-lite: failed to persist handoff (${(err as Error).message}) — continuation will spawn without it`);
		}
	}
	const args = buildContinuationArgs({ handoffPath, model: config.model, autonomous: config.autonomous });
	try {
		const stdout = execFileSync("kl", args, { env: { ...process.env, AGENT_HOME: agentHome }, timeout: 5000 });
		const agentId = stdout.toString().trim();
		console.log(`kiln-lite: continuation spawned → ${agentId}`);
		handoffTmuxClient(priorAgentId, agentId, { warn });
	} catch (err) {
		warn(`kiln-lite: failed to spawn continuation: ${(err as Error).message}`);
	}
}
