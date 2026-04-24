# Messaging

How sessions exchange messages — inbox file format, direct sends, channel pub/sub, and the `message` skill.

## Overview

Each Pi session running kiln-lite has an inbox directory at `<home>/inbox/<agent-id>/` where incoming messages land as `.md` files with YAML frontmatter. The daemon routes between inboxes; the extension watches the recipient's inbox and delivers.

Two routing modes:

- **Direct** — address another session by agent-id. The daemon resolves the recipient's inbox (via live presence, or `known-sessions.json` fallback) and writes the file.
- **Channel** — publish to a named channel. The daemon fans out: for every subscriber ≠ sender, write a file to their inbox.

Delivery is asynchronous. The recipient's extension watches the inbox:

- **Idle** — new `.md` is injected as a full user turn.
- **Mid-turn** — new `.md` bumps an unread counter, which gets appended as `[INBOX: N unread]` to the next tool result.

The `read` and `list` subcommands of the `message` skill are pure file reads — no daemon needed. Send, publish, subscribe, unsubscribe, list-subscriptions, and status all go through the daemon via `kl-msg`. Peer discovery (listing live sessions) is handled by the separate [`sessions`](#session-discovery) tool.

## Architecture

```
sender session                       daemon                           recipient session
─────────────                        ──────                           ─────────────────
message publish #foo ...
  → kl-msg publish #foo ...
      → DaemonClient.publish(...)
          → Unix socket --------→ handlePublish
                                    ├─ for each subscriber ≠ sender:
                                    │    resolve inbox_path (presence → known-sessions)
                                    │    writeInboxMessage(...)           → <recipient inbox>/<ts>-<rand>.md
                                    ├─ appendChannelHistory(...)          → channels/#foo/history.jsonl
                                    └─ ack { recipient_count: N }  ←────┐
                                                                         │
                                                                   fs.watch in recipient's
                                                                   extension picks up new .md
                                                                      ↓
                                                                   idle   → deliver as user turn
                                                                   busy   → queue for next tool_result
```

### Actors

- **`kl-msg` CLI** (`src/client/cli.ts`) — subcommands wrap `DaemonClient` calls. The `message` skill's `send`/`publish`/`subscribe`/etc all shell out to `kl-msg`.
- **`DaemonClient`** (`src/client/index.ts`) — autostarting Unix-socket RPC client.
- **Daemon handlers** (`src/daemon/handlers.ts`) — one per request type. `handlePublish` fans out, `handleSendDirect` resolves + writes.
- **`writeInboxMessage`** (`src/daemon/inbox.ts`) — writes the `.md` file with frontmatter.
- **Extension inbox watcher** (`extensions/kiln-lite/inbox.ts`) — fs.watch on `<home>/inbox/<agent-id>/`; delivery logic.
- **`message` skill** (`tools/message`) — bash frontend the agent uses. Daemon-bound subcommands delegate to `kl-msg`; file-bound (`read`, `list`) stay pure bash.

### Send flow — direct

```
agent → message send <to> <summary>
  → kl-msg send ...
    → DaemonClient.sendDirect
      → socket: {type: "send_direct", to, summary, body, priority, requester}
        → handleSendDirect
          ├─ resolve inbox_path for <to>:
          │    1. presence registry (is <to> alive?)
          │    2. known-sessions.json (have we seen <to> before?)
          │    3. fall back to sender's own inbox_path (single-home scenario)
          ├─ writeInboxMessage → <inbox>/<to>/<ts>-<rand>.md
          └─ ack
```

### Send flow — channel

```
agent → message publish <channel> <summary>
  → kl-msg publish ...
    → DaemonClient.publish
      → socket: {type: "publish", channel, summary, body, priority, requester}
        → handlePublish
          ├─ for each subscriber ≠ sender:
          │    resolve inbox_path, writeInboxMessage
          ├─ appendChannelHistory → channels/<name>/history.jsonl
          └─ ack { recipient_count: N }
```

### Delivery flow

Two non-overlapping windows:

- **Idle delivery.** When `ctx.isIdle()` is true, the watcher reads new `.md` files and `pi.deliver(...)`s them as user turns. Full body goes into the conversation. `.read` marker file written so we don't re-deliver.
- **Mid-turn ping.** When the session is actively thinking or looping through tools, the watcher adds new files to an in-memory unread set. On the next `tool_result` hook, the extension appends `[INBOX: N unread]` to the last text content item. Body isn't injected — the agent reads the file via `message read <id-prefix>` if it cares.

On `agent_end`, the watcher's `markAllSeen()` clears the unread set so the ping suffix doesn't repeat on every turn.

## Reference

### Message file format

`.md` files under `<home>/inbox/<agent-id>/`:

```markdown
---
from: <sender-agent-id>
to: <recipient-agent-id>
summary: "Short one-line summary"
timestamp: 2026-04-22T21:15:12Z
priority: normal
channel: docs-review             # present for channel messages; omitted for direct
---

<body text, can be multiple paragraphs>
```

Field notes:

- `summary` is YAML-escaped (backslashes, quotes, newlines) by the writer so it always parses.
- `timestamp` is second-precision UTC.
- `priority` is `normal` or `high`.
- `channel` presence distinguishes channel messages from direct; frontmatter is otherwise identical.

Filename convention: `<YYYYMMDDTHHMMSSZ>-<16-hex>.md`. The hex suffix prevents collisions on fast-succession writes within the same second.

### The `message` skill

Located at `<home>/tools/message`. Installed by `bootstrap.sh`.

```
message <subcommand> [args]

Daemon-bound (delegate to kl-msg):
  send <to> <summary> [--body <text> | --stdin] [--priority normal|high]
  publish <channel> <summary> [--body <text> | --stdin] [--priority ...]
  subscribe <channel>
  unsubscribe <channel>
  list-subscriptions
  status

File-based (no daemon):
  read <id-prefix>           # print a received message
  list [--unread|--all]      # list received messages
```

Requires env: `$AGENT_HOME`, `$AGENT_ID`, `$INBOX`. All three are exported by the kiln-lite extension at `session_start`.

Peer discovery lives in a separate tool (see [below](#session-discovery)) — `message` is for messaging, `sessions` is for finding who's out there to message.

### Session discovery

`<home>/tools/sessions` — queries the daemon's presence registry to list live agent sessions; falls back to a `tmux list-sessions` scan when the daemon is unreachable. Canonical tool for peer discovery; `message` deliberately doesn't duplicate it.

```
sessions                      list active sessions (excludes self)
sessions list [--all]         same; --all includes self
sessions show <agent-id>      detail view for one session
```

Underneath, `sessions` uses `kl-msg list-sessions [--agent NAME]` — you can call that directly if you want the raw TSV output (`session_id\tagent_name\tpid=N\tstatus\tlast_seen_at`).

### `kl-msg` CLI

See [`cli.md`](./cli.md) for full details. In short: thin wrapper around `DaemonClient` that reads `$AGENT_ID` / `$AGENT_HOME` / `$INBOX` / `$AGENT_NAME` from env to build the requester envelope.

### Wire protocol

Full wire reference in [`daemon.md`](./daemon.md). The messaging-relevant subset:

| Type | Required fields | Response |
|------|-----------------|----------|
| `subscribe` | `channel`, `requester` | `ack { subscriber_count }` |
| `unsubscribe` | `channel`, `requester` | `ack { subscriber_count }` |
| `publish` | `channel`, `summary`, `body`, `priority`, `requester` | `ack { recipient_count }` |
| `send_direct` | `to`, `summary`, `body`, `priority`, `requester` | `ack` |
| `list_subscriptions` | `requester` | `result { channels: [str] }` |

### Inbox notification format

Mid-turn `tool_result` suffix:

```
[INBOX: 3 unread]
```

Just the count — the body is deliberately not injected. The agent decides whether to interrupt the current thread to read.

Idle delivery injects the full body as a user turn, rendered by Pi normally. No extra formatting on top.

### Subscription persistence

Written by the daemon to `~/.kl/daemon/subscriptions/<session-id>.json` on every `subscribe` / `unsubscribe`. Removed on `deregister`. On daemon restart, subscriptions are replayed into the in-memory `ChannelRegistry` so existing subs survive restart.

The extension does **not** track "desired subscriptions" on the session side — if the daemon drops a subscription and the session doesn't notice, that channel is just lost for that session. Re-subscribe to recover. A future iteration could reconcile a desired-set against the daemon's actual state, but today it doesn't.

### Recipient resolution order

`handleSendDirect` tries, in order:

1. **Live presence** — is the recipient currently registered? Use their registered `inbox_path`.
2. **Known sessions** — was the recipient ever registered? Use the last-known `inbox_path` from `known-sessions.json`.
3. **Sender fallback** — use the sender's own `inbox_path`. This works only in the current single-home case and is a correctness hack for targets the daemon has truly never seen.

If none of these produce a directory, the write fails silently. (Future iteration: error back to the client.)

## Examples

### Subscribe, publish, read

```bash
# In session A:
message subscribe docs-review

# In session B:
message publish docs-review "draft ready for review" \
  --body "scratch/draft-v2.md — §4 still open."

# Session A sees:
#   mid-turn: [INBOX: 1 unread]
#   OR idle:  delivered as full user turn
#
# To read manually:
message list --unread
#   20260422T211512Z-2d1d7b  from agent-thorn-hawk     draft ready for review (chan: docs-review)
message read 20260422T211512Z
#   ---
#   from: agent-thorn-hawk
#   to: agent-ash-fern
#   summary: "draft ready for review"
#   timestamp: 2026-04-22T21:15:12Z
#   priority: normal
#   channel: docs-review
#   ---
#
#   scratch/draft-v2.md — §4 still open.
```

### Direct message

```bash
message send agent-quiet-elk "spec q" \
  --body "Does the §4 heading rule still hold when the section has no content?"
```

### List active sessions

```bash
sessions
# SESSION                       STATUS    UPTIME      UNREAD
# agent-quiet-elk               running   25m         0
# agent-wild-brook              running   1h 12m      2

sessions --all
# (includes self)

sessions show agent-quiet-elk
# agent_id:     agent-quiet-elk
# agent_name:   agent
# status:       running
# pid:          45821
# last_seen:    2026-04-22T20:15:30
# uptime:       25m
# inbox:        /home/kira/.kl/agent/inbox/agent-quiet-elk
# unread:       0
```

For the raw presence feed (e.g. scripting), `kl-msg list-sessions [--agent NAME]` emits TSV.

### Write a shell helper that reads all unread

```bash
for f in "$INBOX"/*.md; do
  [ -f "${f%.md}.read" ] && continue
  echo "=== $(basename "$f") ==="
  cat "$f"
  touch "${f%.md}.read"
done
```

The watcher respects `.read` markers — anything with one is skipped on future delivery.

## Conventions

- **Summary is for the notification; body is for detail.** A well-written summary lets the recipient decide whether to read the body now or later. Keep it to one line.
- **Use channels for broadcast, DMs for 1:1.** `send_direct` per recipient is fine for small N; a channel is cleaner beyond 3-4 subscribers.
- **Reply in the same mode.** Channel → reply on the channel. DM → reply with `send <to>`. Mixing looks like you didn't read the context.
- **Subscribe early, unsubscribe rarely.** Subscriptions are cheap (one file, one set entry). Leaving a stale subscription until session end is fine.
- **Don't hand-write `.md` files into someone else's inbox.** The daemon route writes channel history and respects presence. Direct filesystem writes bypass both.
- **File-based `read`/`list` works without the daemon.** Useful for debugging, CI, or when the daemon is misbehaving.

## Gotchas

- **Session ID collisions mean inbox collisions.** `<agent-id>` is deterministic from Pi's session UUID, so two sessions with the same UUID share the same inbox. This doesn't happen under normal use (Pi assigns fresh UUIDs) but if you synthesize UUIDs manually, watch it.
- **Mid-turn pings need a `tool_result` to piggyback on.** A turn with no tool calls gets no ping. Usually fine because the next turn either calls a tool or goes idle and triggers full delivery; but long tool-less turns (the agent "thinking" without calling anything) can delay notification.
- **Channel fanout excludes the sender.** Publishing to a channel you're subscribed to doesn't put a copy in your own inbox. `channels/<name>/history.jsonl` has the canonical record if you want to see what you sent.
- **`known-sessions.json` is the resolver for dead sends.** If it gets deleted, DMs to sessions that aren't currently alive will fall back to the sender's own inbox — they won't error, they'll just land somewhere unexpected. Don't delete it unless you're resetting the daemon entirely.
- **Subscriptions don't outlive `deregister`.** The daemon removes subscription files on `deregister`. A session that re-registers under a new id starts fresh. If you want persistent subscriptions per *agent* rather than per session, that's a layer kiln-lite doesn't currently provide.
- **The filename timestamp is second-precision.** Two messages written within the same second get different 16-hex suffixes, so no collision — but if you sort purely by the timestamp prefix you'll see ties.
- **`.read` markers are only written on delivery.** If a session reads a message file directly without going through the watcher (e.g. `cat` in a shell tool), the watcher will still see it as unread and re-deliver. Use `message read <id-prefix>` — it writes the marker for you.

## Cross-references

- [`daemon.md`](./daemon.md) — wire protocol + state files.
- [`extension.md`](./extension.md) — inbox watcher, mid-turn suffix, idle delivery.
- [`cli.md`](./cli.md) — `kl-msg` invocation details.
- [`home.md`](./home.md) — `<home>/inbox/<agent-id>/` layout.
