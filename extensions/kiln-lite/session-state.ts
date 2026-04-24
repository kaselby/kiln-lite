/**
 * Periodic session state suffix — kiln's `[Session state] ...` line, ported.
 *
 * Kiln emits an ambient status line on every Nth PostToolUse so the LLM can
 * see its own context window, peer agents, channel subscriptions, and any
 * unread inbox backlog. kiln-lite mirrors the shape, omitting the Beth-specific
 * fields (permission mode, gateway presence) that have no analog here.
 *
 * Fires from the tool_result handler (kiln-lite's equivalent of PostToolUse).
 * See index.ts — the handler awaits `maybeBuildSuffix(ctx)` and combines the
 * result with inbox notifications into a single suffix appended to the tool
 * result content.
 *
 * Disabled by setting `session_state_interval: 0` in agent.yml. Default is
 * every 15 tool calls.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { DaemonClient } from "../../src/client/index.ts";
import type { InboxWatcher } from "./inbox.ts";

export interface SessionStateHookOptions {
	/** Current DaemonClient, or null if registration hasn't happened yet. */
	getDaemon: () => DaemonClient | null;
	/** Current agent id — marks "(you)" in the Agents list. */
	getAgentId: () => string | null;
	/** Inbox watcher — for the unread-count field. */
	getWatcher: () => InboxWatcher | null;
	/** Tool calls between emissions. <= 0 disables the hook. */
	interval: number;
}

export interface SessionStateHook {
	/**
	 * Build the `[Session state] ...` suffix for the current tool_result,
	 * or empty string if this isn't an emission boundary (or the hook is
	 * disabled, or all fields are empty).
	 */
	maybeBuildSuffix(ctx: ExtensionContext): Promise<string>;
}

export function createSessionStateHook(opts: SessionStateHookOptions): SessionStateHook {
	const interval = opts.interval;
	if (interval <= 0) {
		return { maybeBuildSuffix: async () => "" };
	}

	let callCount = 0;

	return {
		async maybeBuildSuffix(ctx: ExtensionContext): Promise<string> {
			callCount += 1;
			if (callCount % interval !== 0) return "";

			const parts: string[] = [];

			// Context usage — kiln's `context: used_k/max_k`. Skip if the model
			// hasn't produced a token estimate yet (happens right after a fresh
			// compaction or before the first assistant turn).
			const usage = ctx.getContextUsage();
			if (usage && typeof usage.tokens === "number" && usage.contextWindow > 0) {
				const usedK = Math.floor(usage.tokens / 1000);
				const maxK = Math.floor(usage.contextWindow / 1000);
				parts.push(`context: ${usedK}k/${maxK}k`);
			}

			const daemon = opts.getDaemon();
			const agentId = opts.getAgentId();

			// Peer agents — pulled from the daemon's session registry. Only
			// emits when there's at least one peer; a single-session view
			// (just "you") is noise. Daemon errors are swallowed — this is
			// ambient status, not functionality; a missing field is fine.
			if (daemon && agentId) {
				try {
					const sessions = await daemon.listSessions();
					if (sessions.length > 1) {
						// Daemon presence records carry `session_id` (the agent
						// id, e.g. `pi-wild-falcon`) and `agent_name` (the
						// config.name prefix). The session_id is what's unique
						// per-session and what we want to display.
						const names = sessions
							.map((s) => String(s.session_id ?? ""))
							.filter((s) => s.length > 0);
						const display = names
							.map((s) => (s === agentId ? `${s} (you)` : s))
							.join(", ");
						parts.push(`Agents: ${display} (${names.length} total)`);
					}
				} catch {
					// daemon down / RPC failed — omit the field
				}
			}

			// Channel subscriptions — same treatment.
			if (daemon) {
				try {
					const channels = await daemon.listSubscriptions();
					if (channels.length > 0) {
						parts.push(`Channels: ${channels.join(", ")}`);
					}
				} catch {
					// omit
				}
			}

			// Inbox backlog — only surface when non-zero. Format mirrors
			// kiln-lite's existing "unread" phrasing rather than kiln's
			// `pending: N` (same concept, different verb).
			const watcher = opts.getWatcher();
			if (watcher) {
				const unread = watcher.unreadCount();
				if (unread > 0) {
					parts.push(`inbox: (${unread} unread)`);
				}
			}

			if (parts.length === 0) return "";
			return `[Session state] ${parts.join(" | ")}`;
		},
	};
}
