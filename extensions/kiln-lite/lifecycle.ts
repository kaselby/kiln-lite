/**
 * Session lifecycle (core, every agent): the cleanup turn, /exit and
 * /fq, the exit_session tool, and the in-session reset.
 *
 * The cleanup turn runs only if the agent configures a `cleanup:` prompt;
 * agents without one exit plainly. "Persistent" agents differ only in what
 * `kl init --full` scaffolds (a cleanup prompt, memory files), not in code.
 *
 * Reset (exit_session continue): once the exit path finishes (after the
 * cleanup turn, or immediately), the next `agent_before_settle` appends a Pi
 * compaction entry with summary = the handoff and firstKeptEntryId = null,
 * so the model's context restarts from the system prompt plus that summary.
 * Same session id, transcript, inbox and children.
 */

import type { CompactionEntryDraft, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createCleanupDispatcher, registerExitCommands, type CleanupDispatcher } from "./cleanup.ts";
import { buildExitSessionTool, type ResetRequest } from "./exit-session-tool.ts";
import type { SessionState } from "./types.ts";

/** `details.source` on kl's reset compaction entries, to tell them from Pi's own compactions. */
export const RESET_SOURCE = "kl-reset";

const EMPTY_HANDOFF = "(The previous context was reset without a handoff.)";

export interface Lifecycle {
	/** Create the dispatcher for this session. Call from core's session_start. */
	start(state: SessionState, warn: (msg: string) => void): void;
	/**
	 * Call from core's agent_end, before the inbox drain. Returns true when
	 * the session is about to shut down, so the drain should be skipped
	 * (queued turns would never run).
	 */
	handleAgentEnd(ctx: ExtensionContext, messages: unknown[]): boolean;
	stop(): void;
}

/** The compaction entry a reset appends. Pure, for tests. */
export function resetEntry(handoff: string): CompactionEntryDraft {
	return {
		type: "compaction",
		summary: handoff.trim() ? handoff : EMPTY_HANDOFF,
		firstKeptEntryId: null,
		details: { source: RESET_SOURCE },
	};
}

export function installLifecycle(pi: ExtensionAPI): Lifecycle {
	let dispatcher: CleanupDispatcher | null = null;
	/** Requested by exit_session continue; waiting for the exit path to finish. */
	let armed: ResetRequest | null = null;
	/** The exit path finished with a reset armed; commit at the next agent_before_settle. */
	let ready: ResetRequest | null = null;
	let shuttingDown = false;

	const finish = (ctx: ExtensionContext) => {
		if (armed) {
			ready = armed;
			armed = null;
			return;
		}
		shuttingDown = true;
		ctx.shutdown();
	};

	// Stable façade so the tool and commands, registered at load time, reach
	// the per-session dispatcher.
	const facade: CleanupDispatcher = {
		inProgress: () => dispatcher?.inProgress() ?? false,
		hasPrompt: () => dispatcher?.hasPrompt() ?? false,
		dispatch: (ctx) => (dispatcher ? dispatcher.dispatch(ctx) : finish(ctx)),
		forceExit: (ctx) => {
			armed = null;
			ready = null;
			shuttingDown = true;
			if (dispatcher) dispatcher.forceExit(ctx);
			else ctx.shutdown();
		},
		skip: (ctx) => (dispatcher ? dispatcher.skip(ctx) : finish(ctx)),
		handleAgentEnd: (ctx, messages) => dispatcher?.handleAgentEnd(ctx, messages) ?? false,
	};

	pi.registerTool(
		buildExitSessionTool({
			getDispatcher: () => (dispatcher ? facade : null),
			requestReset: (req) => {
				armed = req;
			},
		}),
	);
	registerExitCommands(pi, facade);

	pi.on("agent_before_settle", async (_event, ctx) => {
		if (!ready) return;
		const req = ready;
		ready = null;
		if (ctx.hasUI) ctx.ui.notify("kiln-lite: context reset; the handoff carries on", "info");
		return { entries: [resetEntry(req.handoff)], continue: req.autonomous };
	});

	return {
		start(state, warn) {
			armed = null;
			ready = null;
			shuttingDown = false;
			dispatcher = createCleanupDispatcher(pi, state, warn, finish);
		},
		handleAgentEnd(ctx, messages) {
			// A cleanup turn still in flight (its sentinel not in this run) means
			// an exit is pending: don't queue inbox turns behind it.
			const wasInFlight = facade.inProgress();
			facade.handleAgentEnd(ctx, messages);
			if (shuttingDown) return true;
			return wasInFlight && facade.inProgress();
		},
		stop() {
			dispatcher = null;
			armed = null;
			ready = null;
		},
	};
}
