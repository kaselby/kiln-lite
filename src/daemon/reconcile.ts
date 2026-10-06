/**
 * Liveness reconciliation: drop presence records whose process is gone
 * without having deregistered (a crash, a kill).
 *
 * Liveness is the record's pid (`process.kill(pid, 0)`). A record with no
 * pid (pid 0: registered implicitly by a request, see handlers.ts
 * ensureSession) takes the pid of the session's live lease; with no live
 * lease it is dropped. Dropping presence never touches channel
 * subscriptions.
 *
 * Runs periodically.
 */

import { liveLease } from "../sessions/lease.ts";
import { UUID_RE } from "../sessions/paths.ts";
import type { DaemonState } from "./state.ts";

function isProcessAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
        // Signal 0 checks existence + permission. EPERM: it exists, it's
        // just not ours.
        process.kill(pid, 0);
        return true;
    } catch (err: unknown) {
        return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
    }
}

export interface ReconcileResult {
    pruned: string[];
}

/** Drop presence for sessions whose process is no longer alive. `root` is the kl root (for leases). */
export function reconcile(state: DaemonState, root: string): ReconcileResult {
    const pruned: string[] = [];
    for (const record of state.presence.all()) {
        if (record.pid <= 0) {
            const lease = UUID_RE.test(record.session_id) ? liveLease(record.session_id, root) : null;
            if (lease) {
                record.pid = lease.pid;
                continue;
            }
        } else if (isProcessAlive(record.pid)) {
            continue;
        }
        state.dropPresence(record.session_id);
        pruned.push(record.session_id);
    }
    return { pruned };
}
