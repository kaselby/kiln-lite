# Pi Extension

How the kiln-lite extension wires into Pi's lifecycle — hooks, responsibilities, and what lives in `SessionState`.

## Overview

The kiln-lite extension is a Pi *extension* in the Pi sense: a TypeScript module that registers handlers on Pi's event bus and gets loaded into every Pi session. It owns no process of its own, doesn't replace any of Pi's built-in tools, and doesn't touch the model loop. What it does do:

- Load `agent.yml` from the agent home and resolve defaults.
- Generate a deterministic agent-id (`<name>-<adj>-<noun>`).
- Export `AGENT_HOME` / `AGENT_ID` / `INBOX` / `SESSION_UUID` into `process.env` so every child process (including Pi's built-in `bash` tool) inherits them.
- Compose the system prompt from static content + dynamic context-injection + a rendered tool index.
- Discover shell tools in `<home>/tools/`, render their YAML headers into the system prompt, and prepend the dir to `$PATH`.
- Register `<home>/skills/` as a Pi skills path.
- Start an inbox watcher that delivers mid-turn `[INBOX: N unread]` pings and full idle-turn messages.
- Register and deregister with the kiln-lite daemon so channel fanout and DM routing work.
- Handle the cleanup turn (`/wrapup` / `/exit` / `/fq`).
- Run `agent.yml:startup` commands.

Every one of these is a thin layer over Pi's APIs. The extension doesn't duplicate anything Pi already does — it fills in the gaps between a raw Pi session and a persistent, addressable agent.

## Architecture

Entry point: `extensions/kiln-lite/index.ts`. Six Pi lifecycle hooks:

```
session_start
  ├─ resolve $AGENT_HOME, auto-scaffold if missing
  ├─ load agent.yml
  ├─ generate agent-id (or read $AGENT_ID from env if set by `kl`)
  ├─ build + apply env vars (hoists to process.env)
  ├─ preload static context_injection files
  ├─ create inbox dir
  ├─ instantiate DaemonClient + fire-and-forget register()
  ├─ discover tools + render tool-index
  ├─ register cleanup dispatcher + /wrapup /exit /fq
  ├─ start inbox watcher
  └─ run startup commands sequentially

before_agent_start
  └─ compose + return system prompt (merges Pi's default with injection + tool index)

tool_result
  └─ if inbox has unread → append [INBOX: N unread] suffix to last text content

agent_end
  ├─ cleanup dispatcher: if cleanup-turn sentinel saw, shut down; else arm it
  └─ inbox watcher: mark-all-seen (so we don't re-ping next turn)

resources_discover
  └─ return skillPaths: ["<home>/skills"]

session_shutdown
  ├─ stop inbox watcher
  └─ daemon.deregister() with a 500ms budget
```

Presence (who's alive, where's their inbox) is owned by the daemon's presence registry, not a per-session file on disk — `register()` / `deregister()` are the whole story.

### `SessionState`

A single object threaded through every handler. Defined in `types.ts`:

```ts
interface SessionState {
    agentHome: string;              // resolved absolute path
    agentId: string;                // <name>-<adj>-<noun>
    sessionUuid: string;            // Pi session UUID
    config: AgentConfig;            // parsed agent.yml + defaults
    env: Record<string, string>;    // what was exported this session
    staticInjection: Map<string, string>;  // preloaded non-dynamic context
    systemPromptBase: string | null;       // memoized base prompt
}
```

The state lives in a closure inside the extension's default export and is mutated in place on `session_start`. Subsequent hooks read from it. Null-checked on every hook to tolerate the edge case where `session_start` threw before setting it.

### Module breakdown

| File | Role |
|------|------|
| `index.ts` | Entry point — registers every hook, owns the `SessionState` closure. |
| `config.ts` | Loads and normalizes `agent.yml`; applies defaults. |
| `identity.ts` | Generates `<name>-<adj>-<noun>` deterministically from a session UUID via sha256. |
| `env.ts` | Builds the env map + hoists to `process.env`; prepends tools dir + venv/bin to PATH. |
| `prompt.ts` | `composeSystemPrompt` (merges base + injection + tool index) + `preloadStaticInjection` (cache). |
| `tools.ts` | `discoverTools` (scan YAML headers) + `renderToolIndex` (pretty-print for prompt). |
| `inbox.ts` | `startInboxWatcher` — fs.watch over inbox dir; idle delivery, mid-turn suffixes, `.read` markers. |
| `cleanup.ts` | `createCleanupDispatcher` + `registerExitCommands` (/wrapup /exit /fq). |
| `bootstrap.ts` | First-run auto-scaffold if `$AGENT_HOME` is set explicitly and lacks `agent.yml`. |
| `types.ts` | Shared interfaces. |

## Reference

### `agent.yml` schema

```yaml
# Required: name prefix for the agent-id and AGENT_NAME env var.
name: agent

# Optional: absolute or home-relative path to a file that replaces Pi's
# default system prompt. Omit to use Pi's default.
system_prompt: prompts/base.md

# Files prepended to the system prompt on every session.
# Each entry takes either `path:` (file contents) or `command:` (stdout
# of a shell command) — mutually exclusive. `dynamic: true` re-reads
# (or re-runs) on every turn; default is load-once at session_start.
context_injection:
  - path: memory/core.md
    label: Core Memory
  - path: memory/volatile.md
    label: Volatile — Working State
    dynamic: true
  - command: project list
    label: Active Projects
    dynamic: true

# Shell commands run sequentially at session_start (stdout inherited).
startup:
  - "git -C $AGENT_HOME pull --ff-only"

# Cleanup turn dispatched when the session wraps via /wrapup.
# Template vars: {today}, {agent_id}, {session_uuid}, {summary_path}.
cleanup: |
  Write a session summary to {summary_path} covering what happened,
  what you learned, unresolved threads.

# Directory names relative to $AGENT_HOME.
tools_dir: tools          # default "tools"
inbox_dir: inbox          # default "inbox"
sessions_dir: sessions    # default "sessions"
```

All fields are optional except `name`. Unknown top-level fields produce a warning, not a hard error.

### Identity generation

Resolution order at session_start (`index.ts`):

1. **Explicit `$AGENT_ID` env** (set by `kl run` / `kl resume`). Uniquified against the snapshot store — if a prior session with the same name already bound a *different* pi-session-uuid, suffix `-2`, `-3`, … until free.
2. **Reverse-lookup of pi-session-uuid in the snapshot store**. This is the resume path for plain `pi --continue` / `pi --resume` / pi's `/resume` slash command — `$AGENT_ID` isn't set but the session UUID matches a record under `state/sessions/`. Recovers the original agent-id without needing kl.
3. **Deterministic UUID-derivation** (`identity.ts:generateAgentId`):
   1. sha256 of the session UUID → 32 bytes.
   2. First 4 bytes → index into adjectives pool; next 4 bytes → nouns pool.
   3. `<name>-<adj>-<noun>`.

Adjective and noun pools are defined in both `identity.ts` and `bin/kl`. Keep them in sync when you edit either.

### Snapshot store

For every session, `index.ts` persists a small record under `$AGENT_HOME/state/sessions/<agent-id>/`:

- **`meta.json`** — written at every session_start. Carries the agent-id ↔ pi-session-uuid binding plus the JSONL path, cwd, model, `created_at`, and `last_seen`. This is what powers `kl resume <agent-id>` and the reverse-lookup above.
- **`system-prompt.txt`** — the verbatim rendered system prompt from the *first* compose of the session. Replayed verbatim on every `before_agent_start` of any future resume of the same agent-id, so the model sees byte-identical context across resumes regardless of whether the underlying memory / skills / tools / identity files have drifted.

The snapshot is written exactly once per agent-id. Within the same live process, subsequent turns continue to re-render from current state — staleness is only a concern across resume boundaries, and the snapshot is precisely what makes that re-render unnecessary.

Failures writing to the snapshot store are warned but never block startup.

### Context injection

On `before_agent_start`, `composeSystemPrompt` builds the prompt in this order:

1. **Base** — `agent.yml:system_prompt` file contents, or Pi's default system prompt if unset.
2. **Identity doc** — if `<home>/<AGENT_NAME>.md` exists, injected as its own block.
3. **Context injection** — one block per `context_injection` entry, labelled.
   - Each entry carries either `path:` (file contents, resolved relative to `$AGENT_HOME`) or `command:` (stdout of a shell command, executed with the agent env + cwd = `$AGENT_HOME`). The two are mutually exclusive; entries with both or neither are skipped with a warning.
   - Static entries (`dynamic: false`) are preloaded once at `session_start` into `state.staticInjection`.
   - Dynamic entries are re-read (path) or re-run (command) every turn. Dynamic commands cost per-turn latency — keep them fast.
   - Commands have a 1s wall-clock timeout and 64 KB stdout cap. Timeouts, non-zero exit, or spawn errors cause the entry to be skipped for that turn with a warn-log; the session continues.
4. **Tool index** — the rendered listing from `tools.ts:renderToolIndex`.
5. **Skill listing** — Pi adds this itself via `resources_discover`.

Labels are rendered as `## <label>` headings. Entries without a label default to the path.

### Inbox watching

`inbox.ts:startInboxWatcher` opens an `fs.watch` on `<home>/inbox/<agent-id>/`. Two delivery modes:

- **Idle** — when `ctx.isIdle()` is true, a new `.md` file is delivered as a full user turn (via `pi.deliver(...)`) and marked `.read`.
- **Mid-turn** — when the session is mid-turn (agent is thinking or tool-looping), a new `.md` file is *noted* in an in-memory unread queue. The next `tool_result` hook appends `[INBOX: N unread]` to the tool output as a `TextContent` suffix. The body isn't injected — the agent reads the file on demand if it wants to.

On `agent_end`, the watcher's `markAllSeen()` clears the queue so the next turn doesn't re-append the suffix.

### Cleanup flow

`cleanup.ts` hooks `/wrapup`, `/exit`, `/fq`:

- **`/wrapup`** and its alias `/exit` dispatch the `agent.yml:cleanup` prompt as a follow-up turn. When that turn ends (`agent_end`), the session shuts down.
- **`/fq`** force-quits without cleanup.
- During cleanup, a second `/exit` or `/fq` forces immediate shutdown (escape hatch if cleanup hangs).

`agent_end` is where the dispatcher decides: did we just finish the cleanup turn? If yes, exit; if no, normal return to user input.

### Daemon integration

On `session_start`, the extension constructs a `DaemonClient` and calls `register()` as fire-and-forget. The client autostarts the daemon if the socket is missing (see [`daemon.md`](./daemon.md) §Autostart). Daemon failures at this point never block session startup — the session just runs without channel fanout.

On `session_shutdown`, the extension calls `deregister()` with a 500 ms budget. Success drops presence immediately; failure is covered by the daemon's reconcile loop (60 s), so the worst case is a 60-second delay before this session's record is cleaned up.

### Ephemeral fallback

If `ctx.sessionManager.getSessionFile()` returns no file path (no `.jsonl` — rare, usually non-persistent Pi sessions), the extension generates `ephemeral-<rand>` as the session UUID. Everything else works normally; the session just can't be `/resume`-d later.

## Examples

### Minimal `agent.yml`

```yaml
name: myagent
cleanup: |
  Write a short note to memory/sessions/{today}-{agent_id}.md covering what
  we did and anything I should remember next time.
```

The session will:
- generate an id like `myagent-silver-gate` deterministically from the Pi session UUID
- compose the system prompt with Pi's default + tool index (no context_injection, so nothing added)
- run no startup commands
- dispatch the cleanup prompt on `/wrapup`

### With memory injection

```yaml
name: myagent
system_prompt: IDENTITY.md
context_injection:
  - path: memory/core.md
    label: Core Memory
  - path: memory/volatile.md
    label: Volatile — Working State
    dynamic: true
  - command: project list
    label: Active Projects
    dynamic: true
startup:
  - "date > scratch/session-start.log"
cleanup: |
  You're wrapping up. Append a session summary to {summary_path} covering
  threads worked on, decisions made, anything the next session needs.
```

Now the prompt has `IDENTITY.md` as its base (replacing Pi's default), a static `core.md` block, a live-reloading `volatile.md` block, a live-refreshing Active Projects block sourced from the `project` tool, and the standard tool index.

### Iterating on the extension without `pi install`

```bash
AGENT_HOME=~/.kl/agent pi -e ./extensions/kiln-lite/index.ts
```

Skips the global registration — useful when editing the extension source and wanting changes to take effect immediately on next session.

## Conventions

- **Fire-and-forget daemon integration.** The session must keep working when the daemon is unavailable. Every daemon call from the extension is either fire-and-forget (register) or time-budgeted (deregister). Same principle for inbox delivery: file-based `read`/`list` commands work without the daemon.
- **Static injection is preloaded.** Memory files are only read once per session unless `dynamic: true`. For files you're actively editing mid-session, opt in to dynamic.
- **`$AGENT_ID` from env wins.** When `kl` launches a session, it exports `AGENT_ID` up-front so the tmux session name, the extension's id, and the inbox dir all agree from spawn. Plain `pi` launches recover the original agent-id via reverse-lookup of the pi-session-uuid in `state/sessions/`; failing that, fall back to UUID-derivation.
- **Startup commands inherit `process.env`.** They see the full exported env (including `AGENT_HOME`, `AGENT_ID`, etc) and run with `cwd = ctx.cwd`. Exit non-zero just warns — doesn't abort session start.

## Gotchas

- **`ensureScaffold` only fires when `$AGENT_HOME` is set explicitly.** If the default (`~/.kl/agent`) is used and the dir is missing, the extension fails hard on first write. Run `./install.sh` — that's what the default case expects.
- **`session_start` failures are mostly soft.** Individual steps (mkdir, daemon register, write id file) are wrapped in try/catch and warn-on-fail. This means a partially-broken session can start. Check the console / `ctx.ui.notify` warnings if things seem off.
- **Mid-turn inbox pings only fire after `tool_result`.** An agent that never calls a tool between inbox arrivals won't see the suffix. Idle delivery catches it eventually — but if you're expecting live fanout on a tool-less turn, it won't happen.
- **`resources_discover` fires at session_start AND on `/reload`.** If you add a new skill mid-session, `/reload` picks it up; shell tools don't have an equivalent re-scan, and new tools in `<home>/tools/` won't appear in the listing until next session (though they're still callable via bash).
- **Cleanup prompt template vars are a flat substitution.** `{today}` / `{agent_id}` / `{session_uuid}` / `{summary_path}`. Anything else is passed through unchanged. No escaping — if a literal `{` appears in the cleanup prompt that shouldn't be substituted, write `{{` … except that isn't supported either. Keep the prompt simple.
- **Raw `pi` launches don't set `AGENT_ID`.** The extension first tries to recover it via reverse-lookup of the pi-session-uuid against `state/sessions/`, then falls back to UUID-derivation. The recovered name still won't match a tmux session (because there isn't one). Use `kl` for anything you want to `kl attach` / `kl resume` to later.

## Customizing via a personal harness

For agent-specific behavior that goes beyond `agent.yml` configuration —
custom event handlers, replaced prompt assembly, new tools wired into
session state, role-specific cleanup flows — write a **harness** at
`$AGENT_HOME/harness/index.ts`. `kl` loads it in preference to the bundled
default extension when present (`kl doctor` will show which one is active).

A harness is a normal Pi extension factory:

```ts
// $AGENT_HOME/harness/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDefaultHarness } from "kiln-lite/extensions/kiln-lite/lib/index.ts";

export default function (pi: ExtensionAPI): void {
  installDefaultHarness(pi);

  // Add anything you want on top — Pi composes handlers across registrations.
  pi.on("tool_result", async (event) => {
    // ... your additional hook
  });
  pi.registerCommand("/canonical", { /* ... */ });
}
```

Two override patterns:

1. **Additive** — call `installDefaultHarness(pi)` to get every kiln-lite
   default, then register your own handlers / tools / commands on top.
   Pi runs all handlers; `tool_result` mutations chain (your handler sees
   the kiln-lite-mutated event), `before_agent_start` system-prompt
   transformations stack, `session_start` side-effects run independently.

2. **Replacement** — skip `installDefaultHarness` and compose building
   blocks from `kiln-lite/extensions/kiln-lite/lib/index.ts` to your
   own taste. Use this when you need to REPLACE behavior (custom prompt
   assembly, different agent-id policy, alternate cleanup template) rather
   than just extend. Copy the body of `installDefaultHarness` (in
   `lib/install.ts`) as a starting template.

### Stable lib surface

`kiln-lite/extensions/kiln-lite/lib/index.ts` re-exports the stable public
API:

- `installDefaultHarness(pi)` — the wire-everything-up composition.
- Pure helpers: `composeToolResultSuffix`, `appendTextToContent`,
  `resolveAgentId`, `createSnapshotWriter`, `loadOrCreateSnapshotWriter`,
  `runAgentEndOrdered`.
- Factories: `startInboxWatcher`, `createCleanupDispatcher`,
  `createSessionStateHook`, `buildMessageTool`, `buildWrapupTool`,
  `registerSpawnCommand`, `registerExitCommands`.
- Stateless utilities: `loadAgentConfig`, `resolveAgentHomeDetailed`,
  `buildEnv`, `applyEnv`, `composeSystemPrompt`, `preloadStaticInjection`,
  `discoverTools`, `renderToolIndex`, `generateAgentId`,
  `loadCommandGates`, `applyCommandGates`, `ensureScaffold`.
- Snapshot API: `readMeta`, `writeMeta`, `readPromptSnapshot`,
  `writePromptSnapshot`, `findAgentIdForUuid`, `uniquifyAgentId`,
  `metaPath`, `promptPath`.
- Types: `AgentConfig`, `SessionState`, `InboxWatcher`,
  `CleanupDispatcher`, `SessionStateHook`, `SnapshotWriter`,
  `SnapshotMeta`, `ResolvedAgentId`, `CompiledGate`.
- `DaemonClient` re-export.

Additions to this surface are non-breaking; renames are considered
breaking.

### Load-bearing invariants (don't accidentally regress)

If your harness composes its own handler bodies rather than calling
`installDefaultHarness`, preserve these:

- **agent_end ordering:** cleanup-sentinel check FIRST, then inbox drain.
  Use `runAgentEndOrdered({ dispatcher, watcher, ctx, messages })`.
  Reversing this reintroduces the markAllSeen silent-sweep bug (fixed
  in commit `ca82822`).
- **snapshot write-once:** the system-prompt snapshot must be written
  exactly once per agent-id (at first compose). Use `SnapshotWriter` from
  `lib/snapshot-writer.ts` rather than tracking the bit yourself.
- **inbox watcher starts LAST in session_start.** Earlier startup steps
  (mkdir agent home, register daemon, discover tools, run startup
  commands) can take time; messages that land during that window must be
  visible to the watcher's initial scan, not dropped between watcher init
  and first dispatch.
- **applyEnv() before discoverTools().** Shell tools resolve via PATH;
  the env step prepends the tools dir so bare names work.
- **DaemonClient register / deregister are best-effort.** `register()` is
  fire-and-forget at session_start. `deregister()` runs at session_shutdown
  with a 500ms timeout race — don't `await` it bare or you'll block exit
  on an unhealthy daemon.
