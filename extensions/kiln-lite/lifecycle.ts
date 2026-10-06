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
 *
 * The system prompt is rebuilt at a reset (hooks.onReset), so the run that
 * commits the reset ends there: Pi applies prompt changes only when a new run
 * starts (before_agent_start), not when a run continues. Inbox messages that
 * arrive meanwhile are held back, and once the run settles an autonomous reset
 * starts a new run with RESET_KICKOFF, then hooks.afterReset delivers them.
 */

import type {
	CompactionEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

import { createCleanupDispatcher, registerExitCommands, type CleanupDispatcher } from "./cleanup.ts";
import { buildExitSessionTool, type ResetRequest } from "./exit-session-tool.ts";
import type { SessionState } from "./types.ts";

/** `details.source` on kl's reset compaction entries, to tell them from Pi's own compactions. */
export const RESET_SOURCE = "kl-reset";

const EMPTY_HANDOFF = "(The previous context was reset without a handoff.)";

/** The user turn that starts an autonomous reset's new run. */
export const RESET_KICKOFF = "<system-reminder>Your context was reset. Carry on from the handoff above.</system-reminder>";

export interface LifecycleHooks {
	/** A reset is committing. Returns entries to append after the reset's compaction. */
	onReset?(ctx: ExtensionContext): SessionBoundaryDraft[];
	/** The run that committed a reset has settled. Deliver what agent_end held back. */
	afterReset?(): void;
}

export interface Lifecycle {
	/** Create the dispatcher for this session. Call from core's session_start. */
	start(state: SessionState, warn: (msg: string) => void): void;
	/**
	 * Call from core's agent_end, before the inbox drain. Returns true when
	 * the drain should be skipped: the session is about to shut down (queued
	 * turns would never run), or a reset is about to commit (they'd run on
	 * the old prompt; afterReset delivers them).
	 */
	handleAgentEnd(ctx: ExtensionContext, messages: unknown[]): boolean;
	/** A cleanup turn, exit or reset is pending or running. */
	busy(): boolean;
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

export function installLifecycle(pi: ExtensionAPI, hooks: LifecycleHooks = {}): Lifecycle {
	let dispatcher: CleanupDispatcher | null = null;
	/** Requested by exit_session continue; waiting for the exit path to finish. */
	let armed: ResetRequest | null = null;
	/** The exit path finished with a reset armed; commit at the next agent_before_settle. */
	let ready: ResetRequest | null = null;
	/** Committed at agent_before_settle; acted on at agent_settled. */
	let committed: ResetRequest | null = null;
	let shuttingDown = false;
	let warn: (msg: string) => void = console.warn;

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

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!ready) return;
		const req = ready;
		ready = null;
		committed = req;
		let extra: SessionBoundaryDraft[] = [];
		try {
			extra = hooks.onReset?.(ctx) ?? [];
		} catch (err) {
			warn(`kiln-lite: rebuilding the prompt at reset failed: ${(err as Error).message}`);
		}
		if (ctx.hasUI) ctx.ui.notify("kiln-lite: context reset; the handoff carries on", "info");
		// Pi hands each handler the drafts so far and takes `entries` as the new full list.
		return { entries: [...event.entries, resetEntry(req.handoff), ...extra], continue: false };
	});

	pi.on("agent_settled", async () => {
		if (!committed) return;
		const req = committed;
		committed = null;
		// Sent from agent_settled, Pi starts these as new runs once the settle finishes.
		if (req.autonomous) pi.sendUserMessage(RESET_KICKOFF);
		hooks.afterReset?.();
	});

	return {
		start(state, warnFn) {
			armed = null;
			ready = null;
			committed = null;
			shuttingDown = false;
			warn = warnFn;
			dispatcher = createCleanupDispatcher(pi, state, warn, finish);
		},
		handleAgentEnd(ctx, messages) {
			// A cleanup turn still in flight (its sentinel not in this run) means
			// an exit is pending: don't queue inbox turns behind it.
			const wasInFlight = facade.inProgress();
			facade.handleAgentEnd(ctx, messages);
			if (shuttingDown || ready) return true;
			return wasInFlight && facade.inProgress();
		},
		busy() {
			return armed !== null || ready !== null || shuttingDown || facade.inProgress();
		},
		stop() {
			dispatcher = null;
			armed = null;
			ready = null;
			committed = null;
		},
	};
}
