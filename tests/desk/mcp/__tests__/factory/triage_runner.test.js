// These exercise production admission/runner decisions with trusted non-model
// diagnostic/child fixtures. They do NOT qualify Claude's actual enforcement.
import "../_isolated_env.mjs"
import { test } from "node:test"
import fsNative from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { probeSignIn, runHeadless } from "../../../../../plugins/desk/mcp/src/factory/headless.js"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

const runner = await import("../../../../../plugins/desk/mcp/src/factory/triage-runner.js").catch(() => ({}))
const qualifier = await import("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js").catch(() => ({}))
const hash = (value) => createHash("sha256").update(value).digest("hex")
const flags = ["--restricted", "--safe-mode", "--permission-mode", "--permission-prompts", "--tools",
  "--disable-slash-commands", "--no-chrome", "--no-session-persistence", "--strict-mcp-config",
  "--mcp-config", "--settings", "--max-budget-usd", "--output-format", "--verbose", "--system-prompt"]
const metadata = { host: "claude-code", flags }
const doctor = "Claude Code doctor\nManaged settings (remote): not fetched — requires an Enterprise or Team subscription\nOrganization policy: not applicable to Pro and Max accounts\n"
const source = { kind: "managed", revision: "a".repeat(64), settings: {} }
const readers = { read: () => ({ complete: true, controller_invariant: true, sources: [source], validation_errors: [] }) }
const diagnostic = async () => ({ kind: "closed", code: 0, stdout: doctor, truncated: false })
const brief = { batch: "a".repeat(16), producer_version: "1.2.0", rubric_version: 1, cards: [] }
const candidate = JSON.stringify({ schema: "desk.factory.triage-result/1", batch: brief.batch,
  producer_version: brief.producer_version, rubric_version: 1, results: [] }) + "\n"

function fixture(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "triage-test-")))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const inputDir = path.join(dir, "input")
  // No operator setup is accessed by these fixtures.
  writeFileSync(path.join(dir, "engine"), "engine revision one")
  writeFileSync(path.join(dir, "runtime"), "runtime revision one")
  return import("node:fs").then(({ mkdirSync }) => {
    mkdirSync(inputDir)
    const resultFile = path.join(inputDir, ".triage-result.json")
    writeFileSync(path.join(inputDir, "input.json"), JSON.stringify(brief))
    writeFileSync(resultFile, "{}")
    const cli = path.join(dir, "engine")
    const resolveExec = () => ({ cmd: cli, prefix: [], files: [cli, path.join(dir, "runtime")], supported: true })
    const env = { HOME: dir, PATH: "/fixture", PRIVATE_SECRET: "not-for-child", HTTPS_PROXY: "https://proxy" }
    return { dir, inputDir, resultFile, cli, env, resolveExec }
  })
}

async function qualification(f, overrides = {}) {
  const policy = runner.triagePolicy({ ...f, cliMetadata: metadata })
  const chain = runner.inspectLaunchChain(f)
  const admission = await runner.collectTriageAdmission({ ...f, argv: policy.argv, runDiagnostic: diagnostic, policyReaders: readers })
  return { state: "qualified", launches: 2, cli: f.cli, cliMetadata: metadata,
    resolveExec: f.resolveExec, runDiagnostic: diagnostic, policyReaders: readers,
    probeSpawn: authSpawn(),
    chain_fingerprint: chain.fingerprint, policy_fingerprint: policy.fingerprint,
    admission_fingerprint: admission.fingerprint,
    fingerprint: hash(JSON.stringify([chain.fingerprint, policy.fingerprint, admission.fingerprint])),
    ...overrides }
}

function authSpawn(state = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }) {
  return (_cmd, args) => {
    assert.deepEqual(args, ["auth", "status"])
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify(state))
      child.emit("close", 0)
    })
    return child
  }
}

function childSpawn(f, { output, code = 0, hang = false, change, error, noPid = false, overflow = false } = {}) {
  const calls = [], killed = []
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const child = new EventEmitter()
    child.pid = noPid ? undefined : 731
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = (signal) => { killed.push(signal); return true }
    queueMicrotask(() => {
      change?.()
      if (error) return child.emit("error", { code: error })
      if (hang) return
      writeFileSync(f.resultFile, candidate)
      child.stdout.write(overflow ? Buffer.alloc(1024 * 1024 + 1) : output ?? JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.03 }) + "\n")
      child.emit("close", code)
    })
    return child
  }
  return { spawn, calls, killed }
}

test("new_Node6_test_discovery_executes_real_exports", () => {
  for (const name of ["runTriageChild", "inspectLaunchChain", "collectTriageAdmission", "triagePolicy"]) {
    assert.equal(typeof runner[name], "function", `${name} must be implemented, not the old baseline`)
  }
})

test("compatible_trusted_policy_is_admissible_without_admin_tamper_proof", async (t) => {
  const f = await fixture(t)
  const result = await runner.collectTriageAdmission({ ...f, argv: [], runDiagnostic: diagnostic, policyReaders: readers })
  assert.equal(result.state, "admitted")
  assert.equal(result.remote_delivery, "not_applicable")
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/)
})

test("pending_applicable_policy_blocks", async (t) => {
  const f = await fixture(t)
  for (const [stdout, reason] of [
    ["Managed settings (remote): checking… (fetch in progress; re-run in a moment)", "applicable_delivery_pending"],
    ["Managed settings (remote): unfamiliar future message", "diagnostic_inadequate"],
    ["Managed settings (remote): fetch failed (cached policy applies)", "effective_policy_unknown"],
  ]) {
    const result = await runner.collectTriageAdmission({ ...f, argv: [], runDiagnostic: async () => ({ kind: "closed", code: 0, stdout }), policyReaders: readers })
    assert.equal(result.state, "scope_unqualified")
    assert.equal(result.reason, reason)
  }
})

test("effective_hook_helper_or_widening_grant_blocks", async (t) => {
  const f = await fixture(t)
  for (const [settings, reason] of [
    [{ hooks: { SessionStart: [{ command: "never execute this" }] } }, "active_hook_or_helper"],
    [{ policyHelper: "never execute this" }, "active_hook_or_helper"],
    [{ permissions: { allow: ["Edit"] } }, "unsafe_permission_grant"],
    [{ permissions: { additionalDirectories: ["/outside"] } }, "unsafe_permission_grant"],
    [{ env: { ANTHROPIC_API_KEY: "secret" } }, "billing_unresolved"],
  ]) {
    const result = await runner.collectTriageAdmission({ ...f, argv: [], runDiagnostic: diagnostic,
      policyReaders: { read: () => ({ complete: true, controller_invariant: true, sources: [{ ...source, settings }], validation_errors: [] }) } })
    assert.equal(result.reason, reason)
    assert.equal(JSON.stringify(result).includes("secret"), false)
    assert.equal(JSON.stringify(result).includes("never execute"), false)
  }
})

test("result_read_deny_blocks_edit", async (t) => {
  const f = await fixture(t)
  const policy = runner.triagePolicy({ ...f, cliMetadata: metadata })
  const settings = structuredClone(policy.settings)
  settings.permissions.deny.push(`Read(/${f.resultFile})`)
  assert.equal(runner.triagePolicy({ ...f, cliMetadata: metadata, settings }).state, "scope_unqualified")
})

test("exact_result_edit_succeeds_input_edit_denied", async (t) => {
  const f = await fixture(t)
  const q = await qualification(f)
  const child = childSpawn(f)
  const result = await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })
  assert.equal(result.state, "ran")
  const settings = JSON.parse(child.calls[0].args[child.calls[0].args.indexOf("--settings") + 1])
  assert.deepEqual(settings.permissions.allow, [`Read(/${f.resultFile})`, `Edit(/${f.resultFile})`])
  assert.equal(child.calls[0].opts.cwd, f.inputDir)
  assert.equal(child.calls[0].args.includes("--add-dir"), false)
  // The runner emits exact result Edit only, not an input-directory grant.
  assert.equal(settings.permissions.allow.includes(`Edit(/${f.inputDir}/**)`), false)
})

test("inline_selected_policy_does_not_reload", async (t) => {
  const f = await fixture(t)
  const policy = runner.triagePolicy({ ...f, cliMetadata: metadata })
  const inline = policy.argv[policy.argv.indexOf("--settings") + 1]
  policy.settings.permissions.allow.push("Edit")
  assert.equal(JSON.parse(inline).permissions.allow.length, 2)
  assert.equal(inline.startsWith("{"), true)
})

test("unqualified_or_changed_runtime_starts_nothing", async (t) => {
  const f = await fixture(t)
  const q = await qualification(f)
  for (const [options, state] of [
    [{ qualification: undefined }, "scope_unqualified"],
    [{ qualification: { ...q, fingerprint: "changed" } }, "scope_changed"],
    [{ qualification: { ...q, cliMetadata: { host: "other", flags } } }, "unsupported_host"],
    [{ env: { ...f.env, DESK_FACTORY_HEADLESS: "1" } }, "headless_session"],
    [{ env: { ...f.env, ANTHROPIC_API_KEY: "no" } }, "disabled_would_bill"],
    [{ deadline: 0 }, "no_time_for_a_run"],
  ]) {
    const child = childSpawn(f)
    const result = await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn, ...options })
    assert.equal(result.state, state)
    assert.equal(child.calls.length, 0)
  }
  const link = path.join(f.dir, "result-link")
  symlinkSync(f.resultFile, link)
  const child = childSpawn(f)
  assert.equal((await runner.runTriageChild({ ...f, resultFile: link, qualification: q, spawn: child.spawn })).state, "scope_unqualified")
  assert.equal(child.calls.length, 0)
})

test("launcher_or_engine_change_invalidates_qualification", async (t) => {
  const f = await fixture(t)
  const before = runner.inspectLaunchChain(f)
  writeFileSync(path.join(f.dir, "runtime"), "runtime revision two")
  assert.notEqual(runner.inspectLaunchChain(f).fingerprint, before.fingerprint)
  writeFileSync(f.cli, "engine revision two")
  assert.notEqual(runner.inspectLaunchChain(f).fingerprint, before.fingerprint)
  assert.equal(runner.inspectLaunchChain({ ...f, resolveExec: () => null }).state, "scope_unqualified")
})

test("prelaunch_drift_blocks", async (t) => {
  const f = await fixture(t), q = await qualification(f)
  writeFileSync(f.cli, "replaced")
  const child = childSpawn(f)
  assert.equal((await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })).state, "scope_changed")
  assert.equal(child.calls.length, 0)
})

test("detected_run_drift_never_accepts_candidate", async (t) => {
  const f = await fixture(t), q = await qualification(f)
  const child = childSpawn(f, { change: () => writeFileSync(f.cli, "replaced during run") })
  const result = await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })
  assert.equal(result.state, "scope_changed")
  assert.equal(result.resultFile, undefined)
})

test("child_cannot_mutate_policy_or_runtime", async (t) => {
  const f = await fixture(t)
  const q = await qualification(f), child = childSpawn(f)
  const policyBytes = readFileSync(f.cli)
  await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })
  const settings = JSON.parse(child.calls[0].args[child.calls[0].args.indexOf("--settings") + 1])
  assert.deepEqual(settings.permissions.deny, ["Bash", "PowerShell", "REPL", "Agent", "Task", "Skill", "WebFetch", "WebSearch", "mcp__*"])
  assert.equal(settings.disableAllHooks, true)
  assert.equal(child.calls[0].args[child.calls[0].args.indexOf("--tools") + 1], "Read,Grep,Glob,Edit")
  assert.deepEqual(readFileSync(f.cli), policyBytes)
  // Native attempted-operation proof belongs to the qualifier, not this fixture.
})

test("owned_PID_timeout_cleanup_env_and_malformed_output", async (t) => {
  const f = await fixture(t), q = await qualification(f)
  const child = childSpawn(f, { hang: true }), started = [], exited = []
  const result = await runner.runTriageChild({ ...f, qualification: q, deadline: Date.now() + 40,
    spawn: child.spawn, onChild: (pid) => started.push(pid), onChildExit: (pid) => exited.push(pid) })
  assert.equal(result.state, "timeout")
  assert.deepEqual(child.killed, ["SIGKILL"])
  assert.deepEqual(started, [731])
  assert.deepEqual(exited, [731])
  assert.equal(child.calls[0].opts.env.PRIVATE_SECRET, undefined)
  assert.equal(child.calls[0].opts.env.HTTPS_PROXY, "https://proxy")
  assert.equal(child.calls[0].opts.env.DESK_FACTORY_HEADLESS, "1")
  const bad = childSpawn(f, { output: "not-json" })
  assert.equal((await runner.runTriageChild({ ...f, qualification: q, spawn: bad.spawn })).state, "failed")
})

test("qualifier_requires_observed_attempts_not_model_restraint", async (t) => {
  const f = await fixture(t)
  assert.equal(typeof qualifier.qualifyTriageRunner, "function")
  const out = path.join(f.dir, "evidence")
  const child = childSpawn(f)
  const result = await qualifier.qualifyTriageRunner({ out, cli: f.cli, env: f.env,
    cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
    spawn: child.spawn, probeSpawn: authSpawn() })
  assert.equal(result.state, "blocked")
  assert.equal(result.cases.some((row) => row.enforcement === "not_exercised"), true)
  assert.equal(result.cases.some((row) => row.enforcement === "model_claim"), false)
  const record = JSON.parse(readFileSync(path.join(out, "qualification.json")))
  assert.ok(record.resources.files.includes(path.join(out, "qualification.json")),
    "durable resource record must include its own protected report")
})

test("qualifier_is_a_production_policy_consumer_and_records_two_launches", async (t) => {
  const f = await fixture(t)
  assert.equal(typeof qualifier.qualifyTriageRunner, "function")
  const spawn = (_cmd, _args, opts) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => {
      const input = JSON.parse(readFileSync(path.join(opts.cwd, "input.json")))
      if (readFileSync(path.join(opts.cwd, ".triage-result.json")).toString() !== "{}") {
        child.stdout.write(JSON.stringify({ type: "result", subtype: "stale_synthetic_result", is_error: true }) + "\n")
        child.emit("close", 1)
        return
      }
      const events = [{ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob", "Edit"] }]
      for (const [i, operation] of input.operations.entries()) {
        if (!["Read", "Grep", "Glob", "Edit"].includes(operation.tool)) continue
        events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: String(i),
          name: operation.tool, input: { file_path: operation.target, path: operation.target } }] } })
        events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: String(i),
          is_error: !operation.positive, content: operation.positive ? "runtime operation succeeded" : "Permission denied by restricted working directory" }] } })
      }
      writeFileSync(path.join(opts.cwd, ".triage-result.json"), candidate)
      events.push({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.04 })
      child.stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n")
      child.emit("close", 0)
    })
    return child
  }
  const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, "evidence"), cli: f.cli, env: f.env,
    cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
    spawn, probeSpawn: authSpawn() })
  assert.equal(result.state, "qualified")
  assert.equal(result.resources.launches, 2)
  assert.equal(result.cases.every((row) => row.result === "passed"), true)
  assert.equal(result.cases.some((row) => row.enforcement === "tool_absent"), true)
})

test("admission_missing_invalid_and_incompatible_evidence_never_becomes_none", async (t) => {
  const f = await fixture(t)
  for (const [observed, evidence, reason] of [
    [{ kind: "timeout" }, readers.read(), "diagnostic_inadequate"],
    [{ kind: "closed", code: 1, stdout: doctor }, readers.read(), "diagnostic_inadequate"],
    [{ kind: "closed", code: 0, truncated: true, stdout: doctor }, readers.read(), "diagnostic_inadequate"],
    [{ kind: "closed", code: 0, stdout: 3 }, readers.read(), "diagnostic_inadequate"],
    [{ kind: "closed", code: 0, stdout: "" }, readers.read(), "diagnostic_inadequate"],
    [null, undefined, "diagnostic_inadequate"],
    [null, { sources: [], validation_errors: [], complete: false }, "diagnostic_inadequate"],
    [null, { ...readers.read(), controller_invariant: false }, "policy_control_unsupported"],
    [null, { ...readers.read(), validation_errors: ["private raw settings error"] }, "effective_policy_unknown"],
    [null, { ...readers.read(), sources: [{ ...source, kind: "future" }] }, "effective_policy_unknown"],
    [null, { ...readers.read(), sources: [{ ...source, revision: "unknown" }] }, "effective_policy_unknown"],
    [null, { ...readers.read(), sources: [{ ...source, settings: null }] }, "effective_policy_unknown"],
    [null, { ...readers.read(), sources: [{ ...source, settings: [] }] }, "effective_policy_unknown"],
    [null, { ...readers.read(), sources: [{ ...source, settings: { futurePolicy: true } }] }, "effective_policy_unknown"],
    [null, { ...readers.read(), sources: [{ ...source, settings: { permissions: { deny: ["Read"] } } }] }, "unsafe_permission_grant"],
  ]) {
    const result = await runner.collectTriageAdmission({ ...f, argv: [], runDiagnostic: observed ? async () => observed : diagnostic,
      policyReaders: { read: () => evidence } })
    assert.equal(result.state, "scope_unqualified")
    assert.equal(result.reason, reason)
    assert.equal(JSON.stringify(result).includes("private raw"), false)
  }
  for (const env of [{ ...f.env, DESK_FACTORY_HEADLESS: "1" }, { ...f.env, ANTHROPIC_API_KEY: "private" }]) {
    assert.equal((await runner.collectTriageAdmission({ ...f, env, argv: [], runDiagnostic: () => { throw new Error("must not run") } })).state, "scope_unqualified")
  }
  assert.equal((await runner.collectTriageAdmission({ ...f, argv: [], runDiagnostic: () => { throw new Error("failed diagnostic") } })).reason, "effective_policy_unknown")
  const captured = await runner.collectTriageAdmission({ ...f, argv: [], runDiagnostic: diagnostic,
    policyReaders: { ...readers, captureDiagnostic: () => { throw new Error("private capture failed") } } })
  assert.equal(captured.reason, "effective_policy_unknown")
  const defaultRead = await runner.collectTriageAdmission({ ...f, argv: [], runDiagnostic: diagnostic })
  assert.equal(defaultRead.reason, "diagnostic_inadequate")
  // Node itself has no doctor subcommand: a real bounded non-model failure.
  assert.equal((await runner.collectTriageAdmission({ ...f, cli: process.execPath, argv: [] })).reason, "diagnostic_inadequate")
})

test("resolved_remote_outcomes_still_require_exact_effective_policy", async (t) => {
  const f = await fixture(t), policy = runner.triagePolicy({ ...f, cliMetadata: metadata })
  for (const [text, remote] of [["no server-managed settings configured", "no_configuration"], ["delivered settings loaded", "delivered"]]) {
    const admitted = await runner.collectTriageAdmission({ ...f, argv: policy.argv,
      runDiagnostic: async () => ({ kind: "closed", code: 0, stdout: `Managed settings (remote): ${text}` }),
      policyReaders: { read: () => ({ ...readers.read(), sources: [{ ...source, path: "/protected/policy",
        settings: { permissions: { allow: policy.settings.permissions.allow, deny: [] }, disableAllHooks: true, hooks: {} } }] }) } })
    assert.equal(admitted.state, "admitted")
    assert.equal(admitted.remote_delivery, remote)
  }
  const badSettings = await runner.collectTriageAdmission({ ...f, argv: ["--settings", "invalid-json"], runDiagnostic: diagnostic, policyReaders: readers })
  assert.equal(badSettings.reason, "effective_policy_unknown")
})

test("unsupported_policy_and_launch_resolution_starts_nothing", async (t) => {
  const f = await fixture(t)
  assert.equal(runner.triagePolicy({ ...f, cliMetadata: { host: "claude-code", flags: [] } }).reason, "diagnostic_inadequate")
  assert.equal(runner.triagePolicy({ ...f, inputDir: "relative", cliMetadata: metadata }).state, "scope_unqualified")
  assert.equal(runner.triagePolicy({ ...f, inputDir: "/wild*", resultFile: "/wild*/.triage-result.json", cliMetadata: metadata }).state, "scope_unqualified")
  assert.equal(runner.inspectLaunchChain({ ...f, cli: "relative" }).reason, "launch_chain_unknown")
  for (const resolution of [
    { supported: false }, { supported: true, cmd: "relative", prefix: [], files: [] },
    { supported: true, cmd: f.cli, prefix: null, files: [f.cli] },
    { supported: true, cmd: f.cli, prefix: [], files: null },
    { supported: true, cmd: f.cli, prefix: [], files: [] },
    { supported: true, cmd: f.cli, prefix: [], files: Array(65).fill(f.cli) },
    { supported: true, cmd: f.cli, prefix: [], files: [f.cli, "relative"] },
  ]) assert.equal(runner.inspectLaunchChain({ ...f, resolveExec: () => resolution }).state, "scope_unqualified")
})

test("native_loader_inspection_refuses_unknown_or_unreadable_images", async (t) => {
  const f = { ...await fixture(t), resolveExec: undefined }
  const realRead = fsNative.readFileSync, realPath = fsNative.realpathSync
  let files = new Map()
  t.mock.method(fsNative, "readFileSync", (file, ...args) => files.has(String(file)) ? files.get(String(file)) : realRead(file, ...args))
  t.mock.method(fsNative, "realpathSync", (file, ...args) => files.has(String(file)) ? String(file) : realPath(file, ...args))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const image = (dependencies = []) => {
    const b = Buffer.alloc(32 + dependencies.length * 160)
    b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(dependencies.length, 16)
    dependencies.forEach((dep, i) => { const offset = 32 + i * 160; b.writeUInt32LE(0xc, offset); b.writeUInt32LE(160, offset + 4); b.writeUInt32LE(24, offset + 8); b.write(dep, offset + 24) })
    return b
  }
  files = new Map([[f.cli, image(["/fixture/dependency"])], ["/fixture/dependency", image()], ["/usr/lib/dyld", image()]])
  assert.equal(runner.inspectLaunchChain(f).state, "inspected")
  files.set("/fixture/dependency", image([f.cli]))
  assert.equal(runner.inspectLaunchChain(f).state, "inspected", "dependency cycles are recorded once")
  const nonLoadCommand = image(["not a dependency"]); nonLoadCommand.writeUInt32LE(0xd, 32)
  files.set(f.cli, nonLoadCommand)
  assert.equal(runner.inspectLaunchChain(f).state, "inspected", "non-load native commands do not become runtime paths")
  for (const b of [Buffer.alloc(3), Buffer.alloc(32), image(["@rpath/libunknown"])]) {
    files.set(f.cli, b)
    assert.equal(runner.inspectLaunchChain(f).state, "scope_unqualified")
  }
  const tooMany = image(); tooMany.writeUInt32LE(4097, 16)
  files.set(f.cli, tooMany)
  assert.equal(runner.inspectLaunchChain(f).state, "scope_unqualified")
  const badSize = image(["/fixture/dependency"]); badSize.writeUInt32LE(4, 36)
  files.set(f.cli, badSize)
  assert.equal(runner.inspectLaunchChain(f).state, "scope_unqualified")
  badSize.writeUInt32LE(999999, 36)
  assert.equal(runner.inspectLaunchChain(f).state, "scope_unqualified")
  for (const offset of [0, 160]) {
    const bad = image(["/fixture/dependency"]); bad.writeUInt32LE(offset, 40)
    files.set(f.cli, bad)
    assert.equal(runner.inspectLaunchChain(f).state, "scope_unqualified")
  }
  const noEnd = image(["/fixture/dependency"]); noEnd.fill(65, 56)
  files.set(f.cli, noEnd)
  assert.equal(runner.inspectLaunchChain(f).state, "scope_unqualified")
  const endOutsideCommand = image(["unknown", "/fixture/dependency"]); endOutsideCommand.fill(65, 56, 192)
  files.set(f.cli, endOutsideCommand)
  assert.equal(runner.inspectLaunchChain(f).state, "scope_unqualified")
  files = new Map([[f.cli, image(["/fixture/0"])], ["/usr/lib/dyld", image()]])
  for (let i = 0; i < 65; i++) files.set(`/fixture/${i}`, image([`/fixture/${i + 1}`]))
  assert.equal(runner.inspectLaunchChain(f).state, "scope_unqualified")
})

test("runner_auth_child_failure_budget_and_candidate_outcomes_are_closed", async (t) => {
  const f = await fixture(t)
  for (const state of [{ loggedIn: false }, { loggedIn: true, authMethod: "unknown" }, { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }]) {
    const q = await qualification(f, { probeSpawn: authSpawn(state) }), child = childSpawn(f)
    const result = await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })
    assert.ok(["no_credentials", "sign_in_unknown", "disabled_would_bill"].includes(result.state))
    assert.equal(child.calls.length, 0)
  }
  for (const [childOptions, want] of [
    [{ error: "EACCES" }, "failed"], [{ overflow: true }, "failed"],
    [{ code: 1 }, "failed"],
    [{ output: JSON.stringify({ type: "result", subtype: "budget_exceeded", is_error: true }) }, "budget_exceeded"],
    [{ output: JSON.stringify({ type: "result", subtype: "success", is_error: true, total_cost_usd: -1 }) }, "failed"],
    [{ output: JSON.stringify({ type: "unknown", subtype: "success", is_error: false }) }, "failed"],
    [{ output: JSON.stringify({ type: "result", subtype: "unknown", is_error: false }) }, "failed"],
  ]) {
    const q = await qualification(f), child = childSpawn(f, childOptions)
    assert.equal((await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })).state, want)
  }
  const q = await qualification(f), child = childSpawn(f)
  q.capture = () => { throw new Error("protected capture failed") }
  assert.equal((await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })).state, "failed")
  for (const options of [{ qualification: { ...q, state: "unknown" } }, { qualification: { ...q, launches: 1 } }, { workDir: "/other" }]) {
    assert.equal((await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn, ...options })).state, "scope_unqualified")
  }
  assert.equal((await runner.runTriageChild({ ...f, qualification: { ...q, cli: null }, env: {}, spawn: child.spawn })).state, "no_agent_cli")
  assert.equal((await runner.runTriageChild({ ...f, qualification: { ...q, resolveExec: () => null }, spawn: child.spawn })).state, "scope_unqualified")
  assert.equal((await runner.runTriageChild({ ...f, qualification: { ...q, policyReaders: { read: () => ({ ...readers.read(), complete: false }) } }, spawn: child.spawn })).state, "scope_unqualified")
  for (const output of ["null", "[]", '"text"']) {
    const malformed = childSpawn(f, { output })
    assert.equal((await runner.runTriageChild({ ...f, qualification: await qualification(f), spawn: malformed.spawn })).state, "failed")
  }
})

test("qualifier_CLI_fail_closed_arguments_and_unknown_chain", async (t) => {
  const f = await fixture(t)
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js", import.meta.url))
  for (const args of [[], ["--out", f.dir], ["--bad", f.dir, "--cli", f.cli],
    ["--out", f.dir, "--bad", f.cli], ["--out", f.dir, "--out", f.cli],
    ["--cli", f.cli, "--out", path.join(f.dir, "cli-evidence")]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })
    assert.equal(result.status, 1, result.stderr)
    assert.equal(JSON.parse(result.stdout).state, "blocked")
  }
})

function observedSpawn(mode = "normal") {
  return (_cmd, args, opts) => {
    const child = new EventEmitter()
    child.pid = 892
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    queueMicrotask(() => {
      if (args[0] === "--help") {
        child.stdout.write(mode === "help_no_flags" ? "Claude" : flags.join("\n"))
        child.emit("close", mode === "help_failed" ? 1 : 0)
        return
      }
      const input = JSON.parse(readFileSync(path.join(opts.cwd, "input.json")))
      const manifest = mode === "invalid_manifest" ? [4] : mode === "unexpected_tool" ? ["Read", "Grep", "Glob", "Edit", "Bash"] : ["Read", "Grep", "Glob", "Edit"]
      const events = [{ type: "system", subtype: "init", tools: manifest }]
      if (mode === "no_manifest") events.length = 0
      events.push({ type: "assistant" }, { type: "user" })
      for (const [i, operation] of input.operations.entries()) {
        if (!["Read", "Grep", "Glob", "Edit"].includes(operation.tool)) continue
        events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: String(i), name: operation.tool, input: { path: operation.target } }] } })
        events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: String(i),
          is_error: mode === "violation_succeeded" ? false : !operation.positive,
          content: operation.positive ? "tool succeeded" : mode === "unrelated_error" ? "file not found" : "Permission denied" }] } })
      }
      if (mode === "absence_contradicted" || mode === "later_violation_succeeded") {
        const op = input.operations.find((operation) => operation.operation === (mode === "absence_contradicted" ? "excluded_Bash" : "input_edit"))
        events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "extra",
          name: op.tool, input: { file_path: op.target } }] } })
        events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "extra", is_error: false, content: "succeeded" }] } })
      }
      writeFileSync(path.join(opts.cwd, ".triage-result.json"), candidate)
      if (mode === "sentinel_changed") writeFileSync(input.operations.find((op) => op.operation === "sibling_edit").target, "changed")
      events.push({ type: "result", subtype: "success", is_error: false })
      child.stdout.write(mode === "bad_stream" ? "malformed" : events.map((event) => JSON.stringify(event)).join("\n") + "\n")
      child.emit("close", 0)
    })
    return child
  }
}

test("qualifier_never_accepts_widened_tools_successful_violation_or_unrelated_errors", async (t) => {
  const f = await fixture(t)
  for (const mode of ["invalid_manifest", "unexpected_tool", "no_manifest", "violation_succeeded", "unrelated_error", "sentinel_changed", "bad_stream",
    "absence_contradicted", "later_violation_succeeded"]) {
    const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, mode), cli: f.cli, env: f.env,
      cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
      spawn: observedSpawn(mode), probeSpawn: authSpawn() })
    assert.equal(result.state, "blocked", mode)
    assert.equal(result.cases.some((row) => row.result === "failed"), true)
    assert.equal(result.resources.launches, 1)
  }
})

test("qualifier_diagnostic_chain_and_protection_holds_are_explicit", async (t) => {
  const f = await fixture(t)
  for (const [name, options, reason] of [
    ["unknown-chain", { resolveExec: () => null }, "launch_chain_unknown"],
    ["missing-flags", { cliMetadata: { host: "claude-code", flags: [] } }, "diagnostic_inadequate"],
    ["unsupported-host", { cliMetadata: { host: "other", flags } }, "diagnostic_inadequate"],
    ["pending", { runDiagnostic: async () => ({ kind: "closed", code: 0, stdout: "Managed settings (remote): fetch in progress" }) }, "applicable_delivery_pending"],
    ["bad-help", { cliMetadata: undefined, spawn: observedSpawn("help_failed") }, "diagnostic_inadequate"],
    ["help-no-flags", { cliMetadata: undefined, spawn: observedSpawn("help_no_flags") }, "diagnostic_inadequate"],
    ["real-help-fixture", { cliMetadata: undefined }, undefined],
  ]) {
    const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, name), cli: f.cli, env: f.env,
      cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
      spawn: observedSpawn(), probeSpawn: authSpawn(), ...options })
    assert.equal(result.reason, reason)
    assert.equal(result.state, reason ? "blocked" : "qualified")
  }
  await assert.rejects(qualifier.qualifyTriageRunner({ out: "relative", cli: f.cli }))
  const alias = path.join(f.dir, "alias")
  symlinkSync(f.dir, alias)
  await assert.rejects(qualifier.qualifyTriageRunner({ out: path.join(alias, "evidence"), cli: f.cli }))
})

test("prepared_path_identity_and_bounded_bytes_are_enforced", async (t) => {
  const f = await fixture(t), q = await qualification(f)
  const child = childSpawn(f)
  for (const file of ["input.json", ".triage-result.json"]) {
    const target = path.join(f.inputDir, file), original = readFileSync(target)
    writeFileSync(target, Buffer.alloc(329 * 1024))
    assert.equal((await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })).state, "scope_unqualified")
    writeFileSync(target, original)
    fsNative.linkSync(target, path.join(f.dir, `${file}-hardlink`))
    assert.equal((await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })).state, "scope_unqualified")
    fsNative.unlinkSync(path.join(f.dir, `${file}-hardlink`))
  }
  const inputAlias = path.join(f.dir, "alias")
  symlinkSync(f.inputDir, inputAlias)
  assert.equal((await runner.runTriageChild({ ...f, inputDir: inputAlias,
    resultFile: path.join(inputAlias, ".triage-result.json"), qualification: q, spawn: child.spawn })).state, "scope_unqualified")
  const bad = childSpawn(f)
  const badQ = await qualification(f, { capture: () => writeFileSync(f.resultFile, "{}") })
  assert.equal((await runner.runTriageChild({ ...f, qualification: badQ, spawn: bad.spawn })).state, "failed")
  const changed = childSpawn(f)
  const changedQ = await qualification(f, { capture: () => writeFileSync(path.join(f.inputDir, "input.json"), "changed") })
  assert.equal((await runner.runTriageChild({ ...f, qualification: changedQ, spawn: changed.spawn })).state, "scope_changed")
})

test("immediate_recheck_and_deadline_expiry_allow_no_model_spawn", async (t) => {
  const f = await fixture(t)
  const q = await qualification(f), child = childSpawn(f)
  let count = 0
  q.runDiagnostic = async () => { count += 1; return count === 2 ? { kind: "closed", code: 0, stdout: "Managed settings (remote): checking" } : diagnostic() }
  assert.equal((await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })).state, "scope_changed")
  assert.equal(child.calls.length, 0)
  assert.equal(q.invalidated, true)
  const fresh = await qualification(f)
  let now = 0
  assert.equal((await runner.runTriageChild({ ...f, qualification: fresh, deadline: 2,
    clock: () => ++now, spawn: child.spawn })).state, "no_time_for_a_run")
  assert.equal(child.calls.length, 0)
  assert.equal((await runner.runTriageChild({ ...f, qualification: { ...fresh, invalidated: true }, spawn: child.spawn })).state, "scope_unqualified")
})

test("local_policy_reader_never_executes_command_bearing_settings", async (t) => {
  const f = await fixture(t)
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
  const realRead = fsNative.readFileSync, realList = fsNative.readdirSync
  let mode = "safe"
  t.mock.method(fsNative, "readdirSync", (file, ...args) => {
    if (!String(file).endsWith("managed-settings.d")) return realList(file, ...args)
    if (mode === "unreadable") throw Object.assign(new Error("private policy directory"), { code: "EACCES" })
    return ["20.json", ".hidden.json", "not-json.txt", "10.json"]
  })
  t.mock.method(fsNative, "readFileSync", (file, ...args) => {
    if (!String(file).includes("ClaudeCode") && !String(file).includes("claude-code")) return realRead(file, ...args)
    if (mode === "oversize") return Buffer.alloc(2 * 1024 * 1024 + 1)
    if (mode === "unreadable") throw Object.assign(new Error("private policy read"), { code: "EACCES" })
    return Buffer.from(mode === "hook" ? '{"policyHelper":"must not execute"}' : "{}")
  })
  syncBuiltinESMExports()
  t.after(() => { Object.defineProperty(process, "platform", originalPlatform); t.mock.restoreAll(); syncBuiltinESMExports() })
  for (const platform of ["darwin", "linux", "win32"]) {
    Object.defineProperty(process, "platform", { value: platform, configurable: true })
    const result = await runner.collectTriageAdmission({ ...f, argv: [], runDiagnostic: diagnostic })
    assert.equal(result.reason, "diagnostic_inadequate")
    assert.equal(result.sources.length, 3)
  }
  for (const [next, reason] of [["hook", "active_hook_or_helper"], ["oversize", "effective_policy_unknown"], ["unreadable", "effective_policy_unknown"]]) {
    mode = next
    assert.equal((await runner.collectTriageAdmission({ ...f, argv: [], runDiagnostic: diagnostic })).reason, reason)
  }
})

test("configured_helper_is_rejected_before_native_diagnostic_start", async (t) => {
  const f = await fixture(t)
  let called = 0
  const result = await runner.collectTriageAdmission({ ...f, argv: [],
    runDiagnostic: async () => { called += 1; return diagnostic() },
    policyReaders: { read: () => ({ ...readers.read(), sources: [{ ...source, settings: { policyHelper: "forbidden" } }] }) } })
  assert.equal(result.reason, "active_hook_or_helper")
  assert.equal(called, 0)
})

test("default_owned_spawn_executes_only_a_non_model_fixture", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t)
  // An executable script fixture, NOT a copy of an installed engine.
  writeFileSync(f.cli, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("auth")) console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty",subscriptionType:"max"}));
else {
  if (process.argv.includes("stream-json")) fs.writeFileSync(${JSON.stringify(f.resultFile)}, ${JSON.stringify(candidate)});
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,total_cost_usd:0.01}));
}
`)
  fsNative.chmodSync(f.cli, 0o700)
  assert.deepEqual(await probeSignIn({ cli: f.cli, env: f.env }), { state: "subscription" })
  const q = await qualification(f, { probeSpawn: undefined })
  const pids = [], exited = []
  const result = await runner.runTriageChild({ ...f, qualification: q, onChild: (pid) => pids.push(pid), onChildExit: (pid) => exited.push(pid) })
  assert.equal(result.state, "ran")
  assert.equal(pids.length, 2)
  assert.deepEqual(exited, pids)
  const evaluation = await runHeadless({ env: f.env, job: { host: "claude-code" }, cli: f.cli,
    signIn: { state: "subscription" }, briefPaths: [path.join(f.inputDir, "input.json")],
    evaluationDir: f.inputDir, logDirs: [], workDir: f.inputDir })
  assert.equal(evaluation.state, "ran")
})

test("bounded_diagnostic_PIDs_and_empty_compatible_permissions_are_recorded", async (t) => {
  const f = await fixture(t)
  const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, "diagnostic-resources"),
    cli: f.cli, env: f.env, cliMetadata: metadata, resolveExec: f.resolveExec,
    policyReaders: { read: () => ({ ...readers.read(), sources: [{ ...source, settings: { permissions: {} } }] }) },
    runDiagnostic: async (request) => {
      request.onChild(894)
      request.onChildExit(894)
      return diagnostic()
    }, spawn: observedSpawn(), probeSpawn: authSpawn() })
  assert.equal(result.state, "qualified")
  assert.ok(result.resources.pids.includes(894))
  assert.deepEqual(result.resources.exited_pids, result.resources.pids)
})

test("a_result_that_becomes_unreadable_after_exit_is_not_accepted", async (t) => {
  const f = await fixture(t), q = await qualification(f)
  const realRead = fsNative.readFileSync
  let deny = false
  t.mock.method(fsNative, "readFileSync", (file, ...args) => {
    if (deny && String(file) === f.resultFile) throw new Error("unreadable private result")
    return realRead(file, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  q.capture = () => { deny = true }
  assert.equal((await runner.runTriageChild({ ...f, qualification: q, spawn: childSpawn(f).spawn })).state, "failed")
})
