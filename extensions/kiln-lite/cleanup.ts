/**
 * Cleanup-on-exit flow.
 *
 * Three slash commands:
 *   /wrapup  — run the cleanup turn, then shut down (primary)
 *   /exit    — alias for /wrapup (overrides Pi's builtin)
 *   /quit    — alias for /wrapup (overrides Pi's builtin)
 *   /fq      — force quit: skip cleanup, shut down immediately (escape hatch)
 *
 * Flow (when config.cleanup is non-empty):
 *   1. Render cleanup template with {today}, {agent_id}, {session_uuid}, {summary_path}
 *   2. Embed a unique sentinel in the prompt (so we can identify completion)
 *   3. pi.sendUserMessage(prompt, { deliverAs: "followUp" }) — queues after current turn
 *   4. A persistent agent_end listener (registered once from index.ts) watches for
 *      the sentinel in agent_end messages; when matched, calls ctx.shutdown().
 *
 * If config.cleanup is empty/unset: skip the cleanup turn entirely, shut down
 * immediately. Simple case.
 *
 * Escape hatch: a second /wrapup (or /exit, /quit) while cleanup is in flight
 * force-exits — same effect as /fq.
 */

import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { SessionState } from "./types.ts";

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

function renderTemplate(tpl: string, vars: Record<string, string>): string {
	return tpl.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match));
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
	const vars: Record<string, string> = {
		today: fmtDate(new Date()),
		agent_id: state.agentId,
		session_uuid: state.sessionUuid,
		summary_path: summaryPath(state),
	};
	const body = renderTemplate(state.config.cleanup, vars);
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
 * Register /wrapup, /exit, /quit (all run cleanup then shutdown), and /fq
 * (pure exit, skips cleanup).
 *
 * Second invocation of a cleanup command during in-flight cleanup force-exits
 * (escape hatch for an agent stuck in a bad cleanup turn).
 */
export function registerExitCommands(pi: ExtensionAPI, dispatcher: CleanupDispatcher): void {
	const wrapupHandler = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (dispatcher.inProgress()) {
			ctx.ui.notify("kiln-lite: cleanup already in flight — force-exiting", "warning");
			dispatcher.forceExit(ctx);
			return;
		}
		dispatcher.dispatch(ctx);
	};

	pi.registerCommand("wrapup", {
		description: "Run the cleanup flow (summary, memory updates) then exit",
		handler: wrapupHandler,
	});

	// Override Pi's builtins so standard exits run cleanup too. Agents and
	// users alike expect /exit and /quit to Just Work; keeping them aligned
	// with /wrapup prevents accidental data loss.
	pi.registerCommand("exit", {
		description: "Run the cleanup flow (summary, memory updates) then exit",
		handler: wrapupHandler,
	});
	pi.registerCommand("quit", {
		description: "Run the cleanup flow (summary, memory updates) then exit",
		handler: wrapupHandler,
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
