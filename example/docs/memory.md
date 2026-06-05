# Memory system — formats and cleanup flow

Four memory surfaces live in the agent home:

    memory/core.md                       # injected every session — durable
    memory/volatile.md                   # injected every session — in-flight state
    memory/active.md                     # injected every session — active tracking
    sessions/<date>-<agent-id>.md        # lookup-only — one per session

At session wrap (`/wrapup`), the cleanup turn runs four steps in order:

1. **Session summary** — write to `sessions/<date>-<agent-id>.md`
2. **Volatile update** — refresh `memory/volatile.md`
3. **Active review** — sweep `memory/active.md`
4. **Core (maybe)** — only if something durable and identity-level surfaced

Each surface has a specific shape, documented below.

---

## Session summary

One file per session. Not injected — written once, looked up on demand.
High signal density, prose not changelog, length matched to weight:
~100 words for a trivial session, up to 1000-2000 for a big ship.

Template (skip sections that don't apply — not a rigid schema):

    # YYYY-MM-DD — <brief title> (<agent-id>)

    **Session UUID:** <uuid>

    <Opening paragraph: what the session was about and what shipped.>

    ## What happened

    <Prose per major thread. Enough context for a future reader to get
    the why, not just what files changed. Name scratch docs, commits,
    and paths so recall has breadcrumbs.>

    ## Design decisions

    <Only if non-obvious choices were made. For each: what was on the
    table, what got picked, why. Highest-value section for future search.>

    ## What's not done

    <Loose ends: open threads, verification still needed, questions
    parked for later.>

    ## Lessons / notes

    <Optional. Generalizable observations. Flag anything that might
    belong in memory/core.md.>

---

## volatile.md

Tracks in-flight state across sessions. Injected into every session's
system prompt — every line costs tokens forever until it gets pruned.

    # Volatile — Working State

    <Optional one-line opening: the current "what's going on" vibe.
    Rewrite when context shifts materially.>

    ## Open threads

    [YYYY-MM-DD <agent-id>] **Thread title.** One paragraph. Enough
    context to be generative for the next session — pointers to scratch
    docs / summary files / issue IDs, not just status bullets.

    [YYYY-MM-DD <agent-id>] **Another thread.** ...

    ## Recently shipped

    [YYYY-MM-DD] **Shipped X (agent-id).** One-line summary.
    [YYYY-MM-DD] **Shipped Y.** ...

### Upkeep rules

- Date- and agent-stamp every entry. The stamp is load-bearing — it
  lets the next session spot stale entries at a glance.
- **Prune aggressively.** When a thread is no longer active, move it to
  Recently Shipped (or drop entirely). Items in Recently Shipped age
  out after a few days (or sooner if the section grows unwieldy).
- Aim for ≤5 open threads. If you're above that, the bar is too low.
- Edit in place when updating a thread — don't leave a stale entry
  above a fresh one.

---

## core.md

Durable identity-level facts: who Kira is, working conventions, opinions
that earn their keep on every session. Injected every session; bar for
additions is high.

Only touch core.md from cleanup if something that surfaced this session
is clearly durable: a stable preference, a permanent infra fact, a
conviction. Most sessions don't qualify. When adding: **edit in place
rather than append** — contradictions rot the file fast. If a section
stops being true, rewrite it.

---

## active.md

Active tracking — things Kira has explicitly flagged to surface across
sessions, day plans, and the 1–2 ongoing collaborations currently in
flight. Injected every session, placed after volatile so it's the
freshest chunk in context.

    # Active

    ## Today
    <Day plan or focus, if Kira set one. Cleared when stale.>

    ## Tracking
    [YYYY-MM-DD] Reminder / thing to circle back on / open question.
    [YYYY-MM-DD] ...

    ## Current Work
    - **Short title.** One-line framing of the ongoing collaboration.
      Project: `projects/<name>/` (or other doc anchor, if appropriate).
      - **Done:** major milestones completed (curated, not a changelog).
      - **Outstanding:** major tasks remaining (headlines, not every
        loose end). Aim for ≤5 bullets each.

### Upkeep rules

- **Interactively edited** when Kira flags something ("remind me
  about X", "come back to this", day plans). Don't autonomously add
  to Tracking mid-session unless Kira explicitly framed it that way.
- **Not a second volatile.** Fine-grained work-in-progress belongs in
  volatile open threads, not here.
- **Current Work — two hard requirements, both must hold:**
  a) *Actively in the middle of it.* Currently doing the work, not
     trailing-end loose threads on something basically finished.
  b) *Large enough to span multiple sessions.* One-session work,
     however substantial, stays in volatile.
  Cap: **≤2 items.** Kira rarely sustains more than 1–2 at a time
  meeting both criteria. If you're above 2, the bar has slipped.
  When in doubt, leave it out.
- **Scope of a Current Work entry = the specific active piece of
  work, not its parent project.** "Scaffolding the inference service"
  — not "Shuttle." A project may cycle through many phases; a Current
  Work entry tracks the one phase in flight now. When that phase
  wraps, the entry goes away even if the parent project continues.
- **Done / Outstanding granularity: subsystems and milestones *within*
  the scoped work.** Calibration: if a bullet reads like a commit
  message, it's too granular; if it reads like a parent-project
  phase, it's too high. Anything that's been untouched for more than
  a day gets removed.
- **Length is unconstrained per item.** A single Current Work entry
  can be long if the work is genuinely complex — multiple in-flight
  branches, unwrapped state, messy dependencies. The cap is on
  *number* of items (≤2), not on how much detail each one carries.
  Match documentation density to actual complexity; prune back to
  minimal once the complexity resolves.
- **Cleanup-turn sweep:** remove addressed Tracking items, prune stale
  ones, clear old Today content. For Current Work: add only if Kira
  explicitly framed something new as ongoing this session AND both
  requirements above hold; remove when the work is done, parked, or
  has degraded to trailing-end cleanup.
