# Migrating to the multi-agent layout

If your agent home was installed before multi-agent support landed, this is the upgrade path. Pre-multi-agent kiln-lite kept a single agent at `~/.kl/agent/` (or `~/.agent/` for very old installs). The new layout puts every agent under `$KL_AGENTS_DIR/<name>/` (default `~/.kl/agents/<name>/`) and lets you have as many as you want.

## What changed

| Concept | Before | After |
|---------|--------|-------|
| Default home | `~/.kl/agent/` (singular) | `~/.kl/agents/<name>/` (plural) |
| Identifying an agent | `$AGENT_HOME` env var | positional name (`kl run beth`) |
| `AGENT_HOME` role | Primary mechanism | Escape-hatch override |
| Scaffolding | `install.sh` (every time) | `install.sh` once for starter, `kl new <name>` for the rest |
| Agent registry | None (one home per `AGENT_HOME`) | `kl agents` lists `$KL_AGENTS_DIR/*` |
| Session-id lookup | Per-`AGENT_HOME` only | Prefix-aware: `kl resume beth-bright-fox` finds the right home |

The plumbing didn't change much. The daemon was already agent-agnostic (it routes by per-session `inbox_path`), `agent.yml` is still the source of truth for `name:`, and `AGENT_HOME` still controls where a session reads/writes. What's new is convention + CLI ergonomics around having more than one agent on the same machine.

## The automatic path

Re-run `install.sh` from the kiln-lite repo:

```bash
cd ~/Git/kiln-lite       # or wherever your checkout lives
git pull
./install.sh
```

`install.sh` detects either `~/.agent/` or `~/.kl/agent/` and prompts:

```
[install] detected legacy agent home at /Users/you/.kl/agent
[install]   starter agent now lives at /Users/you/.kl/agents/agent
[install] Move /Users/you/.kl/agent -> /Users/you/.kl/agents/agent? [Y/n]
```

Accepting moves the legacy dir verbatim — your `agent.yml`, memory, scratch, tools, skills, venv, sessions all land at the new path unchanged. The directory name (`agent`) becomes the agent name for the registry, so the starter is now launchable as plain `kl`.

If both legacy paths exist (rare — someone manually re-created `~/.agent/` after the v0.3 migration), `install.sh` migrates the first one it finds and warns about the second. You'll need to inspect and move (or delete) the leftover manually.

## After the migration

Three things to update in your environment:

### 1. Unset `AGENT_HOME` in your shell rc

If your `.zshrc` / `.bashrc` exports `AGENT_HOME=~/.kl/agent` or `~/.agent`, remove the line. `kl` now uses the registry by default — `AGENT_HOME` only matters as an explicit override for one-off homes outside `$KL_AGENTS_DIR`.

If you want the legacy behavior, leave it set: `AGENT_HOME=/path` bypasses the name lookup entirely. But you lose `kl agents`, `kl history` cross-agent listing, and prefix-aware `kl resume` for that home.

### 2. Update any scripts that called `kl` with `AGENT_HOME`

Old shape:

```bash
AGENT_HOME=~/.kl/agent kl --detach --prompt-file brief.md
```

New shape:

```bash
kl run agent --detach --prompt-file brief.md  # 'agent' is the starter's name
kl run beth --detach --prompt-file brief.md   # another agent
```

`AGENT_HOME` still works as before — just rarely needed.

### 3. Check `agent.yml`'s `name:` field

The session-id grammar is `<name>-<adj>-<noun>`. The new layout enforces that `name:` matches `[a-z][a-z0-9_]*` — **hyphens are reserved**. If your legacy `agent.yml` had `name: code-review` or similar, `kl` will now refuse to launch with a clear error pointing at the offending line. Edit it to `code_review` (or any underscore variant) and you're good.

This isn't a contrived case — `kl resume` parses the agent-name prefix from the session id using `${id%%-*}`, so a hyphenated agent name would make the prefix unrecognizable.

## Adding more agents

Once the migration is done:

```bash
kl new beth       # → ~/.kl/agents/beth/  (full scaffold: skills, tools, venv)
kl new dalet      # → ~/.kl/agents/dalet/
kl agents         # list everything
```

`kl new <name>` reuses the same `bootstrap.sh` that scaffolds the starter, and patches `agent.yml`'s `name:` to match the directory name. Each agent gets its own venv (so Python tool deps stay isolated), its own memory, its own inbox root. The daemon at `~/.kl/daemon/` is shared and routes between them seamlessly.

## What stayed the same

- **Per-agent layout** — `agent.yml`, `memory/`, `scratch/`, `tools/`, `skills/`, `inbox/<agent-id>/`, `sessions/`, `venv/`, `credentials/`. Same structure, same semantics.
- **`$AGENT_HOME` env var** — still exported into every child process. Still points at the per-session home dir. Still what shell tools read.
- **Session-id shape** — still `<name>-<adj>-<noun>`. Still deterministic from the session UUID + name.
- **Daemon location + state** — still `~/.kl/daemon/`. Migration doesn't touch it.
- **Custom harnesses** — still loaded from `$AGENT_HOME/harness/index.ts` in preference to the bundled default. Per-agent, not per-machine.

## Custom roots

Want agents somewhere other than `~/.kl/agents/`? Set `KL_AGENTS_DIR`:

```bash
export KL_AGENTS_DIR=/opt/kl-agents
./install.sh                    # scaffolds /opt/kl-agents/agent
kl new beth                     # → /opt/kl-agents/beth
```

Useful for shared-machine setups (per-user dirs under `/srv/`) or for keeping agents on a different volume than the daemon state.

## Rolling back

If something goes wrong, the migration is a `mv` — reverse it:

```bash
mv ~/.kl/agents/agent ~/.kl/agent
```

`kl` won't pick that up via the registry, but `AGENT_HOME=~/.kl/agent kl` (the escape hatch) still launches it like before. Use this to keep working while you figure out what's wrong; nothing else needs touching.

## Reference

- [`install.md`](./install.md) — full install flow including migration details.
- [`home.md`](./home.md) — agent home layout and ownership model.
- [`cli.md`](./cli.md) — `kl` and `kl-msg` reference.
