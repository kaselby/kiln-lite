/**
 * Session lifecycle (core, every agent): the cleanup turn, /exit and
 * /fq, and the exit_session tool.
 *
 * The cleanup turn runs only if the agent configures a `cleanup:` prompt;
 * agents without one exit plainly. "Persistent" agents differ only in what
 * `kl init --full` scaffolds (a cleanup prompt, memory files), not in code.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createCleanupDispatcher, registerExitCommands, type CleanupDispatcher } from "./cleanup.ts";
import { buildExitSessionTool } from "./exit-session-tool.ts";
import type { SessionState } from "./types.ts";

export interface Lifecycle {
	/** Create the dispatcher for this session. Call from core's session_start. */
	start(state: SessionState, warn: (msg: string) => void): void;
	/**
	 * Call from core's agent_end, before the inbox drain. Returns true when
	 * the session is about to shut down, so the drain should be skipped: the
	 * queued turns would never run.
	 */
	handleAgentEnd(ctx: ExtensionContext, messages: unknown[]): boolean;
	/** An exit is under way: a cleanup turn is pending or running, or shutdown was requested. */
	exiting(): boolean;
	stop(): void;
}

export function installLifecycle(pi: ExtensionAPI): Lifecycle {
	let dispatcher: CleanupDispatcher | null = null;
	let shuttingDown = false;

	const shutdown = (ctx: ExtensionContext) => {
		shuttingDown = true;
		ctx.shutdown();
	};

	// Stable façade so the tool and commands, registered at load time, reach
	// the per-session dispatcher.
	const facade: CleanupDispatcher = {
		inProgress: () => dispatcher?.inProgress() ?? false,
		hasPrompt: () => dispatcher?.hasPrompt() ?? false,
		dispatch: (ctx) => (dispatcher ? dispatcher.dispatch(ctx) : shutdown(ctx)),
		exitNow: (ctx) => (dispatcher ? dispatcher.exitNow(ctx) : shutdown(ctx)),
		handleAgentEnd: (ctx, messages) => dispatcher?.handleAgentEnd(ctx, messages) ?? false,
	};

	pi.registerTool(buildExitSessionTool({ getDispatcher: () => (dispatcher ? facade : null) }));
	registerExitCommands(pi, facade);

	return {
		start(state, warn) {
			shuttingDown = false;
			dispatcher = createCleanupDispatcher(pi, state, warn, shutdown);
		},
		handleAgentEnd(ctx, messages) {
			// A cleanup turn still in flight (its sentinel not in this run) means
			// an exit is pending: don't queue inbox turns behind it.
			const wasInFlight = facade.inProgress();
			facade.handleAgentEnd(ctx, messages);
			if (shuttingDown) return true;
			return wasInFlight && facade.inProgress();
		},
		exiting() {
			return shuttingDown || facade.inProgress();
		},
		stop() {
			dispatcher = null;
		},
	};
}
