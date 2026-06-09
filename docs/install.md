# Install

How `install.sh` and `bootstrap.sh` work — prerequisites, ordering, idempotency, and the `~/.agent → ~/.kl/agent` migration.

## Overview

kiln-lite ships two install scripts:

- **`install.sh`** — one-stop install. Runs `npm install`, `npm link` (puts `kl` + `kl-msg` on `$PATH`), `pi install .` (registers the extension globally), and then `bootstrap.sh` to scaffold or refresh the agent home. Safe to re-run; detects existing state and adapts.
- **`bootstrap.sh`** — scaffolds an agent home. Creates the directory layout, seeds `agent.yml`, copies bundled skills and tools, creates a Python venv via `uv`, installs `requirements.txt`.

`install.sh` is what you run. `bootstrap.sh` is the scaffolder that `install.sh` calls — you rarely run it directly, except for targeted refreshes (`--rebuild-venv`, `--refresh-skills`, etc).

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
./install.sh
```

Defaults to `~/.kl/agent/` as the home. Override:

```bash
./install.sh ~/.my-agent          # positional arg wins
AGENT_HOME=~/.my-agent ./install.sh   # or via env
```

What happens:

1. `npm install --silent` — node deps (js-yaml, tsx).
2. `npm link` — registers `kl` and `kl-msg` globally (on `$PATH`).
3. `pi install .` — registers the kiln-lite extension with pi so it loads on every Pi session.
4. **Migration check** — if `$HOME_DIR` resolves to `~/.agent` (legacy) and `~/.kl/agent` doesn't exist, prompts to migrate. See below.
5. **Scaffold or refresh** — fresh home gets full bootstrap; existing home gets skills + tools refresh only.

Output tells you where `kl` ended up and whether there are any warnings to attend to.

### Idempotent re-runs

`install.sh` is designed to be re-run safely. On every re-run:

- `npm install` is idempotent.
- `npm link` is idempotent (silently overwrites).
- `pi install .` is idempotent.
- If the agent home **already exists**, `install.sh` calls `bootstrap.sh --refresh-skills` + `bootstrap.sh --refresh-tools` to propagate bundled fixes. `agent.yml`, `memory/`, `venv/`, and `scratch/` are left alone.
- If the agent home **doesn't exist**, full scaffold.

This means you can pull a new kiln-lite revision and just `./install.sh` — bundled skill and tool updates land automatically, your config and memory don't get stomped.

### Uninstall

```bash
pi remove .                      # or the original install source string
rm -rf ~/.kl/                    # agent home + daemon state (destructive)
```

Pi doesn't own the agent home — you have to remove it yourself. `npm unlink` (from inside the repo) removes `kl` and `kl-msg` from global.

## Migration: `~/.agent → ~/.kl/agent`

v0.1 and v0.2 of kiln-lite used `~/.agent/` as the agent home. v0.3 moved to `~/.kl/agent/` so the daemon state (`~/.kl/daemon/`) can sit alongside. If you're upgrading from a v0.2 install:

1. You have `~/.agent/` populated with memory, tools, skills, venv.
2. You may also have `$AGENT_HOME=~/.agent` exported in your shell rc.
3. `~/.kl/agent/` doesn't exist yet.

Running `./install.sh` detects this case and prompts:

```
[install] detected legacy agent home at /Users/you/.agent (pre-v0.3 layout)
[install] kiln-lite now lives under ~/.kl/ (agent home + daemon state side-by-side)
[install]   note: $AGENT_HOME is set to /Users/you/.agent — update your shell rc to point at
[install]         /Users/you/.kl/agent after migration (or unset it to use the new default)
[install] Move /Users/you/.agent to /Users/you/.kl/agent? [Y/n]
```

Decline → nothing moves; the install continues with the legacy path. Accept → `mv ~/.agent ~/.kl/agent`. After migration:

- Update your shell rc (`.zshrc`, `.bashrc`, etc) — unset `AGENT_HOME` (to fall back to the new default) or point it at `~/.kl/agent`.
- The `install.sh` output reminds you.

The migration only fires when `$HOME_DIR` resolves to the literal `~/.agent` path — either because `$AGENT_HOME` is still exported there, or because it was passed explicitly as the positional arg. If you already use a custom home (`AGENT_HOME=~/.myagent`), nothing migrates and nothing prompts.

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
./bootstrap.sh ~/.kl/agent --rebuild-venv
```

`uv` auto-downloads the named version if it isn't already installed.

## Reference

### `install.sh` ordering rationale

```
npm install          → dep install before linking (npm link requires deps)
  ↓
npm link             → registers kl + kl-msg before extension registration
  ↓
pi install .         → extension registered before scaffold
  ↓
migration prompt     → before scaffold, because scaffold writes to the resolved path
  ↓
scaffold / refresh   → last, because this is where bundled content lives
```

Failing a step bails; earlier steps leave the system in a recoverable state.

### File operations summary

| Step | Touches | Destructive |
|------|---------|-------------|
| `npm install` | `node_modules/` in the repo | no |
| `npm link` | `~/.npm-global/bin/` (or equivalent) | no |
| `pi install .` | Pi's config directory | no |
| Migration | `~/.agent` → `~/.kl/agent` (rename) | yes, on accept |
| Fresh scaffold | `<home>/*` | no (refuses on non-empty unless `--force`) |
| Refresh (existing home) | `<home>/skills/*`, `<home>/tools/*` | yes (overwrites bundled names) |

### Env vars

| Var | Consumer | Effect |
|-----|----------|--------|
| `AGENT_HOME` | `install.sh` | Default target if no positional arg. |
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
# [install] scaffolding agent home at /Users/you/.kl/agent
# ...
# [install] complete.

kl    # first session
```

### Pull an update, refresh everything

```bash
cd ~/Git/kiln-lite
git pull
./install.sh    # refreshes bundled skills + tools, leaves config alone
```

### Rebuild the venv after changing Python version

```bash
echo "3.13" > .python-version
./bootstrap.sh ~/.kl/agent --rebuild-venv
```

### Reset completely (destructive)

```bash
cd ~/Git/kiln-lite
pi remove .
rm -rf ~/.kl/
./install.sh    # fresh scaffold
```

## Conventions

- **Run `install.sh` on every version bump.** Bundled skill/tool fixes only propagate via re-run. Nothing else updates automatically.
- **`bootstrap.sh` is for targeted refreshes.** `install.sh` handles the common path; reach for `bootstrap.sh` when you want to rebuild the venv, upgrade Python deps, or `--force` a clean scaffold.
- **Keep `AGENT_HOME` unset unless you need a custom home.** The default (`~/.kl/agent`) is what every doc and script assumes. Explicit override works, but you're on the hook for keeping your shell rc in sync.
- **`.python-version` is the source of truth.** If someone asks "what Python version does this use", the answer is that file. Override by editing it, not by passing flags.

## Gotchas

- **`npm link` may need sudo or a user-level prefix.** If `install.sh` warns that `kl` isn't on `$PATH`, check `npm config get prefix` — you may need `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `$PATH`.
- **`pi install .` registers a source string.** Pi remembers the install path. If you move the `kiln-lite` repo on disk, `pi` will stop loading the extension until you re-run `pi install .` from the new location.
- **Migration only fires once.** After `~/.agent` moves to `~/.kl/agent`, the prompt doesn't re-appear even if you re-run `install.sh`. If something went wrong and you want to redo it, you'll have to mv back and re-run (or just symlink).
- **`--force` is destructive.** `bootstrap.sh --force` overwrites `agent.yml`, `skills/`, `tools/`, and recreates `venv/`. Memory directories (`memory/`, `scratch/`) are not touched — but any local `agent.yml` customization is lost. Stage a backup first if you care.
- **The uv auto-installer modifies shell rc files.** If you're in a tightly-managed environment, set `AUTO_INSTALL_UV=0` and install uv yourself ahead of time.
- **Bundled tool/skill names are reserved.** If you create `<home>/tools/fetch` yourself, a later `install.sh` will overwrite it with the bundled version. Name your custom variants differently (e.g. `fetch-mine`).
- **`bootstrap.sh` refuses non-empty targets without a flag.** First time this trips people: `bootstrap.sh ~/.kl/agent` on an existing home errors with a "use --force / --rebuild-venv / --refresh-..." message. That's intentional — `install.sh` handles the existing-home case for you.
