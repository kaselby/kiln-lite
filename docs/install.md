# Install

How `install.sh`, `kl new`, and `bootstrap.sh` work — prerequisites, ordering, idempotency, and migration from legacy single-agent layouts.

## Overview

kiln-lite is multi-agent: agents live under `$KL_AGENTS_DIR` (default `~/.kl/agents/`). Each agent gets its own home dir under that root with its own config, tools, skills, memory, and venv. The daemon lives separately at `~/.kl/daemon/`.

Three scripts handle setup:

- **`install.sh`** — one-stop install. Runs `npm install`, `npm link` (puts `kl` + `kl-msg` on `$PATH`), cleans up any legacy global pi registration, migrates legacy single-agent homes, and scaffolds a starter agent at `~/.kl/agents/agent/`. Safe to re-run; detects existing state and adapts.
- **`kl new <name>`** — scaffolds an additional agent at `$KL_AGENTS_DIR/<name>/`. Thin wrapper around `bootstrap.sh` that also patches `agent.yml`'s `name:` field to match the directory.
- **`bootstrap.sh`** — the low-level scaffolder. Creates the directory layout, seeds `agent.yml`, copies bundled skills and tools, creates a Python venv via `uv`, installs `requirements.txt`. Used internally by `install.sh` and `kl new`; reach for it directly only for targeted refreshes (`--rebuild-venv`, `--refresh-skills`, etc).

## Installation

### Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| Node ≥ 20 | Pi's runtime, kiln-lite's runtime, npm link | `brew install node` / `apt install nodejs` |
| npm | Ships with node | — |
| pi | The underlying agent | `npm install -g @earendil-works/pi-coding-agent` |
| tmux | `kl`'s session wrap | `brew install tmux` / `apt install tmux` |
| uv | Python venv for shell tools | Auto-installed by `bootstrap.sh` if missing |

`install.sh` checks the first four up-front and bails if any are missing (tmux is warn-only). `uv` is checked lazily by `bootstrap.sh` and auto-installed on prompt.

### Standard install

```bash
cd /path/to/kiln-lite
./install.sh                  # installs kl + scaffolds starter agent
./install.sh --no-starter     # installs kl only; scaffold explicitly later
```

The starter agent lives at `~/.kl/agents/agent/`. To add more:

```bash
kl new beth                   # → ~/.kl/agents/beth/
kl new dalet                  # → ~/.kl/agents/dalet/
KL_AGENTS_DIR=/opt/agents kl new ci  # custom agents root
```

What `install.sh` does:

1. `npm install --silent` — node deps (js-yaml, tsx).
2. `npm link` — registers `kl` and `kl-msg` globally (on `$PATH`).
3. Removes any legacy global `pi install` registration of kiln-lite (idempotent — `kl` loads the extension directly via `-e`).
4. **Migration check** — if `~/.agent/` or `~/.kl/agent/` (legacy single-agent layouts) exist and `~/.kl/agents/agent/` doesn't, prompts to move. See below.
5. **Scaffold or refresh starter** — fresh: full bootstrap; existing: skills + tools refresh only. `--no-starter` skips this step entirely.

Output tells you where `kl` ended up, where the agents dir lives, and any warnings.

### Idempotent re-runs

`install.sh` is designed to be re-run safely. On every re-run:

- `npm install` is idempotent.
- `npm link` is idempotent (silently overwrites).
- Legacy pi-extension cleanup is idempotent.
- If the starter agent **already exists**, `install.sh` calls `bootstrap.sh --refresh-skills` + `bootstrap.sh --refresh-tools` to propagate bundled fixes. `agent.yml`, `memory/`, `venv/`, and `scratch/` are left alone.
- If the starter agent **doesn't exist**, full scaffold.

This means you can pull a new kiln-lite revision and just `./install.sh` — bundled skill and tool updates land automatically, your config and memory don't get stomped. Re-runs do **not** touch agents other than the starter; for those, use `bootstrap.sh <home> --refresh-skills` / `--refresh-tools` directly.

### Uninstall

```bash
npm unlink -g kiln-lite          # remove the kl global link
rm -rf ~/.kl/                    # agent homes + daemon state (destructive)
```

`~/.kl/` is yours to manage — remove individual agent homes (`rm -rf ~/.kl/agents/<name>`), the agents root (`~/.kl/agents/`), or the whole tree as fits. Daemon state at `~/.kl/daemon/` is independent.

## Migration: legacy single-agent layouts

Pre-multi-agent kiln-lite used a single-agent layout. Two versions existed:

- **v0.1–v0.2** — `~/.agent/`
- **v0.3** — `~/.kl/agent/` (singular)

The current layout (multi-agent) puts every agent under `~/.kl/agents/<name>/` (plural), with the starter at `~/.kl/agents/agent/`.

If `~/.agent/` or `~/.kl/agent/` exists and `~/.kl/agents/agent/` doesn't, `install.sh` prompts:

```
[install] detected legacy agent home at /Users/you/.kl/agent
[install]   starter agent now lives at /Users/you/.kl/agents/agent
[install] Move /Users/you/.kl/agent -> /Users/you/.kl/agents/agent? [Y/n]
```

Decline → nothing moves; you'll need to scaffold the starter manually (or use `kl new`) and `kl` won't see the legacy dir. Accept → `mv` to the new location. If `$AGENT_HOME` was set to the old path, `install.sh` warns to unset it (or accept that the env var now overrides the new default).

Migration runs at most once per layout. `~/.agent/` is checked first, then `~/.kl/agent/`. Both check `~/.kl/agents/agent/` before prompting — so once one is moved, the second is left in place (with a warning) and you'll need to inspect/move it manually.

## `bootstrap.sh`

Called by `install.sh`, also usable directly. Scaffolds or refreshes an agent home.

### Usage

```
bootstrap.sh <agent-home>                       # fresh install (refuses if non-empty)
bootstrap.sh <agent-home> --force               # overwrite everything (destructive)
bootstrap.sh <agent-home> --upgrade-deps        # only: `uv pip install --upgrade -r requirements.txt`
bootstrap.sh <agent-home> --rebuild-venv        # only: nuke + recreate venv
bootstrap.sh <agent-home> --refresh-skills      # only: recopy bundled skills
bootstrap.sh <agent-home> --refresh-tools       # only: recopy bundled tools
```

Flags are mutually exclusive — pass only one, or none for full-fresh scaffold. `install.sh` orchestrates `--refresh-skills` + `--refresh-tools` for you on re-run.

### What a fresh scaffold does

1. `mkdir -p` for `memory/ scratch/ tools/ inbox/ sessions/ skills/`.
2. `.gitkeep` in each so `git init` picks them up later.
3. Write `agent.yml` template (unless present + `--force` not set).
4. Copy `<repo>/skills/*` → `<home>/skills/` (currently: `messaging/`).
5. Copy `<repo>/tools/*` → `<home>/tools/` (currently: `message`, `sessions`, `fetch`, `web-search`, `seek`, `explore`, `todo`).
6. `uv venv --python $(cat .python-version) <home>/venv`.
7. `uv pip install -r requirements.txt` into the venv.

The venv is where bundled Python tools' deps live — `trafilatura` for `fetch`, `PyYAML` for `todo`. The extension prepends `<home>/venv/bin` to `$PATH` at `session_start` so `#!/usr/bin/env python3` shebangs resolve to the venv.

### uv auto-install

`bootstrap.sh` requires `uv`. If it's missing:

- **Interactive tty** — prompts to install via `curl -LsSf https://astral.sh/uv/install.sh | sh`.
- **`AUTO_INSTALL_UV=1`** in env — installs without prompting (useful for CI).
- **`AUTO_INSTALL_UV=0`** in env, or no tty and no env var — bails with install instructions.

The installer drops `uv` at `~/.local/bin/uv` and updates shell rc. `bootstrap.sh` prepends the install dir to `$PATH` for its own lifetime so it can use the freshly-installed `uv` immediately.

### Python version

Pinned via `<repo>/.python-version` (currently `3.12`). To change:

```bash
echo "3.13" > .python-version
./bootstrap.sh ~/.kl/agents/agent --rebuild-venv
```

`uv` auto-downloads the named version if it isn't already installed.

## Reference

### `install.sh` ordering rationale

```
npm install            → dep install before linking (npm link requires deps)
  ↓
npm link               → registers kl + kl-msg before anything else needs them
  ↓
legacy pi cleanup      → idempotent; removes stale global registration if any
  ↓
migration prompt       → before scaffold, because the starter target depends on resolved path
  ↓
scaffold / refresh     → last, because this is where bundled content lives
```

Failing a step bails; earlier steps leave the system in a recoverable state.

### File operations summary

| Step | Touches | Destructive |
|------|---------|-------------|
| `npm install` | `node_modules/` in the repo | no |
| `npm link` | `~/.npm-global/bin/` (or equivalent) | no |
| Legacy pi cleanup | `pi remove <repo-path>` if previously registered | no (idempotent) |
| Migration | `~/.agent` or `~/.kl/agent` → `~/.kl/agents/agent` (rename) | yes, on accept |
| Fresh scaffold | `<home>/*` | no (refuses on non-empty unless `--force`) |
| Refresh (existing home) | `<home>/skills/*`, `<home>/tools/*` | yes (overwrites bundled names) |

### Env vars

| Var | Consumer | Effect |
|-----|----------|--------|
| `KL_AGENTS_DIR` | `install.sh`, `kl` | Parent dir for all agent homes (default `~/.kl/agents`). |
| `AGENT_HOME` | `kl` | Escape-hatch override — bypasses the `KL_AGENTS_DIR/<name>` lookup. |
| `AUTO_INSTALL_UV` | `bootstrap.sh` | `1` → auto-install uv; `0` → bail if missing; unset → prompt. |

### Bundled content

Installed by `bootstrap.sh` into the home:

**Skills:**
- `messaging/` — documents the `message` + `sessions` tools and messaging conventions.

**Tools:**
- `message` — DMs, channel pub/sub, inbox management.
- `sessions` — local peer lookup.
- `fetch` — web page → readable text.
- `web-search` — Tavily or Exa search.
- `seek` — fast file-name search.
- `explore` — Haiku subagent for context-friendly code exploration.
- `todo` — task tracker with boards.

See [`tools.md`](./tools.md) and [`skills.md`](./skills.md) for details.

### Cross-references

- [`overview.md`](./overview.md) — high-level architecture.
- [`home.md`](./home.md) — what a scaffolded home looks like.
- [`extension.md`](./extension.md) — what the extension assumes about the home's shape.
- [`cli.md`](./cli.md) — `kl` and `kl-msg` binaries linked by `install.sh`.

## Examples

### Fresh machine

```bash
brew install node tmux
npm install -g @earendil-works/pi-coding-agent
cd ~/Git/kiln-lite
./install.sh
# [install] scaffolding starter agent at /Users/you/.kl/agents/agent
# ...
# [install] complete.

kl    # launch the starter agent
```

### Add another agent

```bash
kl new beth        # → ~/.kl/agents/beth/
kl beth            # launch it
kl agents          # list everything
```

### Pull an update, refresh everything (starter only)

```bash
cd ~/Git/kiln-lite
git pull
./install.sh    # refreshes starter's skills + tools, leaves config alone
# for other agents: ./bootstrap.sh ~/.kl/agents/<name> --refresh-skills
```

### Rebuild the venv after changing Python version

```bash
echo "3.13" > .python-version
./bootstrap.sh ~/.kl/agents/agent --rebuild-venv
```

### Reset completely (destructive)

```bash
cd ~/Git/kiln-lite
rm -rf ~/.kl/            # wipes every agent + daemon state
./install.sh             # fresh scaffold (just the starter)
```

## Conventions

- **Run `install.sh` on every version bump.** Bundled skill/tool fixes only propagate via re-run. Nothing else updates automatically.
- **`bootstrap.sh` is for targeted refreshes.** `install.sh` handles the common path; reach for `bootstrap.sh` when you want to rebuild the venv, upgrade Python deps, or `--force` a clean scaffold.
- **Use the positional name, not `AGENT_HOME`.** `kl beth` is the supported path. `AGENT_HOME=/some/path kl` is an escape hatch for advanced setups (CI, throwaway test homes) — it bypasses the registry entirely, so `kl agents`, `kl resume`'s prefix lookup, and `kl history` won't know about it.
- **`.python-version` is the source of truth.** If someone asks "what Python version does this use", the answer is that file. Override by editing it, not by passing flags.

## Gotchas

- **`npm link` may need sudo or a user-level prefix.** If `install.sh` warns that `kl` isn't on `$PATH`, check `npm config get prefix` — you may need `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `$PATH`.
- **`kl` loads the extension directly via `pi -e <path>`** — kiln-lite is not registered globally with pi (bare `pi` stays pristine). If `install.sh` finds a leftover `pi install` registration from a pre-v0.4 install, it removes it.
- **Migration only fires while the old path exists.** Once `~/.agent` or `~/.kl/agent` has been moved to `~/.kl/agents/agent`, the prompt won't reappear. If you want to redo a migration, `mv` back manually and re-run `install.sh`.
- **`--force` is destructive.** `bootstrap.sh --force` overwrites `agent.yml`, `skills/`, `tools/`, and recreates `venv/`. Memory directories (`memory/`, `scratch/`) are not touched — but any local `agent.yml` customization is lost. Stage a backup first if you care.
- **The uv auto-installer modifies shell rc files.** If you're in a tightly-managed environment, set `AUTO_INSTALL_UV=0` and install uv yourself ahead of time.
- **Bundled tool/skill names are reserved.** If you create `<home>/tools/fetch` yourself, a later `install.sh` will overwrite it with the bundled version. Name your custom variants differently (e.g. `fetch-mine`).
- **`bootstrap.sh` refuses non-empty targets without a flag.** First time this trips people: `bootstrap.sh ~/.kl/agents/agent` on an existing home errors with a "use --force / --rebuild-venv / --refresh-..." message. That's intentional — `install.sh` handles the existing-starter case for you; for other agents reach for `bootstrap.sh <home> --refresh-skills` (or whichever flag fits) directly.
