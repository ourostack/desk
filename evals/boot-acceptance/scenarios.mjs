// Scenario definitions for the boot-acceptance harness. Each scenario is one
// operator-shaped opening prompt plus a shared critique ask appended to the
// same `-p` call (see run.mjs for why: `--no-session-persistence` means a
// `--resume` second turn is not available, and the task's own instructions
// say to fold both into one prompt when resume isn't possible headless).
//
// `check(ctx)` returns { outcome: "pass" | "fail" | "unknown", notes: [...] }
// from the transcript alone (tool calls + text), never from the agent's own
// self-report -- matching the acceptance loop's "correctness is checked from
// the transcript, not from the agent's self-report."

export const CRITIQUE_SUFFIX = `

---

Once you have finished with the above, take a step back. What could be better about this boot-up? What confused you, what did you have to work around, what was slow or noisy, what would you change? Feel free to poke around the desk and the Desk tools before answering. Be concrete; if it was genuinely fine, say so.`

function toolNames(ctx) {
  return ctx.toolCalls.map((t) => t.name)
}

function toolInputsContaining(ctx, name, substring) {
  return ctx.toolCalls.filter((t) => t.name === name && JSON.stringify(t.input ?? {}).toLowerCase().includes(substring.toLowerCase()))
}

function textMentions(ctx, ...needles) {
  const hay = ctx.allText.toLowerCase()
  return needles.some((n) => hay.includes(n.toLowerCase()))
}

export const SCENARIOS = [
  {
    id: "say-hi",
    description: `Operator opens with a bare "hi" — does boot run its full checklist without dumping noise or stalling?`,
    prompt: "hi",
    inject: null,
    check(ctx) {
      const notes = []
      const ranStatus = toolNames(ctx).some((n) => n.endsWith("desk_status"))
      notes.push(ranStatus ? "called desk_status during boot" : "did not call desk_status directly (the SessionStart hook already injects boot status into context, so this alone is not a failure)")
      const crashed = ctx.isError === true
      if (crashed) notes.push("run ended in an error result")
      const outcome = crashed ? "fail" : "pass"
      return { outcome, notes }
    },
  },
  {
    id: "where-were-we",
    description: "Operator asks a resume-oriented question with no task named — boot should surface active tasks across both tracks.",
    prompt: "where were we?",
    inject: null,
    check(ctx) {
      const notes = []
      const mentionsWatering = textMentions(ctx, "watering-schedule-api", "watering schedule")
      const mentionsBeaconOrDashboard = textMentions(ctx, "beacon-uptime-alerts", "soil-sensor-dashboard", "beacon-relay-push-check", "soil sensor")
      notes.push(mentionsWatering ? "mentioned the in-progress watering-schedule-api task" : "did not mention watering-schedule-api")
      notes.push(mentionsBeaconOrDashboard ? "mentioned at least one other active task" : "did not mention any other active task")
      const outcome = mentionsWatering ? "pass" : "fail"
      return { outcome, notes }
    },
  },
  {
    id: "resume-named-task",
    description: 'Operator names the in-progress task directly ("resume watering-schedule-api") — boot should go straight to it, not sweep every task.',
    prompt: "resume watering-schedule-api",
    inject: null,
    check(ctx) {
      const notes = []
      const readTask = ctx.toolCalls.some((t) => (t.name === "Read" || t.name === "Bash") && JSON.stringify(t.input ?? {}).includes("watering-schedule-api"))
      notes.push(readTask ? "read the named task's own files" : "never read the named task's files")
      const mentionsNextStep = textMentions(ctx, "raindelaypolicy", "shoulddelay", "rain-delay", "rain delay", "test_rain_delay_boundary", "30%")
      notes.push(mentionsNextStep ? "surfaced the task's recorded next step" : "did not surface the task's recorded next step")
      const readUnrelatedTask = ctx.toolCalls.some((t) => JSON.stringify(t.input ?? {}).includes("beacon-uptime-alerts") || JSON.stringify(t.input ?? {}).includes("soil-sensor-dashboard"))
      notes.push(readUnrelatedTask ? "also opened an unrelated task's files (full sweep, not a direct jump)" : "did not open unrelated tasks' files")
      const outcome = readTask && mentionsNextStep ? "pass" : "fail"
      return { outcome, notes }
    },
  },
  {
    id: "slow-or-failing-status",
    description: "Origin remote points at a path that does not exist, so the sync step (session-start Step 2) fails — does boot degrade gracefully and say so, instead of stalling or crashing silently?",
    prompt: "where were we?",
    inject: "break-origin",
    check(ctx) {
      const notes = []
      const crashed = ctx.isError === true
      const mentionsSyncProblem = textMentions(ctx, "sync", "pull", "origin", "remote", "could not", "failed", "unresolved", "desk problem")
      notes.push(crashed ? "run ended in an error result" : "run completed without an error result")
      notes.push(mentionsSyncProblem ? "surfaced the sync/origin problem to the operator" : "never mentioned the sync/origin problem")
      const outcome = !crashed && mentionsSyncProblem ? "pass" : crashed ? "fail" : "unknown"
      return { outcome, notes }
    },
  },
  {
    id: "wrong-push-account",
    description: "Named task's only repo is a real public repo the configured account cannot push to — does the agent notice/say so before assuming it can deliver?",
    prompt: "resume beacon-relay-push-check",
    inject: null,
    check(ctx) {
      const notes = []
      const touchedRepo = ctx.toolCalls.some((t) => JSON.stringify(t.input ?? {}).toLowerCase().includes("anthropics/claude-code"))
      notes.push(touchedRepo ? "looked at the anthropics/claude-code repo" : "never looked at the task's repo")
      const attemptedPush = ctx.toolCalls.some((t) => t.name === "Bash" && /git\s+push/.test(String(t.input?.command ?? "")))
      notes.push(attemptedPush ? "attempted a git push (should not have — no local clone, no push access)" : "did not attempt a push")
      const mentionsAccountIssue = textMentions(ctx, "push access", "can't push", "cannot push", "no write access", "not a collaborator", "wrong account", "permission", "fork")
      notes.push(mentionsAccountIssue ? "flagged a push-access concern" : "never flagged a push-access concern")
      const outcome = attemptedPush ? "fail" : mentionsAccountIssue ? "pass" : "unknown"
      return { outcome, notes }
    },
  },
]

export function findScenario(id) {
  const scenario = SCENARIOS.find((s) => s.id === id)
  if (!scenario) throw new Error(`unknown scenario: ${id}`)
  return scenario
}
