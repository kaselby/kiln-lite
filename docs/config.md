# The kl folder and config.yml

This covers the kl folder, `~/.kl` (or `$KL_ROOT`): what's in it, what
writes and reads each part, and what's safe to delete. It also lists the
keys of the global `config.yml`. Per-agent settings are in
[agents.md](agents.md#agentyml).

## Layout

```
~/.kl/
  config.yml              settings for every agent (below)
  agents/<name>/          agent folders, unless $KL_AGENTS_DIR is set
  pi/                     the kl Pi dir
    auth.json             symlinks to the same files in ~/.pi/agent
    keybindings.json
    models.json
    settings.json         Pi's settings for kl sessions (Pi writes it)
    sessions/             Pi's transcripts of kl sessions
    APPEND_SYSTEM.md      optional: text added to every kl agent's prompt
  run/
    <uuid>/               one folder per session:
      session.yml           registry entry
      lease.json            present while the session runs
      inbox/                inbox
      plan.json             plan
      status.json           status file
      schedule/             pending wakes from the schedule tool
      wake.lock/            lock held while starting the stopped session
    names.lock/           lock held while drawing a name
  daemon/                 the messaging daemon's state and log
```

`KL_ROOT` moves all of it; `$KL_AGENTS_DIR` moves just the agent folders.
The daemon's socket isn't here: it's `$XDG_RUNTIME_DIR/kiln-lite.sock`, or
`/tmp/kiln-lite-<uid>.sock` if that's unset. It doesn't follow `KL_ROOT`,
so two kl folders on one machine share a daemon unless their
`XDG_RUNTIME_DIR` differs.

## What uses each part

**`config.yml`** is yours. kl reads it on every launch and session start.

**`pi/`** is the Pi config dir for every kl session
(`PI_CODING_AGENT_DIR`), kept apart from base Pi's `~/.pi/agent`. kl creates
it on the first launch: it symlinks `auth.json`, `keybindings.json` and
`models.json` to `~/.pi/agent` if they exist there. It never overwrites a
file that's already there, never copies, and never writes to
`~/.pi/agent`. After that it's Pi's: Pi writes transcripts under
`sessions/`, and `kl install` installs packages here
([install.md](install.md)). Edit `settings.json` as you like.

**`run/<uuid>/`** holds everything kl keeps about one session.

**`session.yml`** and **`lease.json`**: the session's process writes its
own registry entry and lease; `kl`, the daemon and the `sessions` tool read
them. See [sessions.md](sessions.md#names-and-the-registry).

**`inbox/`**: the daemon writes messages, the session reads them; see
[messaging.md](messaging.md).

**`plan.json`**: the `plan` tool writes it; `kl sessions` and the
`sessions` tool read it. **`status.json`**: written by tools outside kl,
read by the same two; see [sessions.md](sessions.md#status-files).

**`schedule/`**: the `schedule` tool and its background workers.

**`daemon/`**: the daemon's pid file, log, channel subscriptions and
channel history; see [messaging.md](messaging.md).

## Deleting things

Nothing here is a cache that kl rebuilds; deleting a file loses what it
held. With no kl sessions running and the daemon stopped, all of `run/`
and `daemon/` can go, at the cost of every session's name, mail and plan,
and all channel history.

A session that isn't running can be deleted with `rm -r run/<uuid>`: its
name, mail, plan and pending wakes go with it. Its transcript stays in
`pi/sessions/`. Don't do this to a running session (one with a live
`lease.json`; `kl sessions` marks it with `*`).

Piece by piece:

- **Plans and status files**: safe. They only feed DOING in
  `kl sessions`.
- **A dead session's lease**: safe; it already reads as not running. A
  running session's lease: no. The session would look stopped and could be
  started a second time.
- **Registry entries**: the session loses its name. It can no longer be
  resumed or messaged by name, though its transcript stays in
  `pi/sessions/`.
- **Inboxes**: deleting a message loses it. Read messages are already
  removed a day after they're read, when the daemon starts.
- **Locks**: kl breaks a lock whose holder has died, so you shouldn't need
  to.
- **Pending wakes**: cancel them with the `schedule` tool.
- **`pi/sessions/`**: the transcripts. Without them nothing can be resumed.

## config.yml

`config.yml` takes every `agent.yml` key except `name` and `description`;
the values are defaults that an agent's own `agent.yml` overrides key by
key (`prompt:` merges one level down). The keys and their defaults are in
[agents.md](agents.md#agentyml). Relative `prompt.identity` and
`prompt.extra_sections` paths here are relative to the kl folder; a
`cleanup` path is always relative to the agent folder.

One key belongs only here:

- **`user_name`** (default `user`): the sender name on messages you send
  with `kl message` from your own shell. Letters, digits, `_`, `.` and `-`,
  up to 64 characters. `$KL_USER` overrides it.

```yaml
user_name: sam
model: openai-codex/gpt-5.6-luna
prompt:
  extra_sections:
    - {name: house_rules, path: house-rules.md}   # ~/.kl/house-rules.md
```
