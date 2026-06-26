# Skills

How kiln-lite discovers and exposes skills — packaged domain knowledge that an agent opts into.

## Overview

A **skill** is a folder containing a `SKILL.md` file (plus optional supporting files). Its YAML frontmatter declares `name` and `description`; the body is prose instructions that get loaded into the agent's context when the skill is activated.

Skills sit between always-present content (identity, memory, tool listings) and on-demand knowledge (files you `Read` when you need them). The listing is always in context — one line per skill — but the instructions only load when the agent calls Pi's `activate_skill` tool. That way a long domain guide can exist without burning tokens every session.

The format matches [Anthropic's open Skill spec](https://www.anthropic.com/news/skills) — the same shape works in Claude Code, Pi, and every other Skill-aware runtime. kiln-lite's contribution is minimal:

1. **Register** `<home>/skills/` as a skill path via Pi's `resources_discover` event.
2. **Bundle** the `messaging` skill into `<home>/skills/` during `bootstrap.sh` so agents have inbox tooling out of the box.

Everything else — discovery, listing, activation, body injection — is owned by Pi. kiln-lite just points Pi at the right directory.

## Architecture

```
<home>/skills/
├── messaging/               # bundled (pure documentation — no scripts dir)
│   └── SKILL.md
└── my-skill/                # agent-added
    ├── SKILL.md
    └── references/
        └── deeper-guide.md
```

Layout is flat: one subdirectory per skill under `<home>/skills/`, each with its own `SKILL.md`. Pi's discovery walks one deep, so `skills/core/<name>/SKILL.md` and `skills/library/<name>/SKILL.md` also work if you want to group skills into tiers yourself.

### Registration

On `session_start` (and again on `/reload`), Pi fires the `resources_discover` event. The kiln-lite extension returns:

```ts
pi.on("resources_discover", async () => ({
  skillPaths: [join(state.agentHome, "skills")],
}));
```

That's it. Pi does the rest: scans for `SKILL.md`, parses frontmatter, renders the listing, wires up `activate_skill`.

### Listing + activation

In the system prompt, Pi emits:

```
Available skills:
- **messaging** (skills/messaging): Send, read, and subscribe to messages via the kiln-lite daemon + inbox.
- **my-skill** (skills/my-skill): Short description of what this skill covers.
```

When the agent calls `activate_skill(name="messaging")`, Pi reads `skills/messaging/SKILL.md`, strips the frontmatter, and injects the body as an `[Skill: messaging]` context block. The skill's body is now in context for the rest of the session.

Once activated, a skill can't be "deactivated" mid-session. Calling `activate_skill` for the same skill a second time re-injects the body — usually harmless but wasteful.

## Reference

### SKILL.md frontmatter

```yaml
---
name: messaging
description: >
  Send, read, and subscribe to messages through kiln-lite's daemon + inbox.
  Activate when the task involves communicating with peers, broadcasting
  to channels, or reading incoming messages.
---

# Messaging

<body — instructions, usage examples, conventions>
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Case-sensitive. Should match the folder name. |
| `description` | no* | Shown in the context listing. |

\* Technically optional, but a skill without a description provides zero discovery signal. Always include one.

The frontmatter must open on the first line with `---` and close with a second `---`. Anything before the first `---` or any YAML parse error causes the skill to be dropped from discovery with no warning.

### Supporting files

Everything under a skill's folder is conventionally addressable by the skill body — reference files with relative paths from the SKILL.md's directory. kiln-lite / Pi don't auto-load these; the skill's own instructions tell the agent what to read.

Common conventions (not enforced):

- `scripts/` — helper scripts the skill documents. Bundled into `<home>/skills/<name>/scripts/`, but **not** automatically put on `$PATH` (only `<home>/tools/` is pathed).
- `references/` — markdown docs the agent should `Read` on demand.
- `assets/` — static files the skill refers to.

### The bundled `messaging` skill

```
skills/messaging/
└── SKILL.md                  # documents the `message` + `sessions` tools
```

Pure documentation — the `message` and `sessions` commands it describes live under `<home>/tools/` (see [`tools.md`](./tools.md)), not inside the skill. The skill is activated when an agent wants the context on *how to use messaging well*; the tools themselves are always callable.

### Activation flow

```
agent → activate_skill(name="messaging")
  → Pi: read <home>/skills/messaging/SKILL.md
  → strip frontmatter
  → inject body as [Skill: messaging] context block
  → confirmation message back to agent
```

No kiln-lite code runs during activation — it's pure Pi.

### Cross-references

- [`extension.md`](./extension.md) — where `resources_discover` is registered.
- [`home.md`](./home.md) — where `<home>/skills/` sits.
- [`messaging.md`](./messaging.md) — what the bundled `messaging` skill actually does.
- [`install.md`](./install.md) — `--refresh-skills` and bundled-skill copy.

## Examples

### Minimal skill

```
<home>/skills/docs-style/
└── SKILL.md
```

```markdown
---
name: docs-style
description: House style for reference docs — tone, structure, conventions.
---

# Docs Style

## Tone
- Mechanism-first.
- Assume competent readers.
- Short sections, progressive disclosure.

## Structure
...
```

To activate in a session:

```
activate_skill(name="docs-style")
```

Full body now in context under `[Skill: docs-style]`.

### Skill with deeper references

```
<home>/skills/mysterium/
├── SKILL.md
└── references/
    ├── propositions.md
    └── reconstruction.md
```

```markdown
---
name: mysterium
description: Investigation-graph engine — propositions, NPC dialogue, scoring.
---

# Mysterium

## Quick start
See `references/propositions.md` for the proposition model and
`references/reconstruction.md` for scoring.

...
```

The agent activates the skill, then reads the reference files as needed.

## Conventions

- **One SKILL.md per directory.** Don't nest skills inside other skills.
- **Description is for discoverability.** Write it so the agent can decide whether to activate without reading the body. "When to use this" framing beats "what this is".
- **Body starts with *how to use* the skill, not *what it is*.** The agent already activated it on purpose — skip the preamble.
- **Reference material goes in `references/`, not inline.** Keep the SKILL.md body focused on quick-start + conventions; dump deep content into sibling files the body points at.
- **Bundled skills get refreshed on install.** Edit a bundled skill in place and your changes survive normal use, but get overwritten on the next `./install.sh` or `./bootstrap.sh --refresh-skills`. Rename the skill if you want custom behaviour that sticks.

## Gotchas

- **Malformed frontmatter = silent skip.** Missing `---`, unclosed fence, or a YAML parse error drops the skill from discovery with no warning. If a skill doesn't show up in the listing, check frontmatter first.
- **Discovery is one-deep.** Skills at `<home>/skills/foo/bar/SKILL.md` aren't found — only `<home>/skills/<name>/SKILL.md`. `core/<name>/` and `library/<name>/` *are* one-deep and work if you use them.
- **`/reload` picks up new skills; full session restart is cleanest.** Adding a skill mid-session and running `/reload` re-fires `resources_discover`, which re-registers the path. But if you hit weirdness, restart the session — discovery is cheap.
- **Activation re-injects every time.** Calling `activate_skill` repeatedly for the same skill adds the body to context each call. No caching. Usually fine; don't loop on it.
- **Scripts under `skills/<name>/scripts/` aren't on PATH.** Only `<home>/tools/` is. If you want a script to be invokable by bare name, put it in `tools/` — or have the skill body document the full path.
- **Frontmatter is stripped at injection.** Don't rely on fields other than `name` / `description` being visible to the model. Anything the agent needs to see goes in the body below the closing `---`.
