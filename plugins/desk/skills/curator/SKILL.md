---
name: curator
description: Invoke ONLY when the operator explicitly asks to process the open friction backlog or work the kaizen cards — walk each open `_friction/*.md` entry and decide encode / no-op dispositions, file system friction as kaizen cards, and ship, check and close open kaizen cards. Triggered by phrases like "let's go through friction", "process the backlog", "curate the friction", "let's curate", "work the kaizen cards". Do NOT invoke for appending a new friction entry (that's `friction-management`), answering questions about what's in the backlog, or discussing friction abstractly.
---

# Curator

a Sunday-afternoon pass over the corkboard. i sit down, take every still-pinned card off in turn, decide what to do with it, and put the board back together with only what still belongs there. the operator runs this when the cards have built up and the signal is starting to dim.

invoke this skill when the operator asks to process the friction backlog — typically phrased as "let's go through friction," "process the friction backlog," or "curate `_friction/`." worker remains the agent; curator is a set of instructions worker follows for the friction-processing pass.

## What this skill does

for each open friction entry in `$DESK/<track>/_friction/` (or `$DESK/_meta/friction.md` for cross-track entries), produce one of three dispositions:

1. **encode-in-skill** — content belongs in an existing or new `plugins/<plugin>/skills/<name>/SKILL.md`. this covers both narrow single-purpose skills and longer multi-phase skills (like curator itself, or `pr-feedback-on-own-pr`) that worker internalizes for specific operator-triggered workflows. use `content-routing` to choose the plugin (generic vs an overlay) and the within-plugin surface (the layer's always-on foundation vs a triggered skill).
2. **encode-in-repo-knowledge** — content is repo-specific (build gotchas, pipeline IDs, code-review rules for a particular repo); goes under `plugins/<plugin>/repo-knowledge/<repo>/*.md` where the `repo-handling` auto-loader picks it up.
3. **no-op** — content cannot be encoded in the plugin. carries a one-line rationale on the entry's `Status:` line and stays open on the originating friction doc. see the canonical example below.

### Triage the governing rule before encoding

Before choosing `encode-in-skill`, find the rule that should already have covered the card. If it exists, the defect is loading, placement, enforcement, or missing regression evidence; fix that instead of writing the rule twice.

If existing rules conflict, consolidate them under one owner. If instruction volume buried the rule, cut or simplify before adding prose. Group repeated cards by root cause and fix the governing defect instead of accumulating exceptions.

no deferrals. every card gets a disposition in the same pass: encoded, or an explicit no-op with a one-line rationale. "not enough data yet", "wait and see if it keeps happening" and "revisit next session" are deferrals dressed up as no-ops; reject them. the whole point of the pass is that the board is clearer when it ends than when it began.

### Encoding a human gate

when a card is about a human-intervention point in a skill (a sign-off gate, an approval checkpoint, a "steer?" prompt), treat the gate as scaffolding: name the gate and why it exists. if the why is only that the agent might not do the right thing, encode the rule and remove the gate. where the gate is really a safety check, turn it into a self-check the agent runs, with the operator reviewing only failed checks. replace default escalation with named escalation conditions (a new architectural decision, a failed self-check, a missing prerequisite). "you should have just done X" encodes X; "you should have asked" adds the named condition. a gate stays only when it is a genuine human gate from `using-desk`.

## The kaizen worker

curator is also the kaizen worker: it moves system friction through the kaizen loop. a kaizen card is an issue labeled `kaizen` in the desk's factory store, with a `yaml` card block the store's build checks (`docs/factory-local-capture.md`, "The kaizen check").

1. **andon first.** an open `andon` issue means a release made a quality measure clearly worse for a plugin the store tracks; session start lists them. treat it as the top card: find the change that caused it (the issue names every plugin that changed in the same version set) and fix or revert it. the store's build closes the andon issue itself once a later release recovers. when you judge an alarm a false one or an accepted trade-off, label it `andon-dismissed` with a one-line reason; the build then never reopens or closes it, but still posts the numbers when they change.
2. **file the system friction, after signoff.** kaizen candidates on the desk (entries `friction_add` recorded with `about: "system"`, including ones an earlier pass could not file) are part of the step 4 batch below. after the operator's signoff, file each one with `friction_add`, `about: "system"` and `file_card: true`, at most five per pass. the filer routes, dedupes and caps it (`friction-management`); a desk whose route is unknown keeps its candidates, and a work desk never files to a public store. take each filed candidate down, leaving the card's URL.
3. **work the open cards.** for each open card, pick the countermeasure and ship it through the normal PR flow on the owning repository, as for `encode-in-skill` below. set the card's `countermeasure` to the PR URL. complete a draft card (no `signal` or `hypothesis`) from the rollups first: the check can't judge a card without them.
4. **fill `version` when the release lands.** once the release carrying the countermeasure is published, edit the card block's `version` to that first version. from then on every store build compares the jobs before and after it and keeps one comment on the card.
5. **act on the verdict.** `confirmed`: close the card, naming the release and the build comment. `not-confirmed`: the measure moved clearly the wrong way after the countermeasure; revert it or re-plan it through a new PR, and set `version` again when that ships. "not enough independent jobs yet" or "no clear change so far": leave the card open; the build checks it again as jobs arrive. never close a card because the data is thin.

## Process

1. **list the still-pinned cards.** `ls $DESK/<track>/_friction/` plus `$DESK/_meta/friction.md` for cross-track entries. skip archived entries under `_archive/`.
2. **read each card end-to-end** before picking a disposition. don't skim. reactive edits without reading the full entry produce churn.
3. **decide disposition.** name the target file or rationale.
4. **batch decisions.** present dispositions to operator in one message with a clear table (entry → disposition → target). wait for signoff. don't walk the operator through one card at a time (`interaction-style` §1). include the kaizen candidates to file in the same table; file them only after the signoff.
5. **Encode in a single authorized PR** against the plugin repo, one unit per card with acceptance checks. Invoke `desk:using-superpowers-with-desk` for the needed Superpowers planning and implementation skills.
6. **take landed cards down** in the same motion they shipped: update the `Status:` line to name the PR and merge SHA, move the entry to `_friction/_archive/`. see the `friction-management` skill.

## Engine-agnostic constraint

the plugin must not name a specific agent harness. don't ship:

- harness MCP tool names (use the underlying REST API instead — e.g., `GET /_apis/git/repositories/.../pullRequests/{id}/threads`, not the MCP wrapper name).
- subagent-spawn primitives (worker is the agent; skills are instruction sets worker internalizes, not separate agents to spawn).
- harness-specific file paths like `.claude/settings.json` — see the canonical no-op below for the one exception.

the `AGENTS.md` hard constraint at the root of the worker repo encodes this. per-unit acceptance checks grep for harness-tool identifiers (double-underscore-prefixed tool names, subagent-type keys, spawn-paren forms) and expect zero hits.

## What a valid no-op looks like: engine-specific protection

the canonical example of the no-op disposition: a card whose only viable resolution is a harness-level configuration file (pre-execution hook, command interceptor, settings flag) that is engine-specific and cannot ship in the plugin without breaking on other harnesses.

**shape of the ask:** make it structurally impossible for the agent to perform some unsafe operation (push to the wrong account, write to a protected path, run an irreversible command without confirmation) by intercepting at the harness level.

**what can land in the plugin (acceptable):** a skill-level degrade path that runs the safety check before the unsafe operation and fails loud if the check doesn't pass. engine-agnostic, ships as a skill, covered.

**what stays out of the plugin (the no-op):** the harness-level interceptor configured in the operator's personal engine-specific config file (e.g., a pre-execution hook in the operator's Claude Code `settings.json`, an equivalent config in another harness). this is a structural guardrail, layered under the skill-level check.

**why it is a no-op for the plugin:**

- the hook is configured via an engine-specific file. the plugin is engine-agnostic: `AGENTS.md` hard constraint #1 forbids shipping harness-specific configuration in plugin content.
- shipping the hook in the plugin would break on any other harness that doesn't read that config file.
- the skill-level degrade path already handles the 99% case; the hook is belt-and-suspenders, not primary protection.

**disposition:** plugin-side no-op. card stays pinned on `_meta/friction.md` with `Status:` updated to name the operator-personal config file the hook belongs in (harness-specific). operator handles the hook personally in their own settings.

## When no-op is not the right call

don't reach for no-op because encoding feels hard. patterns that look like they should be no-ops but aren't:

- "this is just a style preference" — style preferences encode into the applicable skill; not a no-op.
- "i don't know what skill to put it in" — that's a routing question, not a no-op signal. ask the operator.
- "it might change" — encode the current version. if it changes later, update the encoding. plugin content evolves; that's what PRs are for.

no-op is appropriate when: the content is structurally incompatible with the plugin's engine-agnostic constraint (the engine-specific protection case above), when the ask duplicates already-landed content, or when operator explicitly decides against encoding after seeing the proposal.

## Handoff back to worker

after all dispositions are decided and operator has signed off:

- Encoded entries become units of a single authorized PR. Use the existing approval and selected method through `desk:using-superpowers-with-desk`.
- no-op entries get their `Status:` line updated in-place. they stay pinned because the ask is not resolved, just redirected out of plugin scope — they do not move to `_archive/`.
- curator is done when the corkboard has zero undecided open cards.
