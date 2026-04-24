/**
 * Inbox retention sweep.
 *
 * Messages stay at their original `.md` path forever (the extension's
 * marker-file scheme — see extensions/kiln-lite/inbox.ts). Without a
 * reaper, read messages accumulate indefinitely. The daemon is the
 * natural owner of this sweep: it sees every registered session's
 * `inbox_path`, and its startup is the one guaranteed moment across
 * all sessions' lifetimes.
 *
 * Policy: delete `<name>.md` + `<name>.read` pairs where the `.read`
 * marker's mtime is older than `maxAgeMs`. Unread messages (no `.read`
 * sibling) are never touched.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface InboxCleanupOptions {
    /** Inbox root paths to sweep. Duplicates are deduped. */
    inboxRoots: Iterable<string>;
    /** Max age of a `.read` marker before its pair is deleted. */
    maxAgeMs: number;
    /** Called with a one-line summary for each root swept. */
    log?: (msg: string) => void;
}

export interface InboxCleanupResult {
    rootsScanned: number;
    sessionsScanned: number;
    deleted: number;
}

export function cleanInboxes(opts: InboxCleanupOptions): InboxCleanupResult {
    const result: InboxCleanupResult = { rootsScanned: 0, sessionsScanned: 0, deleted: 0 };
    const cutoff = Date.now() - opts.maxAgeMs;

    for (const root of new Set(opts.inboxRoots)) {
        let sessionDirs: string[];
        try {
            sessionDirs = readdirSync(root);
        } catch {
            continue; // root doesn't exist — nothing to do
        }
        result.rootsScanned++;

        let rootDeleted = 0;
        for (const sid of sessionDirs) {
            const sessionDir = join(root, sid);
            try {
                if (!statSync(sessionDir).isDirectory()) continue;
            } catch {
                continue;
            }
            let entries: string[];
            try {
                entries = readdirSync(sessionDir);
            } catch {
                continue;
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
                rootDeleted++;
            }
        }

        if (opts.log && rootDeleted > 0) {
            opts.log(`inbox-cleanup: ${root} — removed ${rootDeleted} stale message(s)`);
        }
    }

    return result;
}
