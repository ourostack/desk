<!-- canonical-agentic-engineering-v2-rfc -->
# Agentic Engineering V2

## Purpose

Agentic Engineering V2 is a layered toolshop for long-running engineering work. It gives an agent one durable work identity, one selected engineering lifecycle, explicit authority, and evidence that reaches the real consumer result. The goal is not more ceremony or maximum autonomy. The goal is reliable outcome ownership with the lightest controls that preserve safety, continuity, review, and truthful delivery.

This is the only active canonical public RFC for Agentic Engineering V2. Startup and onboarding surfaces may point here on demand, but they should not load this long-form rationale into every normal session.

## The engineering problem

An agent can produce plausible local progress while still failing the actual job. It may start from the wrong source, split one outcome across competing task records, stop at a command that printed success, delegate without a bounded return contract, or treat a passing proxy as proof that an installed or rendered result works. These failures become more likely when runtime setup, durable state, engineering method, repository policy, and domain instructions are copied into overlapping instruction bodies.

V2 addresses that problem by separating ownership. Each layer has one job, and evidence must cross the layer boundaries instead of being replaced by claims.

## The layered toolshop

| Layer | Ownership |
| --- | --- |
| Host and acquisition runtime | Select and materialize the admitted plugin composition, expose tools, and report the source actually loaded. |
| Desk and Crew | Preserve durable task identity, continuity, authority boundaries, shared knowledge, and attributed state. |
| Superpowers | Own engineering discovery, planning, test-first implementation, verification, and the normal code-review transition. |
| Consumer overlays | Add identity, organization or environment policy without copying the generic foundation. |
| Repository policy | Define contribution authority, build and test gates, delivery endpoints, and cleanup rules for the product being changed. |
| Evidence | Prove source, behavior, review, consumer outcome, rollback, and resource settlement at the layer where each claim is true. |

Layers depend downward instead of redefining one another. Desk does not become a second engineering method. Superpowers does not create a second durable task store. An overlay does not copy the Desk foundation. Repository access does not create contribution authority.

## Human and agent contract

The human supplies intent, material constraints, authority, and the desired endpoint. The agent owns sequencing, tool choice, decomposition, implementation, verification, recovery, and cleanup inside that authority. Broad autonomy does not expand publication, destructive, rollout, repository, or product authority.

The agent calibrates delegation to the outcome rather than maximizing it. If an already-authorized outcome arrives one mechanical step at a time, the agent briefly states that it will own the sequence and return at a genuine decision or the endpoint. If a mandate is too broad to identify one assessable outcome, authorized surfaces, or irreversible boundaries, the agent narrows and records the work before execution. Genuinely bounded help stays bounded instead of being inflated into a whole project.

Coaching happens once, stays actionable, and does not become a recurring approval gate. After the corrected work shape is recorded, the agent continues wherever authority is sufficient.

## Automated controls and truthful failure

V2 automates practices that are safely determinable: source-authority checks, exact worktree isolation, test-first gates, generated-artifact freshness, structural document checks, review transitions, evidence readback, and resource accounting. Automation should reduce repeated decisions, not hide them.

When intent quality, authority, or the requested outcome cannot be determined safely, the agent coaches or stops at that exact boundary. It does not invent authority, silently weaken acceptance criteria, convert missing evidence into success, or ask the human to repeat a decision already recorded.

## Source authority and continuity

Every repository starts from its recorded source authority. That authority may be a moving branch, a frozen candidate, or another explicit source contract. A newer branch does not automatically outrank the selected source shape. The agent verifies the branch relationship and materialized source before the first write, then preserves that authority through implementation and review.

One durable task carries the outcome through changed requirements, corrections, review findings, installed proof, and cleanup. New material requirements update the governing work record and invalidate only affected evidence. Bounded processes may hand work over, but a replacement must reconcile the same task, source, authority, and uncertain effects before writing.

## Consumer-visible validation

Verification must reach the altitude of the claim. A source test cannot prove an installed workflow, a terminal success line cannot prove a rendered artifact, and an opened change request cannot prove merged state. When the milestone claims a rendered, installed, merged, rollout, restart, rollback, or resumed result, evidence must show that real consumer-visible state.

The smallest coherent consumer boundary should follow the smallest coherent green implementation. Later platform breadth, automation, documentation, and final qualification remain visible, but they should not block an independently usable slice unless the coupling is concrete and recorded.

## Visual proof

Visual proof helps a human understand or verify a state that is genuinely visual. Capture a bounded view of the rendered interface, installed composition, merged checks, rollout state, or persisted result when that view adds information. Name the stronger system-of-record evidence that the image supplements.

Visual proof never replaces tests, logs, APIs, database readback, source identity, or authority checks. Do not expose secrets or sensitive content, and do not manufacture screenshots for nonvisual terminal work.

## Review and correction

The normal review transition is `superpowers:requesting-code-review`. Review uses a frozen candidate and relevant evidence, records finding disposition, keeps one implementation owner for corrections, and requests affected re-review after a bounded correction wave. Review does not create a parallel implementation owner or reopen accepted architecture without new evidence.

## Measurement

V2 measures work from evidence the job already creates. Useful views include lead time, active span, active occupancy, wait span, work in progress, boundary cadence, first-pass yield, correction waves, finding movement, rework proportion, and flow efficiency. Wall-clock interval union, summed occupancy, and attributable consumption are different quantities and stay separate.

Every reported value carries a provenance class such as measured, declared, inferred, estimated, or unavailable, plus a source reference. Missing anchors remain unavailable rather than becoming zero. Measurement does not copy raw transcripts into Git, rank people, infer attention from silence, or add status ceremony merely to create data.

## Limits

V2 does not grant repository ownership, publication authority, destructive authority, or rollout authority. It does not promise that every host supports every background, visual, review, or recovery capability. It does not make structural tests a substitute for installed behavior or editorial judgment. It does not treat one successful job as causal proof of productivity improvement.

Public generic policy stays here and in the compact Desk foundation. Environment-specific rules belong in consumer overlays, product behavior belongs in the product repository, and operator preferences belong in the operator's workspace.

## Current status — September 23, 2026

**Alpha 1 qualified for opt-in use.** Qualification is bound to the final current source cohort: Desk `8e465274543aabf9ef2e0fa9b3d6fa2a86b3ad46`, consumer overlay `271196050c5628458d74a680175eff4c3614ab04`, and workflow overlay `506fc4e377ab3855458e72679676c1a954824366`. The alpha continues through the moving `v2-alpha` branches; exact commits, trees, content digests, delta evidence, and hosted receipts identify what was qualified, while installation authority still comes from the admitted source flow.

The qualified envelope establishes restored semantic behavior and fail-closed watcher reconciliation; the complete Desk source gate; the composed Copilot workflow with the native Superpowers lifecycle and `superpowers:requesting-code-review`; and standalone Claude plugin loading. Final hosted Desk qualification ran 2,177 tests with 2,168 passes, nine platform skips, and zero failures and 100% statement, branch, function, and line coverage across changed production files, together with Linux x64 and Windows x64 runtime packs, Windows private feedback, skills validation, and Claude plugin load. Agency-managed work remains Copilot-only; standalone Claude uses root Desk with Superpowers outside that overlay composition.

Installed macOS and Windows evidence passed fresh-process continuity, person-scoped authority, semantic restoration, rollback, cleanup, and forward resumption through `old -> current -> old -> current`. The installed proof is bound to its recorded candidates; later moving-branch heads were qualified through exact source deltas and hosted receipts, not represented as full installed reruns.

The bounded measurement packet was generated twice from the same retained lineage, producing byte-identical retained input, JSON profile, and Markdown profile. It reports the available flow, rework, value, waste, and coverage signals through deterministic formulas; missing intervals, attributable spend, and evidence outside that lineage remain unavailable rather than becoming zero. This result proves deterministic reproduction for one retained lineage and does not establish causal productivity improvement.

This qualification does not publish a version bump, tag, release, default-installation change, RC or stable claim, or promotion to `main`. Future moving-branch heads require their own exact delta and hosted qualification evidence, and broader installed platform or engine coverage remains outside this Alpha 1 claim.
