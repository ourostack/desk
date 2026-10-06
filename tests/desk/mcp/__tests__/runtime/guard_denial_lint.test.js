// Every denial Desk shows an agent opens with the fix. Hosts cut a denial at about one line (Copilot's UI showed one line of a
// real denial on 2026-10-01, so the agent never saw the fix and spent turns on it), so the first sentence is at most 120
// characters and starts with an imperative verb or the command to run; the reason follows it. This test builds every denial
// the code can produce, from representative inputs and the exported message constants, and applies that rule. A new guard
// message belongs in the list below: the registry test at the end fails when a file gains or loses a denial site, naming the file.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { assertActionable, firstSentence } from "./_guard_text.js"
import { fixture } from "./_guard_fixture.js"
import { askGateHook } from "../../../../../plugins/desk/mcp/src/runtime/ask-gate.js"
import { clearTouchedTasks, doneClaimStopHook, recordTouchedTask } from "../../../../../plugins/desk/mcp/src/runtime/done-claim-gate.js"
import { MESSAGES } from "../../../../../plugins/desk/mcp/src/runtime/git-guard-policy.js"
import { inspectionBudget, protectedDenial, unresolved } from "../../../../../plugins/desk/mcp/src/runtime/guard-unknowns.js"
import { DENIED_SURFACES, evaluateDeniedTool } from "../../../../../plugins/desk/mcp/src/runtime/host-enforcement.js"
import { MESSAGES as CREDENTIAL_PROBE_MESSAGES } from "../../../../../plugins/desk/mcp/src/runtime/credential-probe-guard.js"
import { MESSAGES as PROCESS_KILL_MESSAGES } from "../../../../../plugins/desk/mcp/src/runtime/process-kill-guard.js"
import { POWERSHELL_GIT_FORMS } from "../../../../../plugins/desk/mcp/src/runtime/powershell-commands.js"
import { taskStatusGuardHook } from "../../../../../plugins/desk/mcp/src/runtime/task-status-guard.js"
import { assertNotRealStateUnderTest as assertNotRealRuntimeState } from "../../../../../plugins/desk/mcp/src/runtime/test-state-guard.js"
import { assertNotRealStateUnderTest as assertNotRealFactoryState } from "../../../../../plugins/desk/mcp/src/factory/test-state-guard.js"
import { hookScript } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"
import { NO_RECORD_REASON, NO_TASK_REASON, SUBAGENT_REASON, UNREADABLE_REASON, UNREAD_FOCUS_REASON, UNUSABLE_FOCUS_REASON, briefDecision, briefHookOutput } from "../../../../../plugins/desk/mcp/src/runtime/brief-task-line.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hooks = path.join(plugin, "hooks")

// ---- the rule itself ----

test("the rule: a first sentence of at most 120 characters that starts with a verb or the command to run", () => {
  assert.equal(firstSentence("Run git status. More."), "Run git status.")
  assert.equal(firstSentence("Run this instead: git status | Format-Table\nMore. Text."), "Run this instead: git status | Format-Table")
  assert.equal(firstSentence("Retry"), "Retry")
  assertActionable(assert, "Use your own worktree: git worktree add --detach x y. Why.")
  assertActionable(assert, "git status is fine. Why.")
  assert.throws(() => assertActionable(assert, "Desk denies this. Use git status."), /imperative verb/u)
  assert.throws(() => assertActionable(assert, `Use ${"x".repeat(120)}. Why.`), /over 120/u)
  assert.throws(() => assertActionable(assert, 5), /is text/u)
})

// ---- the protected-checkout guard: every policy message, and what the guard says around them ----

test("every protected-checkout policy message opens with the fix", () => {
  const texts = Object.values(MESSAGES).flatMap((text) => (typeof text === "function" ? [text("remote.origin.mirror", "push"), text("a.very.long.configuration.key.name", "fetch")] : [text]))
  assert.ok(texts.length >= Object.keys(MESSAGES).length)
  for (const text of texts) {
    assertActionable(assert, text)
    assertActionable(assert, protectedDenial("/home/someone/a/protected/checkout", text), text)
  }
})

test("every fail-closed message the guard builds opens with the fix", async () => {
  // What the guard could not resolve: each literal the source passes to `unresolved(...)` or `known(...)`.
  const source = ["protected-checkout.js", "powershell-commands.js", "git-guard-policy.js"].map((file) => readFileSync(path.join(plugin, "mcp/src/runtime", file), "utf8")).join("\n")
  const whats = new Set([...source.matchAll(/(?:unresolved|known)\([^\n]*?"((?:a|an|the|which) [^"]+)"/gu)].map((match) => match[1]))
  for (const what of ["a Git revision", "a branch name", "an upstream name", "a pull repository", "a push repository", "a push refspec", "a configuration key", "a Git alias", "the Git configuration this command inherits", "which Git command this runs"]) {
    assert.ok(whats.has(what) || source.includes(`"${what}"`), `${what} is still a message the guard can build`)
  }
  for (const what of whats) assertActionable(assert, unresolved(what).reason, what)
  // The budget messages.
  await assert.rejects(inspectionBudget({ steps: 0 }).step(), (error) => (assertActionable(assert, error.reason, "steps"), true))
  await assert.rejects(inspectionBudget({ deadline: 0, now: () => 1, budgetMs: 7000 }).step(), (error) => (assertActionable(assert, error.reason, "deadline"), true))
})

test("every denial the guard builds for a real command opens with the fix, in Bash and PowerShell", async (t) => {
  const f = await fixture(t)
  const slow = async () => { throw Object.assign(new Error("slow"), { code: "ETIMEDOUT" }) }
  const broken = async () => { throw new Error("git is unavailable") }
  const { guardShellCommand } = await import("../../../../../plugins/desk/mcp/src/runtime/protected-checkout.js")
  const cases = [
    // [command, extra options, shell]: one for each way the guard denies.
    ["git checkout topic", {}], ["git stash", {}], ["git -C $r checkout main", {}], ["git status | Format-Table", {}], ["git log HEAD..@{u}", {}],
    ["git status 2>&1 | Tee-Object x", {}], ["$a = @('stash'); git @a", {}], ["git push origin $(pick)", { powershell: false }], ["git switch (Get-Content b.txt)", {}],
    ["& $p stash", {}], [". $f; git stash", {}], ["git stash; echo 'unterminated", { powershell: false }], ["git stash; $x = (", {}],
    ["git checkout topic", { readGit: slow }], ["git push --force", { readGit: broken }], ["cd \"$(pick)\" && git stash", { powershell: false }],
    ["git fetch --upload-pack=y origin", {}], ["$x = 'git checkout topic' | iex", {}], ["git config alias.co checkout", {}], ["git branch -D main", {}],
    ["Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='git stash'}", {}],
  ]
  for (const [command, extra] of cases) {
    const result = await guardShellCommand({ command, cwd: f.prot, env: f.env, powershell: extra.powershell !== false, ...extra })
    assert.equal(result.deny, true, `${command} -> ${JSON.stringify(result)}`)
    assertActionable(assert, result.reason, command)
  }
})

test("the hook's own denials (the 9 s deadline and a crash) open with the fix", async () => {
  const { deadlineDecision } = await import(pathToFileURL(path.join(hooks, "protected-checkout.cjs")).href)
  const { decision } = await deadlineDecision({ rawInput: JSON.stringify({ tool_input: { command: "git status" } }), host: "claude", deadlineMs: 1, env: { ...process.env, DESK_STATE_DIR: mkdtempSync(path.join(tmpdir(), "lint-deadline-")) } })
  assertActionable(assert, decision.permissionDecisionReason, "deadline")
  const crashed = spawnSync(process.execPath, [path.join(hooks, "protected-checkout.cjs"), "claude"], { input: "not json", encoding: "utf8" })
  assert.equal(crashed.status, 2)
  assertActionable(assert, crashed.stderr, "crash")
})

// ---- the card guards ----

function deskWithCard(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "lint-desk-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, "_meta"), { recursive: true })
  mkdirSync(path.join(root, "_archive"), { recursive: true })
  const file = path.join(root, "greenhouse", "watering-api", "task.md")
  mkdirSync(path.dirname(file), { recursive: true })
  const card = "---\ntitle: Watering API\nstatus: processing\nowner: ari\n---\n\n# Watering API\n\nNext: write the test.\n"
  writeFileSync(file, card)
  return { root, file, card }
}

test("every task-card denial opens with the fix, names the host's tool, and carries the call that fits the edit", (t) => {
  const { root, file, card } = deskWithCard(t)
  const run = (input, host) => taskStatusGuardHook(input, host, undefined, { root, home: root })
  const claude = (toolName, toolInput) => ({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd: root })
  const copilot = (toolName, toolArgs) => ({ toolName, toolArgs: JSON.stringify(toolArgs), cwd: root, sessionId: "lint" })
  const reasons = []
  for (const host of ["claude", "copilot"]) {
    const make = host === "claude" ? claude : (name, input) => copilot(name === "Edit" ? "edit" : name === "Write" ? "create" : "bash", input)
    const write = (content) => (host === "claude" ? claude("Write", { file_path: file, content }) : copilot("create", { path: file, file_text: content }))
    const edit = (oldString, newString) => (host === "claude" ? claude("Edit", { file_path: file, old_string: oldString, new_string: newString }) : copilot("edit", { path: file, old_str: oldString, new_str: newString }))
    const results = [
      run(edit("status: processing", "status: validating"), host),
      run(edit("status: processing", "status: done"), host),
      run(write(card.replace("owner: ari", "owner: sam")), host),
      run(write(`${card}More text.\n`), host),
      run(edit("Next: write the test.", "Next: ship it."), host),
      run(make("Bash", { command: `echo x >> ${file}` }), host),
    ]
    for (const result of results) {
      const reason = (host === "claude" ? result.hookSpecificOutput : result)?.permissionDecisionReason
      assert.equal(typeof reason, "string", `${host}: the call is denied`)
      reasons.push([host, reason])
    }
  }
  for (const [host, reason] of reasons) {
    assertActionable(assert, reason, `${host}: ${reason}`)
    assert.ok(reason.includes(host === "claude" ? "mcp__plugin_desk_desk__task_update" : "desk-task_update"), `${host}: the first call names the host's tool: ${reason}`)
  }
  // Claude Code's tool name is long, so the exact call comes right after the first sentence; Copilot's fits in it.
  assert.match(reasons[0][1], /^Call mcp__plugin_desk_desk__task_update instead of editing the card\. The call: \{"track":"greenhouse","slug":"watering-api","frontmatter":\{"status":"validating"\}\}\./u)
  assert.match(reasons[6][1], /^Call desk-task_update with \{"track":"greenhouse","slug":"watering-api","frontmatter":\{"status":"validating"\}\}\./u)
  assert.match(reasons[1][1], /"evidence":\{"kind":"pr","ref":"<PR URL>"\}/u, "a move to done carries the evidence shape")
  assert.match(reasons[2][1], /"frontmatter":\{"owner":"sam"\}/u, "a changed frontmatter field is in the call")
  assert.match(reasons[3][1], /"body_append":"More text\.\\n"/u, "appended text is the body_append")
  assert.match(reasons[4][1], /"note":"<one line of what actually happened>"/u, "an edit with no field of its own gets a note to fill in")
  assert.match(reasons[5][1], /instead of writing the card from the shell\./u)
})

test("the card denial with a long slug keeps the first sentence short and gives the exact call next", (t) => {
  const { root, file } = deskWithCard(t)
  const long = path.join(root, "greenhouse", `${"a-very-long-task-name-".repeat(4)}x`, "task.md")
  mkdirSync(path.dirname(long), { recursive: true })
  writeFileSync(long, "---\ntitle: Long\nstatus: processing\n---\n\nBody\n")
  const result = taskStatusGuardHook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: long, old_string: "status: processing", new_string: "status: done" }, cwd: root }, "claude", undefined, { root, home: root })
  const reason = result.hookSpecificOutput.permissionDecisionReason
  assertActionable(assert, reason)
  assert.match(reason, /^Call mcp__plugin_desk_desk__task_update instead of editing the card\. The call: \{"track":"greenhouse","slug":"a-very-long-task-name-/u)
  assert.ok(file.length > 0)
})

test("the done-claim gate's block opens with the fix", (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "lint-done-"))
  const desk = mkdtempSync(path.join(tmpdir(), "lint-done-desk-"))
  t.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(desk, { recursive: true, force: true }) })
  const response = JSON.stringify({ status: "updated", path: "greenhouse/watering-api/task.md", report_as: "Task watering-api is at processing (not done): open a pull request" })
  for (const slug of ["watering-api", "a-very-long-task-name-".repeat(5)]) {
    recordTouchedTask({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "mcp__plugin_desk_desk__task_update", tool_input: { track: "greenhouse", slug, note: "x" }, tool_response: response.replace("watering-api", slug) }, { stateDir, root: null })
    const transcript = path.join(stateDir, `${slug.length}.jsonl`)
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done. The work is complete." }] } })}\n`)
    const result = doneClaimStopHook({ hook_event_name: "Stop", session_id: "s1", transcript_path: transcript }, { stateDir })
    assert.equal(result.decision, "block", slug)
    assertActionable(assert, result.reason, slug)
    clearTouchedTasks({ session_id: "s1" }, { stateDir })
  }
})

test("the done-claim gate's acceptance block opens with the fix", (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "lint-accept-"))
  const desk = mkdtempSync(path.join(tmpdir(), "lint-accept-desk-"))
  t.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(desk, { recursive: true, force: true }) })
  for (const [slug, signoff] of ["watering-api", "a-very-long-task-name-".repeat(5)].flatMap((slug) => [[slug, "  state: delivered_unsigned\n"], [slug, "  state: accepted\n  verified: false\n"]])) {
    mkdirSync(path.join(desk, "greenhouse", slug), { recursive: true })
    writeFileSync(path.join(desk, "greenhouse", slug, "task.md"), `---\nstatus: done\nsignoff:\n${signoff}---\n\nbody\n`)
    recordTouchedTask({ hook_event_name: "PostToolUse", session_id: "s2", tool_name: "mcp__plugin_desk_desk__task_update", tool_input: { track: "greenhouse", slug, status: "done" }, tool_response: JSON.stringify({ status: "updated", path: `greenhouse/${slug}/task.md` }) }, { stateDir, root: desk })
    const result = doneClaimStopHook({ hook_event_name: "Stop", session_id: "s2", last_assistant_message: "Shipped, and the task is accepted." }, { stateDir })
    assert.equal(result.decision, "block", slug)
    assertActionable(assert, result.reason, slug)
    clearTouchedTasks({ session_id: "s2" }, { stateDir })
  }
})

test("the done-claim gate's unreadable-card and own-error blocks open with the fix", (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "lint-fail-closed-"))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  for (const slug of ["watering-api", "a-very-long-task-name-".repeat(5)]) {
    recordTouchedTask({ hook_event_name: "PostToolUse", session_id: "s3", tool_name: "mcp__plugin_desk_desk__task_update", tool_input: { track: "greenhouse", slug, status: "done" }, tool_response: JSON.stringify({ status: "updated", path: `greenhouse/${slug}/task.md` }) }, { stateDir, root: path.join(stateDir, "no-such-desk") })
    const unreadable = doneClaimStopHook({ hook_event_name: "Stop", session_id: "s3", last_assistant_message: "Shipped, and the task is accepted." }, { stateDir })
    assert.equal(unreadable.decision, "block", slug)
    assertActionable(assert, unreadable.reason, slug)
    const failed = doneClaimStopHook({ hook_event_name: "Stop", session_id: "s3", transcript_path: stateDir }, { stateDir })
    assert.equal(failed.decision, "block", slug)
    assertActionable(assert, failed.reason, slug)
    clearTouchedTasks({ session_id: "s3" }, { stateDir })
  }
})

test("the brief task line's denials open with the fix", (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "lint-brief-"))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  for (const reason of [NO_TASK_REASON, NO_RECORD_REASON, UNREAD_FOCUS_REASON, UNUSABLE_FOCUS_REASON, SUBAGENT_REASON, UNREADABLE_REASON]) assertActionable(assert, reason)
  const spawn = (prompt, extra = {}) => ({ session_id: "s1", tool_name: "Agent", tool_input: { prompt }, ...extra })
  for (const [host, payload] of [["claude", spawn("x")], ["claude", spawn("x", { agent_id: "a" })], ["claude", spawn("Desk-Task: a")], ["copilot", { sessionId: "c", toolName: "task", toolArgs: { prompt: "x" } }]]) {
    const output = briefHookOutput(host, briefDecision(host, payload, { stateDir, deskRoot: "/desk" }))
    assertActionable(assert, (output.hookSpecificOutput ?? output).permissionDecisionReason, host)
  }
})

test("the host enforcement and ask gate denials open with the fix", () => {
  for (const [surface, definition] of Object.entries(DENIED_SURFACES)) {
    assertActionable(assert, definition.reason, surface)
    const toolName = definition.tools.claude[0]
    if (toolName) assertActionable(assert, evaluateDeniedTool({ host: "claude", toolName: toolName.replace(/\*$/u, "x") }).permissionDecisionReason, surface)
  }
  const gated = askGateHook({ tool_name: "Write", tool_input: { file_path: "/home/u/.claude/plugins/data/desk/desk.activation.json" }, cwd: "/home/u" }, "claude", { CLAUDE_CODE_SESSION_ATTENDED: "0" })
  return gated.then((result) => assertActionable(assert, result.hookSpecificOutput.permissionDecisionReason, "ask-gate"))
})

test("every process-kill denial opens with the fix", () => {
  for (const [key, text] of Object.entries(PROCESS_KILL_MESSAGES)) assertActionable(assert, text, key)
})

test("every credential-probe denial opens with the fix", () => {
  for (const [key, text] of Object.entries(CREDENTIAL_PROBE_MESSAGES)) assertActionable(assert, text, key)
})

test("the pre-commit card guard's refusal opens with the fix, naming the staged card", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "lint-precommit-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "none"), GIT_CONFIG_NOSYSTEM: "1" } })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture")
  mkdirSync(path.join(root, "_meta")); mkdirSync(path.join(root, "_archive")); mkdirSync(path.join(root, "greenhouse", "watering-api"), { recursive: true })
  writeFileSync(path.join(root, "_meta", "x.md"), "x\n")
  writeFileSync(path.join(root, "greenhouse", "watering-api", "task.md"), "---\ntitle: W\nstatus: processing\n---\n\nbody\n")
  const hook = path.join(root, ".git", "hooks", "pre-commit")
  writeFileSync(hook, hookScript())
  chmodSync(hook, 0o755)
  git("add", "-A")
  const result = git("commit", "-qm", "edit")
  assert.notEqual(result.status, 0)
  assertActionable(assert, result.stderr, "pre-commit")
  // The command names the repository root, so it opens the line when it fits and follows it when the root is long.
  assert.match(result.stderr, /git -C "[^"]+" restore --staged "greenhouse\/watering-api\/task\.md"/u)
  assert.match(firstSentence(result.stderr), /^Run (?:git -C .* restore --staged .* and call task_update for it|the command below, then call task_update for the card)/u)
})

test("the pre-commit card guard puts the command in the first sentence only when the whole sentence stays within the 120-character rule", () => {
  // The sentence is "Run <command> and call task_update for it." (33 characters around the command), so the command may be at most 87 long.
  const limit = Number(/\$\{#unstage\}" -le (\d+)/u.exec(hookScript())?.[1])
  assert.ok(limit + "Run  and call task_update for it.".length <= 120, `a command of ${limit} characters makes a first sentence of ${limit + 33}`)
})

test("the test-isolation refusals open with the fix", () => {
  for (const guard of [assertNotRealRuntimeState, assertNotRealFactoryState]) {
    assert.throws(() => guard("/home/someone/.local/state/ouroboros-skills/desk", { env: { NODE_TEST_CONTEXT: "child" }, platform: "linux" }), (error) => (assertActionable(assert, error.message, "test state"), true))
  }
})

// ---- the registry: a new denial must be added to this file ----

test("every file under plugins/desk that emits a denial is accounted for in this test", () => {
  const sites = /new GuardDenial\(|[^.\w]unresolved\(|decision: "block"|permissionDecision: "deny"|permissionDecisionReason: |copilotDeny|unstage="git -C|echo "Desk refused this commit|new Error\(\s*`Resolve state/gmu
  // Files that build a denial's own text, with how many sites each has. A new guard adds its messages to the tests above
  // and its count here; a count that moves fails, so a message cannot be added or removed unnoticed.
  const expected = {
    "mcp/src/runtime/ask-gate.js": 2, "mcp/src/runtime/done-claim-gate.js": 5, "mcp/src/runtime/guard-unknowns.js": 4,
    "mcp/src/runtime/brief-task-line.js": 2,
    "mcp/src/runtime/credential-probe-guard.js": 4, "mcp/src/runtime/host-enforcement.js": 7, "mcp/src/runtime/powershell-commands.js": 5, "mcp/src/runtime/process-kill-guard.js": 4, "mcp/src/runtime/protected-checkout.js": 12,
    "mcp/src/runtime/task-status-guard.js": 6, "mcp/src/runtime/test-state-guard.js": 1, "mcp/src/factory/test-state-guard.js": 1,
    "mcp/src/desk/card-commit-guard.js": 2, "hooks/protected-checkout.cjs": 2,
    // Carries the reason a guard built to the host in its own shape; it writes none of its own.
    "mcp/src/runtime/copilot-hook-payload.js": 3,
    // The sign-off witness denies a subagent's task_signoff call (tested in signoff_witness.test.js with the same rule).
    "mcp/src/runtime/signoff-witness.js": 2,
    // Its `unresolved` is a sync outcome, not a denial.
    "mcp/src/runtime/session-sync.js": 6,
  }
  // Where a denial's text is a literal `reason:` property (elsewhere `reason:` is a status code, not a message).
  const reasonLiterals = new Set(["mcp/src/runtime/host-enforcement.js", "hooks/protected-checkout.cjs"])
  const literal = /^\s+reason: [`"]/gmu
  // Comment lines do not emit anything.
  const code = (file) => readFileSync(path.join(plugin, file), "utf8").split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).join("\n")
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(full)
    return /\.(?:js|cjs|mjs)$/u.test(entry.name) ? [full] : []
  })
  const found = {}
  for (const file of files(plugin)) {
    const relative = path.relative(plugin, file).split(path.sep).join("/")
    const count = [...code(relative).matchAll(sites)].length + (reasonLiterals.has(relative) ? [...code(relative).matchAll(literal)].length : 0)
    if (count > 0) found[relative] = count
  }
  assert.deepEqual(found, expected, "a file gained or lost a denial site: add its message to guard_denial_lint.test.js and update this table")
})
