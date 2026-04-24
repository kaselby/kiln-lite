---
name: messaging
description: Inter-session messaging via kiln-lite's daemon + file-based inboxes. Use when coordinating with peer sessions — DMs, channel broadcasts, peer discovery, inbox management. Activate when the task involves talking to other agents.
---

# Messaging

Every kiln-lite session has a unique agent ID and a file-based inbox at
`$AGENT_HOME/inbox/<agent-id>/`. Sessions communicate by dropping markdown
files into each other's inboxes — directly (DM) or through a channel
(broadcast to subscribers).

Behind the scenes, a Node daemon (`~/.kl/daemon/`) owns channel subscriptions,
session presence, and inbox routing. It **autostarts on first use** and
self-exits when no sessions are alive for 30 s — you never have to start
or stop it manually. If you're curious, `kl-msg status` confirms it's there.

The extension watches your inbox transparently: idle-arriving messages
become user turns; mid-work arrivals add an `[INBOX: N unread]` suffix to
your next tool result so you can check when convenient. Delivered messages
get moved into `$INBOX/.read/` so the unread list stays tight.

**Full reference:** see `docs/messaging.md` in the kiln-lite repo — wire
protocol, file format, delivery semantics, gotchas.

## Using the `message` command

`message` and `sessions` are bundled shell tools — on `$PATH` in every
kiln-lite session, invokable by bare name. Daemon-bound subcommands of
`message` (`send`, `publish`, `subscribe`, `unsubscribe`,
`list-subscriptions`, `status`) talk to the daemon via `kl-msg`.
File-based subcommands (`read`, `list`) read your inbox directly — no
daemon needed. For session discovery, use `sessions` (not `message`).

### Direct messages

```bash
message send <to-agent-id> "<summary>" --body "<text>"
message send <to-agent-id> "<summary>" --stdin <<'EOF'
multi-line body
EOF
message send <to-agent-id> "<summary>" --body "urgent" --priority high
```

### Channels

```bash
message subscribe <channel>
message unsubscribe <channel>
message list-subscriptions

message publish <channel> "<summary>" --body "<text>"
message publish <channel> "<summary>" --stdin <<'EOF'
longer broadcast body
EOF
```

Publish fans out to every subscriber ≠ sender — you don't receive a copy of
your own broadcast. The channel's full history lives at
`~/.kl/daemon/channels/<channel>/history.jsonl` if you need to see what you
sent.

### Reading your inbox

```bash
message list                 # unread (default)
message list --all           # unread + read
message read <id-prefix>     # print a message body
```

### Peer discovery + daemon status

```bash
sessions                        # list active sessions (daemon-first, tmux fallback)
sessions show <agent-id>        # detail view for a specific peer
message status                  # daemon pid, uptime, counts
```

`sessions` is the canonical tool for peer discovery. It queries the
daemon's presence registry first; if the daemon is unreachable, it falls
back to tmux session listing.

## Addressing

Agent IDs are shaped `<name>-<adjective>-<noun>` — e.g. `beth-bright-raven`.
Deterministic from the Pi session UUID, so `/resume` recovers the same ID.
You can also address any session you've been messaged by (the `from:` line
in their message frontmatter is the literal address).

## Message file format

```markdown
---
from: beth-bright-raven
to: beth-still-wren
summary: Ready for your review
timestamp: 2026-04-22T10:15:00Z
priority: normal
channel: kiln-docs              # present for channel messages; omitted for DMs
---

Body text. Can be multiple paragraphs.
```

Filenames: `<YYYYMMDDTHHMMSSZ>-<16-hex>.md`. Timestamp-prefixed so
sorted listings are chronological; hex suffix prevents collisions.

## Delivery semantics

Automatic — no action needed. What happens:

- **Peer idle**: the message is delivered as a user turn on their side.
- **Peer busy**: `[INBOX: N unread]` is appended to their next tool result;
  they `message read <id>` when convenient.

On delivery, the `.md` file moves into `$INBOX/.read/` so it stops showing
up in unread lists. Read messages are still reachable via `message read <id>`
(the lookup checks both the unread and `.read/` dirs).

## Conventions

- **Summary is for notifications; body is for detail.** A good summary lets
  the recipient decide whether to interrupt their current thread. Keep it
  to one line.
- **DM for 1:1, channels for broadcast.** `send` per recipient is fine
  for N=2-3; a channel is cleaner beyond that.
- **Subscribe early, unsubscribe rarely.** Subscriptions are cheap — one
  JSON file, one set entry. Leaving a stale sub until session end is fine.
- **Reply in the same mode you received.** Channel → reply on the channel.
  DM → reply with `send <to=from>`. Mixing looks like you missed context.

## Environment

The extension exports these to every child process (startup commands,
tools, scripts you invoke via bash):

| Var             | Meaning                                         |
|-----------------|-------------------------------------------------|
| `AGENT_HOME`    | Resolved agent home (default `~/.kl/agent/`)    |
| `AGENT_ID`      | Your session's ID                               |
| `AGENT_NAME`    | The name component (e.g. `beth`)                |
| `SESSION_UUID`  | Pi session UUID                                 |
| `INBOX`         | `$AGENT_HOME/inbox/$AGENT_ID/`                  |

The `message` and `sessions` tools read all of these from the env
automatically.

## Gotchas

- **Publishing to a channel you subscribe to doesn't add a copy to your
  own inbox** — fanout excludes the sender. Channel history at
  `~/.kl/daemon/channels/<channel>/history.jsonl` has the canonical record.
- **Mid-turn inbox pings piggy-back on tool results.** A turn with no tool
  calls gets no ping. Usually fine (next turn catches it), but worth
  remembering if you're expecting live fanout during a tool-less turn.
- **Dead-peer DMs fall back to last-known inbox.** If you DM a session
  that registered once and exited without clean deregister, the daemon
  uses the stored `inbox_path` from `known-sessions.json`. Usually this
  works; if the recipient has since deleted their inbox dir, the write
  silently fails.
- **Subscriptions don't survive `deregister`.** The daemon removes a
  session's subscription file when the session ends. If you want persistent
  subs per *agent* across sessions, re-subscribe at startup (e.g. via an
  `agent.yml:startup` command).
