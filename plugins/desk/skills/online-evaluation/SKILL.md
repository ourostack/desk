---
name: online-evaluation
description: Evaluate a real Desk work item's outcome, flow, review burden and resource consumption at an agreed endpoint or observation horizon. Use for a work-item evaluation or retrospective, not for every tool call. Composes canonical Desk records, the factory's report for the finished job and existing independent outcome evidence. Does not own the lifecycle, start another implementation loop, run an offline benchmark, grant collection consent or rank people.
---

# Online evaluation

Produce an evidence-backed account of real work. Keep outcome quality, flow and consumption separate.

The selected lifecycle still owns the work and any remediation. This skill reads its evidence and reports what happened. It does not introduce another task store, planner, reviewer-fix loop or model execution service.

## Invocation trigger and boundaries

Invoke this skill (`desk:online-evaluation`), when it is present in the admitted selected-method composition, at an agreed evaluation endpoint or observation horizon, or for a requested work-item evaluation or retrospective. Otherwise report evaluation unavailable. Accounting is automatic: the factory captures each session when it ends and reports each finished job, so there is nothing to record or import here, and invocation grants no collection consent. This is a trigger, not another engine, store or lifecycle.

## Start from the existing work item

Find the canonical Desk task and active iteration. Keep the same outcome identity through planning, implementation, review, necessary rework and publication. A session, PR, delegated step or report is not another work item. The factory's job is the canonical task: its job ID is derived from the desk, the person prefix, the track and the task slug, so never create or rename a task because a report was requested.

Read the request, commitment, intended endpoint and completion evidence. Record the observation horizon. Keep unfinished work censored at that horizon and cancellations separate from delivery, with their recorded cause. A missing canonical task makes the work-item evaluation unavailable; it does not justify inventing one in a private report.

Use the work-type, scope, uncertainty, risk and verification features recorded before execution. If they were captured later, label them post-hoc or unavailable rather than presenting them as predictive sizing. Do not label expensive work complex because it was expensive.

Reuse criteria and a horizon recorded with the commitment. Do not add another approval ceremony or retrospectively tune the criteria to the result. Criteria or a horizon first recorded after execution are post-hoc, including on the conclusion; they are not preregistered.

## Read the factory's evidence

Flow and consumption come from the factory, never from a hand-kept record:

- The job's report, linked from the task card's `factory_report:` field once the task is `done` and its store has consent. It answers four questions: what happened, what mattered, what was waste and what we could not see. The link resolves once the store has merged the job's facts; until then, flow is pending, not zero.
- The waste labels an independent `desk:observer` wrote with `desk:factory-evaluator` for the finished job, once the store has them. Until they arrive, the report's waste section lists candidate signals only; treat those as inferred, not as classified waste.
- For a job still open, or detail the public report leaves out by design, the local status from `node mcp/scripts/factory.js status` run from the installed Desk plugin root. It stays on this machine and is never uploaded or pasted into a repository.

If the store has no consent, the report does not exist yet or the factory is not installed, mark flow and consumption unavailable with that reason and return the supported outcome-only assessment. Do not reconstruct a report from transcripts, and do not grant consent to finish an evaluation.

Missing usage does not erase available outcome evidence. Missing outcome evidence does not become success because usage is available. Missing capabilities and coverage remain visible in the assessment.

## Keep the operated composition attached

Reference the actual selected-source and native-consumption evidence for the observed work: lifecycle and contextual components, implementation posture including Ponytail/reuse policy, plugin versions, model identity/effort, reviewer configuration, host, authority and interaction mode, and the covered interval.

A requested source specification, installed menu entry or author-declared label is not proof that the work ran under that composition. Keep that distinction in the report. A mixed or unknown exposure remains mixed or unknown.

## Assess the outcome before interpreting efficiency

For each criterion fixed by the request, record the observable result, its evidence source and any limitation. Use the appropriate far boundary: delivered behavior, a published artifact in its consuming environment, a system-of-record result or a source-bound check. A document claiming that it works is not the same evidence as the result.

Reuse existing independent review and QA evidence when its source, scope and requirements still match. For code, use the selected independent-review function and its actual review receipt. A passing review, feedback or green diagnostic alone is not endpoint evidence. Do not launch another review solely to manufacture a measurement. A missing or stale assessment is unavailable; if a fresh assessment is necessary, route it through the established independent-review owner without creating another remediation loop.

Keep the following separate:

- The canonical completion claim and its declared evidence.
- What the endpoint observation establishes.
- The independent assessor's judgment, identity, source scope and unresolved findings.
- The evaluation's conclusion: `satisfied`, `not_satisfied` or `unavailable`, with the supporting criterion results. Apply the evaluation owner's published importance/severity ranking and quality floors to those results; if that model is unpublished or unbound, mark the classification unavailable rather than inventing one.

A major defect or unsafe outcome is not redeemed by low cost or short duration. Missing evidence is not a clean verdict. If the canonical completion claim conflicts with the observed result, report the mismatch and hand the finding to the existing lifecycle on the same work item. Do not silently rewrite canonical state while measuring it.

## Account for the work without inventing time or prices

Use the report's values as it classes them: measured, inferred or unavailable with a reason. Do not recompute its aggregates in another store or upgrade an inferred value into a measured one. Never render an unavailable or out-of-coverage value as zero, or total a partial view without naming the gap. Do not add subagent work to a total that already contains it.

Lead time runs from the task card's creation to the first `done` of its final terminal stretch; active time before the card existed is reported separately and is outside lead time. Unfinished work retains right-censoring at its horizon. Summed tool or API duration is not lead time, compute time or human effort. Do not invent request intervals from a timestamp whose producer meaning is unknown.

Keep active, queue, blocked and unknown classes distinct, with rework as a purpose annotation that can overlap activity. Show known overlap and concurrency. When the evidence cannot establish the critical chain, mark that analysis unavailable. Do not infer that removing any busy interval would have advanced delivery.

Record interruptions, review burden and failure demand from evidence. An interruption is a human intervention episode with a cause, not every user-shaped message. Review burden counts review occasions and resulting rework cycles, not comments. Failure demand needs a cause linking the work to earlier incorrect output; necessary exploration does not become waste by default. Keep machine and human burden distinct, and do not infer human effort by subtracting time from a wall-clock gap.

Keep token counters, source-named credit or multiplier units and money separate. Never convert account totals into a task bill, invent a rate or report counterfactual savings as measured.

## Return one useful report

Run the full assessment at the requested horizon or endpoint, not after every tool call. Repeatedly asking models to reinterpret the same unchanged progress is not measurement.

The report contains the canonical identity and horizon, composition exposure, criterion-level outcome evidence, the factory's flow and consumption view, interruption, review and failure-demand evidence, coverage and any grounded work-design findings. Keep numeric denominators explicit. Retain incomplete and never-approved work; do not silently narrow the view to completed items. Do not create a composite productivity score, and never rank people.

Separate an observed cause from a hypothesis. A proposed workflow change should name the avoidable failure or wait it targets and the quality constraint it preserves; a repeated one belongs on a kaizen card. If the critical chain or attribution is unknown, do not attach a fabricated time or money saving.

Return the assessment in the response. Persist it only in the already-approved, protected evidence location supplied by the current Desk context (see `desk:session-resumption`), never in the factory's state directory, a Git-backed desk or harness scratch; if that location cannot be established, report storage as unavailable and do not write elsewhere. Canonical Desk records receive only a pointer or an explicitly approved summary, never private usage detail.

A real-world failure can become a candidate fixed offline regression case. Preserve its recurrence evidence and propose that case through the existing evaluation owner. Do not silently edit a frozen dataset, discard failed attempts or claim comparative improvement from this observational report.
