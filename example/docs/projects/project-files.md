# Project YAML Files

Specs for the YAML files in a project folder. See [yaml-contracts.md](yaml-contracts.md) for the underlying contracts these conform to.

---

## log.yml

Append-only session log. Conforms to **Entry Store**. Managed by `ystore`.

```yaml
- date: 2026-05-01
  agent: cal-dusk-falcon
  summary: "scaffolded project structure, drafted overview"
  commits: [abc1234]
  tasks: [3, 7]
  tags: [infra, setup]
```

| Field     | Required | Description                          |
|-----------|----------|--------------------------------------|
| `date`    | auto     | ISO date                             |
| `agent`   | auto     | Agent session ID                     |
| `summary` | yes      | One-liner of what the session did    |
| `commits` | no       | Short commit hashes                  |
| `tasks`   | no       | Task IDs completed                   |
| `tags`    | no       | Freeform tags                        |

Appended at session end for any session that touched the project.

---

## notes.yml

Searchable buffer for facts, gotchas, decisions. Conforms to **Entry Store**. Managed by `ystore`. Low bar for adding entries; periodically synthesize clusters into `references/` docs.

```yaml
- date: 2026-05-01
  agent: cal-dusk-falcon
  content: "API silently returns 200 on failure — check response body"
  tags: [gotcha, api]
```

| Field     | Required | Description                          |
|-----------|----------|--------------------------------------|
| `date`    | auto     | ISO date                             |
| `agent`   | auto     | Agent session ID                     |
| `content` | yes      | The note                             |
| `tags`    | no       | Freeform tags                        |

---

## priorities.yml

Hierarchical goals and directions. Conforms to **Trackable**. Two levels max. Edited directly, not managed by ystore or the task tool.

```yaml
- id: 1
  summary: "Improve inference latency to <100ms"
  context: "Current latency is 300ms+, blocking on-device deployment"
  status: active
  priority: high
  tags: [perf]
  children:
    - id: 1.1
      summary: "Profile and identify bottlenecks"
      status: done
    - id: 1.2
      summary: "Optimize tokenizer"
      status: active
      task: 14
```

| Field      | Required | Description                              |
|------------|----------|------------------------------------------|
| `id`       | yes      | Stable ID (integer top-level, dotted sub) |
| `summary`  | yes      | What we're trying to achieve             |
| `context`  | no       | Why it matters (top-level only)          |
| `status`   | yes      | `pending`, `active`, `paused`, `blocked`, `done` |
| `priority` | no       | `high`, `normal`, `low`                  |
| `tags`     | no       | Freeform tags                            |
| `children` | no       | Sub-priorities (top-level only)          |
| `task`     | no       | Linked task ID in tasks.yml (sub-priorities) |

---

## tasks.yml

Claimable work items. Conforms to **Trackable**. Managed by the `task` tool — see `task help` for full schema and usage.
