# Skills

A skill is a folder with a `SKILL.md`: YAML frontmatter (`name`,
`description`) and a body of instructions. Pi lists every skill's name,
description and path in the `<skills>` part of the system prompt. The model
reads the file with the `read` tool when a task matches, so the body costs
nothing until it's needed.

kl ships two skills in the repo's `skills/` folder: `kl-messaging` (talking
to other sessions) and `kl-agents` (finding, starting and resuming agents
and sessions). It loads, in this order:

1. the agent's own `skills/` folder, if it has one
2. kl's skills
3. base Pi's `~/.pi/agent/skills/`, unless `external.skills: false`
4. whatever Pi discovers itself, in Pi's order: the project's
   (`.pi/skills/`, `.agents/skills/`), then global (`~/.kl/pi/skills/`,
   `~/.agents/skills/`), then packages from `kl install`

When two skills share a name, the first one in that order wins, so an
agent's own skill always beats a same-named one from anywhere else, and an
agent can replace `kl-messaging` with its own.

`external.skills: false` (in `agent.yml` or `<kl root>/config.yml`) keeps
only the agent's and kl's skills: it drops 3 and all of 4, project skills
included ([agents.md](agents.md#agentyml)).

```
~/.kl/agents/scout/skills/
  review/
    SKILL.md
    references/checklist.md
```

```markdown
---
name: review
description: How scout reviews a PR. Use when asked to review code.
---
Read references/checklist.md, then ...
```

Relative paths in a skill resolve against the skill's folder. Discovery,
the listing and the format are Pi's; see Pi's docs for details. (kl hands
1 to 3 to Pi as a generated package, `<kl root>/pi/skill-stubs/<name>/`,
because Pi ranks `--skill` paths below everything it discovers.)
