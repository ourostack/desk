---
name: friction-management
description: How worker maintains the operator's friction log — appending new entries during real use, recording friction about the shared system (Desk, its skills and tools, the factory) as a kaizen candidate the curator files as a card, updating `Status:` lines when fixes land, and archiving landed/partial entries so the live log stays signal-dense. Friction scope is pain points in HOW worker operated (mental models, tooling blind spots, communication misses), not the operational content of tasks worker is helping with — that goes in task cards or track-level lessons. Use when capturing a new such pain point, when a friction item's fix ships in worker, or when the friction log grows past ~150 lines and open items start getting buried.
---

# Friction management

the corkboard above the desk is where i pin the things that snagged. `$DESK/_meta/friction.md` is the operator-wide corkboard; each track has its own smaller one at `<track>/_friction/friction.md` for pain that belongs to just that drawer. operators pin cards when real use snags; future sessions take cards down and turn them into fixes. the corkboard only works if it stays readable — if it fills up with cards whose fixes already shipped, the still-open ones get lost behind them, and the whole thing goes quiet.

this skill governs three small motions: pin a new card, mark a card landed, and move the landed card off the corkboard in the same breath. before any of those, though, the question of *whether* a thing belongs on the corkboard at all — that's the first cut.

## What goes on the corkboard

friction is about how *i* operated — my mental models, tooling blind spots, communication misses, mistaken first-pass conclusions. when i hit a rough edge in HOW i was doing the work, that's a friction card.

friction is NOT the work's operational subject matter. when i'm helping with substrate operations / external-system gotchas / a tricky debugging session, those details belong in the task card or in the track's lessons-learned — not on the corkboard. those are notes about the thing being worked on, not about me.

quick test: would a different agent (different model, different runtime) hit this same rough edge when doing similar work? if yes → friction (the snag is in my shape). if it's specific to the system / API / external thing being interacted with → task or track-level lessons.

mixing the two dulls the corkboard. operational knowledge is task knowledge — it goes where the work is. the corkboard exists so future sessions of me can find patterns in how i operate, not to re-document the systems i operate on.

### About the system, or about this desk's setup

every card is about one of two things, and `friction_add` takes it as `about`:

- **`system`**: the shared system snagged: Desk, a skill, a tool, a hook, the factory. any agent on any desk doing similar work would hit it. system friction becomes a kaizen card, an issue labeled `kaizen` in the desk's factory store, so the fix is measured by the store's build once it ships. `friction_add` with `about: "system"` records it on the desk as a kaizen candidate and sends nothing anywhere: give it a one-line `title`, the `body`, the `plugin` it is in (default `desk`), its `friction_class` (`guard`, `hook`, `mcp_tool`, `skill`, `factory`, `release`, `ci`, `docs` or `other`), and, when you know them, the `signal` (the rollups measure the snag moves, such as `tool_failures` or `tool_retries`) and the `evidence_jobs` (factory job ids that show it).
- **`setup`** (the default): this desk's own setup snagged: the operator's machine, accounts, credentials, local configuration, one track's arrangements. it stays on the desk as today.

only the kaizen worker (`curator`) files a candidate as a card, after its signoff step. filing follows the same route as the desk's facts: the desk's own store declaration, else the store the session recorded from the overlays at start. when neither is known the card is not filed (`route_unknown`), so a work desk files only to its work store or keeps the entry on the desk. a filed card leaves only its URL on the desk once the curator takes the candidate down, so a card later edited or deleted on GitHub takes the original wording with it; a retry finds the open card by its fingerprint and files nothing again (`duplicate`); at most five cards go to one store in a day (`held_cap`).

free text never goes to a public store. a card in a public store carries only structured fields: the plugin (only a publicly distributed one: `crew`, `desk`, `plain-language` or `superpowers`; any other stays on the desk as `plugin_not_public`), the friction class, the measure and published job ids (never this machine's plain local job ids: `evidence_jobs_local`). the title and body stay on the desk, or go into a private store's card. still write them generically: describe the pattern, not the incident, with no names of people, customers, private repositories or tracks, and no paths, hostnames, email addresses, tokens or quoted private text. "shell tool calls fail when a heredoc holds a backtick" is a good title; "the build for <private repo> broke on <person>'s laptop" is not. the filer refuses anything credential-shaped, a home or drive path, or an email address even for a private store (`not_generic`); rewrite it rather than dropping it to `setup`.

when a card can't be filed (not opted in, no account, `gh` unavailable, route unknown), the candidate stays on the desk with the reason, and the result's `kaizen` field gives the code; the next curator pass tries again.

when a card's fix is later encoded (the `curator` pass), *where* it lands — workspace vs plugin, which plugin, always-on vs a triggered skill — is a `content-routing` decision.

When the operator asks why skill-driven work omitted something, diverged from an agreement, or landed somewhere unexpected, treat the question as a friction report. Before continuing, verify whether the applicable rule already exists and whether it was loaded, then record the expected outcome, the verified cause, and why the existing rules did not prevent it. Do not assume the rule is missing; the `curator` pass checks that before encoding.

## 1. Pin a new card

pin whenever the operator teaches me something about how i work, even offhand. over-logging is cheap; making the operator re-teach it next session is not. an explicit no-write instruction for the run still wins.

when the operator hits friction, or when i notice a recurring rough edge:

1. decide the scope. first, system or setup (above): system friction goes through `friction_add` with `about: "system"`, which records the candidate entry itself; the steps below are for setup friction. then, is this operator-wide (`_meta/friction.md`), or does it belong to one drawer (`<track>/_friction/friction.md`)? default to operator-wide; use track-local only when the issue is tightly coupled to one track's work.
2. append a new entry at the END of the file using this format:

   ```markdown
   ## YYYY-MM-DD — <short title>

   **Context** (optional, use when background matters): <one paragraph>.

   **What happened**: <what went wrong — concrete, specific>.

   **Why it hurt**: <impact — what broke, how much time, what's at risk>.

   **Proposed fix**: <specific, actionable. Prefer a numbered list when multiple paths exist>.

   **Status**: open.
   ```

3. `friction_add` stages and commits the entry itself; only pushing to the desk workspace remains manual. no separate review step; the corkboard is live evidence.

### Pin the card while it's still warm

pin friction during the activity that surfaced it, not after. mid-meeting / mid-debug / mid-review captures preserve the surface-level detail (specific tool result, exact phrasing, immediate cost, the sequence of events that made the failure mode visible) that fades within hours. post-hoc capture compresses nuance into "we hit X" without the Y and Z that made X hurt.

the bias is toward writing the entry while the failure is still fresh, even if it interrupts the activity for thirty seconds. the alternative — "i'll write it up after the meeting" — produces shallower entries that miss the specific friction surface and end up under-leveraged when curator processes the backlog.

a short live-capture entry is more useful than a long after-the-fact one. capture the cost first ("burned a tool-result of context", "lost ten minutes", "operator caught at last possible moment"), then expand to root cause once the activity wraps. the cost-first frame anchors the entry to evidence and resists drift toward post-hoc rationalization.

## 2. Mark a card landed

system friction filed as a kaizen card is marked landed on the card, not here: the kaizen worker (`curator`) closes it when the store's build confirms the countermeasure helped. the desk entry holding the card's URL comes off the corkboard in the same motion.

when a fix ships in the owning plugin or repo that resolves a card on the corkboard:

1. update the entry's `**Status**:` line. format:

   ```markdown
   **Status**: landed in <repo> commit `<sha>` (PR #N) — <one-line summary of how the fix addresses the friction>.
   ```

   if the fix is only partial, use `partial` and spell out what remains open.

2. **in the SAME commit**, take the card off the corkboard. see section 3.

**why same commit:** a card marked `landed` but still pinned is easy to miss — readers scan down the file and all they see is friction, landed or not. the canonical state of the corkboard is "pinned = still open." mixing landed in with open dulls the whole board.

## 3. Take the card down — same motion as mark-landed

move landed/partial entries into `_meta/_archive/friction-YYYY-MM-DD.md` (or `<track>/_friction/_archive/friction-YYYY-MM-DD.md` for track-local). landed cards aren't thrown away — they slide into the back of the room, still browsable, still mine.

### Archive file naming

- **per-date**: `friction-YYYY-MM-DD.md` — groups entries archived on the same date.
- **per-theme** (when a batch of related entries lands together): `friction-YYYY-MM-DD-<theme>.md` — e.g., `friction-2026-04-17-windows-prereqs.md`.

use per-theme when 3+ entries land in one sweep with a shared story (e.g., "all the first-Windows-run friction"). use per-date otherwise.

### Archive file structure

```markdown
# Friction archive — <YYYY-MM-DD>[<theme>]

Entries archived from `_meta/friction.md` on <YYYY-MM-DD>. Each is landed or partial — see the Status line at the bottom of each entry.

---

<entry 1 — full body including the Status line>

---

<entry 2 — full body including the Status line>

---
```

entries keep their original bodies verbatim — no rewording when archiving. the archive is evidence, not a summary.

### The single-motion rule

archiving must happen in the SAME git commit as the `Status: landed` update. commit message pattern:

```
friction: archive landed — <comma-separated short titles> (<sha>s)

Entries moved from _meta/friction.md to _meta/_archive/friction-<date>[-<theme>].md.
Status lines updated in the archived copy with the shipping commit sha.
```

splitting the mark-landed and archive steps leaves a window where `friction.md` has inconsistent state (some landed entries still pinned, others already in the back). always atomic.

## 4. When the corkboard fills up past ~150 lines

even with open-only-on-the-board, an operator can accumulate open cards faster than they fix them. if `_meta/friction.md` grows past ~150 lines, consider:

- **group by theme** in the archive when you eventually land a batch.
- **add a brief summary at the top of `friction.md`** — e.g. "N open entries across [themes]" — so the shape of the board is visible at a glance.

do NOT aggressively close entries just to shrink the log. open means unresolved; the corkboard is evidence, not a todo list.

## 5. Never delete, never rewrite

- don't delete entries, even landed ones. archive them.
- don't edit an entry's original `What happened` / `Why it hurt` / `Proposed fix` after it's written. those are the operator's in-the-moment capture; rewriting them loses the signal of what they actually experienced.
- only the `Status:` line changes after initial write. everything else is append-only evidence.
