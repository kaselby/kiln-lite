# kiln-lite Reference Docs

Progressive-disclosure reference for kiln-lite. Start with `overview.md` for the 30-second shape; drill into a topic doc for depth.

## Where to start

- [`overview.md`](./overview.md) — **What kiln-lite is.** What it gives you, what's out of scope, how it layers around Pi, repo layout, single-paragraph lifecycle. Read this first if you've never used kiln-lite before.

## Topic docs

- [`home.md`](./home.md) — **Agent Home.** The `~/.kl/` layout — agent home + daemon state side-by-side, ownership tiers, the env vars exported to every subprocess.
- [`extension.md`](./extension.md) — **Pi Extension.** How the extension wires into Pi's lifecycle (`session_start`, `before_agent_start`, `tool_result`, `agent_end`, `session_shutdown`, `resources_discover`), `agent.yml` schema, identity generation, context injection.
- [`daemon.md`](./daemon.md) — **Daemon.** Architecture, wire protocol, state registries, lifecycle, autostart. The JSON-line Unix-socket protocol every `kl-msg` call routes through.
- [`messaging.md`](./messaging.md) — **Messaging.** Inbox file format, direct sends, channel pub/sub, the `message` skill, delivery modes (idle vs. mid-turn), subscription persistence.
- [`tools.md`](./tools.md) — **Shell Tools.** How `<home>/tools/` is discovered and rendered into the system prompt. YAML header format. Bundled tools reference.
- [`skills.md`](./skills.md) — **Skills.** SKILL.md-based skill packaging. Discovery via Pi's `resources_discover`. The bundled `messaging` skill.
- [`cli.md`](./cli.md) — **CLI.** The `kl` session launcher (tmux wrap, `--detach` for peer-spawn) and the `kl-msg` messaging CLI.
- [`install.md`](./install.md) — **Install.** `install.sh` and `bootstrap.sh` — prerequisites, ordering, idempotency, the `~/.agent → ~/.kl/agent` migration, bundled content, uninstall.
- [`tmux.md`](./tmux.md) — **tmux settings.** Recommended `~/.tmux.conf` tweaks for `kl` sessions — CSI-u extended keys (required for pi modifier-Enter), mouse scrollback, buffer size.

## Conventions used in these docs

Each topic doc follows the same shape:

```
# Title
One-line summary.

## Overview
Narrative-level description — read this for the shape of the thing.

## Architecture
Code layout, diagrams, actors, flows — the how.

## Reference
Tables, wire protocols, exact field lists — the what.

## Examples
Usage snippets.

## Conventions
Norms: how this is *meant* to be used.

## Gotchas
Traps and sharp edges.

## Cross-references
Related docs.
```

Progressive disclosure: stop at Overview and you understand the surface; keep going for depth. Every section can be skimmed independently.
