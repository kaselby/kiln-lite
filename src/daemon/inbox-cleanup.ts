/**
 * Inbox retention sweep.
 *
 * Messages stay at their original `.md` path forever (the extension's
 * marker-file scheme — see extensions/kiln-lite/inbox.ts). Without a
 * reaper, read messages accumulate indefinitely. The daemon is the
 * natural owner of this sweep: its startup is the one guaranteed moment
 * across all sessions' lifetimes.
 *
 * Policy: delete `<name>.md` + `<name>.read` pairs where the `.read`
 * marker's mtime is older than `maxAgeMs`. Unread messages (no `.read`
 * sibling) are never touched.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { inboxDir, sessionUuids } from "../sessions/paths.ts";

export interface InboxCleanupOptions {
    /** kl root: every run/<uuid>/inbox under it is swept. */
    root: string;
    /** Max age of a `.read` marker before its pair is deleted. */
    maxAgeMs: number;
}

export interface InboxCleanupResult {
    sessionsScanned: number;
    deleted: number;
}

export function cleanInboxes(opts: InboxCleanupOptions): InboxCleanupResult {
    const result: InboxCleanupResult = { sessionsScanned: 0, deleted: 0 };
    const cutoff = Date.now() - opts.maxAgeMs;

    for (const uuid of sessionUuids(opts.root)) {
        const sessionDir = inboxDir(uuid, opts.root);
        let entries: string[];
        try {
            entries = readdirSync(sessionDir);
        } catch {
            continue; // no inbox
        }
        result.sessionsScanned++;

        for (const name of entries) {
            if (!name.endsWith(".read")) continue;
            const markerPath = join(sessionDir, name);
            let markerStat;
            try {
                markerStat = statSync(markerPath);
            } catch {
                continue;
            }
            if (markerStat.mtimeMs >= cutoff) continue;

            const base = name.slice(0, -".read".length);
            const mdPath = join(sessionDir, `${base}.md`);
            // Delete both; either may already be missing.
            try { unlinkSync(mdPath); } catch { /* missing .md is fine */ }
            try { unlinkSync(markerPath); } catch { /* missing marker is fine */ }
            result.deleted++;
        }
    }

    return result;
}
