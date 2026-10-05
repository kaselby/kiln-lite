# Install

## Requirements

Node 20+, tmux, and Pi 1.0.3 or newer (`@earendil-works/pi-coding-agent`).

## install.sh

```bash
./install.sh [--no-starter]
```

It runs `npm install`, then `npm link`, which puts `kl` and `kl-msg` on
PATH. It removes any old global `pi install` of kiln-lite, and creates a
starter agent at `~/.kl/agents/agent` (`kl init agent`) unless one exists.
Running it again is safe.

kl loads its extension with `pi -e` on every launch. It is not installed into
Pi, so plain `pi` stays as it was.

<!-- TODO(merge): kl install -->
<!-- TODO(merge): kl migrate -->

## The kl Pi dir: `~/.kl/pi`

Every kl session runs with `PI_CODING_AGENT_DIR=~/.kl/pi`, not
`~/.pi/agent`. On first launch kl creates it with:

- `auth.json`, `keybindings.json`, `models.json`: symlinks to the files in
  `~/.pi/agent`, if those exist then. kl never copies them and never
  writes to `~/.pi/agent`.
- `settings.json`: kl's own Pi settings (`tool_search` on). Edit freely; kl
  never overwrites it.
- `sessions/`: Pi transcripts for kl sessions.
- `APPEND_SYSTEM.md` (optional): text added to every kl agent's prompt.

Log in with base `pi` before the first `kl run`. If Pi creates its own
`~/.kl/pi/auth.json` first (because `~/.pi/agent/auth.json` didn't exist yet),
replace it with the symlink by hand.

Base pi and kl share `auth.json` but not its lock. If both refresh a token in
the same second, one refresh wins.

## `~/.kl` layout

```
~/.kl/
  config.yml        defaults for every agent (see agents.md)
  agents/<name>/    agent folders
  pi/               the kl Pi dir (above)
  run/
    sessions/<uuid>.yml   registry: name(s), agent, transcript, parent
    leases/<uuid>.json    running sessions (pid, state)
    inbox/<uuid>/         inboxes
    schedule/<uuid>/      pending wakes
  daemon/           messaging daemon state and log
```

`KL_ROOT` moves everything except `agents/`, which follows `KL_AGENTS_DIR`
(default `~/.kl/agents` even when `KL_ROOT` is set).

## Uninstall

```bash
npm unlink -g kiln-lite
mv ~/.kl ~/.kl.bak
```
