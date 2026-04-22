---
name: messaging
description: Inter-session messaging via file-based inboxes. Use when you need to coordinate with other agent sessions on this machine — send a message, check your inbox, list peer agents, or hand off work. Activate when asked to communicate between sessions or coordinate with a peer.
---

# Messaging

Every kiln-lite session has a unique agent ID and a file-based inbox under
`$AGENT_HOME/inbox/<agent-id>/`. Sessions communicate by writing markdown files
into each other's inboxes. Same-machine only. No daemon. No network.

The extension watches your inbox — if a message arrives while you're idle it
becomes a user turn; if you're mid-work, a `[INBOX: N unread]` suffix is
appended to your next tool result so you can check when convenient.

**This skill bundles two scripts:** `message` (send/read/manage your inbox)
and `sessions` (discover active peers). Both expect the kiln-lite extension
to be loaded (for env vars + inbox delivery). Invoke them via bash using
the paths below.

## Using the `message` script

The script lives inside this skill at:

```
<this-skill-dir>/scripts/message
```

Invoke it with bash. Arguments:

```bash
bash <skill-dir>/scripts/message send <to-agent-id> "<summary>" --body "<text>"
bash <skill-dir>/scripts/message send <to-agent-id> "<summary>" --stdin <<'EOF'
multi-line body
EOF
bash <skill-dir>/scripts/message send <to-agent-id> "<summary>" --body "urgent" --priority high

bash <skill-dir>/scripts/message list [--unread|--all]
bash <skill-dir>/scripts/message read <id-prefix>
bash <skill-dir>/scripts/message clear          # move unread -> .read/
bash <skill-dir>/scripts/message stats          # counts

bash <skill-dir>/scripts/message subscribe <channel>    # v1 stub — no daemon yet
bash <skill-dir>/scripts/message unsubscribe <channel>  # v1 stub
```

The script reads `$AGENT_HOME`, `$AGENT_ID`, and `$INBOX` from the environment
(set by the kiln-lite extension). Don't pass them explicitly.

## Addressing

Each session has an agent ID shaped `<name>-<adjective>-<noun>` — e.g.
`pi-bright-raven`. The ID is deterministic from the Pi session UUID, so
`/resume`-ing recovers the same ID.

Use the `sessions` script (also shipped inside this skill) for peer discovery:

```bash
bash <skill-dir>/scripts/sessions list               # all active agents + unread counts
bash <skill-dir>/scripts/sessions show <agent-id>    # metadata for a specific peer
bash <skill-dir>/scripts/sessions resolve <uuid>     # uuid -> agent-id
```

Under the hood, `sessions` reads the `.id` files the kiln-lite extension
maintains at `$AGENT_HOME/sessions/*.id` (one per active session). Stale entries
can linger if a session crashed without cleanup.

## Message format

Messages are plain markdown with YAML frontmatter:

```markdown
---
from: pi-bright-raven
to: pi-still-wren
summary: Ready for your review
timestamp: 2026-04-22T10:15:00Z
priority: normal
---

Body text.
```

## Delivery semantics (happens automatically, no action needed)

- **Peer idle**: message appears as a user turn on their side immediately
- **Peer busy**: `[INBOX: N unread]` suffix on their next tool result; they
  read the body when convenient

Read messages are moved to `$INBOX/.read/` — keeps the active inbox small.

## Channels (v1 stubs)

`message subscribe`/`unsubscribe` log "channels unavailable (no daemon)". The
interface is stable for a future daemon port — don't expect broadcasts yet.

## Environment

The extension exports these to every child process (startup commands, tools,
scripts you invoke via bash):

| Var             | Meaning                                         |
|-----------------|-------------------------------------------------|
| `AGENT_HOME`    | Resolved agent home (default `~/.agent/`)       |
| `AGENT_ID`      | Your session's ID                               |
| `AGENT_NAME`    | The name component (e.g. `pi`)                  |
| `SESSION_UUID`  | Pi session UUID                                 |
| `INBOX`         | `$AGENT_HOME/inbox/$AGENT_ID/`                  |
