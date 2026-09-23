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

**Alpha 1 pre-final candidate; Windows PWF delta and hosted Linux receipts pending.** The candidate follows the moving `v2-alpha` branches. Exact commits, trees and content digests are qualification evidence, not installation authority.

The completed source, macOS and Windows evidence establishes restored semantic behavior, fail-closed watcher reconciliation, the complete Desk source gate, a seven-root Copilot composition with native Superpowers review, zero excluded review-provider context in the admitted normal session, deterministic work-measurement formulas, macOS and Windows fresh-process continuity, person-scoped authority, real local Ollama repeatability, exact-owned Windows cleanup, and `old -> current -> old -> current` rollback and forward resumption. The Windows pass binds PWF `7770499f3c483328df2a61c41a3a0e8e945539e3`; the current PWF candidate `d6f45e777510d42f8aeaa3dc091c658348548be4` still needs its targeted registry-authority delta receipt. Agency-managed work remains Copilot-only. Claude uses standalone root Desk outside that overlay composition and its approval integration; a failed Agency Claude launch is therefore negative-boundary evidence, not a product failure.

Two release rows remain open:

- **Managed Windows PWF delta:** the registry-authority correction must pass the bounded Windows mission against the changed PWF bytes.
- **Hosted Linux source qualification:** source gates must be reused from authorized source pull-request CI; the current Docker registry `ECONNRESET` leaves this coverage unavailable, and no duplicate temporary CI infrastructure will be created.

The Alpha 1 measurement packet uses manually normalized, safe events and the reusable deterministic formula kernel. It reports what happened, what mattered, what was muda, how the system flowed, and what coverage is unavailable. Missing intervals, spend and cross-host receipts remain unavailable rather than becoming zero, and this one lineage does not establish causal productivity improvement.

Until the Windows delta and hosted Linux receipts exist and the pre-final packet is regenerated against them, this RFC does not claim opt-in qualification, publication, default adoption, RC readiness, or stable support. Future DevRel “show one” examples remain a non-blocking refinement.
