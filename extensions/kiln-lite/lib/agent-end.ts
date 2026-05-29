/**
 * agent_end ordering helper.
 *
 * The order of operations at agent_end is load-bearing: cleanup-sentinel
 * check must run BEFORE the inbox drain. Getting this wrong reintroduces
 * the markAllSeen silent-sweep bug (see commit ca82822 — Inbox: queue+
 * dispatch-per-trigger model; fix agent_end silent sweep).
 *
 * Reasoning:
 *   - If this agent_end is the cleanup-sentinel turn (i.e. shutdown is
 *     imminent), dispatchIdle would queue user-message turns that never run
 *     while ALSO touching the read-markers on those messages -> silent
 *     swallow. So we skip the drain in that case.
 *   - Otherwise (normal turn ending), the queue likely contains messages
 *     that arrived mid-turn but produced no tool_result (text-only turn).
 *     The agent is transitioning to idle, so dispatchIdle is the correct
 *     consumer; those messages become user turns.
 *
 * Extracted into a tiny named function so the invariant is visible at the
 * call site and a harness override that forgets the ordering is obvious by
 * inspection.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { InboxWatcher } from "../inbox.ts";
import type { CleanupDispatcher } from "../cleanup.ts";

export interface RunAgentEndOptions {
	dispatcher: CleanupDispatcher | null;
	watcher: InboxWatcher | null;
	ctx: ExtensionContext;
	messages: unknown[];
}

/**
 * Run the agent_end side-effects in the correct order.
 *
 * Returns true if the agent_end was the cleanup sentinel turn (shutdown
 * imminent, drain skipped), false otherwise (drain was dispatched if a
 * watcher was present).
 */
export function runAgentEndOrdered(opts: RunAgentEndOptions): boolean {
	const wasCleanup = opts.dispatcher?.handleAgentEnd(opts.ctx, opts.messages) ?? false;
	if (!wasCleanup && opts.watcher) opts.watcher.dispatchIdle();
	return wasCleanup;
}
