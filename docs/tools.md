# Shell Tools

How kiln-lite discovers, renders, and exposes agent-owned shell tools.

## Overview

Tools beyond Pi's built-ins live as executable scripts under `<home>/tools/`. They're **not** registered as Pi tools — they're plain executables on `$PATH`, invoked by the agent through Pi's built-in `bash` tool. kiln-lite's only runtime responsibility is (a) discovering them at `session_start` and (b) rendering a listing into the system prompt so the agent knows they exist.

The directory layout is **flat** — one script per file at the top level, no subdirectory tiers, no separate YAML registry. Every discovered tool is rendered with its full header. If a home accumulates enough tools that the listing becomes noisy, a tiered layout (with a "library" tier that only shows one-liners until the agent asks for details) is a natural extension — but today, flat is fine.

## Architecture

```
<home>/tools/
├── fetch           # bundled
├── web-search      # bundled
├── seek            # bundled
├── explore         # bundled
├── todo            # bundled
├── my-tool         # agent-added
└── another-tool    # agent-added
```

- `bootstrap.sh` copies `<repo>/tools/*` into `<home>/tools/` on install.
- The agent can add, edit, or delete tools freely. Running `bootstrap.sh --refresh-tools` recopies bundled ones over any local edits.
- `install.sh` re-runs `--refresh-tools` on every re-run so bundled fixes propagate, but never deletes agent-added tools.

At `session_start`, the extension:

1. Scans `<home>/tools/` (path configurable via `agent.yml:tools_dir`).
2. Parses a `# ---` YAML header from each executable file.
3. Renders a listing block for the system prompt.
4. Prepends `<home>/tools/` and `<home>/venv/bin/` to `$PATH` so tools are callable by bare name from Pi's `bash` tool.

### Discovery

`extensions/kiln-lite/tools.ts:discoverTools` walks the tools dir (top level only — no recursion), reads each file's opening YAML comment header, and returns a list of `ToolHeader` records:

```ts
interface ToolHeader {
    name: string;
    description: string;
    arguments?: string;
    brief?: string;
    cost?: string;
}
```

Files without a `+x` bit are skipped. Files without a parseable `# ---` header are skipped silently. Dotfiles (`.gitkeep`, `.DS_Store`) are ignored.

### Rendering

`renderToolIndex(headers)` produces:

```
Custom tools (invoke via Bash):
- **fetch** `<url> [output-file]` — Web page fetcher (trafilatura + Chrome fallback)
- **web-search** `<query> [--answer] [--backend tavily|exa]` — Tavily or Exa web search [**[$0.008/call]**]
- **seek** `<pattern> [dir]` — Fast file search (fd or find)
...
```

Formatting rules:

- `brief` wins over `description` for the one-liner (description is then available for `tool-info`-style verbose lookup if the agent wants it).
- Whitespace in descriptions is collapsed to a single space — multi-line YAML block scalars don't break the listing.
- `arguments` is rendered in backticks after the name.
- `cost` renders as `**[$X/call]**` at the end.

The rendered block is injected into the system prompt by `composeSystemPrompt` at `before_agent_start`.

## Reference

### YAML header format

Must start at line 1 (after the shebang, if any). Fences are `# ---` lines — opener and closer both. Everything between is parsed as YAML (with `# ` prefix stripped from each line).

```bash
#!/usr/bin/env bash
# ---
# name: fetch
# brief: Web page fetcher
# arguments: "<url> [output-file]"
# description: |
#   Fetch a web page as readable text. Uses trafilatura by default, falls
#   back to headless Chrome for JS-rendered pages.
# cost: 0.001
# ---
set -euo pipefail
...
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Invocation name — usually matches the filename. |
| `description` | yes* | Multi-line OK. Rendered verbatim (whitespace collapsed) unless `brief` present. |
| `brief` | no | Short one-liner; wins over `description` for the listing. |
| `arguments` | no | Short usage signature, rendered in backticks. |
| `cost` | no | Per-call cost; renders as `**[$X/call]**`. |

\* `description` or `brief` — at least one. Both missing → tool is skipped from the listing (but still callable if on PATH).

### Environment

Every tool invocation inherits:

| Variable | Value |
|----------|-------|
| `AGENT_HOME` | Resolved agent home (default `~/.kl/agents/agent`) |
| `AGENT_ID` | `<name>-<adj>-<noun>` for this session |
| `AGENT_NAME` | Name prefix from `agent.yml` |
| `SESSION_UUID` | Pi session UUID |
| `INBOX` | `$AGENT_HOME/inbox/$AGENT_ID/` |
| `PATH` | `$AGENT_HOME/tools`, `$AGENT_HOME/venv/bin`, then inherited |
| `VIRTUAL_ENV` | `$AGENT_HOME/venv` if the venv exists |

Tools can assume these are present. The extension exports them all onto `process.env` at `session_start` so every subprocess (Pi's `bash` tool, startup commands, the tools themselves) sees them.

### Python tools

Bundled tools that need Python use `#!/usr/bin/env python3`. The extension prepends `$AGENT_HOME/venv/bin` to `$PATH`, so the shebang resolves to the venv's Python, not the system one. Deps come from `<repo>/requirements.txt` — installed during `bootstrap.sh`.

To add your own Python dependencies:

```bash
VIRTUAL_ENV="$AGENT_HOME/venv" uv pip install some-pkg
```

### Bundled tools

Installed by `bootstrap.sh` from `<repo>/tools/`:

| Tool | Purpose |
|------|---------|
| `message` | DMs, channel pub/sub, and inbox management. Wraps `kl-msg` + file-based `read`/`list`. See [`messaging.md`](./messaging.md). |
| `sessions` | Local peer lookup — `list` / `show <agent-id>` / `resolve <uuid>`. |
| `fetch` | Web page → readable text. Trafilatura default, headless Chrome fallback for JS pages. |
| `web-search` | Web search via Tavily or Exa. `--answer` for synthesized answer. |
| `seek` | Fast file-name search. Uses `fd` if available, falls back to `find` with sensible prunes. |
| `explore` | Spawn a Haiku subagent to read and summarize without burning your context. |
| `todo` | Task tracker with project boards. |

### Cross-references

- [`extension.md`](./extension.md) — where discovery fires in the lifecycle.
- [`home.md`](./home.md) — where `<home>/tools/` sits in the agent home.
- [`install.md`](./install.md) — how bundled tools are copied and refreshed.
- [`skills.md`](./skills.md) — SKILL.md-based skill packaging (tools are executables, skills are instructions).

## Examples

### Minimal bash tool

```bash
#!/usr/bin/env bash
# ---
# name: ping
# brief: Check a service heartbeat
# arguments: "<url>"
# ---
set -euo pipefail
curl -sf "$1" >/dev/null && echo ok || echo down
```

```bash
chmod +x ~/.kl/agents/agent/tools/ping
# Next session, the agent sees:
#   - **ping** `<url>` — Check a service heartbeat
```

### Python tool with multi-line description

```python
#!/usr/bin/env python3
# ---
# name: reindex
# brief: Rebuild the session index
# arguments: "[--force]"
# description: |
#   Walks every .md under memory/sessions/, re-ingests into the local FTS
#   database. --force wipes the existing index first.
# ---
import sys
...
```

### Override a bundled tool

Edit `<home>/tools/fetch` directly. Your edits persist until someone runs `bootstrap.sh --refresh-tools` or `install.sh` (which refreshes every bundled tool). If you want a custom version that survives refresh, rename the file or add an agent-named replacement like `fetch-ext` alongside.

### Add a tool mid-session

```bash
# In a running session:
cat > ~/.kl/agents/agent/tools/mynew <<'EOF'
#!/usr/bin/env bash
# ---
# name: mynew
# brief: My new tool
# ---
echo "hello"
EOF
chmod +x ~/.kl/agents/agent/tools/mynew
```

The tool is callable immediately (it's on `$PATH` already). It won't appear in the system prompt's tool listing until the next session — Pi's `before_agent_start` runs once, not per turn.

## Conventions

- **Combine related subcommands into one tool.** `todo add|list|done|...` rather than five scripts. Fewer lines in the context listing, same expressivity.
- **Use `brief` + `description` together** when the listing needs to be short but the tool has depth. `brief` renders; `description` lives in the header for `--help`-style deeper lookup.
- **Quote `arguments` strings with shell metacharacters.** YAML parses `[a|b]` as a flow sequence otherwise. Always wrap in `"..."` if it has `|`, `<`, `[`, etc.
- **Cost tags for paid tools.** `cost: 0.008` → renders as `**[$0.008/call]**`. Agents see the price before invoking.
- **Dotfiles and subdirs are skipped.** Don't hide tools under `tools/hidden/` — they won't be discovered.

## Gotchas

- **Header must be `# ` prefixed with no blank comment lines inside the fence.** The parser stops at the first non-`# ` line. `#!` shebang before the opener is fine; blank `#` lines inside are fine; a literal blank line inside breaks parsing silently (tool is skipped).
- **Executable bit matters.** Scripts without `+x` are skipped from discovery. `chmod +x` is part of adding a tool.
- **Discovery is session-scoped.** Adding a tool mid-session doesn't update the listing until next session. The tool is callable immediately via bash; it just isn't advertised in the prompt.
- **Only top-level files are scanned.** Subdirectories under `<home>/tools/` aren't walked. Keep tool files flat.
- **Bundled tools get overwritten by `install.sh` re-runs.** If you edit a bundled tool in place (e.g. `tools/fetch`), the edit survives normal use but gets reverted on the next `install.sh` run. Rename or copy the tool if you want custom behaviour that sticks.
- **`venv/bin` takes precedence over system Python.** Which is usually what you want — but if you're debugging a tool that fails only inside the venv, the first check is `which python3` inside Pi's `bash` tool: if it shows `$AGENT_HOME/venv/bin/python3`, the venv is active.
