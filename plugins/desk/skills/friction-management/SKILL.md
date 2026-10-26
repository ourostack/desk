---
name: friction-management
description: Capture friction about how the agent worked or about Desk itself (which opens an improvement card), mark fixes landed and archive old entries. Task content goes on task cards; a Desk mechanism failing at its own job is `desk-problem`.
---

# Friction management

`$DESK/_meta/friction.md` is the operator-wide friction log, the corkboard; each track has its own at `<track>/_friction/friction.md`. This skill covers appending new entries during real use, marking an entry landed and archiving it in the same commit, and first, deciding whether something belongs in the log at all. The log works only while it holds open entries; landed ones bury the rest.

## What goes on the corkboard

Friction is about how the agent operated: its mental models, tooling blind spots, communication misses and mistaken first conclusions. It is not the subject matter of the work: details of a system, an API or a debugging session belong on the task card or in the track's lessons. Test: would a different agent, on another model or host, hit the same rough edge doing similar work? Then it is friction.

### About the system, or about this desk's setup

every card is about one of two things, and `friction_add` takes it as `about`:

- **`system`**: the shared system snagged: Desk, a skill, a tool, a hook, the factory. any agent on any desk doing similar work would hit it. system friction becomes an improvement card on the desk, and the loop mirrors it to an issue labeled `kaizen` in the desk's factory store, so the fix is measured by the store's build once it ships. `friction_add` with `about: "system"` records it on the desk as a kaizen candidate and sends nothing anywhere (the card it opens is a file on the desk too): give it a one-line `title`, the `body`, the `plugin` it is in (default `desk`), its `friction_class` (`guard`, `hook`, `mcp_tool`, `skill`, `factory`, `release`, `ci`, `docs` or `other`), and, when you know them, the `signal` (the rollups measure the snag moves, such as `tool_failures` or `tool_retries`) and the `evidence_jobs` (factory job ids that show it).
- **`setup`** (the default): this desk's own setup snagged: the operator's machine, accounts, credentials, local configuration, one track's arrangements. it stays on the desk as today.

when the friction is a state you found (a checkout off its branch, a missing file, a changed setting), establish what produced it before a card says `system`. a `system` card claims the shared system did something wrong, so it needs evidence that the system did it: the mechanism's own output, log or commit that names the action. timing is not that evidence: "it happened right after Desk's commits" is a guess. a state that a person or another process produced, and that Desk then reported and repaired the way it is designed to (a degraded `desk_status` with a fix, a `desk_doctor` repair that worked), is the system doing its job: pin no `system` card and open no improvement card for it, and say in one line what you found and what the repair did. if it keeps happening on this desk, that is `setup` friction and a `setup` card is right. when you cannot tell what produced it, say the cause is unknown, ask the human once whether they changed it if they are in the conversation, and record nothing as `system` until evidence names the system.

`friction_add` with `about: "system"` opens an improvement card by itself, with no signoff and no curator pass: the entry is written, then the card `friction_candidate:<fingerprint>` opens (read `improvement` in the result: `opened`, `duplicate` or `reopened` means the card exists; any other value is the reason it does not). the entry ends with the line Improvement card key: `friction_candidate:<fingerprint>`, so the agent that takes the card finds your note by that key. the card holds only codes and pointers, and Desk builds its title; your title and body stay in the entry. a card on the desk is not a store issue: the loop's mirror step files that, and `file_card: true` files it at once. filing follows the same route as the desk's facts: the desk's own store declaration, else the store the session recorded from the overlays at start. when neither is known the card is not filed (`route_unknown`), so a work desk files only to its work store or keeps the entry on the desk. a filed issue leaves only its URL on the desk once the entry is taken down, so an issue later edited or deleted on GitHub takes the original wording with it; a retry finds the open card by its fingerprint and files nothing again (`duplicate`); at most five cards go to one store in a day (`held_cap`).

free text never goes to a public store. a card in a public store carries only structured fields: the plugin (only a publicly distributed one: `crew`, `desk`, `plain-language` or `superpowers`; any other stays on the desk as `plugin_not_public`), the friction class, the measure and published job ids (never this machine's plain local job ids: `evidence_jobs_local`). the title and body stay on the desk, or go into a private store's card. still write them generically: describe the pattern, not the incident, with no names of people, customers, private repositories or tracks, and no paths, hostnames, email addresses, tokens or quoted private text. "shell tool calls fail when a heredoc holds a backtick" is a good title; "the build for <private repo> broke on <person>'s laptop" is not. the filer refuses anything credential-shaped, a home or drive path, or an email address even for a private store (`not_generic`); rewrite it rather than dropping it to `setup`.

when a card can't be filed (not opted in, no account, `gh` unavailable, route unknown), the candidate stays on the desk with the reason, and the result's `kaizen` field gives the code; the improvement card is unaffected, and the loop's mirror step tries the issue again.

when a card's fix is later encoded (the `curator` pass), *where* it lands — workspace vs plugin, which plugin, always-on vs a triggered skill — is a `content-routing` decision.

When the operator asks why skill-driven work omitted something, diverged from an agreement, or landed somewhere unexpected, treat the question as a friction report. Before continuing, verify whether the applicable rule already exists and whether it was loaded, then record the expected outcome, the verified cause, and why the existing rules did not prevent it. Do not assume the rule is missing; the `curator` pass checks that before encoding.

## 1. Pin a new card

capture friction close to where it hurts. pin whenever the operator teaches me something about how i work, even offhand. over-logging is cheap; making the operator re-teach it next session is not. an explicit no-write instruction for the run still wins.

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

### Write it while it is fresh

Write the entry during the activity that surfaced it, even if that interrupts for thirty seconds; the exact tool result, wording and cost fade within hours. Lead with the cost ("lost ten minutes", "the operator caught it at the last moment"), then add the root cause once the activity ends.

## 2. Mark a card landed

system friction is marked landed on its improvement card, not here: the loop closes the card when the store's build confirms the countermeasure helped, or by its source's own recovery rule. the desk entry that names the card key comes off the corkboard in the same motion.

when a fix ships in the owning plugin or repo that resolves a card on the corkboard:

1. update the entry's `**Status**:` line. format:

   ```markdown
   **Status**: landed in <repo> commit `<sha>` (PR #N) — <one-line summary of how the fix addresses the friction>.
   ```

   if the fix is only partial, use `partial` and spell out what remains open.

2. **in the SAME commit**, take the card off the corkboard. see section 3.

A landed entry left in the log reads as open friction to anyone scanning it; in the log means open.

## 3. Take the card down — same motion as mark-landed

Move landed and partial entries, bodies unchanged, into `_meta/_archive/friction-YYYY-MM-DD.md` (or `<track>/_friction/_archive/` for a track). When three or more entries land together with one story, name the file `friction-YYYY-MM-DD-<theme>.md`. The archive file starts with `# Friction archive — <date>[ <theme>]`, a line saying the entries came from `_meta/friction.md` and are landed or partial, then each entry in full, separated by `---`. The archive is evidence, not a summary.

### The single-motion rule

Archive in the same commit as the `Status: landed` update, never in two steps, with a message like `friction: archive landed — <short titles> (<sha>s)`.

## 4. When the log passes about 150 lines

Group archived entries by theme when a batch lands, and consider a one-line summary at the top ("N open entries across <themes>"). Never close entries just to shrink the log: open means unresolved.

## 5. Never delete, never rewrite

- don't delete entries, even landed ones. archive them.
- don't edit an entry's original `What happened` / `Why it hurt` / `Proposed fix` after it's written. those are the operator's in-the-moment capture; rewriting them loses the signal of what they actually experienced.
- only the `Status:` line changes after initial write. everything else is append-only evidence.
