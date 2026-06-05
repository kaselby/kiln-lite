# Project Memory

Standard structure for project folders under `$AGENT_HOME/projects/`. Designed around two principles:

1. **Progressive disclosure.** The index tells you what exists and where to look. You never need to read everything.
2. **Rapid orientation.** `index.md` → `status.md` → active tasks gets an agent up to speed in seconds.

## Layout

```
projects/<name>/
    overview.md        # why this project exists — motivation, context, goals
    index.md           # structural map of the folder, especially references/
    status.md          # narrative current state — active work, recent completions, blockers
    log.yml            # append-only session log
    notes.yml          # searchable facts, gotchas, decisions
    priorities.yml     # hierarchical goals and directions
    tasks.yml          # claimable work items
    scratch/           # optional — ephemeral working notes
    references/        # optional — durable reference docs, research, design docs
```

## File Roles

- **overview.md** — The "why" document. Purpose, motivation, high-level goals. Deliberately separated from task-oriented files so the big picture doesn't get lost. Updated rarely.
- **index.md** — Structural map. Trivial for small projects; essential as `references/` grows. Kept in sync when files are added/removed.
- **status.md** — Narrative snapshot for rapid orientation. Refreshed at session end when project state changes. Standard sections:
  - **Open threads** — what's currently in flight
  - **Priorities** — what matters most right now and why
  - **Recent progress** — what shipped in the last few sessions
- **log.yml / notes.yml / priorities.yml / tasks.yml** — Structured YAML files. See [project-files.md](project-files.md) for detailed formats.
- **scratch/** — In-flight thinking, temp files. Not durable.
- **references/** — Design docs, research, benchmarks. Indexed by `index.md`.

## Tools

- **`project`** — Orientation and scaffolding. `project init <name>` creates a new project; `project load <name>` dumps overview + index + status; `project status <name>` shows status + active tasks; `project list` shows all projects.
- **`task`** — Manages `tasks.yml`. Add, claim, release, complete, block/unblock tasks. Supports linking to other trackable files (see [yaml-contracts.md](../yaml-contracts.md)).
- **`ystore`** — Manages `log.yml` and `notes.yml`. Generic tool for any YAML list-of-entries file — add, list, search, edit, remove.
- **`priorities.yml`** is edited directly (hierarchical structure doesn't fit the flat-list tools).
