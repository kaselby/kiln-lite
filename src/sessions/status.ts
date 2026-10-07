/**
 * Status file: an optional `<kl root>/run/<uuid>/status.json`, an override
 * hook for things outside kl (a memory tool saying "working on thread X").
 * kl only reads it and never writes or deletes it:
 *
 *   { "summary": "one line", "detail": "free-form, any length", "updated_at": "ISO (optional)" }
 *
 * `kl sessions` and the sessions tool show the session's plan goal as its
 * one-line "doing"; a status file's `summary` replaces that, and its
 * `detail` is shown above the plan in the full view. See docs/cli.md.
 */

import { readFileSync } from "node:fs";

import { klRoot, statusPath } from "./paths.ts";

export interface SessionStatus {
	summary: string;
	detail?: string;
	updated_at?: string;
}

/** The status file, or null if missing or unreadable. A non-string summary counts as unreadable. */
export function readStatus(uuid: string, root = klRoot()): SessionStatus | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(statusPath(uuid, root), "utf8"));
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.summary !== "string") return null;
	return {
		summary: r.summary,
		...(typeof r.detail === "string" ? { detail: r.detail } : {}),
		...(typeof r.updated_at === "string" ? { updated_at: r.updated_at } : {}),
	};
}

/** First line of a summary, trimmed to `max` characters (for one-line columns). */
export function oneLine(s: string, max = 60): string {
	const line = (s.split("\n")[0] ?? "").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
