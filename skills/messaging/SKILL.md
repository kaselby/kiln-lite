---
name: messaging
description: Inter-session messaging via kiln-lite's daemon + file-based inboxes. Use when coordinating with peer sessions — DMs, channel broadcasts, peer discovery, inbox management. Activate when the task involves talking to other agents.
---

# Messaging

Every kiln-lite session has a name (`<agent>-<adj>-<noun>`, e.g.
`reviewer-calm-fox`) and a file-based inbox at `$KL_INBOX`
(`~/.kl/run/<session uuid>/inbox/`). Sessions communicate by dropping markdown
files into each other's inboxes — directly (DM) or through a channel
(broadcast to subscribers).

Behind the scenes, a Node daemon (`~/.kl/daemon/`) owns channel subscriptions,
session presence, and inbox routing. It **autostarts on first use** and
self-exits when no sessions are alive for 30 s — you never have to start
or stop it manually. If you're curious, `kl message status` confirms it's there.

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
not a shell script. Single tool, five actions behind an `action`
discriminator.

```
message(action="send", to="<session name>", summary="<one-liner>", body="<text>")
message(action="send", channel="<channel>", summary="<one-liner>", body="<text>")
message(action="subscribe", channel="<channel>")
message(action="unsubscribe", channel="<channel>")
message(action="channels")
message(action="history", channel="<channel>", limit=20)
message(action="history", to="<session name>")
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
Read("$KL_INBOX/<timestamp>-<hex>.md")      # the notification gives the full path
```

The mid-turn notification block gives you the full path — just feed it to
`Read` directly.

### Listing your inbox

Use bash `ls` to see what's there. `.md` files without a matching `.read`
sibling are unread:

```bash
ls -t "$KL_INBOX"                          # newest first (all)
ls "$KL_INBOX"/*.md 2>/dev/null             # every message (read or unread)
# unread = .md with no .read sibling; one-liner:
for f in "$KL_INBOX"/*.md; do [ -e "${f%.md}.read" ] || echo "$f"; done
kl message history <session name>          # any session's mail, "new" = unread
```

### Peer discovery + daemon status

```bash
kl sessions                     # recent sessions as parent/child trees; * = running
kl message status               # daemon pid, uptime, counts
kl message channels             # every channel; * = you subscribe
kl message history '#build'     # a channel's history (or a session name: its inbox)
```

The `sessions` tool (or `kl sessions`) is the canonical way to find peers
and see what each is doing. `kl message` is the shell CLI for scripting;
the `message` tool is the normal agent-facing surface and can also list
channels (`action="channels"`) and read history (`action="history"`).

## Addressing

Address a session by its name, `<agent>-<adjective>-<noun>`, e.g.
`reviewer-calm-fox`. The name is drawn when the session starts and is
unique among running sessions; a resumed session keeps its name unless
another running session holds it. The `from:` line of a message you
received is the sender's name, so you can reply to it directly.

The daemon turns the name into a session once, when you send:

- **Running** → delivered; the tool says `sent to <name>`.
- **Known but not running** → the message is written anyway and waits
  ("parked"). The tool says `parked: <name> is not running (last seen
  <time>); kl resume <name> to wake`. It is delivered when that session
  is resumed. Nothing wakes it automatically.
- **Unknown** → the send fails and nothing is written.

A name used by several sessions over time means the running one, else the
one that used it most recently; the tool's reply then says other sessions
were skipped. Reach a specific one with `name@<id-prefix>` (at least 4 hex
characters of its session UUID; `kl sessions` shows the ids).

`to` can also be an agent name (`"boss"`): its session if exactly one is
running, else its most recent one; the reply says which. If several of its
sessions are running, the send fails and lists them; pick one by name.

## Message file format

```markdown
---
from: reviewer-calm-fox          # sender's name
from_session: 01a10d7c-...       # sender's session UUID (DMs)
to: reviewer-red-owl
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

- **Peer idle**: the message is delivered as a user turn on their side,
  headed by a note that it comes from another agent, not the user, and
  carries no obligation to comply.
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
| `AGENT_ID`      | Your session's name (e.g. `reviewer-calm-fox`)  |
| `AGENT_NAME`    | The name component (e.g. `scout`)                |
| `SESSION_UUID`  | Pi session UUID                                 |
| `KL_INBOX`      | `~/.kl/run/$SESSION_UUID/inbox/`                |

## Gotchas

- **Publishing to a channel you subscribe to doesn't add a copy to your
  own inbox** — fanout excludes the sender. Channel history at
  `~/.kl/daemon/channels/<channel>/history.jsonl` has the canonical record.
- **Mid-turn inbox pings piggy-back on tool results.** A turn with no tool
  calls gets no ping. The message stays pending; the first tool call on
  the next turn surfaces it.
- **A stopped session still gets mail.** DMs and channel posts to a
  session that isn't running are parked in its inbox (`run/<uuid>/inbox/`)
  as long as its folder exists. Delete the folder and nothing reaches it.
- **Subscriptions don't survive `deregister`.** The daemon removes a
  session's subscription file when the session ends. If you want persistent
  subs per *agent* across sessions, re-subscribe at startup (e.g. via an
  `agent.yml:startup` command).
