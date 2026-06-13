/**
 * Cleanup-on-exit flow.
 *
 * Slash commands:
 *   /exit    — run the cleanup turn, then shut down (primary). Pi has no
 *              built-in /exit slash command, so this routes through our
 *              extension handler normally.
 *   /fq      — force quit: skip cleanup, shut down immediately (escape hatch)
 *
 * Note: we do NOT register /quit. Pi's interactive mode hardcodes
 * `if (text === "/quit") shutdown()` in its editor submit handler, which runs
 * before extension command dispatch, so an extension /quit handler is never
 * invoked. Ctrl+C (double) and Ctrl+D also call shutdown() directly and
 * bypass extension commands. Users who want cleanup must use /exit.
 *
 * Flow (when config.cleanup is non-empty):
 *   1. Expand {key} placeholders (state.vars + cleanup-specific vars)
 *   2. Embed a unique sentinel in the prompt (so we can identify completion)
 *   3. pi.sendUserMessage(prompt, { deliverAs: "followUp" }) — queues after current turn
 *   4. A persistent agent_end listener (registered once from index.ts) watches for
 *      the sentinel in agent_end messages; when matched, calls ctx.shutdown().
 *
 * If config.cleanup is empty/unset: skip the cleanup turn entirely, shut down
 * immediately. Simple case.
 *
 * Escape hatch: a second /exit while cleanup is in flight
 * force-exits — same effect as /fq.
 */

import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SessionState } from "./types.ts";
import { expandPlaceholders } from "./placeholders.ts";

export interface CleanupDispatcher {
	/** True if a cleanup turn is currently in flight. */
	inProgress(): boolean;
	/** Dispatch a cleanup turn (or exit immediately if cleanup is empty/unset). */
	dispatch(ctx: ExtensionContext): void;
	/** Bypass any in-flight cleanup and shut down immediately. */
	forceExit(ctx: ExtensionContext): void;
	/**
	 * Called from the single persistent agent_end handler.
	 * If this agent_end corresponds to the in-flight cleanup, shuts down and
	 * returns true. Otherwise returns false.
	 */
	handleAgentEnd(ctx: ExtensionContext, messages: unknown[]): boolean;
}

function fmtDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}



function summaryPath(state: SessionState): string {
	const today = fmtDate(new Date());
	return join(state.agentHome, state.config.sessions_dir, `${today}-${state.agentId}.md`);
}

function ensureSummaryDir(state: SessionState, warn: (msg: string) => void): void {
	const dir = dirname(summaryPath(state));
	try {
		mkdirSync(dir, { recursive: true });
	} catch (err) {
		warn(`kiln-lite: failed to create sessions dir ${dir}: ${(err as Error).message}`);
	}
}

function buildCleanupPrompt(state: SessionState, sentinel: string): string {
	// Merge state.vars (base + harness-provided) with cleanup-specific vars.
	const vars: Record<string, string> = {
		...state.vars,
		today: fmtDate(new Date()),
		summary_path: summaryPath(state),
	};
	const body = expandPlaceholders(state.config.cleanup, vars);
	// HTML comment keeps the sentinel visible in message content (for our scan) but
	// unobtrusive for the agent reading the prompt.
	return `${body}\n\n<!-- kiln-lite:cleanup:${sentinel} -->`;
}

export function createCleanupDispatcher(
	pi: ExtensionAPI,
	state: SessionState,
	warn: (msg: string) => void,
): CleanupDispatcher {
	let pendingSentinel: string | null = null;

	function dispatch(ctx: ExtensionContext): void {
		if (!state.config.cleanup.trim()) {
			ctx.shutdown();
			return;
		}
		if (pendingSentinel) {
			warn("kiln-lite: cleanup already in progress — ignoring duplicate request");
			return;
		}
		const sentinel = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		pendingSentinel = sentinel;
		ensureSummaryDir(state, warn);

		const prompt = buildCleanupPrompt(state, sentinel);
		try {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (err) {
			warn(`kiln-lite: failed to dispatch cleanup prompt: ${(err as Error).message} — exiting`);
			pendingSentinel = null;
			ctx.shutdown();
		}
	}

	function forceExit(ctx: ExtensionContext): void {
		pendingSentinel = null;
		ctx.shutdown();
	}

	function handleAgentEnd(ctx: ExtensionContext, messages: unknown[]): boolean {
		if (!pendingSentinel) return false;
		const haystack = JSON.stringify(messages);
		if (!haystack.includes(pendingSentinel)) return false;
		pendingSentinel = null;
		ctx.shutdown();
		return true;
	}

	return {
		inProgress: () => pendingSentinel !== null,
		dispatch,
		forceExit,
		handleAgentEnd,
	};
}

/**
 * Register /exit (cleanup then shutdown) and /fq (pure exit, skips cleanup).
 *
 * /quit is intentionally NOT registered — see the file-level comment. Pi's
 * interactive mode intercepts /quit before extension dispatch, so registering
 * it only produces a misleading autocomplete-conflict warning without ever
 * firing our handler.
 *
 * Second invocation of /exit during in-flight cleanup force-exits (escape
 * hatch for an agent stuck in a bad cleanup turn).
 */
export function registerExitCommands(pi: ExtensionAPI, dispatcher: CleanupDispatcher): void {
	// /exit is not a pi built-in slash command (pi only binds it as a
	// keybinding action name for Ctrl+D), so registering it here routes
	// through the normal extension command dispatcher. This lets users
	// reach for the conventional /exit and still get cleanup.
	pi.registerCommand("exit", {
		description: "Run the cleanup flow (summary, memory updates) then exit",
		handler: async (_args, ctx) => {
			if (dispatcher.inProgress()) {
				ctx.ui.notify("kiln-lite: cleanup already in flight — force-exiting", "warning");
				dispatcher.forceExit(ctx);
				return;
			}
			dispatcher.dispatch(ctx);
		},
	});

	// Force quit — no cleanup, no summary. For when cleanup is broken or
	// you just want out.
	pi.registerCommand("fq", {
		description: "Force quit — skip cleanup, exit immediately",
		handler: async (_args, ctx) => {
			dispatcher.forceExit(ctx);
		},
	});
}
