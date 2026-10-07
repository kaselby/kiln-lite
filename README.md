# kiln-lite

kiln-lite (`kl`) turns [Pi](https://github.com/earendil-works/pi) into a
multi-agent setup. Every Pi session gets a name, runs in its own tmux
session, and can message other sessions, start helpers, and wake itself up
later. You define agents as small folders (a config file and an identity
prompt) and run as many sessions of each as you like.

```bash
kl run reviewer                  # starts reviewer-bright-raven in tmux and attaches
kl message send reviewer-bright-raven "look at the auth diff"
kl sessions                      # what's running, and what each session is doing
```

kl is a launcher plus a Pi extension. It doesn't change Pi: plain `pi`
behaves exactly as before, and `kl` starts Pi with the extension loaded.

## What you get

- **Named sessions.** Each session is named `<agent>-<adj>-<noun>`, like
  `reviewer-bright-raven`. You attach to it, resume it, or send it mail by
  that name, whether or not it's running.
- **Messaging.** Sessions send each other direct messages, and broadcast on
  channels they subscribe to. Mail to a session that isn't running waits in
  its inbox until it starts. Inboxes are plain folders of markdown files.
- **Subagents.** A session can start another agent as its child. The child
  works in its own tmux session and reports back by message. Children stop
  when their parent exits.
- **Scheduled wakes.** A session can ask to be woken at a time, after a
  delay, or when a process exits.
- **Agents.** An agent is a folder with an `agent.yml` and an `IDENTITY.md`.
  kl builds the system prompt from them and loads the agent's own Pi
  extensions and skills. Add memory files and a cleanup prompt, and the
  agent keeps notes from one session to the next.
- **Resume anything.** Any past session can be started again from its
  transcript, under the same name. Mail it missed is delivered when it
  starts.

## Install

You need Node 20+, tmux, and Pi 1.0.3 or newer.

```bash
npm install -g @earendil-works/pi-coding-agent   # if you don't have Pi yet
pi                                               # /login, then quit

git clone https://github.com/kaselby/kiln-lite.git ~/kiln-lite
cd ~/kiln-lite
./install.sh
kl doctor
```

`install.sh` installs dependencies, puts `kl` on your PATH (`npm link`), and
creates a default agent called `worker`. Running it again is safe.

**Log in with plain `pi` first.** kl keeps its own Pi folder, `~/.kl/pi`,
and on the first launch links its `auth.json` to `~/.pi/agent/auth.json`.
If you launch kl before logging in, `kl doctor` tells you how to fix the
link.

Packages you add with `pi install` don't load in kl sessions. To add a Pi
package for kl agents, use `kl install <source>`, which takes the same
arguments as `pi install`.

## First session

```bash
kl
```

This starts a session of the `worker` agent in a new tmux session and
attaches you to it. The worker is Pi with its default prompt and tools,
plus what kl adds. Talk to it as you would to Pi.

Detach with your tmux prefix and `d` (`Ctrl-b d` by default). The session
keeps running. Then:

```bash
kl sessions                        # recent sessions; * = running
kl attach worker-quiet-fox         # back in
kl resume worker-quiet-fox         # start a stopped session again, in the background
```

To end a session, use Pi's `/quit`, or `/cleanup` (below).

## Inside a session

kl gives the model these tools. You don't call them yourself: ask for what
you want in plain words.

| tool | what it does |
|---|---|
| `message` | send direct messages and channel broadcasts, subscribe to channels, read mail |
| `sessions` | list sessions and see what each one is doing |
| `subagent` | start a session of another agent as a child; it reports back by message |
| `schedule` | wake this session at a time, after a delay, or when a process exits |
| `plan` | keep a task list that `kl sessions` shows to you and to other agents |
| `exit_session` | end the session, after its cleanup turn if it has one |

For example:

> Start a worker subagent to read the tests in `src/auth/` and list what
> isn't covered. Keep going on the refactor while it works.

> Check back in 20 minutes and see whether the build finished.

Mail arrives on its own. An idle session gets new messages as its next
turn. A busy one gets a short notice in its next tool result and reads the
message when it's ready. Mail from other agents is marked as such, so the
model treats it as a colleague's note, not as instructions from you.

Two slash commands:

- `/cleanup` runs the agent's cleanup turn, if it has one, then exits. An
  agent with memory uses this turn to write down what it did.
- `/spawn` forks the session at one of your earlier messages into a new,
  separate session.

kl also ships two skills that teach the model how to use all of this,
`kl-messaging` and `kl-agents`.

## Messaging from your shell

```bash
kl message send worker-quiet-fox "Tests pass" --body "Merged to main; go ahead."
kl message send '#builds' "nightly is red"     # everyone subscribed to #builds
kl message history worker-quiet-fox             # a session's mail
kl message channels
```

Your messages come from `user` (set `KL_USER` to use another name). Add
`--wake` to start a stopped session so it reads the message now.

## Making your own agent

```bash
kl init reviewer
$EDITOR ~/.kl/agents/reviewer/IDENTITY.md
kl run reviewer
```

`kl init` creates the agent folder, `~/.kl/agents/reviewer/`:

```
reviewer/
  agent.yml       # config
  IDENTITY.md     # who the agent is; opens its system prompt
```

`IDENTITY.md` is plain text. If it's empty, the agent gets a short default
identity. After it, kl adds a section about kl itself (messaging, other
agents, where its docs are), then Pi's usual sections.

A small `agent.yml`:

```yaml
name: reviewer
description: Reviews diffs for bugs and missing tests.
model: openai-codex/gpt-5.6-luna
thinking: medium
```

Write the description for other agents: the `subagent` tool lists every
agent with its description, and that's how a session decides whom to start.

Two optional folders inside the agent:

- `skills/`: skills only this agent sees. They win over a skill with the
  same name from anywhere else.
- `extensions/`: Pi extensions only this agent loads. This is how you give
  an agent tools of its own.

**Agents that remember.** `kl init reviewer --full` also creates a
`memory/` folder, puts `memory/MEMORY.md` into every system prompt, and
adds a cleanup prompt that asks the agent to update its memory before it
exits. kl has no memory system of its own. This is just files, a prompt
section and a cleanup turn, so you can change any part of it.

`kl agents` lists your agents. `~/.kl/config.yml` holds defaults for all of
them, such as the model, or which agent `kl` starts when you don't name
one.

## Where things live

Everything is under `~/.kl` (or `$KL_ROOT`):

- `agents/`: one folder per agent
- `run/`: one folder per session, with its inbox, plan and registry entry
- `pi/`: kl's Pi folder, with transcripts, settings and packages from
  `kl install`
- `daemon/`: the small daemon that routes messages. kl starts it when
  needed.
- `config.yml`: defaults for every agent

## Docs

- [docs/agents.md](docs/agents.md): agent folders, `agent.yml`, how the
  system prompt is built, extensions
- [docs/sessions.md](docs/sessions.md): names, resuming, subagents, exiting
- [docs/messaging.md](docs/messaging.md): delivery, parked mail, channels,
  message files, the daemon
- [docs/tools.md](docs/tools.md): every built-in tool and slash command
- [docs/cli.md](docs/cli.md): every `kl` command and flag
- [docs/config.md](docs/config.md): the `~/.kl` folder and `config.yml`
- [docs/skills.md](docs/skills.md): skills, and which one wins on a name
  clash
- [docs/install.md](docs/install.md): install details and `kl install`
- [docs/tmux.md](docs/tmux.md): recommended tmux settings

## Uninstall

```bash
npm unlink -g kiln-lite
mv ~/.kl ~/.kl.bak       # agents, sessions and inboxes; delete it if you don't need them
```

## License

MIT. See [LICENSE](LICENSE).
