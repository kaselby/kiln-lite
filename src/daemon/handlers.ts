/**
 * Request handlers.
 *
 * Each handler takes a parsed protocol Message + the Daemon, performs the
 * requested action, and returns a response message (ack / result / error).
 * Handlers are pure functions — lifecycle + transport lives in index.ts.
 *
 * Discovery story: the daemon relies on explicit register/deregister from
 * sessions for the fast path. As a resiliency net, any mutating request
 * from a session that isn't currently in presence triggers an implicit
 * re-register using the envelope data — this covers the case where the
 * daemon restarted mid-session.
 */

import * as proto from "./protocol.ts";
import type { SessionRecord } from "./state.ts";
import { appendChannelHistory, writeInboxMessage } from "./inbox.ts";
import type { Daemon } from "./index.ts";

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function requireRequester(msg: proto.Message): proto.Requester | null {
    const req = msg.data.requester;
    if (!req || typeof req !== "object") return null;
    if (typeof req.agent !== "string" || typeof req.session !== "string") return null;
    if (!req.agent || !req.session) return null;
    return req;
}

/**
 * If the requester session isn't in presence, re-register it from envelope
 * data. No-op otherwise. Keeps the daemon resilient to restart-mid-session.
 *
 * Cancels any pending idle-shutdown on implicit (re-)registration so a
 * session arriving via subscribe/publish after the autostart's initial
 * empty-presence timer was set doesn't get killed out from under itself.
 */
function ensureSession(daemon: Daemon, req: proto.Requester): void {
    if (daemon.state.presence.get(req.session)) {
        daemon.state.presence.touch(req.session);
        return;
    }
    if (!req.inbox_path) {
        // Without an inbox_path we can't build a full presence record;
        // fall back to the known-sessions index for a previously-registered
        // inbox_path, or leave unregistered if we've truly never seen this one.
        const known = daemon.state.knownSessions.lookup(req.session);
        if (!known) return;
        req = { ...req, inbox_path: known.inbox_path };
    }
    const now = new Date().toISOString();
    const record: SessionRecord = {
        session_id: req.session,
        agent_name: req.agent,
        inbox_path: req.inbox_path!,
        pid: 0,
        first_seen_at: now,
        last_seen_at: now,
        status: "unknown",
    };
    daemon.state.presence.register(record);
    daemon.state.knownSessions.upsert(record);
    daemon.cancelShutdown();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleRegister(
    msg: proto.Message,
    daemon: Daemon,
): Promise<proto.Message> {
    const req = requireRequester(msg);
    if (!req) return proto.error(msg.ref!, "register requires requester identity");
    if (!req.inbox_path) {
        return proto.error(msg.ref!, "register requires requester.inbox_path");
    }

    const now = new Date().toISOString();
    const pid = typeof msg.data.pid === "number" ? (msg.data.pid as number) : 0;
    const record: SessionRecord = {
        session_id: req.session,
        agent_name: req.agent,
        inbox_path: req.inbox_path,
        pid,
        first_seen_at: now,
        last_seen_at: now,
        status: "running",
    };
    daemon.state.presence.register(record);
    daemon.state.knownSessions.upsert(record);
    daemon.cancelShutdown();
    return proto.ack(msg.ref!, { session_count: daemon.state.presence.size() });
}

export async function handleDeregister(
    msg: proto.Message,
    daemon: Daemon,
): Promise<proto.Message> {
    const req = requireRequester(msg);
    if (!req) return proto.error(msg.ref!, "deregister requires requester identity");
    daemon.state.pruneSession(req.session);
    daemon.maybeScheduleShutdown();
    return proto.ack(msg.ref!, { session_count: daemon.state.presence.size() });
}

export async function handleSubscribe(
    msg: proto.Message,
    daemon: Daemon,
): Promise<proto.Message> {
    const channel = typeof msg.data.channel === "string" ? msg.data.channel : "";
    if (!channel) return proto.error(msg.ref!, "subscribe requires a channel name");
    const req = requireRequester(msg);
    if (!req) return proto.error(msg.ref!, "subscribe requires requester identity");
    ensureSession(daemon, req);

    const count = daemon.state.channels.subscribe(channel, req.session);
    daemon.state.subscriptions.write(
        req.session,
        req.agent,
        daemon.state.channels.channelsFor(req.session),
    );
    return proto.ack(msg.ref!, { subscriber_count: count });
}

export async function handleUnsubscribe(
    msg: proto.Message,
    daemon: Daemon,
): Promise<proto.Message> {
    const channel = typeof msg.data.channel === "string" ? msg.data.channel : "";
    if (!channel) return proto.error(msg.ref!, "unsubscribe requires a channel name");
    const req = requireRequester(msg);
    if (!req) return proto.error(msg.ref!, "unsubscribe requires requester identity");

    daemon.state.channels.unsubscribe(channel, req.session);
    daemon.state.subscriptions.write(
        req.session,
        req.agent,
        daemon.state.channels.channelsFor(req.session),
    );
    return proto.ack(msg.ref!);
}

export async function handlePublish(
    msg: proto.Message,
    daemon: Daemon,
): Promise<proto.Message> {
    const channel = typeof msg.data.channel === "string" ? msg.data.channel : "";
    const summary = typeof msg.data.summary === "string" ? msg.data.summary : "";
    const body = typeof msg.data.body === "string" ? msg.data.body : "";
    const priority = (msg.data.priority === "high" ? "high" : "normal") as "normal" | "high";
    if (!channel) return proto.error(msg.ref!, "publish requires a channel name");
    const req = requireRequester(msg);
    if (!req) return proto.error(msg.ref!, "publish requires requester identity");
    ensureSession(daemon, req);

    const subscribers = daemon.state.channels.subscribers(channel);
    subscribers.delete(req.session); // don't echo back to sender

    let delivered = 0;
    for (const sub_id of subscribers) {
        const record = daemon.state.presence.get(sub_id);
        const inbox_root = record?.inbox_path
            ?? daemon.state.knownSessions.lookup(sub_id)?.inbox_path;
        if (!inbox_root) continue; // subscriber disappeared + not known — skip
        writeInboxMessage({
            inboxRoot: inbox_root,
            recipient: sub_id,
            sender: req.session,
            summary,
            body,
            priority,
            channel,
        });
        delivered++;
    }

    appendChannelHistory({
        channelsDir: daemon.config.channelsDir,
        channel,
        sender: req.session,
        summary,
        body,
        priority,
    });

    return proto.ack(msg.ref!, { recipient_count: delivered });
}

export async function handleSendDirect(
    msg: proto.Message,
    daemon: Daemon,
): Promise<proto.Message> {
    const to = typeof msg.data.to === "string" ? msg.data.to : "";
    const summary = typeof msg.data.summary === "string" ? msg.data.summary : "";
    const body = typeof msg.data.body === "string" ? msg.data.body : "";
    const priority = (msg.data.priority === "high" ? "high" : "normal") as "normal" | "high";
    if (!to) return proto.error(msg.ref!, "send_direct requires 'to'");
    const req = requireRequester(msg);
    if (!req) return proto.error(msg.ref!, "send_direct requires requester identity");
    ensureSession(daemon, req);

    // Resolve recipient inbox: live presence first, then known-sessions
    // fallback, then derive from sender's agent_home as a last resort.
    // (Last-resort derivation assumes single-home; safe for kiln-lite's
    // current shape but gracefully degrades when multi-home lands.)
    const liveRecord = daemon.state.presence.get(to);
    const knownRecord = daemon.state.knownSessions.lookup(to);
    const senderRecord = daemon.state.presence.get(req.session);
    const inbox_root =
        liveRecord?.inbox_path
        ?? knownRecord?.inbox_path
        ?? senderRecord?.inbox_path
        ?? req.inbox_path;

    if (!inbox_root) {
        return proto.error(
            msg.ref!,
            `cannot resolve inbox for '${to}' — recipient never registered and no fallback available`,
            "unknown_recipient",
        );
    }

    writeInboxMessage({
        inboxRoot: inbox_root,
        recipient: to,
        sender: req.session,
        summary,
        body,
        priority,
    });
    return proto.ack(msg.ref!, { message: `sent to ${to}` });
}

export async function handleListSubscriptions(
    msg: proto.Message,
    daemon: Daemon,
): Promise<proto.Message> {
    const req = requireRequester(msg);
    if (!req) return proto.error(msg.ref!, "list_subscriptions requires requester identity");
    const channels = daemon.state.channels.channelsFor(req.session);
    return proto.result(msg.ref!, { channels });
}

export async function handleListSessions(
    msg: proto.Message,
    daemon: Daemon,
): Promise<proto.Message> {
    const agentFilter = typeof msg.data.agent === "string" ? msg.data.agent : null;
    let sessions = daemon.state.presence.all();
    if (agentFilter) sessions = sessions.filter((s) => s.agent_name === agentFilter);
    return proto.result(msg.ref!, {
        sessions: sessions.map((s) => ({
            session_id: s.session_id,
            agent_name: s.agent_name,
            pid: s.pid,
            first_seen_at: s.first_seen_at,
            last_seen_at: s.last_seen_at,
            status: s.status,
        })),
    });
}

export async function handleGetStatus(
    msg: proto.Message,
    daemon: Daemon,
): Promise<proto.Message> {
    return proto.result(msg.ref!, {
        sessions: daemon.state.presence.size(),
        channels: daemon.state.channels.allChannels().length,
        socket_path: daemon.config.socketPath,
        pid: process.pid,
        uptime_sec: Math.round(process.uptime()),
    });
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

export type Handler = (msg: proto.Message, daemon: Daemon) => Promise<proto.Message>;

export const handlers: Record<string, Handler> = {
    [proto.REGISTER]: handleRegister,
    [proto.DEREGISTER]: handleDeregister,
    [proto.SUBSCRIBE]: handleSubscribe,
    [proto.UNSUBSCRIBE]: handleUnsubscribe,
    [proto.PUBLISH]: handlePublish,
    [proto.SEND_DIRECT]: handleSendDirect,
    [proto.LIST_SUBSCRIPTIONS]: handleListSubscriptions,
    [proto.LIST_SESSIONS]: handleListSessions,
    [proto.GET_STATUS]: handleGetStatus,
};
