/**
 * Pure helpers for /spawn (and the subagent tool): no value imports from
 * pi-coding-agent, so the CJS test runner can load them.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** This repo's kl launcher ($KL_BIN overrides). Never a `kl` from PATH: it may be another install. */
export function klBin(): string {
	return process.env.KL_BIN || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "kl");
}

/**
 * Write the fork transcript: root up to (not including) `beforeEntryId`.
 * `sm` must be a manager opened just for this (it is switched to the fork).
 * Returns the new file, or null when there is nothing before that entry.
 */
export function writeForkedSession(
	sm: Pick<SessionManager, "getEntry" | "createBranchedSession">,
	beforeEntryId: string,
): string | null {
	const parentId = sm.getEntry(beforeEntryId)?.parentId;
	if (!parentId) return null;
	return sm.createBranchedSession(parentId) ?? null;
}

