---
name: curator
description: Work an improvement card by taking the oldest one with `improvement_next` and carry it to a shipped countermeasure, as standing, pre-authorized work the operator need not ask for; handle open andon issues first. Also invoke when the operator explicitly asks to process the open friction backlog (walk each open `_friction/*.md` entry and decide encode / no-op dispositions), with phrases like "let's go through friction", "process the backlog", "curate the friction", "work the improvement cards". Do NOT invoke for appending a new friction entry (that's `friction-management`), answering questions about what's in the backlog, or discussing friction abstractly.
---

# Curator

curator has two jobs. the first is the improvement-card routine: the factory's loop opens improvement cards by itself, and an agent that takes one with `improvement_next` carries it to a shipped fix. that is standing work and needs no request. the second is the friction backlog pass, which the operator asks for when the cards have built up and the signal is starting to dim. worker remains the agent; curator is a set of instructions worker follows.

## The improvement-card routine

an improvement card is one file on the desk under `_meta/improvement/`, opened by the factory's loop or by system friction (`docs/factory-local-capture.md`, "The improvement loop"). cards are standing, pre-authorized work: the operator has already said yes, so don't ask before taking one. `improvement_next` claims the oldest open card (or one whose claim ran out) and answers with the card, a `claim_id` and the authority text. it refuses in a noninteractive or headless session. the bounds: 1 live claim per machine, 2 new claims per machine per day, a claim lasts 4 hours. a refusal (`claim_held`, `cap_reached`, `none_open`) says why; don't hunt for card files to work around it.

the authority, in short: decide and fix. a human is asked only for a true gate: money on a human's payment method, a credential or an account only a human can act in, or an irreversible destructive action. every ruling you make while working the card goes in the countermeasure pull request, and the card links to it.

1. **andon first.** an open `andon` issue means a release made a quality measure clearly worse for a plugin the store tracks; its card (`andon:<store>#<n>`) comes before any other. find the change that caused it (the issue names every plugin that changed in the same version set) and fix or revert it. the store's build closes the andon issue itself once a later release recovers. when you judge an alarm a false one or an accepted trade-off, label the issue `andon-dismissed` with a one-line reason, so the build never reopens or closes it, and close the card with `improvement_update` as `wont_fix`.
2. **read the card.** it holds only the key, source, evidence pointers (a job id, an issue or pull request number, a reconcile reason), the measure (`signal`) and its state. nothing else is on it by design. for a `friction_candidate` card, search the desk's friction files for the key; the entry ends with `Improvement card key: ...` and holds the note. a loop alarm card names what to fix in `docs/factory-local-capture.md`, "When a loop alarm card opens".
3. **fix the cause.** ship the countermeasure through the normal pull request flow on the owning repository, with tests, as for `encode-in-skill` below. merge it when the repository lets you; where the repository enforces a human approval, that approval is a gate: request it with the exact reviewed head and status, and resume after it. put every ruling in the pull request description.
4. **ship the card.** call `improvement_update` with the `key`, the `claim_id` and the `countermeasure` pull request URL. the card becomes `shipped`. do not set a version, a check result or a close by hand: the loop looks up the release that carried the pull request, moves the card to `verifying` and checks it each day.
5. **or let go of it.** if you cannot finish, call `improvement_update` with `state: "open"` and the claim id, so the next agent can take it. if the card is not worth fixing, close it as `wont_fix`, `duplicate` or `not_reproducible`; those are the only closes an agent makes, and only while it holds the claim.
6. **what happens next is the loop's.** a card with a store issue closes on the store's verdict; others close on their source's own recovery; a Desk problem closes after 7 days quiet; thin data closes `closed_unverified` after 14 checks, and never `closed_confirmed`. `not-confirmed`: the measure moved clearly the wrong way after the countermeasure, and the card reopens; revert it or re-plan it through a new pull request. never close a card because the data is thin. a closed card that comes back reopens the same card, with a recurrence counted.

`friction_add` with `about: "system"` and `file_card: true` also files the store's kaizen issue at once, in the desk's factory store only (structured fields only in a public store, deduplicated, at most five a day); the loop's mirror step does the same for every card with a measure, so you rarely need it. a desk whose route is unknown keeps the card and never files to a public store.

## The friction backlog pass

a Sunday-afternoon pass over the corkboard. i sit down, take every still-pinned card off in turn, decide what to do with it, and put the board back together with only what still belongs there. run this pass only when the operator asks to process the friction backlog, typically phrased as "let's go through friction," "process the friction backlog," or "curate `_friction/`." system friction no longer waits for signoff or for this pass: `friction_add` opens its own card by itself, so the pass decides encodings, not filings.

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

## Process

1. **list the still-pinned cards.** `ls <desk path>/<track>/_friction/` plus `<desk path>/_meta/friction.md` for cross-track entries. skip archived entries under `_archive/`.
2. **read each card end-to-end** before picking a disposition. don't skim. reactive edits without reading the full entry produce churn.
3. **decide disposition.** name the target file or rationale.
4. **batch decisions.** present dispositions to operator in one message with a clear table (entry → disposition → target). wait for signoff. don't walk the operator through one card at a time (`interaction-style` §1).
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
