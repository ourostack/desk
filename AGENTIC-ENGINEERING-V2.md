# Agentic Engineering V2 technical alpha

This is an opt-in technical alpha for existing Desk users, not the main-branch default or a qualified V1 replacement. It selects pinned Superpowers as the engineering method while retaining Desk/Crew state, authority and approved delivery boundaries. Public implementation evidence is separate from private participant feedback.

**Candidate status: pending.** This publication is a dogfoodable source milestone, not a qualified alpha. Native runtime qualification is explicitly pending, the relevant-revision status for this head is `pending` with no result, and mechanical CI success does not turn it green. Current source/package tests do not establish alpha runtime admission. The [historical outcome ledger](evals/engineering-v2-results.md) retains the earlier Work Suite-based preview's method failures, bounded Mac/Windows observations and measurement limits. Those source identities and result tables remain unchanged; they are not evidence that this Superpowers composition passed.

## The proposal

Keep the durable workspace. Simplify how work happens inside it. Stronger models should not need a second task system, a stack of overlapping methodologies, or ceremony that substitutes for a working result.

| Part | Responsibility |
|---|---|
| The native host and frontier model | Reason, use tools, and execute the agreed work |
| Desk and Crew | Keep task state, continuity, shared knowledge, attribution, and read-across/write-own boundaries |
| Pinned Superpowers | Own discovery, planning, implementation and verification through `desk:using-superpowers-with-desk`, the single adapter between Desk state and pristine provider skills; consume existing approval and canonical Desk records |
| Independent review | `desk:independent-review` owns finding disposition and re-review; RoboRev reviews continuously, commit by commit, through an admitted host integration, with one implementation owner for fixes |
| Ready-set scheduling | `desk:work-orchestration` owns the ready set, the dependency graph and delivery milestones: the smallest coherent usable milestone ships first, and later qualification stays visible instead of gating an independently usable slice |
| Private work measurement | The work-accounting ledger stays in private state on your own machine; only preview feedback you confirm is written to Git |
| Preview feedback | Let the participant publish comments they explicitly offer, as attributed Markdown in their own desk |

The provider pins `obra/superpowers` at `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` (6.3.0, MIT), with selected-file provenance in `upstream-sources.lock.json`. The authored Copilot hook adapter is separate from pristine upstream hooks. Historical comparisons remain historical; adopting this opt-in composition is not a new measured reliability result or authority to run an always-on review daemon.

### What changes in a task

Read the recorded intent, design agreement, scope, definition of done and go before acting. Preserve an existing approval; use Superpowers brainstorming when agreement is missing, not to repeat an approved questionnaire. Scope, repository authority, delegation limits and intentional alpha/PR-only endpoints remain binding.

After go, retain control through the agreed result. Resume an already-approved task without repeating its questionnaire. A local implementation, a PR, a preview branch, and a production rollout are different finish lines; broad autonomy does not expand repository authority or silently promote one finish line into another.

Keep test-first changes, failure-path checks, the repository's own coverage rules, and risk-scaled independent review. Add primary evidence that the requested result works, including an executed attempt to falsify a consequential claim with a materially different probe. Passing the examples that drove the implementation is not enough. Review invocation alone is not review evidence.

Keep the human-facing evidence in the existing task: what was agreed, what changed, the actual source and workflow version, the outcome, review findings and closure, known limits, and rollout or rollback when relevant. Do not add another progress database or a numeric self-grade.

The maintained bindings are [Superpowers integration](plugins/desk/skills/superpowers-integration/SKILL.md), [independent review](plugins/desk/skills/independent-review/SKILL.md) and the pinned [provider](plugins/superpowers/README.md). Legacy capability names have explicit successor owners and runtime limits in the integration contract, not a second enabled lifecycle.

### Keep work continuous without keeping one process alive

V2 keeps the project durable while allowing bounded worker processes. [Session resumption](plugins/desk/skills/session-resumption/SKILL.md) owns checkpoints at completed integration/delegation boundaries and before long unattended work. A checkpoint includes the original work identity and authority, exact source and publication state, preserved unfinished changes and local commits, evidence hashes, pending external effects, and the next action. Its generation-bound handoff manifest becomes ready atomically only after the referenced payloads are persisted and read back, retaining a previous complete generation without discarding newer work. Raw histories and private records stay outside Git; a same-host archive is not off-host replication.

Persistent runtime memory pressure followed by failed compaction requires a handover rather than indefinite retries. The owning host must detect and recover outside the affected worker, establish release of its actual process generation and writers, and start a fresh conversation from the bounded canonical handoff. The replacement reconciles existing source and uncertain external effects before writing. It does not replay the exhausted transcript, reset work accounting or silently change the selected stack. The host declares arming/disarming, finite handover limits and a persisted no-progress recovery ceiling; intentional stop must not trigger resurrection. A task-bound acknowledgement and an observed next work step distinguish resumed work from a successful launch.

This source contract does not itself install a supervisor or prove a host recovered. An unattended host claim requires two actual consecutive interruption/recovery cycles, including graceful handover and abrupt mid-batch interruption with unfinished source and an uncertain external effect identified before issue. Prove destination reconciliation without replay, sole-writer ownership, continued work on the admitted source and ordinary rollback, plus refusal when recovery is non-ready or exhausted. Missing host capability remains explicit. More physical RAM, a larger heap, a terminal restore label or a live MCP process is not that evidence.

## Opt in without mixing versions

The current source candidate is Desk `3.2.0-alpha.4`, Superpowers `6.3.0`, MCP `1.4.0-alpha.4` and Plain Language `0.2.1`. Standalone Desk selects exactly those three roots — Desk, Superpowers and Plain Language — with no Ponytail, no Work Suite and no private feedback API. A shared workspace adds Crew `0.2.0` and its organization overlay, which is a five-root consumer composition; a Platform Workflows consumer adds its own root for six. Generic source references use `@v2-alpha`, resolved to an exact commit and content fingerprint for admission. Versions, generated activation and native artifacts must agree. A version label alone is not loaded-artifact identity.

Acquisition is ordinary and single-root: select `desk` and let its declaration pull Superpowers and Plain Language. Agency branch tracking of `@v2-alpha` is the update path, so a later source correction arrives the same ordinary way. This build ships no separate installer, refresh command or rollback channel, and nothing here authorizes mutating an installed profile on your behalf.

Choose one active workflow version for your work. Retaining an inactive checkout is fine; enabling V1 and V2 methods together is not. Keep your existing Desk location, Crew person binding, selected overlay, and repository permissions.

**Use the owning host's explicit opt-in composition.** Do not change a live default profile, replace an existing overlay with the standalone worker or infer transitive native loading from packaging metadata. The admitted Desk root must be the same artifact supplied to native skill loading and the MCP process. Do not guess a sibling cache root or bypass a host's source authority.

This candidate publishes one offline runtime pack: ARM macOS on Node 22 (ABI 127), built on that host. The Linux x64 and Windows x64 packs for `1.4.0-alpha.4` are not built yet, because each pack must be produced on its own platform and ABI rather than relabelled from another host; until their own hosts produce them, those targets stay pending and the generated-artifact check reports them missing. Earlier candidates' packs remain in place for their own versions. Use the matching Node version on the CLI's `PATH`. The [native Windows CI](https://github.com/ourostack/ouroboros-skills/actions/runs/34266621708) exercised actual NTFS protection, feedback CRUD/reopen and offline source-mirror attribution on an earlier candidate; it does not qualify a full Windows CLI installation or skill discovery here. A different Node/architecture combination is not qualified by these packs.

Keep the existing workspace/person binding, source inventory and overlay chain. Read-only inventory commands can help establish the selected source:

```bash
git -C "$ALPHA_SOURCE" rev-parse HEAD
git -C "$ALPHA_SOURCE" status --short
copilot plugin marketplace list
copilot plugin list
```

Do not mutate the admitted source during an in-flight task. A fresh session must consume the chosen instructions and MCP together. Keep the existing overlay's launch and binding. Standalone `desk:worker` is not a substitute for a consumer-owned worker.

Before starting work, inspect the actual skill sources from that project's working directory:

```bash
copilot skill list --json
```

Require Superpowers skills to resolve under the admitted source's `plugins/superpowers/skills/`, with `desk:using-superpowers-with-desk`, `desk:independent-review` and Desk state skills under that same source's `plugins/desk/skills/`. Verify actual source paths and content, not just menu names. An enabled Work Suite lifecycle is a conflict; an inactive legacy checkout is not. Preserve operator preferences and interpret retired names through the compatibility map rather than rewriting their text. Ancestor or personal skill shadowing must be resolved through the owning host, not bypassed by deleting guidance.

The legacy Work Suite audit and old preview receipts are not Superpowers admission checks. Freeze current source hashes, selected provider lock, native launch inputs, loaded skills and actual backend identity. Offline fixtures, bootstrap transport and full method-following behavior are distinct evidence classes; do not promote one into another.

The retained [method-slice kernel](evals/engineering-v2-kernel.json) and [investigation-boundary suite](evals/investigation-boundaries.json) carry current seals for their declared source files. Those seals change when shared Desk owners change; historical receipts and result tables do not. Their legacy source maps are not a complete Superpowers evaluation map. Structural validation does not run an agent, judge evidence or qualify this composition.

Use the plugin list for version metadata, `desk_status` for workspace/person and startup state, and `desk_doctor` with `{"format":"preview"}` for the MCP version and minimal runtime state. These do not identify the entire loaded stack or prove behavior. The host owns RoboRev launch and backend authentication; missing reviewer capability must be reported, not silently replaced or called successful.

For isolated installation experiments, changing `HOME` alone is not sufficient when `COPILOT_HOME` is inherited. Explicitly select the disposable `COPILOT_HOME` and XDG directories as well, and check the actual settings destination before registering plugins. Also place the experimental working directory outside ancestor trees containing another installation's skills or instructions. Changing profile variables does not stop inherited directory discovery.

## Give feedback through the agent

Say, for example:

> Record this as preview feedback: "The agent asked for go at the right point, but repeated the same design choice three times."

The agent uses [Preview Feedback](skills/preview-feedback/SKILL.md). There is no feedback tool and no feedback database: your words are written as a dated, attributed Markdown entry in your own desk at `_meta/preview-feedback.md`, and nothing is inferred about you or scored. If the agent proposes a summary rather than preserving your text, it must show you that summary and get your confirmation first.

You can then say "show me my preview feedback", "correct this entry to ...", or "withdraw this entry". The file is ordinary Markdown you own: reading it back, correcting an entry in place, or writing your own tombstone are all edits you can see and review.

Two fixed native Mac scenarios exercised the earlier private-tool surface on alpha.2: ordinary discussion with feedback capability available made no capture attempt, and explicitly authorized capture, inspection, same-record correction and deletion completed with an empty final store. The discussion case also attempted an unrelated read that the fixed tool policy denied. Those remain bounded historical observations about the retired tool, not a general privacy reliability estimate and not evidence about this Markdown convention.

Saying something is not consent to publish it. Before writing or sending identifiable feedback, the agent shows the exact excerpt and destination and waits for your confirmation. A publication in Git belongs in your own desk and remains attributed to you. Withdrawing something already published in Git means a tombstone, not erasing its history.

### The privacy boundary

Your desk is a Git checkout that syncs to a remote, so an entry you confirm is visible to everyone who can read that repository and stays in its history. That is the trade this convention makes plainly rather than quietly: nothing is written until you have seen the exact words and the exact destination.

Private records captured by the earlier preview tool are untouched. That tool is gone from this build, and nothing migrated, indexed, exported, or deleted what it stored: the entries stay in their protected local store on your own machine. Be aware of the trade — this build ships no way to read or edit them either, so treat them as preserved archival data. Only you can decide to offer any of it again, by saying it here. See the [storage contract](plugins/desk/mcp/docs/private-feedback.md) for platform details and limits.

None of this makes your conversation private from the host or model provider. Text you type, or ask the agent to read back, remains part of that conversation and follows its retention rules. A tombstone in Git, like a deletion in the old local store, cannot erase conversation history, OS backups, or copies already shared. No claim of anonymity, employee-performance measurement, or regulatory compliance is made.

The optional [minimal diagnostic](plugins/desk/docs/preview-diagnostics.md) is a separate, on-demand package/process snapshot. It reads no feedback or task data and sends nothing on its own.

## Correct your source through Agency

Keep the existing workspace and private-state directory. Neither is part of switching source versions, and nothing here asks you to delete either one.

Source corrections arrive the ordinary way: Agency tracks the `@v2-alpha` branch for the roots you already selected, so a corrected commit reaches you through the update path you are already using. This build deliberately ships no parallel installer, no manual refresh command and no rollback channel, and it does not modify an installed profile for you. If you need to leave the alpha, that is the owning host's ordinary source-selection decision under its own authority.

For history, the earlier Work Suite-based preview did exercise a manual rollback to `c5a210f91ee59584f5cbcf126966498c17ebccc2` — Desk `3.1.2`, Work Suite `3.0.0` and MCP `1.3.4` — with a preserved workspace sentinel and unchanged private-store bytes across two native Mac cycles. That record stands as history for that composition. It is not an instruction for this build and not evidence that this Superpowers composition can roll back; those manual steps are no longer part of the supported path.

Whichever source you run, a private store created by the earlier preview stays on disk: this build neither reads, migrates nor deletes it.

## What qualifies the proposal

The [permanent engineering kernel](evals/engineering-v2-kernel.json) covers new-work alignment, approved local delivery, and primary-source status. It binds results to complete source and contract fingerprints. Structural validation does not run a model or establish behavior.

The [experiment design and historical arm definitions](evals/engineering-v2-experiments.md) publish the original coding task, rubric, source pins and invocation modes. They distinguish what was executed from what a new run of the published fixture would test.

The first alpha failed despite green-looking intermediate evidence: one subject implemented and deleted scratch prototypes before go, and another passed its authored tests and review while losing required input characters. The second round preserved alignment in its recorded subjects, but GPT delivery still lost combining marks after consuming the method, obtaining fresh review and executing its challenge. Opus delivered a correct result without demonstrating delivery-method consumption, fresh review or strict test-first execution. Three judges also made malformed report attempts before their accepted reports. The [complete outcome ledger](evals/engineering-v2-results.md) separates these results rather than treating driver passes as proof of every floor.

Before another method comparison, close the measurement gaps: map each claimed floor to observable evidence, distinguish configured method from actual consumption, and make the judge's report rule agree with the adapter's admission rule. Another reminder or unchanged-candidate rerun is not the next step. Independent acceptance authorship is a hypothesis to investigate, not an established fix.

Controlled single-prompt method slices, native installation, actual skill discovery and participant experience remain separate evidence categories. The published fixture genericizes one descriptive ASCII example; historical runs keep their original source and contract identities. No historical receipt is relabeled as a coding-method run of this publication variant.

This branch is the place to challenge the proposal, not proof that the challenge is over. Promotion to main remains a separate owner decision after existing V1 users have a genuine opportunity to give feedback.
