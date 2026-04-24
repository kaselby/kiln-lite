# Daemon

The kiln-lite daemon — architecture, wire protocol, lifecycle. A standalone Node process that owns cross-session state (channel subscriptions, session presence, inbox routing).

## Overview

The daemon is a small, single-purpose Node process. It owns exactly the state that needs to be shared across Pi sessions — **which sessions are alive, which channels they subscribe to, where to write messages** — and nothing else. No model calls, no session lifecycle, no tool dispatch. It's a registry + router.

It autostarts on the first client call and self-exits 30 seconds after the last session deregisters. No `kl start-daemon`, no pidfile to tend by hand, no config file required to get going. From the extension's perspective, the daemon is invisible: every `DaemonClient` call handles autostart transparently.

Written in TypeScript (shared protocol types with the extension and `kl-msg`), run via `tsx` at runtime, no build step. About 800 LOC total across `src/daemon/`. Scope is deliberately narrow: channel pub/sub, direct-message routing, session presence. Nothing else — no gateway, no scheduler, no platform adapters, no management RPC.

## Architecture

```
src/daemon/
├── index.ts       socket listener, lifecycle, main loop, idle timer
├── protocol.ts    wire envelope + message builders (shared with client)
├── state.ts       PresenceRegistry, ChannelRegistry, SubscriptionStore,
│                  KnownSessionStore
├── handlers.ts    per-message-type handler functions
├── inbox.ts       writeInboxMessage, appendChannelHistory
└── reconcile.ts   tmux-poll zombie cleanup (safety net)
```

Two in-memory registries, rebuilt on startup from disk:

- **`PresenceRegistry`** — `session_id → SessionRecord`. Populated by `register`. Purely transient; rebuilt from nothing on daemon restart.
- **`ChannelRegistry`** — `channel_name → Set<session_id>`. Rebuilt from `subscriptions/*.json` on startup so subs survive daemon restarts.

Two on-disk stores, written through on every mutation:

- **`SubscriptionStore`** — one JSON file per session listing that session's channel subscriptions. Removed on `deregister`.
- **`KnownSessionStore`** — single `known-sessions.json` with every session that has ever registered, plus its last-known `inbox_path`. Used by `send_direct` to resolve inbox paths for recipients that aren't currently alive (just-exited, crashed, or pruned).

Two stores instead of one because subscriptions have a per-session lifecycle (created on subscribe, removed on deregister) while known-sessions is a stable index that outlives any one session.

### Connection model

JSON-per-line over a Unix domain socket. One request per connection:

1. client opens a fresh socket,
2. writes one JSON line,
3. reads one JSON response line,
4. closes.

No long-lived connections, no streaming. Each handler stays stateless on the daemon side. Read timeout is 10 s per request; in-flight requests are tracked so shutdown can drain cleanly.

### Lifecycle

- **Startup.** Claim socket path (remove stale socket if no listener holds it), write pidfile, load `subscriptions/*.json` back into the channel registry, install SIGINT/SIGTERM handlers, start reconcile timer, start listening.
- **Idle auto-shutdown.** When `presence.size() == 0`, schedule a 30-second shutdown. Any `register` cancels the timer; any `deregister` or reconcile-prune that leaves presence empty rearms it. Covers "last session ended, nothing needs the daemon" while tolerating quick respawns.
- **Reconcile (safety net).** Every 60 s, poll `tmux list-sessions`. Any session in presence or subscriptions that isn't a live tmux session gets pruned. Covers sessions that crashed before their `deregister` ran.
- **Shutdown.** Close server, wait up to 2 s for in-flight requests, remove socket + pidfile, exit.

### Autostart

The daemon is spawned by `DaemonClient` on the first `ECONNREFUSED` / `ENOENT`:

1. Resolve `node_modules/.bin/tsx` by walking up from the autostart module (falls back to `$PATH` with a clean error if unreachable).
2. `spawn(tsx, [daemon/index.ts, ...], { detached: true, stdio: ['ignore', daemon.log, daemon.log] })`.
3. Poll the socket for readiness for up to 5 s.
4. Return when the socket accepts a connection, or throw if the daemon didn't come up.

The spawned process is detached and its stdout/stderr go to `~/.kl/daemon/daemon.log`, so killing the parent session doesn't kill the daemon.

## Reference

### Wire protocol

JSON-line over `$XDG_RUNTIME_DIR/kiln-lite.sock` (macOS fallback: `/tmp/kiln-lite-$UID.sock`). Each message is a single JSON object on one line:

```json
{
  "type": "subscribe",
  "ref": "a1b2c3d4e5f6",
  "channel": "build-chatter",
  "requester": {
    "agent": "agent",
    "session": "agent-bright-jay",
    "inbox_path": "/Users/.../.kl/agent/inbox"
  }
}
```

- `type` — request kind.
- `ref` — 12-hex correlation id; daemon echoes it back on the response.
- `requester` — identity envelope on every mutating request. Carries the calling session's id, agent name, and inbox path.

**Why `inbox_path` is on the envelope.** Every session is the authoritative source on its own inbox — no prefix → home-path registry file needed. When a session registers, the daemon learns its inbox path directly from the envelope. Today every session has the same `inbox_path`; tomorrow multi-home sessions get routing for free.

### Request types

**Lifecycle:**

| Type | Fields | Response | Purpose |
|------|--------|----------|---------|
| `register` | `requester` (with `inbox_path`), optional `pid` | `ack { session_count }` | Explicit session announcement. Cancels any pending idle shutdown. |
| `deregister` | `requester` | `ack` | Prune this session's subscriptions + presence. Rearms idle shutdown if empty. |

**Channels:**

| Type | Fields | Response | Purpose |
|------|--------|----------|---------|
| `subscribe` | `channel`, `requester` | `ack { subscriber_count }` | Add session to channel's subscriber set. Persisted. |
| `unsubscribe` | `channel`, `requester` | `ack { subscriber_count }` | Remove from subscriber set. |
| `publish` | `channel`, `summary`, `body`, `priority`, `requester` | `ack { recipient_count }` | Fanout: for each subscriber ≠ sender, resolve inbox and write message file. Appends to channel history. |

**Direct messaging:**

| Type | Fields | Response | Purpose |
|------|--------|----------|---------|
| `send_direct` | `to`, `summary`, `body`, `priority`, `requester` | `ack` | Resolve recipient inbox (live presence → known-sessions → sender's inbox_path as fallback) and write the file. |

**Queries:**

| Type | Fields | Response |
|------|--------|----------|
| `list_subscriptions` | `requester` | `result { channels: [str] }` |
| `list_sessions` | optional `agent` filter | `result { sessions: [SessionRecord] }` |
| `get_status` | — | `result { pid, uptime_sec, session_count, channel_count, ... }` |

### Response types

| Type | Fields |
|------|--------|
| `ack` | `status: "ok"`, optional extras (`subscriber_count`, `recipient_count`, `session_count`) |
| `result` | query-specific payload |
| `error` | `message`, optional `code` |

### Implicit re-registration

If a mutating request arrives from a session that isn't in presence (daemon crashed and restarted mid-session), the handler automatically re-registers the session using the envelope data. No special handshake — sessions are self-healing against daemon restart. This is the reason the envelope carries full registration data rather than just an opaque session id.

If the mutating request lacks `inbox_path` *and* the session isn't in `known-sessions.json` either, the request is refused — the daemon has no way to route messages for it.

### State files

All under `~/.kl/daemon/`.

#### `known-sessions.json`

```json
{
  "version": 1,
  "sessions": {
    "agent-bright-jay": {
      "session_id": "agent-bright-jay",
      "agent_name": "agent",
      "inbox_path": "/Users/.../.kl/agent/inbox",
      "first_seen_at": "2026-04-22T19:40:00Z",
      "last_seen_at":  "2026-04-22T21:15:12Z"
    },
    ...
  }
}
```

Upserted on every `register`. Never pruned at runtime. (If it grows unboundedly, `rm` and restart — the daemon will rebuild from new registrations. Proper TTL pruning is deferred.)

#### `subscriptions/<session-id>.json`

```json
{
  "version": 1,
  "session_id": "agent-bright-jay",
  "agent_name": "agent",
  "channels": ["docs-review", "next-steps"]
}
```

Written on `subscribe` / `unsubscribe`; removed on `deregister`.

#### `channels/<name>/history.jsonl`

Append-only log of every `publish` to each channel. One JSON object per line:

```json
{"ts":"2026-04-22T21:15:12Z","from":"agent-bright-jay","summary":"...","body":"...","priority":"normal","recipient_count":3}
```

Not read by the daemon itself at runtime — purely archival. Useful for post-hoc inspection or rebuilding channel state.

#### `daemon.pid`, `daemon.log`

`daemon.pid` contains the current daemon's PID. Removed on clean exit. `daemon.log` gets all stdout + stderr from the daemon and its autostart spawner. Log rotation is not implemented — `truncate -s 0 ~/.kl/daemon/daemon.log` when it's inconvenient.

### Env and socket resolution

| Var | Default | Notes |
|-----|---------|-------|
| `KL_DAEMON_SOCKET` | `$XDG_RUNTIME_DIR/kiln-lite.sock`, fallback `/tmp/kiln-lite-$UID.sock` | Override for testing. |
| `KL_DAEMON_STATE_DIR` | `~/.kl/daemon` | Override for testing. |

`DaemonClient` respects both — handy for running a second daemon against a temp state dir in smoke tests.

## Examples

### From a shell (via `kl-msg`)

```bash
kl-msg status                                   # daemon uptime + session count
kl-msg list-sessions                            # everyone alive
kl-msg list-sessions --agent myagent               # filter by agent name
kl-msg subscribe docs-review
kl-msg publish docs-review "draft posted" --body-stdin < /tmp/note.md
kl-msg send agent-bright-jay "spec q" --body "Does §4 need a heading?"
```

### From the extension (TypeScript)

```ts
import { DaemonClient } from "../../src/client/index.ts";

const client = new DaemonClient({
  requester: {
    agent: "agent",
    session: "agent-bright-jay",
    inbox_path: "/Users/.../.kl/agent/inbox",
  },
});

await client.register();
await client.subscribe("docs-review");
await client.publish("docs-review", "draft posted", "body text", "normal");
await client.sendDirect("agent-quiet-elk", "spec q", "...", "normal");
const channels = await client.listSubscriptions();
```

### Raw wire (for debugging)

```bash
# One line in, one line out. `jq` for legibility.
echo '{"type":"get_status","ref":"abcdef123456"}' \
  | nc -U ${XDG_RUNTIME_DIR:-/tmp}/kiln-lite.sock \
  | jq .
```

### Inspecting state

```bash
# what subscriptions do I have?
cat ~/.kl/daemon/subscriptions/agent-bright-jay.json | jq .

# who has the daemon ever seen?
jq '.sessions | keys' ~/.kl/daemon/known-sessions.json

# tail channel history
tail -f ~/.kl/daemon/channels/docs-review/history.jsonl | jq .
```

## Conventions

- **Mutations carry the envelope; queries can omit it.** `list_sessions` / `get_status` are pure reads — no requester needed. Everything else requires full identity.
- **Channels are string-keyed, no schema.** Subscribe anyone to any name; publish to any name. No channel registry, no "channel doesn't exist" errors. Unused channels just have zero subscribers and zero history.
- **One handler, one response.** Every request gets exactly one response (ack / result / error) before the connection closes. No streaming, no batching.
- **Fire-and-forget from the extension.** The extension never blocks session startup on the daemon. Register and deregister are both allowed to fail silently; the session runs without channel fanout and reconcile eventually cleans up.

## Gotchas

- **Socket lives in `$XDG_RUNTIME_DIR`, not `~/.kl/`.** If you want to reset the daemon, remove the pidfile and the socket (daemon cleans both on exit, but an ungraceful crash leaves them). A stale socket with no listener is detected on startup and removed automatically.
- **Channel fanout excludes the sender.** Publishing to a channel you're subscribed to doesn't put a copy in your own inbox. This is intentional — publisher has the body already.
- **`known-sessions.json` never prunes.** Every session that ever registered stays in the index forever. Minor footprint; if it becomes a problem, add TTL pruning later.
- **Dead-recipient sends use the last-known inbox_path.** If a session registered once, died without deregistering, and the reconcile loop hasn't run yet, `send_direct` uses the stored inbox_path. If the user has since deleted that inbox directory, the message write silently fails (best-effort write; no follow-up error path). Rare.
- **Reconcile uses `tmux list-sessions`.** If a session was launched via raw `pi` (no tmux), it won't appear in reconcile's poll and is never pruned automatically — only `deregister` on clean exit removes it. This is why `kl` is the recommended launcher.
- **No authentication on the socket.** Any local process that can reach the socket can send anything. This is fine for a single-user dev tool; don't expose the socket over a network.
- **Restart drops in-flight responses.** If the daemon dies between receiving a request and writing the response, the client times out. Retry is the client's problem — today the client doesn't retry automatically.
- **Old sockets from previous dev iterations may linger.** If autostart hangs, check `ls -la $XDG_RUNTIME_DIR/kiln-lite.sock` and `cat ~/.kl/daemon/daemon.pid`. A stale socket with no process is removed on next startup, but a stale pidfile pointing at a reused PID would be a problem (hasn't been observed).

## Cross-references

- [`messaging.md`](./messaging.md) — how sessions use the daemon's routing (subscribe, publish, direct).
- [`extension.md`](./extension.md) — where register/deregister fires in the Pi lifecycle.
- [`cli.md`](./cli.md) — the `kl-msg` CLI that's the primary way agents talk to the daemon.
- [`home.md`](./home.md) — why daemon state lives at `~/.kl/daemon/` and the socket doesn't.
- [`archive/daemon-and-layout.md`](./archive/daemon-and-layout.md) — original architectural write-up during the v0.3 arc (historical context, largely superseded by this doc).
