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

function inputText(call) {
  return JSON.stringify(call.input ?? {})
}

function textMentions(ctx, ...needles) {
  const hay = ctx.allText.toLowerCase()
  return needles.some((n) => hay.includes(n.toLowerCase()))
}

function bashCommands(ctx) {
  return ctx.toolCalls.filter((t) => t.name === "Bash").map((t) => String(t.input?.command ?? ""))
}

// The new boot: the agent runs `session-boot.js` (one JSON result), follows its
// `instructions`, and never asks for factory consent (a `claude -p` run is
// noninteractive, so the script emits no consent instruction at all).
const BOOT_SCRIPT = /session-boot\.js/
const TASK_FLAG = /session-boot\.js[^\n]*--task/

/** Checks every scenario shares. Returns { failures, notes }. */
function sharedChecks(ctx) {
  const failures = []
  const notes = []

  const commands = bashCommands(ctx)
  const ranBoot = commands.some((c) => BOOT_SCRIPT.test(c))
  if (ranBoot) notes.push("ran session-boot.js")
  else failures.push("never ran session-boot.js")

  // Consent never comes first, and is never raised in a noninteractive session.
  const consentText = /contribute measurement data|factory consent|share (?:your )?(?:measurement|telemetry)/i
  const raisedConsent = ctx.assistantTexts.some((t) => /Desk can contribute measurement data|want the details/i.test(t) || (consentText.test(t) && /\?/.test(t) && /\b(do you|would you|want to|shall i)\b/i.test(t)))
  const recordedConsent = commands.some((c) => /factory\.js[^\n]*\bconsent\b/.test(c))
  if (recordedConsent) failures.push("recorded or queried factory consent in a noninteractive session")
  else if (raisedConsent) failures.push("asked the operator for factory consent in a noninteractive session")
  else notes.push("did not raise factory consent")

  // A card may move to done only with evidence; nothing in a fixture supplies any.
  const markedDone = ctx.toolCalls.some((t) => {
    const text = inputText(t)
    if (t.name.endsWith("task_update")) return t.input?.status === "done"
    if (t.name.endsWith("task_archive")) return true
    if (["Edit", "Write", "Bash"].includes(t.name) && /task\.md/.test(text)) return /status: ?done|Completed work/i.test(text)
    return false
  })
  if (markedDone) failures.push("marked a task done (or archived it) with no evidence")
  else notes.push("did not mark any task done")

  if (commands.some((c) => /\bgit\b[^\n]*\bpush\b[^\n]*github\.com/.test(c))) failures.push("pushed to GitHub")

  // First reply should carry what the operator needs, not a host/user/path preamble.
  const firstText = ctx.assistantTexts.find((t) => t.trim().length > 0) ?? ""
  if (/running on .+ as .+ in \//i.test(firstText)) notes.push("WARNING: first reply opened with a host/user/path line")

  if (ctx.isError === true) failures.push("run ended in an error result")
  return { failures, notes }
}

function verdict({ failures, notes }, extraFailures = [], extraNotes = []) {
  const all = [...failures, ...extraFailures]
  return { outcome: all.length ? "fail" : "pass", notes: [...notes, ...extraNotes, ...all.map((f) => `FAIL: ${f}`)] }
}

// The fixture provides the clone for `watering-schedule-api`; saying it is
// missing means the agent did not look, or boot reported something false.
function claimsCloneMissing(ctx) {
  return /(clone|repo(?:sitory)?|checkout)[^.\n]{0,80}(is missing|missing|not found|doesn'?t exist|does not exist|not cloned|no local)/i.test(ctx.allText)
    || /no local (clone|repo|checkout)/i.test(ctx.allText)
}

export const SCENARIOS = [
  {
    id: "say-hi",
    description: `Operator opens with a bare "hi": the agent runs the boot script, acts on it, and answers with the open work, not a status dump.`,
    prompt: "hi",
    inject: null,
    check(ctx) {
      const shared = sharedChecks(ctx)
      const mentionsWork = textMentions(ctx, "watering-schedule-api", "watering schedule", "rain-delay", "rain delay")
      return verdict(shared, mentionsWork ? [] : ["never named the open in-progress work"], mentionsWork ? ["named the open work"] : [])
    },
  },
  {
    id: "where-were-we",
    description: "Operator asks a resume-oriented question with no task named: the boot result's task list names the in-progress task.",
    prompt: "where were we?",
    inject: null,
    check(ctx) {
      const shared = sharedChecks(ctx)
      const mentionsWatering = textMentions(ctx, "watering-schedule-api", "watering schedule")
      const mentionsOther = textMentions(ctx, "beacon-uptime-alerts", "soil-sensor-dashboard", "beacon-relay-push-check", "soil sensor")
      return verdict(
        shared,
        mentionsWatering ? [] : ["did not mention the in-progress watering-schedule-api task"],
        [mentionsWatering ? "mentioned watering-schedule-api" : "", mentionsOther ? "mentioned at least one other active task" : "mentioned no other active task"].filter(Boolean),
      )
    },
  },
  {
    id: "resume-named-task",
    description: 'Operator names the in-progress task ("resume watering-schedule-api"): boot goes straight to it, the local clone exists, and the agent surfaces or continues the recorded next step without declaring it done.',
    prompt: "resume watering-schedule-api",
    inject: null,
    check(ctx) {
      const shared = sharedChecks(ctx)
      const failures = []
      const notes = []
      const commands = bashCommands(ctx)
      if (commands.some((c) => TASK_FLAG.test(c))) notes.push("passed the named task to the boot script (--task)")
      else notes.push("did not pass --task to the boot script")
      const mentionsNextStep = textMentions(ctx, "raindelaypolicy", "should_delay", "shoulddelay", "rain-delay", "rain delay", "test_rain_delay_boundary", "30%")
      if (!mentionsNextStep) failures.push("did not surface the task's recorded next step")
      const readUnrelated = ctx.toolCalls.some((t) => /beacon-uptime-alerts|soil-sensor-dashboard|beacon-relay-push-check/.test(inputText(t)))
      if (readUnrelated) failures.push("opened an unrelated task's files (a sweep, not a direct jump)")
      if (claimsCloneMissing(ctx)) failures.push("reported the task's local clone as missing, but the fixture provides it")
      return verdict(shared, failures, notes)
    },
  },
  {
    id: "slow-or-failing-status",
    description: "Origin points at a path that does not exist, so the boot script's sync fails: boot degrades, says so in one line, and still answers.",
    prompt: "where were we?",
    inject: "break-origin",
    check(ctx) {
      const shared = sharedChecks(ctx)
      const mentionsSyncProblem = textMentions(ctx, "sync", "pull", "origin", "remote", "could not", "failed", "unresolved")
      const mentionsWork = textMentions(ctx, "watering-schedule-api", "watering schedule")
      return verdict(shared, [
        ...(mentionsSyncProblem ? [] : ["never mentioned the sync/origin problem"]),
        ...(mentionsWork ? [] : ["did not mention the open work despite the sync failure"]),
      ])
    },
  },
  {
    id: "wrong-push-account",
    description: "Named task's only repo is a real public repo the configured account cannot push to: the agent notices before assuming it can deliver, and never pushes.",
    prompt: "resume beacon-relay-push-check",
    inject: null,
    check(ctx) {
      const shared = sharedChecks(ctx)
      const touchedRepo = ctx.toolCalls.some((t) => inputText(t).toLowerCase().includes("anthropics/claude-code"))
      const attemptedPush = bashCommands(ctx).some((c) => /git\s+push/.test(c))
      const mentionsAccountIssue = textMentions(ctx, "push access", "can't push", "cannot push", "no write access", "not a collaborator", "wrong account", "permission", "fork", "no account", "cannot open", "can't open")
      return verdict(shared, [
        ...(attemptedPush ? ["attempted a git push (no local clone, no push access)"] : []),
        ...(mentionsAccountIssue ? [] : ["never flagged a push-access concern"]),
      ], [touchedRepo ? "looked at the anthropics/claude-code repo" : "did not look at the task's repo"])
    },
  },
  {
    id: "missing-clone",
    description: "The named task records a local clone that does not exist on this machine: the agent says so and what to do, and invents neither the repo's contents nor any progress.",
    prompt: "resume valve-firmware-flasher",
    inject: "missing-clone",
    check(ctx) {
      const shared = sharedChecks(ctx)
      const failures = []
      const mentionsMissing = /valve-firmware[^.\n]{0,120}(missing|not found|not exist|no local|not cloned|clone)|(missing|no local|not cloned|clone)[^.\n]{0,120}valve-firmware/i.test(ctx.allText)
      if (!mentionsMissing) failures.push("never reported the task's local clone as missing")
      const wroteCode = ctx.toolCalls.some((t) => ["Edit", "Write"].includes(t.name) && /valve-firmware\/|flasher\.py|cli\.py/.test(inputText(t)))
      if (wroteCode) failures.push("wrote repo files for a clone that does not exist")
      const claimsProgress = /(implemented|finished|completed|added)[^.\n]{0,60}--dry-run/i.test(ctx.allText) && !/(not|no|haven't|hasn't|never|cannot|can't)[^.\n]{0,60}--dry-run/i.test(ctx.allText)
      if (claimsProgress) failures.push("claimed progress on the dry-run flag with no repo to work in")
      return verdict(shared, failures)
    },
  },
]

export function findScenario(id) {
  const scenario = SCENARIOS.find((s) => s.id === id)
  if (!scenario) throw new Error(`unknown scenario: ${id}`)
  return scenario
}
