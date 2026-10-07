/**
 * Per-session runtime config: run/<uuid>/config.yml.
 *
 * A third layer over <kl root>/config.yml and agent.yml for the keys below
 * only, read while the session runs: an edit (by the agent, by `kl config`,
 * by hand) applies at the next turn or tool result, no restart. Absent file =
 * no overrides. A bad value warns once and is ignored.
 */

import { statSync } from "node:fs";

import { parseStateInterval, parseTimestamps, readYamlMapping } from "./config.ts";
import type { TimestampConfig } from "./types.ts";

/**
 * The keys run/<uuid>/config.yml may set. Never add one that affects the
 * system prompt: the prompt is built once at session start, and a change
 * mid-session would break Pi's prompt cache and the transcript's record of it.
 */
export const RUNTIME_KEYS = ["timestamps", "session_state_interval"] as const;
export const TIMESTAMP_KEYS = ["per_turn", "every_calls", "every_minutes"] as const;

export interface RuntimeValues {
	timestamps: TimestampConfig | false;
	session_state_interval: number;
}

/** Where each effective value came from, keyed `timestamps`, `timestamps.<key>`, `session_state_interval`. */
export type RuntimeSources = Record<string, string>;

/**
 * Apply one layer's runtime keys over `values`. Other keys are ignored here
 * (`strict` warns about them: in the session file they're mistakes). Records
 * the layer as the source of each value it sets when `sources` is given.
 */
export function applyRuntimeLayer(
	values: RuntimeValues,
	obj: Record<string, unknown>,
	label: string,
	warn: (msg: string) => void,
	opts: { strict?: boolean; sources?: RuntimeSources } = {},
): void {
	const { sources } = opts;
	const has = (k: string) => Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined;
	if (opts.strict) {
		for (const key of Object.keys(obj)) {
			if (!(RUNTIME_KEYS as readonly string[]).includes(key)) {
				warn(`kiln-lite: ${label} has unknown field '${key}' (allowed: ${RUNTIME_KEYS.join(", ")}) — ignoring`);
			}
		}
	}
	if (has("timestamps")) {
		const raw = obj.timestamps;
		const wasOff = values.timestamps === false;
		const t = parseTimestamps(raw, label, warn, values.timestamps);
		if (t !== undefined) {
			values.timestamps = t;
			if (sources) {
				sources.timestamps = label;
				if (t === false || wasOff) for (const k of TIMESTAMP_KEYS) delete sources[`timestamps.${k}`];
				if (t !== false && typeof raw === "object" && raw !== null) {
					for (const k of TIMESTAMP_KEYS) {
						if ((raw as Record<string, unknown>)[k] === t[k]) sources[`timestamps.${k}`] = label;
					}
				}
			}
		}
	}
	if (has("session_state_interval")) {
		const n = parseStateInterval(obj.session_state_interval, label, warn);
		if (n !== undefined) {
			values.session_state_interval = n;
			if (sources) sources.session_state_interval = label;
		}
	}
}

export interface RuntimeConfig {
	/**
	 * The effective values now. Re-reads the file only when it changed
	 * (inode, mtime or size); otherwise returns the same object, so callers
	 * can tell a change by identity.
	 */
	get(): RuntimeValues;
}

/** Watch `path` (run/<uuid>/config.yml) over `base`, the values from config.yml + agent.yml. */
export function runtimeConfig(path: string, base: RuntimeValues, warn: (msg: string) => void): RuntimeConfig {
	const warned = new Set<string>();
	const warnOnce = (msg: string) => {
		if (warned.has(msg)) return;
		warned.add(msg);
		warn(msg);
	};
	let stamp: string | null = null;
	let current: RuntimeValues = base;
	return {
		get() {
			let next: string;
			try {
				const st = statSync(path);
				next = `${st.ino}:${st.mtimeMs}:${st.size}`;
			} catch {
				next = "absent";
			}
			if (next === stamp) return current;
			stamp = next;
			const values: RuntimeValues = { ...base };
			const obj = next === "absent" ? null : readYamlMapping(path, "session config.yml", warnOnce);
			if (obj) applyRuntimeLayer(values, obj, path, warnOnce, { strict: true });
			current = values;
			return current;
		},
	};
}
