# Messaging

Sessions message each other with the `message` tool (or `kl message`
from a shell, see [cli.md](cli.md#kl-message)). Every message is a markdown file in the recipient's inbox,
`~/.kl/run/inbox/<session uuid>/` (`$KL_INBOX` inside the session).

## Sending

- **Direct:** `to` is a session name, resolved as in [cli.md](cli.md): the
  running session with that name, else the most recent one, or
  `name@<id-prefix>`, or an agent name (its one running session, else its
  most recent). An unknown name is an error, and nothing is written.
- **Running recipient:** the reply is `sent to <name>`.
- **Recipient not running:** the message is still written ("parked"), and the
  reply is `parked: <name> is not running (last seen <time>); kl resume <name>
  to wake`. Nothing wakes it automatically. It gets the mail when it's
  resumed.
- **Channel:** `channel` instead of `to` broadcasts to every subscribed
  session. Subscriptions are per session and survive restarts of the daemon.

## Receiving

- Idle when mail arrives (or at startup, for parked mail): all pending
  messages go into one user turn, each headed by a `kl-msg-id:` line.
- Busy: the next tool result gets a `[Notification | AGENT MESSAGE from … ]`
  block with the file path; read the file when convenient.
- Both are prefixed with a note that the mail comes from other agents, not
  the user, and carries no obligation.
- A message counts as delivered once it's in the transcript. Then kl writes
  an empty `<id>.read` next to `<id>.md`. A resumed session doesn't get the
  same message twice.

## Reading

`kl message channels` lists every channel; `kl message history #channel`
or `kl message history <session>` shows a channel's history or a session's
inbox, `--follow` streams new ones, `--json` for scripts. The `message`
tool has the same as `action: "channels"` and `action: "history"`.

## Message files

```
~/.kl/run/inbox/<uuid>/20261005T201341Z-61d000a966b14ee1.md
---
from: helper-hollow-grove
from_session: 01a10db3-5b00-72fe-b16b-590abb4b8d91
to: boss-green-lane
summary: "late"
timestamp: 2026-10-05T20:13:41Z
priority: normal
---

PARKED-BODY
```

Messages with no `.read` sibling are unread. `kl message history <session>` marks them "new".
Files are written to a temp name and renamed, so a reader never sees half a
message.

## The daemon

A small Node daemon routes messages and holds channel subscriptions. It
starts on first use and exits about 30 s after the last session goes away.
You don't manage it.

- Socket: `$XDG_RUNTIME_DIR/kiln-lite.sock`, else `/tmp/kiln-lite-<uid>.sock`
- State and log: `~/.kl/daemon/` (`known-sessions.json`, `subscriptions/`,
  `channels/<name>/history.jsonl`, `daemon.log`)
- Protocol: one JSON line per request over the unix socket; see
  `src/daemon/protocol.ts`.
- `kl message status` checks it's up.

The bundled `messaging` skill (`skills/messaging/SKILL.md`) is the agent-facing
version of this page.
