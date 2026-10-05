# Skills

A skill is a folder with a `SKILL.md`: YAML frontmatter (`name`,
`description`) and a body of instructions. Pi lists every skill's name,
description and path in the `<skills>` part of the system prompt. The model
reads the file with the `read` tool when a task matches, so the body costs
nothing until it's needed.

kl passes two skill dirs to Pi with `--skill`:

1. kl's bundled skills (`skills/` in the repo; today just `messaging`), for
   every agent
2. the agent's own `skills/` folder, if it has one

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
the listing and the format are Pi's; see Pi's docs for details.
