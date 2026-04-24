# Recommended tmux settings

kiln-lite wraps each pi session in a tmux session (`kl` does
`tmux new-session -d -s <agent-id>` and attaches). A few tmux defaults
are worth overriding to get a good experience — particularly so
modifier-Enter reaches pi and so tool output is scrollable.

Drop the snippet below into `~/.tmux.conf` and reload with
`tmux source-file ~/.tmux.conf`.

## Recommended snippet

```tmux
# --- Extended key reporting ---
# Make modifier+Enter (shift-enter, alt-enter, etc.) reach apps running
# inside tmux. Required for pi's multi-line input and follow-up queueing.
# `extended-keys on` emits xterm/kitty CSI-u sequences instead of
# collapsing modified keys to their bare bytes.
# The terminal-features line tells tmux that the outer terminal can
# receive those sequences. iTerm2 handles them out of the box.
set -g extended-keys on
set -g extended-keys-format csi-u
set -as terminal-features 'xterm*:extkeys'

# --- Scrollback ---
# Mouse wheel enters copy mode and scrolls. Bigger buffer since agent
# sessions produce a lot of tool output.
set -g mouse on
set -g history-limit 50000
```

## Setting-by-setting notes

### `extended-keys on` + `extended-keys-format csi-u` + `terminal-features 'xterm*:extkeys'`

Without these, tmux collapses modifier-Enter combinations down to bare
Enter (or similar), so pi never sees shift-enter / alt-enter. Symptom:
multi-line input and queued follow-ups don't work inside `kl`
sessions.

- `extended-keys on` — tmux emits CSI-u escape sequences for modified
  keys.
- `extended-keys-format csi-u` — picks the CSI-u variant (kitty/xterm
  protocol) over the older xterm-style format.
- `terminal-features 'xterm*:extkeys'` — tells tmux the outer terminal
  accepts those sequences. iTerm2 handles them natively. For other
  terminals, check their CSI-u support before enabling.

### `mouse on`

Enables mouse wheel scrolling (enters copy mode and scrolls
scrollback), click-to-select-pane, and drag-to-resize-pane.

**Interaction with TUIs:** mouse events go to the TUI if it declares
mouse interest (DECSET 1000/1002/1003/1006), otherwise tmux handles
them. pi currently lets tmux handle scroll, so scroll wheel scrolls
tmux's scrollback — which is what you usually want.

**iTerm2 copy-paste gotcha:** with `mouse on`, click-drag-to-select
uses tmux's selection buffer, not the system clipboard. Hold **Option**
while dragging to bypass tmux and get normal iTerm2 select/copy
behavior. Usually easier than configuring tmux's `copy-pipe` to
`pbcopy`.

### `history-limit 50000`

Default is 2000, which runs out fast when agents dump tool output,
file reads, or debug logs. 50000 is generous (~10MB per pane, which is
nothing on modern hardware) and covers most long agent sessions.

**Perf:** no meaningful interaction with TUI rendering.  Scrollback
lives on the primary screen; TUIs like pi use the alternate screen,
which is a separate fixed-size grid. `history-limit` only affects the
primary screen buffer.

Common values:
- `10000` — conservative middle ground, 5× default
- `50000` — recommended, covers long agent sessions
- `100000+` — belt-and-suspenders, rarely useful

## Reloading

From inside any tmux session (or outside — tmux finds the running
server):

```
tmux source-file ~/.tmux.conf
```

Applies to all existing sessions. New sessions inherit on spawn.

## Usage reminders

- **Scroll back:** mouse wheel up → enters copy mode, scrolls. `q` or
  Escape to exit.
- **Keyboard scrollback:** `Ctrl-b [` enters copy mode; PgUp/PgDn and
  arrows move; `/` searches; `q` exits.
- **Copy text to system clipboard (iTerm2):** Option-drag bypasses
  tmux and uses iTerm2's normal selection.
