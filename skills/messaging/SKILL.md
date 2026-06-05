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
become user turns; mid-work arrivals append a `[Notification | …]` block
to your next tool result, pointing at the message file path so you can
`Read` it when convenient. Each `.md` message gets a sibling `.read` marker
file once it's been delivered or notified — this is how the watcher tracks
unread state (there's no separate queue).

**Full reference:** see `docs/messaging.md` in the kiln-lite repo — wire
protocol, file format, delivery semantics, gotchas.

## Using the `message` tool

`message` is a **builtin tool** registered by the kiln-lite extension —
not a shell script. Single tool, three actions behind an `action`
discriminator.

```
message(action="send", to="<session-id>", summary="<one-liner>", body="<text>")
message(action="send", channel="<channel>", summary="<one-liner>", body="<text>")
message(action="subscribe", channel="<channel>")
message(action="unsubscribe", channel="<channel>")
```

- **`action=send`** needs `summary` and `body`, plus exactly ONE of `to`
  (for a DM) or `channel` (for a broadcast). Optional `priority:
  "normal"|"high"` — defaults to `"normal"`, surfaces in the recipient's
  notification header when `"high"`.
- **`action=subscribe|unsubscribe`** takes only `channel`. Reject other
  fields — the tool errors if you pass them.

Body is a plain string — newlines, quotes, backticks, code blocks all go
through untouched. No shell quoting to worry about.

### Reading your inbox

Use Pi's built-in `Read` tool on the inbox path. The extension's Read hook
marks the file as consumed (touches the `.read` sibling) so it won't be
re-pinged.

```
Read("/path/to/$AGENT_HOME/inbox/<your-id>/<timestamp>-<hex>.md")
```

The mid-turn notification block gives you the full path — just feed it to
`Read` directly.

### Listing your inbox

Use bash `ls` to see what's there. `.md` files without a matching `.read`
sibling are unread:

```bash
ls -t "$INBOX"                          # newest first (all)
ls "$INBOX"/*.md 2>/dev/null             # every message (read or unread)
# unread = .md with no .read sibling; one-liner:
for f in "$INBOX"/*.md; do [ -e "${f%.md}.read" ] || echo "$f"; done
```

### Peer discovery + daemon status

```bash
sessions                        # list active sessions (daemon-first, tmux fallback)
sessions show <agent-id>        # detail view for a specific peer
kl-msg status                   # daemon pid, uptime, counts
kl-msg list-subscriptions       # your current channel subs
```

`sessions` is the canonical tool for peer discovery. `kl-msg` is the
low-level CLI — useful for scripting and introspection; the `message`
tool is the normal agent-facing surface.

## Addressing

Agent IDs are shaped `<name>-<adjective>-<noun>` — e.g. `agent-bright-raven`.
Deterministic from the Pi session UUID, so `/resume` recovers the same ID.
You can also address any session you've been messaged by (the `from:` line
in their message frontmatter is the literal address).

## Message file format

```markdown
---
from: agent-bright-raven
to: agent-still-wren
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
- **Peer busy**: a `[Notification | AGENT MESSAGE from <sender> | source:
  kiln-lite/<dm-or-channel> | sent HH:MM:SS]` block is appended to their
  next tool result, followed by the full message file path. They `Read`
  the file when convenient.

Once a message is delivered or notified, the extension writes an empty
`<message>.read` sibling marker. Messages stay at their original `.md`
path; the marker is the sole signal of "handled". Reading the `.md` via
Pi's Read tool also touches the marker (belt-and-suspenders for the case
where you spot a message via `ls` before any notification fires).

## Conventions

- **Summary is for notifications; body is for detail.** A good summary lets
  the recipient decide whether to interrupt their current thread. Keep it
  to one line.
- **DM for 1:1, channels for broadcast.** `action=send` with `to=` per
  recipient is fine for N=2–3; a channel is cleaner beyond that.
- **Subscribe early, unsubscribe rarely.** Subscriptions are cheap — one
  JSON file, one set entry. Leaving a stale sub until session end is fine.
- **Reply in the same mode you received.** Channel → reply on the channel.
  DM → reply with `action=send, to=<from>`. Mixing looks like you missed
  context.

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

## Gotchas

- **Publishing to a channel you subscribe to doesn't add a copy to your
  own inbox** — fanout excludes the sender. Channel history at
  `~/.kl/daemon/channels/<channel>/history.jsonl` has the canonical record.
- **Mid-turn inbox pings piggy-back on tool results.** A turn with no tool
  calls gets no ping. The message stays pending; the first tool call on
  the next turn surfaces it.
- **Dead-peer DMs fall back to last-known inbox.** If you DM a session
  that registered once and exited without clean deregister, the daemon
  uses the stored `inbox_path` from `known-sessions.json`. Usually this
  works; if the recipient has since deleted their inbox dir, the write
  silently fails.
- **Subscriptions don't survive `deregister`.** The daemon removes a
  session's subscription file when the session ends. If you want persistent
  subs per *agent* across sessions, re-subscribe at startup (e.g. via an
  `agent.yml:startup` command).
