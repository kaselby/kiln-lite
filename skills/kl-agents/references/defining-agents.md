# Defining an agent

An agent is a folder under `$KL_AGENTS_DIR` (default `~/.kl/agents/`)
with an `agent.yml`. Everything about it is plain files in that folder;
kl reads only what `agent.yml` points at. The full reference is
`agents.md` in kl's docs folder.

## Creating one

`kl init <name>` makes a minimal agent: `agent.yml` and an empty
`IDENTITY.md`. `kl init <name> --full` also sets up memory, a cleanup
prompt, `extensions/`, `skills/`, `scratch/` and a git repo. Names match
`[a-z][a-z0-9_]*` and should equal the folder name, since `kl run <name>`
and the `subagent` tool find agents by folder.

```
<name>/
  agent.yml       config (below)
  IDENTITY.md     identity prompt; empty means kl's built-in one
  extensions/     the agent's own Pi extensions
  skills/         the agent's own skills
```

## agent.yml

Every key is optional. `<kl root>/config.yml` holds defaults for every
agent; a key in `agent.yml` replaces it, except `prompt:` and `external:`,
which merge key by key.

- `name`, `description`: the agent's name, and the one line other agents
  see in `kl agents` and the `subagent` tool's list.
- `model` (`provider/id`, optional `:<thinking>` suffix), `thinking`:
  defaults for new sessions. Unset means config.yml's, else Pi's.
- `prompt`: `identity` (path to the identity file), `include_kl_prompt`
  (`false` drops kl's harness block), `extra_sections` (below).
- `external`: `extensions`, `skills`, `appended_prompt`,
  `project_context`, all `true` by default. Each `false` cuts something
  the agent would otherwise pick up from base Pi or the working directory.
- `cleanup`: a prompt run as a final turn on `/cleanup` or `exit_session`,
  inline or `{path: ...}`.
- `timestamps`, `session_state_interval`: how often the agent sees the
  time and a context/inbox status line.

Unknown keys and wrong types warn and are ignored.

## The system prompt

In order: the identity file, kl's harness block (baseline, tools, tool
rules), Pi's sections (appended prompt, project context, skills, cwd), a
`<session>` block (agent, session name, model, folder, inbox), then each
extra section. Identity and extra sections are read when a session
starts or resumes, so edits apply to the next session. HTML comments in
the identity file are stripped.

**Extra sections** put a file or a command's output into the prompt as
`<name>...</name>`:

```yaml
prompt:
  extra_sections:
    - {name: memory, path: memory/MEMORY.md}
    - {name: today, command: "date +%A"}
```

Paths are relative to `agent.yml`. Commands run in the agent folder with
a 1 s timeout and a 64 KiB limit; a missing file or failing command drops
its section with a warning.

## Memory

kl has no memory system of its own; memory is files plus two settings.
Keep notes in the agent folder (`memory/MEMORY.md`, say), inject them
with an `extra_sections` entry, and give the agent a `cleanup` prompt
that asks it to update them before it exits. `kl init --full` sets up
exactly this, with session summaries in `memory/sessions/`. Anything more
(search, indexes, injected summaries) is files and commands you add the
same way.

## Extensions and hooks

Tools, hooks and commands are Pi extensions: put a `.ts` or `.js` file
(or a folder with a `package.json` `pi.extensions` entry or an
`index.ts`) in the agent's `extensions/`. An extension can register tools
(`pi.registerTool()`), slash commands (`pi.registerCommand()`), and handlers for Pi's events
(`pi.on("tool_call", ...)` to gate a command, `session_start`,
`before_agent_start` and others). Pi's `docs/extensions.md` lists them;
its path is in your system prompt.

kl loads its own extension first, then base Pi's `~/.pi/agent/extensions/`
(unless `external.extensions: false`), then the agent's, in name order.
`examples/extensions/guardrails.ts` in the kl repo is a worked example of
a `tool_call` gate. Pi packages installed with `kl install` load for every
kl agent.

## Skills

A skill is a folder in the agent's `skills/` with a `SKILL.md`
(frontmatter `name` and `description`, then instructions). Pi lists each
skill's description in the prompt, and the agent reads the file when it
applies. The agent's skills win name clashes with kl's and everyone
else's, so an agent can replace a kl skill by defining its own with the
same name. `external.skills: false` keeps only the agent's and kl's
skills.
