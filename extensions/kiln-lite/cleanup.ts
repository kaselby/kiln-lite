/**
 * Cleanup-on-exit flow.
 *
 * `/cleanup` runs the agent's cleanup turn, then quits. A second `/cleanup`
 * while the cleanup turn runs quits at once (for a stuck cleanup turn).
 * Pi's own `/quit` (and Ctrl+C twice, Ctrl+D) is the plain quit: Pi handles
 * those before extension commands, so they never run the cleanup turn.
 *
 * The cleanup turn is core: every agent gets it, and it runs only if
 * the agent configures a `cleanup:` prompt. Agents without one exit plainly.
 *
 * Flow (when the configured cleanup source resolves to non-empty text):
 *   1. Resolve inline text or read the configured file path
 *   2. Strip HTML comments (authoring notes, like IDENTITY.md's)
 *   3. Embed a unique sentinel in the prompt (so we can identify completion)
 *   4. pi.sendUserMessage(prompt, { deliverAs: "followUp" }) — queues after current turn
 *   5. Core's agent_end handler watches for the sentinel in agent_end messages;
 *      when matched, shuts down.
 *
 * If the cleanup source is empty, unset, missing, or unreadable: skip the
 * cleanup turn and shut down normally after surfacing any resolution warning.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SessionState } from "./types.ts";
import { resolvePromptSource } from "./prompt-source.ts";

export interface CleanupDispatcher {
	/** True if a cleanup turn is currently in flight. */
	inProgress(): boolean;
	/** True if the agent configures a non-empty cleanup prompt (so dispatch runs a turn). */
	hasPrompt(): boolean;
	/** Dispatch a cleanup turn (or exit immediately if cleanup is empty/unset). */
	dispatch(ctx: ExtensionContext): void;
	/** Skip (or abandon an in-flight) cleanup turn and shut down now. */
	exitNow(ctx: ExtensionContext): void;
	/**
	 * Called from the single persistent agent_end handler.
	 * If this agent_end corresponds to the in-flight cleanup, shuts down and
	 * returns true. Otherwise returns false.
	 */
	handleAgentEnd(ctx: ExtensionContext, messages: unknown[]): boolean;
}

/** Drop `<!-- ... -->` authoring comments; the prompt goes to the model as a user turn. */
export function stripHtmlComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function buildCleanupPrompt(body: string, sentinel: string): string {
	// The sentinel rides in an HTML comment: visible in message content (for
	// our scan), unobtrusive for the agent. Added after stripping.
	return `${stripHtmlComments(body)}\n\n<!-- kiln-lite:cleanup:${sentinel} -->`;
}

/**
 * `shutdown` ends the session: right away when there is no cleanup prompt,
 * or after the cleanup turn's agent_end. The lifecycle module passes one that
 * also records that an exit is under way.
 */
export function createCleanupDispatcher(
	pi: ExtensionAPI,
	state: SessionState,
	warn: (msg: string) => void,
	shutdown: (ctx: ExtensionContext) => void = (ctx) => ctx.shutdown(),
): CleanupDispatcher {
	let pendingSentinel: string | null = null;

	const resolveBody = (w: (msg: string) => void) =>
		resolvePromptSource(state.config.cleanup, state.agentHome, "cleanup prompt", w);

	function dispatch(ctx: ExtensionContext): void {
		const body = resolveBody(warn);
		if (body === null || !stripHtmlComments(body)) {
			shutdown(ctx);
			return;
		}
		if (pendingSentinel) {
			warn("kiln-lite: cleanup already in progress — ignoring duplicate request");
			return;
		}
		const sentinel = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		pendingSentinel = sentinel;
		const prompt = buildCleanupPrompt(body, sentinel);
		try {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (err) {
			warn(`kiln-lite: failed to dispatch cleanup prompt: ${(err as Error).message} — exiting`);
			pendingSentinel = null;
			shutdown(ctx);
		}
	}

	function exitNow(ctx: ExtensionContext): void {
		pendingSentinel = null;
		shutdown(ctx);
	}

	function handleAgentEnd(ctx: ExtensionContext, messages: unknown[]): boolean {
		if (!pendingSentinel) return false;
		const haystack = JSON.stringify(messages);
		if (!haystack.includes(pendingSentinel)) return false;
		pendingSentinel = null;
		shutdown(ctx);
		return true;
	}

	return {
		inProgress: () => pendingSentinel !== null,
		hasPrompt: () => {
			const body = resolveBody(() => {});
			return body !== null && stripHtmlComments(body) !== "";
		},
		dispatch,
		exitNow,
		handleAgentEnd,
	};
}

/** Register `/cleanup`: the cleanup turn, then quit; a second `/cleanup` during it quits at once. */
export function registerCleanupCommand(pi: ExtensionAPI, dispatcher: CleanupDispatcher): void {
	pi.registerCommand("cleanup", {
		description: "Run the cleanup turn (if the agent has one), then quit",
		handler: async (_args, ctx) => {
			if (dispatcher.inProgress()) {
				ctx.ui.notify("kiln-lite: cleanup turn already running — quitting now", "warning");
				dispatcher.exitNow(ctx);
				return;
			}
			if (!dispatcher.hasPrompt()) ctx.ui.notify("kiln-lite: no cleanup prompt — quitting", "info");
			dispatcher.dispatch(ctx);
		},
	});
}
