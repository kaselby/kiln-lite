/**
 * Periodic session-state suffix: `[Session state] context: 97k/200k | inbox: 2 unread`.
 *
 * Every Nth tool result gets one line so the agent can see how full its
 * context is (and decide when to reset) and whether mail is waiting.
 * Nothing else: peer and channel lists were cut.
 *
 * `session_state_interval: 0` in agent.yml disables it. Default every 15 calls.
 */

export interface ContextUsageSource {
	getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
}

export interface SessionStateHookOptions {
	/** Unread inbox count, or null if the watcher isn't up. */
	getUnread: () => number | null;
	/** Tool calls between emissions. <= 0 disables the hook. */
	interval: number;
}

export interface SessionStateHook {
	/** The suffix for this tool result, or "" when this isn't an emission boundary. */
	maybeBuildSuffix(ctx: ContextUsageSource): string;
}

export function createSessionStateHook(opts: SessionStateHookOptions): SessionStateHook {
	const interval = opts.interval;
	if (interval <= 0) return { maybeBuildSuffix: () => "" };
	let callCount = 0;
	return {
		maybeBuildSuffix(ctx) {
			callCount += 1;
			if (callCount % interval !== 0) return "";
			return buildSessionStateLine(ctx.getContextUsage(), opts.getUnread());
		},
	};
}

/** Pure: the line for a usage reading and unread count ("" when both are empty). */
export function buildSessionStateLine(
	usage: { tokens: number | null; contextWindow: number } | undefined,
	unread: number | null,
): string {
	const parts: string[] = [];
	// No token estimate yet right after a compaction or before the first reply.
	if (usage && typeof usage.tokens === "number" && usage.contextWindow > 0) {
		parts.push(`context: ${Math.floor(usage.tokens / 1000)}k/${Math.floor(usage.contextWindow / 1000)}k`);
	}
	if (unread !== null && unread > 0) parts.push(`inbox: ${unread} unread`);
	return parts.length === 0 ? "" : `[Session state] ${parts.join(" | ")}`;
}
