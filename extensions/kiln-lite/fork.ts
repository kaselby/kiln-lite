/**
 * Pure helpers for /spawn: no value imports from
 * pi-coding-agent, so the CJS test runner can load them.
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";

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

