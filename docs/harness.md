# The harness

What kl adds to a running session on top of Pi: the system prompt,
timestamps, and which extensions load. Defining an agent is in
[agents.md](agents.md).

## The system prompt

```yaml
prompt:
  identity: IDENTITY.md          # default: IDENTITY.md in the agent folder if present
  include_kl_prompt: true        # kl's <harness> block
  include_appended_prompt: true  # Pi's <addendum>
  include_project_context: true  # Pi's <project_context>
  extra_sections:                # none by default
    - {name: memory, path: memory/MEMORY.md}
```

kl writes the top of the prompt and leaves the rest to Pi. In order:

1. The identity prompt: the `identity` file. If there is none, the file is
   missing (that warns), or it's empty once comments are stripped, the
   agent gets "You are <name> - an expert coding assistant operating
   inside pi..."
2. `<harness>`, holding three parts:
   - the baseline, `prompts/kl-baseline.md` in the repo;
   - `<tools>`: one line per active tool that has a prompt snippet;
   - `<rules>`: the active tools' guidelines, deduplicated. Pi's own
     built-in rules are not included.

   `include_kl_prompt: false` drops the whole block, `<tools>` and
   `<rules>` included. The identity then stands alone at the top, so
   that plus your own identity file is how you replace kl's prompt.
3. Pi's sections: `<addendum>` (`APPEND_SYSTEM.md` in the kl Pi dir, or
   `--append-system-prompt`; `include_appended_prompt: false` drops it),
   `<project_context>` (`AGENTS.md` and similar from the working
   directory; `include_project_context: false` drops it), `<skills>`,
   `<cwd>`, and any sections other extensions add.
4. `<session>`: the agent name, session name, model, agent folder and
   inbox path.
5. One `<name>` block per `extra_sections` entry, in order.

HTML comments are stripped from the identity prompt and the baseline, so
use them for notes to yourself. kl edits Pi's prompt options rather than
replacing the prompt, which is why other extensions' sections survive.

kl reads the identity, the baseline and the extra sections when the
session starts or resumes, and again at each reset (`exit_session` with
`continue`).

**Baseline placeholders.** The baseline can use `{{kl_docs}}` (this
`docs/` folder), `{{pi_readme}}`, `{{pi_docs}}` and `{{pi_examples}}` (in
the Pi install that's running). Each becomes an absolute path. An unknown
or unresolvable placeholder warns and is left as written.

**extra_sections.** Each entry is `{name, path}` (the file's contents) or
`{name, command}` (the command's stdout):

```yaml
prompt:
  extra_sections:
    - {name: memory, path: memory/MEMORY.md}
    - {name: today, command: "date +%A"}
```

- A command runs in the folder of the file that declared it, with the
  session's [environment](sessions.md#environment), a 1 s timeout and a
  64 KiB output limit.
- A missing file or a failing command warns and drops that section. Empty
  output drops it silently.
- Names must match `[a-z][a-z0-9_-]*`, be unique, and can't be `preamble`,
  `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`
  or `session`.

**Paths.** `prompt.identity` and `prompt.extra_sections[].path` are
relative to the folder of the file that sets them, so a global section can
point into the kl folder and an agent's into its own.

## Timestamps

With `timestamps` on (the default), each user turn gets a hidden
`[time: Thu, Jun 18, 2026, 15:42 PDT · 2h 13m since last timestamp]`
message, and during long runs of tool calls a tool result gets the same
line every `every_calls` calls or `every_minutes` minutes, whichever comes
first. A mapping overrides any of the defaults
`{per_turn: true, every_calls: 20, every_minutes: 10}`; `0` turns a
periodic trigger off.

## Extensions

kl passes Pi these extensions, each with its own `-e`, in this order:

1. kl's own extension.
2. Base Pi's global extensions in `~/.pi/agent/extensions/`, unless
   `pi_extensions: false`.
3. The agent's `extensions/`.

In each folder kl takes `*.ts` and `*.js` files (not `*.d.ts`), and for each
subfolder the entries listed under `pi.extensions` in its `package.json`,
else its `index.ts` or `index.js`. Entries are sorted by name; dotfiles and
`node_modules` are skipped. Pi packages installed with `kl install` load as
well; see [install.md](install.md).

[`examples/extensions/guardrails.ts`](../examples/extensions/guardrails.ts)
is an example agent extension, and [`example/`](../example/) is a larger
agent setup.
