/**
 * Liveness reconciliation — safety net for zombie sessions.
 *
 * The fast path is explicit register/deregister (see handlers.ts). This
 * module covers the case where a session crashes without getting its
 * deregister call off: the process is gone, but our presence registry
 * still says it's alive.
 *
 * Liveness is checked primarily by PID (`process.kill(pid, 0)`) since
 * it's precise, cheap, and doesn't depend on tmux naming conventions.
 * An earlier revision of this module used tmux session names, which
 * false-pruned any session whose tmux name didn't happen to equal its
 * session_id — that took out subscriptions along with presence (via
 * pruneSession), and sessions reported "subscriptions silently
 * disappearing." PID is the right signal.
 *
 * For sessions with pid=0 (e.g. legacy entries registered before pid
 * tracking, or sessions whose register call lost the pid along the way),
 * we don't prune — there's nothing to check. The reconcile loop is a
 * safety net, not a GC; stale pid=0 entries wash out on deregister or
 * via the known-sessions TTL.
 *
 * Runs periodically.
 */

import type { DaemonState } from "./state.ts";

function isProcessAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
        // Signal 0 doesn't deliver a signal — just checks existence +
        // permission. Throws ESRCH if the process is gone, EPERM if it's
        // owned by another user (we treat that as "alive-enough" — it
        // exists, we just can't touch it).
        process.kill(pid, 0);
        return true;
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === "EPERM") return true;
        return false;
    }
}

export interface ReconcileResult {
    pruned: string[];
}

/**
 * Prune sessions whose owning process is no longer alive.
 */
export function reconcile(state: DaemonState): ReconcileResult {
    const pruned: string[] = [];

    // Only sessions we have a presence record for can be checked — we need
    // a pid. Channel-only rows (subs without presence) are left alone here;
    // they get cleaned up on deregister or by the known-sessions TTL.
    for (const record of state.presence.all()) {
        if (record.pid <= 0) continue;
        if (!isProcessAlive(record.pid)) {
            state.pruneSession(record.session_id);
            pruned.push(record.session_id);
        }
    }

    return { pruned };
}
