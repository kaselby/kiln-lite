/**
 * Daemon wire protocol — message shapes and builders.
 *
 * JSON-line protocol over a Unix domain socket. Each request / response is
 * a single JSON object terminated by newline. Every message has a `type`
 * field. Requests include a `ref` for response correlation; the daemon
 * echoes it back on the response.
 *
 * Requests that mutate per-session state carry a `requester` envelope
 * identifying the calling session and (crucially) its inbox path. This is
 * how the daemon learns where to deliver messages for a given session
 * without a separate prefix -> home-path registry file: the session itself
 * is the source of truth about its home.
 *
 * Ported from kiln/src/kiln/daemon/protocol.py with the surface stripped
 * down to what kiln-lite actually needs: no mgmt, no platform_op, no
 * surfaces.
 */

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Message type constants (client -> daemon requests)
// ---------------------------------------------------------------------------

export const REGISTER = "register";
export const DEREGISTER = "deregister";
export const SUBSCRIBE = "subscribe";
export const UNSUBSCRIBE = "unsubscribe";
export const PUBLISH = "publish";
export const SEND_DIRECT = "send_direct";
export const LIST_SUBSCRIPTIONS = "list_subscriptions";
export const LIST_SESSIONS = "list_sessions";
export const GET_STATUS = "get_status";

// Daemon -> client responses
export const ACK = "ack";
export const RESULT = "result";
export const ERROR = "error";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Identity of the requesting session, threaded through every mutating
 * request. Carries `inbox_path` so the daemon can deliver messages to
 * this session without consulting a separate registry.
 */
export interface Requester {
    agent: string;
    session: string;
    inbox_path?: string;
}

/**
 * Wire-level message envelope. Exactly one JSON object per newline-
 * terminated line on the socket.
 */
export interface Message<T = Record<string, unknown>> {
    type: string;
    ref?: string;
    data: T & { requester?: Requester };
}

/** Serialize a message to a newline-terminated UTF-8 line. */
export function toLine(msg: Message): string {
    const out: Record<string, unknown> = { type: msg.type };
    if (msg.ref !== undefined) out.ref = msg.ref;
    Object.assign(out, msg.data);
    return JSON.stringify(out) + "\n";
}

/** Parse a single JSON line into a Message. Throws on malformed input. */
export function fromLine(line: string): Message {
    const obj = JSON.parse(line);
    if (typeof obj !== "object" || obj === null || typeof obj.type !== "string") {
        throw new Error("invalid message envelope");
    }
    const { type, ref, ...data } = obj as Record<string, unknown>;
    return { type, ref: typeof ref === "string" ? ref : undefined, data } as Message;
}

/** Generate a short correlation id for request/response matching. */
export function makeRef(): string {
    return randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------------
// Request builders (client -> daemon)
// ---------------------------------------------------------------------------

function withRequester<T extends Record<string, unknown>>(
    data: T,
    requester: Requester,
): T & { requester: Requester } {
    return { ...data, requester };
}

export function register(requester: Requester, extras: { pid?: number } = {}): Message {
    return {
        type: REGISTER,
        ref: makeRef(),
        data: withRequester({ pid: extras.pid ?? process.pid }, requester),
    };
}

export function deregister(requester: Requester): Message {
    return { type: DEREGISTER, ref: makeRef(), data: withRequester({}, requester) };
}

export function subscribe(channel: string, requester: Requester): Message {
    return {
        type: SUBSCRIBE,
        ref: makeRef(),
        data: withRequester({ channel }, requester),
    };
}

export function unsubscribe(channel: string, requester: Requester): Message {
    return {
        type: UNSUBSCRIBE,
        ref: makeRef(),
        data: withRequester({ channel }, requester),
    };
}

export function publish(
    channel: string,
    summary: string,
    body: string,
    priority: "normal" | "high",
    requester: Requester,
): Message {
    return {
        type: PUBLISH,
        ref: makeRef(),
        data: withRequester({ channel, summary, body, priority }, requester),
    };
}

export function sendDirect(
    to: string,
    summary: string,
    body: string,
    priority: "normal" | "high",
    requester: Requester,
): Message {
    return {
        type: SEND_DIRECT,
        ref: makeRef(),
        data: withRequester({ to, summary, body, priority }, requester),
    };
}

export function listSubscriptions(requester: Requester): Message {
    return { type: LIST_SUBSCRIPTIONS, ref: makeRef(), data: withRequester({}, requester) };
}

export function listSessions(filter: { agent?: string } = {}): Message {
    return { type: LIST_SESSIONS, ref: makeRef(), data: { ...filter } };
}

export function getStatus(): Message {
    return { type: GET_STATUS, ref: makeRef(), data: {} };
}

// ---------------------------------------------------------------------------
// Response builders (daemon -> client)
// ---------------------------------------------------------------------------

export function ack(ref: string, extra: Record<string, unknown> = {}): Message {
    return { type: ACK, ref, data: { status: "ok", ...extra } };
}

export function result(ref: string, data: Record<string, unknown>): Message {
    return { type: RESULT, ref, data };
}

export function error(ref: string, message: string, code?: string): Message {
    const data: Record<string, unknown> = { message };
    if (code !== undefined) data.code = code;
    return { type: ERROR, ref, data };
}

/** Convenience: narrow an unknown response into a concrete outcome. */
export function isError(msg: Message): boolean {
    return msg.type === ERROR;
}
