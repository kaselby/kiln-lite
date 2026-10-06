# Recommended tmux settings

kl runs each session in its own tmux session, named after the session
(`tmux new-session -d -s <name>`), and attaches to it. A few tmux defaults
are worth changing so that modifier+Enter reaches pi and long tool output
is scrollable. Add this to `~/.tmux.conf` and reload with
`tmux source-file ~/.tmux.conf`; it applies to running sessions too.

```tmux
# Let modifier+Enter (shift-enter, alt-enter) reach pi: needed for
# multi-line input and queued follow-ups.
set -g extended-keys on
set -g extended-keys-format csi-u
set -as terminal-features 'xterm*:extkeys'

# Mouse wheel scrolls; a bigger buffer for agent output.
set -g mouse on
set -g history-limit 50000
```

## The settings

**Extended keys.** Without these, tmux turns modifier+Enter into plain
Enter, so multi-line input and queued follow-ups don't work inside `kl`
sessions. `extended-keys on` makes tmux send escape sequences for modified
keys, `extended-keys-format csi-u` picks the CSI-u (kitty/xterm) format,
and the `terminal-features` line tells tmux the outer terminal accepts
them. iTerm2 does; check other terminals' CSI-u support first.

**`mouse on`** turns on wheel scrolling (it enters copy mode),
click-to-select-pane and drag-to-resize. Pi leaves scrolling to tmux, so
the wheel scrolls tmux's scrollback. With the mouse on, click-drag selects
into tmux's buffer, not the system clipboard; in iTerm2, hold Option while
dragging to get a normal selection.

**`history-limit 50000`**: the default is 2000 lines, which agent output
fills quickly. The limit only affects the normal screen's scrollback, not
pi's full-screen view, so it doesn't slow pi down.

## Scrolling

- Mouse wheel up enters copy mode and scrolls; `q` or Escape leaves it.
- `Ctrl-b [` enters copy mode from the keyboard: PgUp/PgDn and arrows
  move, `/` searches, `q` leaves.
