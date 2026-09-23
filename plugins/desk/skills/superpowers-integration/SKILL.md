---
name: superpowers-integration
description: Retired name for the Desk/Superpowers seam. Redirects to desk:using-superpowers-with-desk and retains the Work Suite capability mapping for unchanged standing instructions.
---

# Superpowers on Desk (retired name)

**Retired.** The active entry is `desk:using-superpowers-with-desk`. Invoke that adapter for entry selection, authority handover and the explicit artifact map; it is the single seam between Desk state and pristine Superpowers skills.

This file remains only as a compatibility redirect for unchanged standing instructions that still name `desk:superpowers-integration` or a retired Work Suite skill. Interpret those legacy calls through the mapping below and then enter the adapter. Do not treat this page as a second contract, and do not load a second lifecycle.

Selected engineering lifecycle: Superpowers. Desk owns durable task/iteration state, work identity, authority and the agreed delivery endpoint; Crew adds shared-workspace read-across/write-own rules and main-branch state. Superpowers owns engineering discovery, planning, implementation and verification.

Recovery goes to `desk:session-resumption`; normal review to `superpowers:requesting-code-review`; scheduling to `desk:work-orchestration`; accounting to `desk:work-measurement-ledger`; evaluation to `desk:online-evaluation`; delivery to the recorded repository policy and the existing repository skills. Authority invariants, provider selection and the artifact map live in `desk:using-superpowers-with-desk`, not here.

## Legacy capability mapping

These are compatibility routes, not copied Work Suite skills. Source availability is not runtime qualification. If a required native or consumer capability is unavailable, report that limitation and preserve the unfinished outcome; do not silently drop its acceptance criteria.

| Retired call | Selected capability and owner | Capability and proof |
| --- | --- | --- |
| `work-ideator` | `superpowers:brainstorming`, consuming existing approval. | Pinned skill available; actual method consumption still needs qualification. |
| `work-planner` | `superpowers:writing-plans`, with the Desk plan path. | Pinned skill available; no second plan tree. |
| `work-doer` | `superpowers:subagent-driven-development` when delegation is authorized, otherwise `superpowers:executing-plans`. | Pinned skills available; no automatic delegation grant. |
| `work-merger` | `superpowers:verification-before-completion`, then authorized finishing only. | An alpha endpoint does not become a main merge. |
| `autopilot` | native continuation within recorded authority. Owner: `superpowers:executing-plans`. | Capability: conditional; requires host continuation. Proof: runtime qualification required. |
| `stay-in-turn` | native notifications and bounded waits. Owner: `superpowers:executing-plans`. | Capability: conditional; requires host wait tools. Proof: runtime qualification required. |
| `inch-worm` | Execute the approved backlog without arbitrary outcome splitting. Owner: `desk:start-task`. | Capability: conditional; requires an approved backlog and authorized continuation. Proof: runtime qualification required. |
| `watchdog-mode` | native monitoring when available; bounded diagnosis is distinct from persistent supervision. Owner: `desk:runtime-symptom-investigation`. | Capability: conditional; persistent monitoring is not bundled. Proof: runtime qualification required. |
| `visual-qa-dogfood` | Inspect actual screenshots or the live consuming surface, not just metrics. Owner: `superpowers:verification-before-completion`. | Capability: conditional; requires visual tools and viewing evidence. Proof: runtime qualification required. |
| `deep-research` | Discovery uses firsthand evidence. Owner: `superpowers:brainstorming` for discovery only; exhaustive research requires a consumer-provided entrypoint. | Capability: conditional; use the consumer's existing evidence/thread-completion contract, not a generic replacement research engine. Proof: runtime qualification required. |

Keep historical Work Suite runs and result tables as historical evidence. New source fingerprints identify the current alpha only; they do not retroactively qualify those runs.
