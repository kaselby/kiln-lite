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

## Pi packages: `kl install`

```bash
kl install npm:@scope/pkg     # any `pi install` source and flags
```

This is `pi install` against the kl Pi dir (below): the package loads for
every kl agent, and base `pi` doesn't see it. A package installed with plain
`pi install` lands in `~/.pi/agent` and kl doesn't load it.

## Upgrading

```bash
kl migrate --dry-run          # show what would change
kl migrate                    # every agent in ~/.kl/agents
kl migrate ~/old/agent-home   # or specific folders
```

It rewrites each `agent.yml` in place (the original is kept as
`agent.yml.bak`): `context_injection` becomes `sections`; `startup`,
`tools_dir`, `sessions_dir` and `inbox_dir` are removed; `system_prompt` is
removed if the file it names is missing; `{summary_path}` in `cleanup`
becomes plain wording. `harness/pre-launch` moves to `hooks/pre-launch`. It
prints one line per key.

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
