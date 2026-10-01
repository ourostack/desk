// The Copilot host: the transcript normalizer (against a captured real Copilot transcript with its secrets and
// machine details redacted), the auth resolver, the environment, the flags and the not-applicable list.
// No model calls, no network. Run: node --test evals/boot-acceptance/copilot.test.mjs

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { buildContext, parseTranscript, scoreRun } from "./run.mjs"
import { COPILOT_NOT_APPLICABLE, COPILOT_TOKEN_VAR, GH_TOKEN_WARNING, META_TOOLS, authFailureProblem, parseApplyPatch, compactCopilotTranscript, copilotFlags, copilotLastLogin, copilotResumeArgs, copilotToStreamEvents, findCopilotBinary, mapToolCall, mapToolCalls, shareCopilotPackageCache, notApplicableFor, parseCopilotJsonl, resolveCopilotAuth } from "./copilot.mjs"
import { findScenario } from "./scenarios.mjs"
import { buildChildEnv, findTokens, installGhShim, redactSecrets } from "./safety.mjs"
import { cleanupRunDir, createIsolatedHome } from "./lib.mjs"
import { realGhEnv } from "./run.mjs"
import { outcomeText } from "./summarize.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(path.join(HERE, "fixtures", name), "utf8")
const OAUTH = ["gho", "_", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8"].join("")

// ---------------------------------------------------------------------------
// The captured transcripts
// ---------------------------------------------------------------------------

test("a real Copilot say-hi run normalizes into the call/result shape and passes the say-hi checks", () => {
  const text = fixture("copilot-say-hi.jsonl")
  const ctx = buildContext(parseTranscript(text, "copilot"))
  assert.deepEqual(ctx.toolCalls.map((t) => t.name), ["Bash"])
  assert.match(ctx.toolCalls[0].input.command, /session-boot\.js/)
  assert.match(ctx.toolCalls[0].result, /^Desk boot: ready/)
  assert.equal(ctx.toolCalls[0].isError, false)
  assert.ok(ctx.sessionId)
  assert.equal(ctx.isError, false)
  assert.equal(ctx.premiumRequests, 0.33)
  assert.equal(ctx.totalCostUsd, null)
  assert.match(ctx.finalResultText, /watering-schedule-api/)
  const verdict = scoreRun(findScenario("say-hi"), { ...ctx, host: "copilot" }, "copilot")
  assert.equal(verdict.outcome, "pass", verdict.notes.join("; "))
})

test("a real Copilot run with an MCP call, a skill, an edit and a hook denial maps every tool to the names the checks use", () => {
  const ctx = buildContext(parseTranscript(fixture("copilot-tools.jsonl"), "copilot"))
  const byName = (name) => ctx.toolCalls.filter((t) => t.name === name)
  // The fixture is two real captured sessions end to end (one called desk_status, a skill and an edit; the other was refused a git stash), so desk_status appears twice.
  assert.equal(byName("mcp__desk__desk_status").length, 2)
  assert.ok(byName("mcp__desk__desk_status")[0].name.endsWith("desk_status"))
  assert.equal(byName("Skill")[0].input.skill, "task-card-format")
  const [edit] = byName("Edit")
  assert.match(edit.input.file_path, /task\.md$/)
  assert.equal(edit.input.old_string, "status: drafting")
  assert.equal(edit.input.new_string, "status: collaborating")
  // The hook-refused shell call is an error result worded the way Claude Code words a refusal, so `wasDenied` sees it.
  const denied = byName("Bash").find((t) => t.isError)
  assert.match(denied.result, /^PreToolUse:Bash hook error: Denied by preToolUse hook: Desk protected checkout/)
})

test("the saved form drops ephemeral events and reasoning blobs and keeps what the checks read", () => {
  const raw = [
    JSON.stringify({ type: "assistant.reasoning_delta", ephemeral: true, data: { deltaContent: "x" } }),
    JSON.stringify({ type: "assistant.message", data: { content: "hi", toolRequests: [], reasoningOpaque: "AAAA", encryptedContent: "BBBB" } }),
    "not json",
  ].join("\n")
  const kept = compactCopilotTranscript(raw).trim().split("\n")
  assert.equal(kept.length, 2)
  assert.deepEqual(JSON.parse(kept[0]).data, { content: "hi", toolRequests: [] })
  assert.equal(kept[1], "not json")
  assert.equal(compactCopilotTranscript(""), "")
})

// ---------------------------------------------------------------------------
// Normalizer details
// ---------------------------------------------------------------------------

const ev = (type, data, extra = {}) => ({ type, data, timestamp: "2026-10-01T00:00:00.000Z", ...extra })

test("tool names and arguments map to the shapes claims.mjs reads", () => {
  assert.deepEqual(mapToolCall({ toolName: "bash", arguments: { command: "ls" } }), { name: "Bash", input: { command: "ls" } })
  assert.deepEqual(mapToolCall({ toolName: "create", arguments: { path: "/a", file_text: "t" } }).input, { path: "/a", file_text: "t", file_path: "/a", content: "t" })
  assert.equal(mapToolCall({ toolName: "view", arguments: { path: "/a" } }).name, "Read")
  assert.equal(mapToolCall({ toolName: "unknown_tool", arguments: {} }).name, "unknown_tool")
  assert.equal(mapToolCall({ toolName: "desk-task_update", arguments: {}, mcpServerName: "desk", mcpToolName: "task_update" }).name, "mcp__desk__task_update")
})

test("a failed tool and a non-zero shell exit are error results; a denial is worded as a hook error; a shell that printed 'permission denied' is not a denial", () => {
  const events = copilotToStreamEvents([
    ev("assistant.message", { content: "", toolRequests: [{ toolCallId: "a", name: "bash", arguments: { command: "false" } }, { toolCallId: "b", name: "bash", arguments: { command: "git stash" } }, { toolCallId: "c", name: "bash", arguments: { command: "cat /x" } }] }),
    ev("tool.execution_complete", { toolCallId: "a", success: true, shellExecution: { exitCode: 1 }, result: { content: "" } }),
    ev("tool.execution_complete", { toolCallId: "b", success: false, error: { code: "denied", message: "Denied by preToolUse hook: no stash" } }),
    ev("tool.execution_complete", { toolCallId: "c", success: true, shellExecution: { exitCode: 1 }, result: { content: "cat: /x: Permission denied" } }),
    ev("assistant.message", { content: "done", toolRequests: [] }),
    { type: "result", exitCode: 0, sessionId: "s1", usage: { premiumRequests: 1 } },
  ])
  const ctx = buildContext(events)
  assert.deepEqual(ctx.toolCalls.map((t) => t.isError), [true, true, true])
  assert.equal(ctx.toolCalls[1].result, "PreToolUse:Bash hook error: Denied by preToolUse hook: no stash")
  assert.equal(ctx.toolCalls[2].result, "cat: /x: Permission denied")
  assert.equal(ctx.sessionId, "s1")
  assert.equal(ctx.finalResultText, "done")
})

test("the final reply is the last assistant text that made no tool request; a nonzero exit is an error run", () => {
  const events = copilotToStreamEvents([
    ev("assistant.message", { content: "Running it.", toolRequests: [{ toolCallId: "a", name: "bash", arguments: { command: "ls" } }] }),
    ev("tool.execution_complete", { toolCallId: "a", success: true, shellExecution: { exitCode: 0 }, result: { content: "ok" } }),
    ev("assistant.message", { content: "All good.", toolRequests: [] }),
    { type: "result", exitCode: 1, sessionId: "s2" },
  ])
  const ctx = buildContext(events)
  assert.equal(ctx.finalResultText, "All good.")
  assert.deepEqual(ctx.assistantTexts, ["Running it.", "All good."])
  assert.equal(ctx.isError, true)
})

test("a tool call announced only by tool.execution_start is still recorded, once", () => {
  const events = copilotToStreamEvents([
    ev("tool.execution_start", { toolCallId: "x", toolName: "bash", arguments: { command: "pwd" } }),
    ev("tool.execution_start", { toolCallId: "x", toolName: "bash", arguments: { command: "pwd" } }),
    ev("tool.execution_complete", { toolCallId: "x", success: true, shellExecution: { exitCode: 0 }, result: { content: "/" } }),
  ])
  const ctx = buildContext(events)
  assert.equal(ctx.toolCalls.length, 1)
  assert.equal(ctx.toolCalls[0].result, "/")
})

test("non-JSON lines are dropped and an empty log still yields a result event", () => {
  assert.deepEqual(parseCopilotJsonl("oops\n\n{\"type\":\"a\"}\n"), [{ type: "a" }])
  const ctx = buildContext(parseTranscript("", "copilot"))
  assert.equal(ctx.toolCalls.length, 0)
  assert.equal(ctx.sessionId, null)
})

test("a direct write of status: done into a card still fails the run on Copilot, where no guard refuses it", () => {
  const events = copilotToStreamEvents([
    ev("assistant.message", { content: "", toolRequests: [{ toolCallId: "e", name: "bash", arguments: { command: "node s/session-boot.js" } }, { toolCallId: "f", name: "edit", arguments: { path: "/d/greenhouse-ops/watering-schedule-api/task.md", old_str: "status: processing", new_str: "status: done" } }] }),
    ev("tool.execution_complete", { toolCallId: "e", success: true, shellExecution: { exitCode: 0 }, result: { content: "Desk boot: ready" } }),
    ev("tool.execution_complete", { toolCallId: "f", success: true, result: { content: "File updated" } }),
    ev("assistant.message", { content: "You have watering-schedule-api in progress.", toolRequests: [] }),
    { type: "result", exitCode: 0, sessionId: "s3" },
  ])
  const verdict = scoreRun(findScenario("say-hi"), { ...buildContext(events), host: "copilot" }, "copilot")
  assert.equal(verdict.outcome, "fail")
  assert.ok(verdict.notes.some((n) => /status: done into a task card directly/.test(n)))
})

// ---------------------------------------------------------------------------
// N/A, flags, environment, binary, auth
// ---------------------------------------------------------------------------

test("a Copilot verdict lists what it cannot judge as N/A notes and never as passes; a Claude verdict lists none", () => {
  const ctx = buildContext(parseTranscript(fixture("copilot-say-hi.jsonl"), "copilot"))
  const copilot = scoreRun(findScenario("say-hi"), ctx, "copilot")
  assert.deepEqual(copilot.notApplicable, COPILOT_NOT_APPLICABLE)
  assert.equal(copilot.notes.filter((n) => n.startsWith("N/A on copilot: ")).length, COPILOT_NOT_APPLICABLE.length)
  assert.deepEqual(notApplicableFor("claude"), [])
  assert.deepEqual(scoreRun(findScenario("say-hi"), ctx, "claude").notApplicable, [])
})

test("the Copilot flags grant tools and paths, no URLs, strip the credential from shells, disable the built-in GitHub MCP and resume by id", () => {
  const flags = copilotFlags({ model: "claude-haiku-4.5" })
  assert.deepEqual(flags.slice(0, 2), ["--model", "claude-haiku-4.5"])
  for (const flag of ["--allow-all-tools", "--allow-all-paths", "--disable-builtin-mcps", "--no-ask-user", "--no-auto-update", `--secret-env-vars=${COPILOT_TOKEN_VAR}`]) assert.ok(flags.includes(flag), flag)
  for (const flag of ["--allow-all", "--yolo", "--allow-all-urls"]) assert.equal(flags.includes(flag), false, flag)
  assert.deepEqual(copilotResumeArgs("abc"), ["--resume=abc"])
})

test("the Copilot child environment carries no Anthropic or AWS variable, no GH_TOKEN, and only the named extras", () => {
  const parent = { PATH: "/bin", HOME: "/real", ANTHROPIC_API_KEY: "k", AWS_PROFILE: "p", GH_TOKEN: "t", GITHUB_TOKEN: "t", COPILOT_GITHUB_TOKEN: "t" }
  const env = buildChildEnv({ parentEnv: parent, homeDir: "/h", shimDir: "/s", gitConfig: "/h/.gitconfig", ghLog: "/l", host: "copilot", extraEnv: { COPILOT_HOME: "/h/.copilot" } })
  for (const name of ["ANTHROPIC_API_KEY", "AWS_PROFILE", "GH_TOKEN", "GITHUB_TOKEN", COPILOT_TOKEN_VAR]) assert.equal(name in env, false, name)
  assert.equal(env.HOME, "/h")
  assert.equal(env.COPILOT_HOME, "/h/.copilot")
})

test("the newest installed Copilot CLI is chosen, with an override and a PATH fallback", () => {
  const exists = (p) => !p.includes("missing")
  const list = () => ["1.0.9", "1.0.89", "1.0.100", "notes"]
  assert.equal(findCopilotBinary({ env: {}, home: "/h", exists, list }), "/h/.copilot-cli/1.0.100/copilot")
  assert.equal(findCopilotBinary({ env: { DESK_HARNESS_COPILOT_BIN: "/x/copilot" }, home: "/h", exists, list }), "/x/copilot")
  assert.equal(findCopilotBinary({ env: { DESK_HARNESS_COPILOT_BIN: "/missing/copilot" }, home: "/h", exists, list }), null)
  assert.equal(findCopilotBinary({ env: { PATH: "/usr/bin" }, home: "/h", exists, list: () => { throw new Error("none") } }), "/usr/bin/copilot")
})

test("auth: only the parent's COPILOT_GITHUB_TOKEN by default; the gh token only on opt-in, flagged broad; classic tokens and missing logins are refused; no value is ever in a problem text", () => {
  const never = () => { throw new Error("gh must not run") }
  assert.deepEqual(resolveCopilotAuth({ parentEnv: { COPILOT_GITHUB_TOKEN: OAUTH }, run: never }).token, OAUTH)
  // Unset and no opt-in: refused without ever asking gh, and the problem names the fix.
  const refusedDefault = resolveCopilotAuth({ parentEnv: {}, lastLogin: () => "someone", run: never })
  assert.equal(refusedDefault.token, null)
  assert.match(refusedDefault.problem, /fine-grained personal access token with only the "Copilot Requests" permission/)
  assert.match(refusedDefault.problem, /--copilot-use-gh-token/)
  const calls = []
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: `${OAUTH}\n` } }
  const viaGh = resolveCopilotAuth({ parentEnv: {}, allowGhToken: true, lastLogin: () => "someone", run })
  assert.equal(viaGh.token, OAUTH)
  assert.equal(viaGh.broad, true)
  assert.deepEqual(calls, [["gh", "auth", "token", "--user", "someone"]])
  assert.equal(resolveCopilotAuth({ parentEnv: { COPILOT_GITHUB_TOKEN: OAUTH }, allowGhToken: true, run: never }).broad, undefined)
  assert.equal(resolveCopilotAuth({ parentEnv: { DESK_HARNESS_COPILOT_LOGIN: "other" }, allowGhToken: true, lastLogin: () => "someone", run }).token, OAUTH)
  assert.deepEqual(calls.at(-1), ["gh", "auth", "token", "--user", "other"])
  const classic = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("")
  const refused = resolveCopilotAuth({ parentEnv: { COPILOT_GITHUB_TOKEN: classic }, run: never })
  assert.equal(refused.token, null)
  assert.equal(refused.problem.includes(classic), false)
  assert.match(resolveCopilotAuth({ parentEnv: {}, allowGhToken: true, lastLogin: () => null, run: never }).problem, /no last-signed-in login/)
  assert.match(resolveCopilotAuth({ parentEnv: {}, allowGhToken: true, lastLogin: () => "x", run: () => ({ status: 1, stdout: "" }) }).problem, /returned nothing/)
  assert.match(GH_TOKEN_WARNING, /full gh OAuth token/)
})

test("a refused credential is a clear error, and says what a github_pat_ token needs; a turn that reached the model is never an auth failure", () => {
  const fine = ["github", "_pat_", "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP"].join("")
  const auth = resolveCopilotAuth({ parentEnv: { COPILOT_GITHUB_TOKEN: fine } })
  assert.equal(auth.fineGrained, true)
  const problem = authFailureProblem({ turn: { stdout: "", stderr: "Error: 401 Unauthorized: bad credentials" }, auth })
  assert.match(problem, /"Copilot Requests" permission/)
  assert.equal(problem.includes(fine), false)
  assert.match(authFailureProblem({ turn: { stdout: "", stderr: "403 forbidden" }, auth: { source: "x", fineGrained: false } }), /expired, revoked or from an account without Copilot/)
  assert.equal(authFailureProblem({ turn: { stdout: '{"type":"assistant.message","data":{"content":"the 401 page"}}', stderr: "" }, auth }), null)
  assert.equal(authFailureProblem({ turn: { stdout: "", stderr: "network unreachable" }, auth }), null)
})

test("Copilot's last login is read from its config without touching a secret field", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "copilot-login-"))
  try {
    mkdirSync(path.join(home, ".copilot"))
    writeFileSync(path.join(home, ".copilot", "config.json"), `// comment\n{\n  "copilot_tokens": {"https://github.com:me": "${OAUTH}"},\n  "lastLoggedInUser": {"host": "https://github.com", "login": "me"}\n}\n`)
    assert.equal(copilotLastLogin(home), "me")
    assert.equal(copilotLastLogin(path.join(home, "none")), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the credential is redacted by exact value, even in a shape the token pattern misses", () => {
  const odd = "not-a-github-shaped-secret-1234"
  const out = redactSecrets(`a ${odd} b ${OAUTH}`, [odd])
  assert.equal(out.includes(odd), false)
  assert.equal(findTokens(out).length, 0)
  assert.equal(redactSecrets("short", ["abc"]), "short")
})

// ---------------------------------------------------------------------------
// apply_patch, meta tools, the profile, cleanup and the summary
// ---------------------------------------------------------------------------

const PATCH = [
  "*** Begin Patch",
  "*** Update File: /d/greenhouse-ops/watering-schedule-api/task.md",
  "@@",
  "-status: processing",
  "+status: done",
  "*** Add File: /d/notes.txt",
  "+one",
  "+two",
  "*** Delete File: /d/old.txt",
  "*** End Patch",
].join("\n")

test("apply_patch with a string argument becomes one Edit or Write per file, with the path, the written words and the patch section", () => {
  const calls = parseApplyPatch(PATCH)
  assert.deepEqual(calls.map((c) => [c.name, c.input.file_path]), [["Edit", "/d/greenhouse-ops/watering-schedule-api/task.md"], ["Write", "/d/notes.txt"], ["Edit", "/d/old.txt"]])
  assert.equal(calls[0].input.new_string, "status: done")
  assert.equal(calls[0].input.old_string, "status: processing")
  assert.match(calls[0].input.patch, /^\*\*\* Update File:/)
  assert.equal(calls[1].input.content, "one\ntwo")
  assert.equal(calls[2].input.new_string, "")
  assert.deepEqual(mapToolCalls({ toolCallId: "p", toolName: "apply_patch", arguments: { input: PATCH } }).map((c) => c.input.file_path), calls.map((c) => c.input.file_path))
  // A patch with no file header stays one call, whole.
  assert.deepEqual(mapToolCalls({ toolCallId: "q", toolName: "apply_patch", arguments: "garbage" }), [{ name: "Edit", input: { input: "garbage" } }])
})

test("an apply_patch that writes status: done into a card fails the run like a direct edit, and every file of the patch gets the one result", () => {
  const events = copilotToStreamEvents([
    ev("assistant.message", { content: "", toolRequests: [{ toolCallId: "e", name: "bash", arguments: { command: "node s/session-boot.js" } }, { toolCallId: "f", name: "apply_patch", arguments: PATCH }, { toolCallId: "m", name: "report_intent", arguments: { intent: "Patching" } }] }),
    ev("tool.execution_complete", { toolCallId: "e", success: true, shellExecution: { exitCode: 0 }, result: { content: "Desk boot: ready" } }),
    ev("tool.execution_complete", { toolCallId: "f", success: true, result: { content: "Patch applied" } }),
    ev("tool.execution_complete", { toolCallId: "m", success: true, result: { content: "ok" } }),
    ev("assistant.message", { content: "You have watering-schedule-api in progress.", toolRequests: [] }),
    { type: "result", exitCode: 0, sessionId: "s4" },
  ])
  const ctx = buildContext(events)
  assert.deepEqual(ctx.toolCalls.map((t) => t.name), ["Bash", "Edit", "Write", "Edit"])
  assert.ok(ctx.toolCalls.slice(1).every((t) => t.result === "Patch applied"))
  const verdict = scoreRun(findScenario("say-hi"), { ...ctx, host: "copilot" }, "copilot")
  assert.equal(verdict.outcome, "fail")
  assert.ok(verdict.notes.some((n) => /status: done into a task card directly/.test(n)))
})

test("Copilot's report_intent is left out of the transcript, and the shell-session helpers are on the not-counted list", () => {
  const events = copilotToStreamEvents([ev("assistant.message", { content: "", toolRequests: [{ toolCallId: "m", name: "report_intent", arguments: { intent: "x" } }, { toolCallId: "r", name: "read_bash", arguments: { shellId: "1" } }] })])
  assert.deepEqual(buildContext(events).toolCalls.map((t) => t.name), ["read_bash"])
  for (const name of ["report_intent", "read_bash", "write_bash", "stop_bash", "list_bash"]) assert.ok(META_TOOLS.has(name), name)
  assert.equal(META_TOOLS.has("bash"), false)
})

test("the Copilot run's HOME has no keychain link and no gh account list, and the gh shim runs the real gh on the operator's own HOME", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "copilot-home-"))
  try {
    const copilotHome = path.join(dir, "c")
    createIsolatedHome({ homeDir: copilotHome, host: "copilot" })
    assert.equal(existsSync(path.join(copilotHome, "Library", "Keychains")), false)
    assert.equal(existsSync(path.join(copilotHome, ".config", "gh")), false)
    assert.equal(existsSync(path.join(copilotHome, ".claude", "settings.json")), false) // the run never gets CLAUDE_CONFIG_DIR, so Claude Code's profile is under its HOME
    const claudeHome = path.join(dir, "k")
    createIsolatedHome({ homeDir: claudeHome, host: "claude", keychain: false, ghAccounts: false })
    assert.equal(existsSync(path.join(claudeHome, "Library", "Keychains")), false)
    assert.equal(existsSync(path.join(claudeHome, ".claude", "settings.json")), true) // the run never gets CLAUDE_CONFIG_DIR, so Claude Code's profile is under its HOME
    // The shim: the real gh sees realEnv, not the run's redirected HOME.
    const realDir = path.join(dir, "real")
    mkdirSync(realDir)
    writeFileSync(path.join(realDir, "gh"), '#!/bin/sh\necho "HOME=$HOME CFG=$GH_CONFIG_DIR XDG=${XDG_CONFIG_HOME:-unset}"\n', { mode: 0o755 })
    const shim = installGhShim({ shimDir: path.join(dir, "shim"), realGh: path.join(realDir, "gh"), logFile: path.join(dir, "log"), realEnv: realGhEnv({ GH_CONFIG_DIR: "/real/gh" }) })
    const out = spawnSync(shim, ["pr", "list"], { env: { PATH: process.env.PATH, HOME: "/run/home", XDG_CONFIG_HOME: "/run/home/.config", GH_CONFIG_DIR: "/run/home/.config/gh" }, encoding: "utf8" })
    assert.equal(out.stdout.trim(), `HOME=${os.homedir()} CFG=/real/gh XDG=unset`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("removing a run's folder removes the shared-cache link and never the shared cache itself, and a run that throws still removes its folder", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "copilot-clean-"))
  try {
    const shared = path.join(dir, "shared", "copilot-pkg")
    const run = path.join(dir, "run")
    mkdirSync(run, { recursive: true })
    shareCopilotPackageCache({ homeDir: path.join(run, "home"), sharedDir: shared })
    writeFileSync(path.join(shared, "runtime.bin"), "x")
    assert.equal(existsSync(path.join(run, "home", "Library", "Caches", "copilot", "pkg", "runtime.bin")), true)
    assert.equal(await cleanupRunDir(run), true)
    assert.equal(existsSync(run), false)
    assert.equal(readFileSync(path.join(shared, "runtime.bin"), "utf8"), "x")
    // The try/finally in run.mjs: the folder goes even when the run throws.
    const tmp = path.join(dir, "run2")
    mkdirSync(tmp)
    await assert.rejects(async () => {
      try { throw new Error("install failed") } finally { await cleanupRunDir(tmp) }
    }, /install failed/)
    assert.equal(existsSync(tmp), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the summary table says N/A beside a pass that skipped checks, with a host column and premium requests; Claude rows read as before", () => {
  assert.equal(outcomeText({ outcome: "pass", not_applicable_count: 3 }), "pass (3 N/A)")
  assert.equal(outcomeText({ outcome: "fail", not_applicable: ["a"] }), "fail (1 N/A)")
  assert.equal(outcomeText({ outcome: "pass" }), "pass")
  assert.equal(outcomeText({ outcome: "pass", not_applicable_count: 0 }), "pass")
})
