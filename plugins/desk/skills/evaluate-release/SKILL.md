---
name: evaluate-release
description: For `desk:observer` evaluating an Agentic Engineering V2 release alongside a human evaluator, or in an agent dry run of the same packet. Works through an evaluation packet from a cold start on the named host, records each step's outcome with evidence, times each scenario, classifies every problem as a defect, a confusion or a gap, and reports without fixing anything. Do NOT use for labeling a finished job's waste, for reviewing a pull request, or for any work observer did itself.
---

# Evaluate a release

Work through an evaluation packet, such as the [V2 evaluation packet](../../docs/evaluation-packet.md), on one named host, starting from nothing. Record what each step did, with evidence, and how long each scenario took. Classify every problem you see. Report it for someone else to fix and judge. The finished report is evidence for the human evaluator's release call; it is never a verdict of yours.

## When to use it

- A human evaluator asks you to work through a packet with them on a named host. They drive the steps; you watch, time and record.
- An agent dry run of a packet: you drive the steps a human evaluator would take, in a separate session under test on a throwaway profile, and the agent in that session does the work. You type what the packet says to type and run what it says to run; you never do the part the agent under test is being evaluated on.

## When not to use it

- Labeling a finished job's stretches as value-adding, necessary support or waste: that is the factory evaluator's job, not a release evaluation.
- Reviewing a pull request or a change: use `superpowers:requesting-code-review` or `desk:peer-pr-review`.
- Any work you did or helped with, including an earlier fix to something you are now evaluating. Say so and ask for another observer.

## Hands off

These rules hold for the whole evaluation.

- **Never fix anything.** Do not edit a file, change a setting, install something the packet does not name, re-run a step with different arguments, or try a workaround to get past a failure, even when the fix is one line. A workaround hides the very problem the evaluation exists to find. When a step fails, record it and carry on with the next step whose preconditions still hold; when none do, mark the rest of the scenario `blocked` and move to the next scenario.
- **Follow the packet exactly as written.** Where it is ambiguous, take the reading a newcomer would most likely take, record the ambiguity as a confusion, and continue.
- **Never certify.** You never certify your own work or declare the release ready; you report what you observed against the packet's stated outcomes.
- **Human gates stay human.** A sign-in, an approval or a decision that belongs to the evaluator waits for them. In a dry run with no human present, record the step as `blocked` at that gate.
- **Evidence stays safe.** Never capture a secret, token or password, even in a screenshot. Private evidence (raw session logs, screenshots with personal data) stays outside Git, where `desk:session-resumption` says private evidence lives; the record holds pointers to it.

## Start cold on the named host

1. Confirm the named host (for example Claude Code, or a managed launcher with a company overlay) and the packet. One run covers one host; a second host is a second run.
2. Start from nothing: a fresh machine, or a throwaway profile the packet names (for Claude Code, a new empty `CLAUDE_CONFIG_DIR`). Record the starting state before step 1: host and version, operating system, the installed plugins (none), and that no desk is bound. Keep your own session in your normal profile, so your record survives when the throwaway profile is removed.
3. Test the channel as it stands. Install exactly what the packet says, from the channel it names. Record the commit you observed on that channel and the plugin versions the host reports after install, as evidence, never as a pin. If the channel moves during the evaluation, note when and carry on; do not freeze or roll back anything.
4. Keep the record in the evaluation's task on your desk: one task for the evaluation, one iteration per host run (`desk:start-task` places it).

## Record every step

For each step of each scenario, record one entry:

| Field | What goes in it |
| --- | --- |
| Step | The packet's scenario and step, quoted briefly |
| Action | The exact command, prompt or click, as performed |
| Expected | The packet's "good looks like" outcome for this step |
| Observed | What actually happened, in one or two sentences |
| Evidence | The command with its output (trimmed to what matters), a screenshot path, the `desk_status` result, a host log path and line, a file and line, a pull request, commit or CI run |
| Outcome | `pass`, `fail`, `blocked` or `unavailable` |

- `pass` means the observed result matches the packet's outcome and the evidence shows it. `fail` means it does not. `blocked` means an earlier failure or a human gate stopped the step. `unavailable` means you could not observe it; say why.
- Take `desk_status` from the session under test, not your own: your session's `desk_status` describes your desk. Read it from that session's output or its host log.
- Host logs: Claude Code keeps a session log under its configuration directory's `projects/` folder; Copilot CLI keeps one under `COPILOT_HOME`, otherwise `~/.copilot`. Cite the path and the line or event, not a paraphrase.
- A screenshot shows a visible state a log cannot (a rendered page, a pull request's state, a startup banner). Nonvisual steps get no artificial screenshots.
- Anything the agent under test claims ("tests pass", "merged") is checked against its artifact before you record it as observed.

## Time each scenario

Record each scenario's elapsed time, measured, never estimated. Take the start and end from a clock you read at the moment (`date -u +%Y-%m-%dT%H:%M:%SZ`) or from host log timestamps, and compute the difference. When you can measure it, record separately the time the scenario spent waiting on a human. If you missed the start or the end, the elapsed time is `unavailable`; never fill it in from memory or a guess.

## Classify every problem

Every problem gets exactly one class. Give the class and one sentence saying why.

- **Defect.** V2 does not do what its packet, docs or RFC say it does: a step fails as written, a command errors, a result is wrong or missing, a promised outcome does not appear.
- **Confusion.** V2 does what it was designed to do, but the packet, a doc, a prompt or the agent's own words misled the evaluator or left them unsure what to do next or whether it worked. Conflicting instructions are a confusion.
- **Gap.** Something the evaluation needs, or that the packet or RFC promises for this stage, does not exist yet: a missing capability, a missing step, no way to see the evidence. A scenario marked as landing by the evaluation whose feature is not on the channel is a gap, with the channel state as evidence.

When a problem fits two classes, pick the one whose fix would remove it: a defect over a confusion when the behavior is wrong, a confusion over a defect when the behavior is right and only its explanation misleads. For each problem, also record whether it blocked the scenario.

## Report

Write the report in the iteration folder, then give it to the evaluator:

1. **Summary:** host, packet, channel and the commit observed, plugin versions, and per scenario its outcome against "good looks like" and its measured elapsed time.
2. **Findings:** each problem with its class, the step, expected, observed, evidence and whether it blocked the scenario. Describe where it happened and what good would have looked like; do not write the fix.
3. **What you could not observe,** with the reason.

The release call is the evaluator's. Your report never says the release is ready or not ready.

File one issue per finding in `ourostack/desk`, labeled `evaluation`, or in the work equivalent when the host run used a company overlay: that overlay's own tracker, with its equivalent label, since public issues carry no work context. An issue is posted from the evaluator's account, so draft each one and follow `desk:operator-voice-comments`: the evaluator approves the exact content before it is filed. Each issue carries the host, the scenario and step, the class, expected and observed, evidence links, the elapsed time and the commit observed. Public issues follow `desk:content-routing`: no private names, no secrets, private evidence by pointer only, and durations, never times of day.

## Clean up

Remove what the evaluation created: the throwaway profile and any process you started, stopped by its exact PID. Keep the record and the evidence. List what you removed in the report.
