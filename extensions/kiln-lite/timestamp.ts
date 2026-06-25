/**
 * Message timestamping — gives the agent an ambient sense of wall-clock
 * time and how much of it has passed between user messages.
 *
 * Pure module — no pi SDK dependencies. The wiring lives in lib/install.ts:
 * a `before_agent_start` handler injects a single `display:false` custom
 * message per user turn whose content is the `[time: ...]` line from
 * createTimestampInjector(). pi persists that message and feeds it to the
 * model (convertToLlm maps custom → user), so the model sees the passage of
 * time across the whole conversation — but it is hidden from the UI and is a
 * separate message, never the user's own input, so it never shows as an
 * artifact or leaks into the input box on rewind/cancel.
 *
 * Pi injects a static `Current date: YYYY-MM-DD` once at session start and
 * never updates it — no time of day, no weekday, no elapsed-time signal.
 * This fills that gap per user turn.
 */

// --- Elapsed-time formatting ---

/**
 * Human-readable duration from a millisecond delta. Mirrors the `sessions`
 * shell tool's uptime style: `45s`, `7m`, `21h 37m`, `3d 4h`. Negative or
 * sub-second deltas clamp to `0s`.
 */
export function formatElapsed(ms: number): string {
	const secs = Math.floor(ms / 1000);
	if (secs <= 0) return "0s";
	if (secs < 60) return `${secs}s`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m`;
	if (secs < 86400) {
		const h = Math.floor(secs / 3600);
		const m = Math.floor((secs % 3600) / 60);
		return `${h}h ${m}m`;
	}
	const d = Math.floor(secs / 86400);
	const h = Math.floor((secs % 86400) / 3600);
	return `${d}d ${h}h`;
}

// --- Timestamp line ---

/**
 * Build the `[time: ...]` line. Shows weekday, date, local time + zone, and
 * (when a prior stamp time is known) how long has passed since it.
 *
 *   [time: Thu, Jun 18, 2026, 15:42 PDT · 2h 13m since last timestamp]
 *   [time: Thu, Jun 18, 2026, 12:01 PDT · session start]
 *
 * "since last timestamp" is measured from the previous stamp of ANY kind —
 * a user message or a periodic autonomous-work tick — since both advance the
 * same clock. It answers "how long since the time was last shown", not
 * specifically "how long since the user last spoke".
 */
export function formatTimestamp(now: Date, prev: Date | null): string {
	const when = now.toLocaleString("en-US", {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZoneName: "short",
	});
	const since =
		prev === null
			? "session start"
			: `${formatElapsed(now.getTime() - prev.getTime())} since last timestamp`;
	return `[time: ${when} · ${since}]`;
}

// --- Per-session injector ---

export interface TimestampInjector {
	/**
	 * Return the timestamp line for an input arriving at `now`, advancing the
	 * internal clock. The first call of a session reports "session start";
	 * subsequent calls report elapsed time since the previous one.
	 */
	stamp(now?: Date): string;
	/** Milliseconds since the last stamp, or null if nothing has been stamped yet. */
	msSinceLast(now?: Date): number | null;
}

export function createTimestampInjector(): TimestampInjector {
	let last: Date | null = null;
	return {
		stamp(now = new Date()): string {
			const line = formatTimestamp(now, last);
			last = now;
			return line;
		},
		msSinceLast(now = new Date()): number | null {
			return last === null ? null : now.getTime() - last.getTime();
		},
	};
}

// --- Periodic emitter (autonomous-work clock) ---

export interface PeriodicTimestamp {
	/**
	 * Call on every tool result. Returns a timestamp line when the cadence is
	 * due — either `everyCalls` tool calls or `everyMs` of wall-clock time have
	 * elapsed since the last stamp (of any kind) — otherwise an empty string.
	 * Shares the injector's clock so "since last" stays continuous across
	 * user messages and periodic emissions alike.
	 */
	maybeSuffix(now?: Date): string;
	/** Reset the tool-call counter — call when a user message arrives so the
	 * autonomous-work cadence starts fresh from the interaction. */
	reset(): void;
}

export function createPeriodicTimestamp(
	injector: TimestampInjector,
	opts: { everyCalls: number; everyMs: number },
): PeriodicTimestamp {
	let callsSinceStamp = 0;
	return {
		maybeSuffix(now = new Date()): string {
			callsSinceStamp += 1;
			const since = injector.msSinceLast(now);
			const byCalls = opts.everyCalls > 0 && callsSinceStamp >= opts.everyCalls;
			const byTime = opts.everyMs > 0 && since !== null && since >= opts.everyMs;
			if (!byCalls && !byTime) return "";
			callsSinceStamp = 0;
			return injector.stamp(now);
		},
		reset(): void {
			callsSinceStamp = 0;
		},
	};
}
