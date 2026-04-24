/**
 * Daemon core state — presence, channel subscriptions, file-backed storage.
 *
 * In-memory registries are the live source of truth while the daemon is
 * running. They're rebuilt from durable files on startup (so restarts
 * don't drop subscriptions) and mirrored back to disk on every mutation.
 *
 * Layout under `~/.kl/daemon/`:
 *   known-sessions.json           every session ever registered + its inbox_path
 *                                 (lets send_direct resolve recipients that
 *                                 aren't currently alive)
 *   subscriptions/<session>.json  channel subs for a single session
 *   channels/<name>/history.jsonl append-only channel history
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Presence registry — who's alive right now
// ---------------------------------------------------------------------------

export interface SessionRecord {
    session_id: string;
    agent_name: string;
    /** Inbox directory for this session. Messages addressed to session_id
     *  are written under `<inbox_path>/<session_id>/`. */
    inbox_path: string;
    pid: number;
    first_seen_at: string;
    last_seen_at: string;
    status: "running" | "unknown";
}

export class PresenceRegistry {
    private sessions: Map<string, SessionRecord> = new Map();

    register(record: SessionRecord): void {
        this.sessions.set(record.session_id, record);
    }

    deregister(session_id: string): SessionRecord | undefined {
        const record = this.sessions.get(session_id);
        this.sessions.delete(session_id);
        return record;
    }

    get(session_id: string): SessionRecord | undefined {
        return this.sessions.get(session_id);
    }

    touch(session_id: string): void {
        const record = this.sessions.get(session_id);
        if (record) record.last_seen_at = new Date().toISOString();
    }

    all(): SessionRecord[] {
        return Array.from(this.sessions.values());
    }

    ids(): Set<string> {
        return new Set(this.sessions.keys());
    }

    size(): number {
        return this.sessions.size;
    }
}

// ---------------------------------------------------------------------------
// Channel registry — channel_name -> set of session_ids
// ---------------------------------------------------------------------------

export class ChannelRegistry {
    private channels: Map<string, Set<string>> = new Map();

    /** Returns new subscriber count. */
    subscribe(channel: string, session_id: string): number {
        let subs = this.channels.get(channel);
        if (!subs) {
            subs = new Set();
            this.channels.set(channel, subs);
        }
        subs.add(session_id);
        return subs.size;
    }

    unsubscribe(channel: string, session_id: string): void {
        const subs = this.channels.get(channel);
        if (!subs) return;
        subs.delete(session_id);
        if (subs.size === 0) this.channels.delete(channel);
    }

    /** Remove a session from every channel. Returns the channels it left. */
    unsubscribeAll(session_id: string): string[] {
        const departed: string[] = [];
        for (const [channel, subs] of this.channels) {
            if (subs.delete(session_id)) {
                departed.push(channel);
                if (subs.size === 0) this.channels.delete(channel);
            }
        }
        return departed;
    }

    subscribers(channel: string): Set<string> {
        return new Set(this.channels.get(channel) ?? []);
    }

    channelsFor(session_id: string): string[] {
        const result: string[] = [];
        for (const [channel, subs] of this.channels) {
            if (subs.has(session_id)) result.push(channel);
        }
        return result;
    }

    allChannels(): string[] {
        return Array.from(this.channels.keys());
    }

    sessionsWithAnySubscription(): Set<string> {
        const out = new Set<string>();
        for (const subs of this.channels.values()) {
            for (const s of subs) out.add(s);
        }
        return out;
    }
}

// ---------------------------------------------------------------------------
// File-backed stores
// ---------------------------------------------------------------------------

interface KnownSessionEntry {
    session_id: string;
    agent_name: string;
    inbox_path: string;
    last_seen_at: string;
}

/**
 * Durable index of every session the daemon has ever seen. Lets send_direct
 * resolve an inbox path for a recipient that isn't currently alive (e.g. a
 * crashed or just-exited session whose presence record was pruned).
 *
 * Entries older than ttlMs are pruned opportunistically on load. The
 * useful window for this index is "just-exited session someone is still
 * messaging" — hours, not weeks. 7 days is generous.
 *
 * Schema:
 *   { version: 1, sessions: { <session_id>: KnownSessionEntry } }
 */
export class KnownSessionStore {
    private ttlMs: number;

    constructor(private path: string, ttlMs = 7 * 24 * 60 * 60 * 1000) {
        this.ttlMs = ttlMs;
    }

    /**
     * Load + prune entries whose last_seen_at is older than ttlMs. Only
     * writes back to disk if pruning actually removed something (avoids
     * churn on every read).
     */
    load(): Record<string, KnownSessionEntry> {
        let raw: Record<string, KnownSessionEntry> = {};
        try {
            const text = readFileSync(this.path, "utf8");
            const data = JSON.parse(text);
            if (data && typeof data.sessions === "object" && data.sessions !== null) {
                raw = data.sessions as Record<string, KnownSessionEntry>;
            }
        } catch (err: unknown) {
            // Missing file / malformed JSON — start fresh.
            const code = (err as NodeJS.ErrnoException | null)?.code;
            if (code !== "ENOENT") {
                // eslint-disable-next-line no-console
                console.warn(`known-sessions.json unreadable: ${String(err)}`);
            }
        }

        const cutoff = Date.now() - this.ttlMs;
        const pruned: Record<string, KnownSessionEntry> = {};
        let droppedAny = false;
        for (const [sid, entry] of Object.entries(raw)) {
            const t = Date.parse(entry.last_seen_at);
            if (Number.isFinite(t) && t < cutoff) {
                droppedAny = true;
                continue; // skip stale entry
            }
            pruned[sid] = entry;
        }
        if (droppedAny) {
            // Write back the pruned set so subsequent loads stay fast.
            try {
                this.save(pruned);
            } catch {
                /* noop — pruning is best-effort */
            }
        }
        return pruned;
    }

    save(sessions: Record<string, KnownSessionEntry>): void {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(
            this.path,
            JSON.stringify({ version: 1, sessions }, null, 2) + "\n",
        );
    }

    upsert(record: SessionRecord): void {
        const sessions = this.load();
        sessions[record.session_id] = {
            session_id: record.session_id,
            agent_name: record.agent_name,
            inbox_path: record.inbox_path,
            last_seen_at: record.last_seen_at,
        };
        this.save(sessions);
    }

    lookup(session_id: string): KnownSessionEntry | undefined {
        return this.load()[session_id];
    }
}

/**
 * Per-session subscription persistence. One file per session. The file
 * tracks which channels this session is subscribed to; the daemon reloads
 * all of them into the ChannelRegistry on startup so subscriptions
 * survive daemon restarts.
 *
 * Schema (JSON):
 *   { version: 1, agent: "...", session: "...", channels: ["a", "b"] }
 */
export class SubscriptionStore {
    constructor(private dir: string) {}

    ensureDir(): void {
        mkdirSync(this.dir, { recursive: true });
    }

    private pathFor(session_id: string): string {
        return join(this.dir, `${session_id}.json`);
    }

    read(session_id: string): string[] {
        try {
            const raw = readFileSync(this.pathFor(session_id), "utf8");
            const data = JSON.parse(raw);
            if (Array.isArray(data?.channels)) return data.channels as string[];
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException | null)?.code;
            if (code !== "ENOENT") {
                // eslint-disable-next-line no-console
                console.warn(`subscription file unreadable: ${String(err)}`);
            }
        }
        return [];
    }

    write(session_id: string, agent_name: string, channels: string[]): void {
        const path = this.pathFor(session_id);
        if (channels.length === 0) {
            try {
                rmSync(path, { force: true });
            } catch {
                /* noop */
            }
            return;
        }
        this.ensureDir();
        const payload = {
            version: 1,
            agent: agent_name,
            session: session_id,
            channels: [...channels].sort(),
        };
        writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
    }

    readAll(): Record<string, string[]> {
        this.ensureDir();
        const out: Record<string, string[]> = {};
        for (const entry of readdirSync(this.dir)) {
            if (!entry.endsWith(".json")) continue;
            const session_id = entry.slice(0, -".json".length);
            const channels = this.read(session_id);
            if (channels.length > 0) out[session_id] = channels;
        }
        return out;
    }

    remove(session_id: string): void {
        try {
            rmSync(this.pathFor(session_id), { force: true });
        } catch {
            /* noop */
        }
    }
}

// ---------------------------------------------------------------------------
// Combined daemon state
// ---------------------------------------------------------------------------

export class DaemonState {
    presence: PresenceRegistry;
    channels: ChannelRegistry;
    subscriptions: SubscriptionStore;
    knownSessions: KnownSessionStore;

    constructor(daemonDir: string) {
        this.presence = new PresenceRegistry();
        this.channels = new ChannelRegistry();
        this.subscriptions = new SubscriptionStore(join(daemonDir, "subscriptions"));
        this.knownSessions = new KnownSessionStore(join(daemonDir, "known-sessions.json"));
    }

    /** Rebuild in-memory channel registry from durable subscription files. */
    loadFromFiles(): void {
        this.subscriptions.ensureDir();
        for (const [session_id, channels] of Object.entries(this.subscriptions.readAll())) {
            for (const channel of channels) {
                this.channels.subscribe(channel, session_id);
            }
        }
    }

    /** Remove all state for a dead session. Idempotent. */
    pruneSession(session_id: string): void {
        this.channels.unsubscribeAll(session_id);
        this.presence.deregister(session_id);
        this.subscriptions.remove(session_id);
    }
}
