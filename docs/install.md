# Install

This covers installing kl, adding Pi packages for kl agents, converting
older agent folders, and uninstalling. What kl keeps on disk is in
[config.md](config.md).

## Requirements

Node 20+, tmux, and Pi 1.0.3 or newer (`@earendil-works/pi-coding-agent`).

## install.sh

```bash
./install.sh
```

It runs `npm install`, then `npm link`, which puts `kl` on PATH. It removes
any global `pi install` of kiln-lite, and creates the default agent,
`worker`, at `$KL_AGENTS_DIR/worker` (`kl init worker` plus a description)
unless that folder exists. The worker is a plain agent: Pi's default
prompt, tools and skills, plus kl. Running it again is safe.

kl loads its extension with `pi -e` on every launch. It is not installed
into Pi, so plain `pi` stays as it was.

**Log in with base `pi` before the first `kl run`.** kl sessions use their
own Pi dir, `~/.kl/pi`, whose `auth.json` is a symlink to
`~/.pi/agent/auth.json`, created on the first launch if that file exists
([config.md](config.md#what-uses-each-part)). If it doesn't exist yet, Pi
creates its own `~/.kl/pi/auth.json` and kl never replaces it; `kl doctor`
warns and prints the commands to swap in the symlink. Base Pi and kl share
`auth.json` but not its lock, so if both refresh a token in the same
second, one refresh wins.

## Pi packages: `kl install`

```bash
kl install npm:@scope/pkg     # any `pi install` source and flags
```

This is `pi install` against `~/.kl/pi`: the package loads for every kl
agent, and base `pi` doesn't see it. A package installed with plain
`pi install` lands in `~/.pi/agent` and kl doesn't load it. Base Pi's
global extensions folder is different: kl loads it unless an agent sets
`external.extensions: false` ([agents.md](agents.md#extensions)).

## Uninstall

```bash
npm unlink -g kiln-lite
mv ~/.kl ~/.kl.bak
```
