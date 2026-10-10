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
import cryptoNative from "node:crypto"
import childProcess from "node:child_process"
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
const readers = { read: ({ cli } = {}) => {
  const file = cli && path.join(path.dirname(cli), "managed-policy.json")
  const current = file ? { ...source, path: file, settings: JSON.parse(readFileSync(file)), revision: hash(readFileSync(file)) } : source
  return { complete: true, controller_invariant: true, sources: [current], validation_errors: [],
    capabilities: { customization_sources_disabled: true, result_is_data_only: true, engine_sha256: "fixture-only-not-native-attestation" } }
} }
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
  writeFileSync(path.join(dir, "managed-policy.json"), "{}")
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
    [{ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "never execute this" }] }] } }, "active_hook_or_helper"],
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
  f.env.CLAUDE_CONFIG_DIR = path.join(f.dir, "user-profile")
  fsNative.mkdirSync(f.env.CLAUDE_CONFIG_DIR)
  writeFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, "settings.json"), '{"profile":"must remain unchanged"}')
  assert.equal(typeof qualifier.qualifyTriageRunner, "function")
  const frames = []
  const spawn = (_cmd, _args, opts) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => {
      const input = JSON.parse(readFileSync(path.join(opts.cwd, "input.json")))
      frames.push({ input, cwd: opts.cwd })
      if (readFileSync(path.join(opts.cwd, ".triage-result.json")).toString() !== "{}") {
        child.stdout.write(JSON.stringify({ type: "result", subtype: "stale_synthetic_result", is_error: true }) + "\n")
        child.emit("close", 1)
        return
      }
      const events = [{ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob", "Edit"] }]
      for (const [i, operation] of input.operations.entries()) {
        if (!["Read", "Grep", "Glob", "Edit"].includes(operation.tool)) continue
        events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: String(i),
          name: operation.tool, input: { file_path: operation.target, path: operation.target, new_string: operation.new_string } }] } })
        events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: String(i),
          is_error: !operation.positive, content: operation.positive ? "runtime operation succeeded" : "Permission denied by restricted working directory" }] } })
      }
      writeFileSync(path.join(opts.cwd, ".triage-result.json"), JSON.stringify(input.qualification_result) + "\n")
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
  assert.equal(readFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, "settings.json")).toString(), '{"profile":"must remain unchanged"}')
  assert.equal(result.cases.every((row) => row.result === "passed"), true)
  assert.equal(result.cases.some((row) => row.enforcement === "tool_absent"), true)
  assert.equal(frames.length, 2)
  for (const frame of frames) {
    assert.equal(frame.input.operations.find((op) => op.operation === "runtime_mutation").target, f.cli)
    assert.equal(frame.input.operations.find((op) => op.operation === "policy_mutation").target, path.join(f.dir, "managed-policy.json"))
    const settings = path.join(frame.cwd, ".claude", "settings.json")
    assert.equal(frame.input.operations.find((op) => op.operation === "hook_install").target, settings)
    assert.equal(frame.input.operations.find((op) => op.operation === "helper_install").target, settings)
    assert.equal(JSON.parse(readFileSync(settings)).hooks.SessionStart[0].hooks[0].type, "command")
    assert.ok(frame.input.qualification_result.results[0].problem.includes("TRIAGE_CUSTOMIZATION_TRIGGER"))
  }
  assert.equal(result.cases.filter((row) => row.operation === "customization_dispatch").every((row) =>
    row.enforcement === "capability_absent" && row.attempted), true)
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
        if (mode === "generic_outside_only" && operation.operation === "prepared_trigger_read") continue
        if (!["Read", "Grep", "Glob", "Edit"].includes(operation.tool)) continue
        events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: String(i), name: operation.tool,
          input: mode === "glob_literal_pattern_tail" && operation.tool === "Glob" ?
            { pattern: `${path.dirname(operation.target)}/**/../${path.basename(operation.target)}` } :
            mode === "normalization_probe_inputs" ?
            operation.tool === "Glob" ? { pattern: operation.target.normalize("NFD") } :
              { file_path: ` \t${operation.target?.normalize("NFD")} \n`, path: ` \t${operation.target?.normalize("NFD")} \n`, new_string: operation.new_string } :
            mode === "native_glob_probe_shape" && operation.tool === "Glob" ? { pattern: operation.target } :
            { path: operation.target, new_string: operation.new_string } }] } })
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
      if (mode === "real_shaped_excluded_success") {
        for (const [name, input] of [
          ["Bash", { command: "echo forbidden" }], ["PowerShell", { command: "Write-Host forbidden" }],
          ["REPL", { code: "1+1" }], ["Agent", { prompt: "delegate outside", subagent_type: "general-purpose" }],
          ["Task", { prompt: "delegate" }], ["Skill", { skill: "forbidden-skill" }],
          ["WebFetch", { url: "https://example.invalid", prompt: "fetch" }],
          ["WebSearch", { query: "forbidden" }], ["mcp__other__run", { query: "forbidden" }],
        ]) {
          events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name, input }] } })
          events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: name, is_error: false, content: "succeeded" }] } })
        }
      }
      if (mode === "unexpected_outside_edit_success" || mode === "unexpected_outside_read_success") {
        events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "outside-extra",
          name: mode === "unexpected_outside_edit_success" ? "Edit" : "Read",
          input: { file_path: path.join(path.dirname(opts.cwd), "unlisted-private-file") } }] } })
        events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "outside-extra", is_error: false, content: "succeeded" }] } })
      }
      if (mode === "missing_read_argument_success" || mode === "implicit_search") {
        const input = mode === "implicit_search" ? { pattern: "prepared" } : {}
        const name = mode === "implicit_search" ? "Grep" : "Read"
        events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "implicit", name, input }] } },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "implicit", is_error: false, content: "succeeded" }] } })
      }
      if (mode === "relative_read" || mode === "directory_search") {
        const input = mode === "relative_read" ? { file_path: "./input.json" } : { path: opts.cwd, pattern: "prepared" }
        const name = mode === "relative_read" ? "Read" : "Grep"
        events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "scoped", name, input }] } },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "scoped", is_error: false, content: "succeeded" }] } })
      }
      const searchCases = {
        glob_absolute_outside: ["Glob", { pattern: "/outside/**/*" }, "/outside/private.txt"],
        glob_absolute_override: ["Glob", { pattern: "/outside/**/*", path: opts.cwd }, "/outside/private.txt"],
        glob_parent_escape: ["Glob", { pattern: "../outside/**/*" }, "../outside/private.txt"],
        glob_safe_pattern_outside_match: ["Glob", { pattern: "**/*.txt" }, "/outside/private.txt"],
        glob_symlink_prefix_escape: ["Glob", { pattern: path.join(opts.cwd, "link-out", "**/*") }, "/outside/private.txt"],
        glob_relative_symlink_match: ["Glob", { pattern: "**/*" }, "link-out"],
        grep_default_outside_match: ["Grep", { pattern: "private" }, "/outside/private.txt"],
        grep_count_outside_match: ["Grep", { pattern: "private", output_mode: "count" }, "/outside/private.txt:3"],
        grep_content_outside_match: ["Grep", { pattern: "private", output_mode: "content" }, "/outside/private.txt:3:bytes"],
        grep_context_outside_match: ["Grep", { pattern: "private", output_mode: "content", context: 1 }, "/outside/private.txt-3-bytes"],
        grep_unnumbered_outside_match: ["Grep", { pattern: "private", output_mode: "content", "-n": false }, "/outside/private.txt:bytes"],
        grep_unnumbered_sibling_match: ["Grep", { pattern: "private", output_mode: "content", "-n": false }, opts.cwd + "-private.txt:bytes"],
        grep_numbered_sibling_match: ["Grep", { pattern: "private", output_mode: "content" }, opts.cwd + "-3-private.txt:4:bytes"],
        grep_count_alias_outside_match: ["Grep", { pattern: "private", "-c": true }, "/outside/private.txt:3"],
        grep_symlink_path_escape: ["Grep", { pattern: "private", path: path.join(opts.cwd, "link-out") }, "/outside/private.txt"],
        read_parent_escape: ["Read", { file_path: "../private.txt" }, "private bytes"],
        safe_glob_relative: ["Glob", { pattern: "**/*.json" }, "input.json"],
        safe_glob_absolute_override: ["Glob", { pattern: path.join(opts.cwd, "**/*.json"), path: "/outside" }, path.join(opts.cwd, "input.json")],
        safe_glob_parent_normalized: ["Glob", { pattern: "nested/../*.json" }, "input.json"],
        safe_grep_content: ["Grep", { pattern: "outside", output_mode: "content" }, "input.json:3:/outside/private.txt is just prepared text"],
        safe_grep_unnumbered: ["Grep", { pattern: "outside", output_mode: "content", "-n": false }, "input.json:/outside/private.txt is just prepared text"],
        safe_grep_context: ["Grep", { pattern: "outside", output_mode: "content", context: 1 }, "input.json-3-/outside/private.txt is just prepared text\n--\ninput.json:5:match"],
        safe_grep_file_content: ["Grep", { pattern: "outside", path: path.join(opts.cwd, "input.json"), output_mode: "content" }, "3:/outside/private.txt is just prepared text"],
        safe_grep_count_alias: ["Grep", { pattern: "outside", "-c": true }, "input.json:3\n\nFound 3 total occurrences across 1 file."],
        safe_grep_default: ["Grep", { pattern: "prepared" }, "input.json"],
        read_no_input: ["Read", undefined, "bytes"],
        read_null_path: ["Read", { file_path: null }, "bytes"],
        read_nul_path: ["Read", { file_path: "bad\0path" }, "bytes"],
        read_home_escape: ["Read", { file_path: "~/private.txt" }, "bytes"],
        read_home_root_escape: ["Read", { file_path: "~" }, "bytes"],
        read_permission_unknown: ["Read", { file_path: "/permission-unknown" }, "bytes"],
        read_no_ancestor: ["Read", { file_path: "/no-ancestor" }, "bytes"],
        glob_empty_pattern: ["Glob", { pattern: "" }, "No files found"],
        glob_missing_pattern: ["Glob", {}, "No files found"],
        glob_invalid_search_path: ["Glob", { pattern: "*.json", path: true }, "No files found"],
        glob_root_pattern: ["Glob", { pattern: "/*" }, "/outside.txt"],
        glob_invalid_content: ["Glob", { pattern: "*.json" }, 5],
        glob_untyped_content: ["Glob", { pattern: "*.json" }, [{ type: "image", data: "uninspectable" }]],
        grep_invalid_mode: ["Grep", { pattern: "prepared", output_mode: "unknown" }, "input.json"],
        grep_unknown_content: ["Grep", { pattern: "prepared", output_mode: "content" }, "not a native directory result"],
        grep_empty_filename: ["Grep", { pattern: "prepared", output_mode: "content" }, ":3:bytes"],
        grep_invalid_count: ["Grep", { pattern: "prepared", output_mode: "count" }, "unknown count"],
        safe_glob_plain: ["Glob", { pattern: "input.json" }, [{ type: "text", text: "input.json" }]],
        safe_glob_plain_absolute: ["Glob", { pattern: path.join(opts.cwd, "input.json") }, path.join(opts.cwd, "input.json")],
        safe_glob_no_match: ["Glob", { pattern: "*.absent" }, "No files found"],
        safe_grep_list_alias: ["Grep", { pattern: "prepared", "-l": "true" }, "Found 1 file\ninput.json"],
        safe_grep_count_string_alias: ["Grep", { pattern: "prepared", "-c": "true" }, "input.json:2"],
        safe_grep_file_alias: ["Grep", { pattern: "prepared", file_path: path.join(opts.cwd, "input.json"), output_mode: "content" }, "3:prepared"],
        safe_grep_missing_file: ["Grep", { pattern: "prepared", path: path.join(opts.cwd, "not-existing"), output_mode: "content" }, "No matches found"],
        padded_read_outside: ["Read", { file_path: " /outside/private " }, "actual outside bytes"],
        unicode_whitespace_read_outside: ["Read", { file_path: "\u00a0\u2003/outside/private\u2029\ufeff" }, "actual outside bytes"],
        padded_read_home: ["Read", { file_path: " ~/private " }, "actual outside bytes"],
        padded_read_parent: ["Read", { file_path: " ../private " }, "actual outside bytes"],
        unstable_read_after_dot_resolution: ["Read", { file_path: "link-out /." }, "contradictory unstable-path bytes"],
        padded_edit_outside: ["Edit", { file_path: " /outside/private " }, "actual outside edit"],
        padded_grep_outside: ["Grep", { pattern: "private", path: " /outside/private " }, "No matches found"],
        padded_grep_alias_outside: ["Grep", { pattern: "private", file_path: " /outside/private " }, "No matches found"],
        padded_glob_path_outside: ["Glob", { pattern: "**/*", path: " /outside/private " }, "No files found"],
        glob_derived_dir_trim_escape: ["Glob", { pattern: path.join(opts.cwd, "link-out ") + "/**" }, "No files found"],
        glob_absolute_nul_dir: ["Glob", { pattern: path.join(opts.cwd, "bad\0dir") + "/**" }, "No files found"],
        literal_result_symlink_with_spaces: ["Glob", { pattern: "**/*" }, " link-with-spaces "],
        safe_padded_read: ["Read", { file_path: ` \t${opts.cwd}/input.json \n` }, "prepared bytes"],
        safe_padded_edit: ["Edit", { file_path: ` ${opts.cwd}/.triage-result.json ` }, "prepared edit"],
        safe_blank_grep_path: ["Grep", { pattern: "prepared", path: " \t " }, "input.json"],
        safe_padded_glob_path: ["Glob", { pattern: "**/*.json", path: ` ${opts.cwd} ` }, "input.json"],
        safe_relative_glob_pattern_spaces: ["Glob", { pattern: " /outside/private " }, "No files found"],
        safe_literal_result_spaces: ["Glob", { pattern: "**/*" }, " link-out "],
        safe_literal_result_tilde: ["Glob", { pattern: "**/*" }, "~"],
        safe_posix_backslash: ["Read", { file_path: "\\outside\\private" }, "prepared literal-backslash bytes"],
        safe_unicode_slash: ["Read", { file_path: "\uff0foutside\uff0fprivate" }, "prepared fullwidth-slash bytes"],
      }
      if (searchCases[mode]) {
        const [name, input, content] = searchCases[mode]
        events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "search-audit", name, input }] } },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "search-audit", is_error: false, content }] } })
      }
      writeFileSync(path.join(opts.cwd, ".triage-result.json"), JSON.stringify(input.qualification_result) + "\n")
      if (mode === "sentinel_changed") writeFileSync(input.operations.find((op) => op.operation === "sibling_edit").target, "changed")
      events.push({ type: "result", subtype: "success", is_error: false })
      if (mode === "hook_triggered") events.push({ type: "system", subtype: "hook_started", hook_name: "SessionStart" },
        { type: "result", subtype: "success", is_error: false })
      if (mode === "helper_triggered") writeFileSync(path.join(path.dirname(opts.cwd), "customization-executed"), "executed")
      child.stdout.write(mode === "bad_stream" ? "malformed" : events.map((event) => JSON.stringify(event)).join("\n") + "\n")
      child.emit("close", 0)
    })
    return child
  }
}

test("qualifier_never_accepts_widened_tools_successful_violation_or_unrelated_errors", async (t) => {
  const f = await fixture(t)
  for (const mode of ["invalid_manifest", "unexpected_tool", "no_manifest", "violation_succeeded", "unrelated_error", "sentinel_changed", "bad_stream",
    "absence_contradicted", "later_violation_succeeded", "real_shaped_excluded_success", "hook_triggered", "helper_triggered",
    "unexpected_outside_edit_success", "unexpected_outside_read_success", "missing_read_argument_success"]) {
    const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, mode), cli: f.cli, env: f.env,
      cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
      spawn: observedSpawn(mode), probeSpawn: authSpawn() })
    assert.equal(result.state, "blocked", mode)
    assert.equal(result.cases.some((row) => row.result === "failed"), true)
    assert.equal(result.resources.launches, 1)
  }
})

test("global_success_audit_allows_only_known_prepared_relative_and_default_search_scope", async (t) => {
  const f = await fixture(t)
  for (const mode of ["implicit_search", "relative_read", "directory_search"]) {
    const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, mode), cli: f.cli, env: f.env,
      cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
      spawn: observedSpawn(mode), probeSpawn: authSpawn() })
    assert.equal(result.state, "qualified", mode)
  }
})

test("R6_3_sign_in_or_final_diagnostic_mutation_never_spends_a_model_launch", async (t) => {
  for (const mutation of ["input_bytes", "input_inode", "result_inode", "directory_inode", "input_symlink", "result_bytes"]) {
    const f = await fixture(t), q = await qualification(f), child = childSpawn(f)
    const mutate = () => {
      const inputFile = path.join(f.inputDir, "input.json")
      if (mutation === "input_bytes") writeFileSync(inputFile, JSON.stringify({ ...brief, batch: "b".repeat(16) }))
      if (mutation === "input_inode" || mutation === "result_inode") {
        const file = mutation === "input_inode" ? inputFile : f.resultFile
        const bytes = readFileSync(file); fsNative.renameSync(file, file + "-prior"); writeFileSync(file, bytes)
      }
      if (mutation === "directory_inode") {
        fsNative.renameSync(f.inputDir, f.inputDir + "-prior")
        fsNative.mkdirSync(f.inputDir)
        writeFileSync(inputFile, JSON.stringify(brief)); writeFileSync(f.resultFile, "{}")
      }
      if (mutation === "input_symlink") { fsNative.renameSync(inputFile, inputFile + "-prior"); symlinkSync(inputFile + "-prior", inputFile) }
      if (mutation === "result_bytes") writeFileSync(f.resultFile, '{"replaced":true}')
    }
    const auth = authSpawn()
    q.probeSpawn = (...args) => { mutate(); return auth(...args) }
    const result = await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })
    assert.equal(result.state, "scope_changed", mutation)
    assert.equal(child.calls.length, 0, mutation + " must block before spending")
    assert.equal(q.invalidated, true)
  }
  const f = await fixture(t), q = await qualification(f), child = childSpawn(f)
  let calls = 0
  q.runDiagnostic = async () => {
    calls += 1
    if (calls === 2) writeFileSync(path.join(f.inputDir, "input.json"), JSON.stringify({ ...brief, batch: "c".repeat(16) }))
    return diagnostic()
  }
  assert.equal((await runner.runTriageChild({ ...f, qualification: q, spawn: child.spawn })).state, "scope_changed")
  assert.equal(child.calls.length, 0)
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
    assert.equal(result.sources.filter((source) => source.path.endsWith(".json") && source.kind === "managed").length >= 3, true)
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
    policyReaders: { read: (request) => ({ ...readers.read(request), sources: [{ ...readers.read(request).sources[0], settings: { permissions: {} } }] }) },
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

test("R6_1_default_platform_provenance_connects_signed_installed_runtime_without_engine_copy", () => {
  // This is a non-model native/platform inspection, not an injected resolver.
  // On unsupported platforms the production adapter must explicitly hold.
  const cli = path.join(process.env.DESK_TEST_REAL_HOME, ".local", "share", "claude", "versions", "2.1.296")
  const result = runner.inspectLaunchChain({ cli, env: process.env })
  if (process.platform === "darwin" && fsNative.existsSync(cli)) {
    assert.equal(result.state, "inspected")
    assert.equal(result.platform.kind, "macos-signed-runtime")
    assert.equal(result.platform.sealed, true)
    assert.match(result.platform.cache_uuid, /^[a-f0-9]{32}$/)
    assert.equal(result.platform.dependencies.includes("/usr/lib/libSystem.B.dylib"), true)
  } else assert.equal(result.state, "scope_unqualified")
})

test("R6_4_generic_outside_refusals_are_not_customization_qualification", async (t) => {
  const f = await fixture(t)
  const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, "generic-only"), cli: f.cli, env: f.env,
    cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
    spawn: observedSpawn("generic_outside_only"), probeSpawn: authSpawn() })
  assert.equal(result.state, "blocked")
})

test("R6_1_default_reader_rejects_user_helpers_before_any_diagnostic", async (t) => {
  const f = await fixture(t)
  const configDir = path.join(f.env.HOME, ".claude")
  fsNative.mkdirSync(configDir)
  writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ apiKeyHelper: "must never execute", permissions: { allow: ["Edit"] } }))
  let diagnosticCalls = 0
  const result = await runner.collectTriageAdmission({ ...f, argv: [],
    runDiagnostic: async () => { diagnosticCalls += 1; return diagnostic() } })
  assert.equal(result.reason, "active_hook_or_helper")
  assert.equal(diagnosticCalls, 0)
})

test("R6_4_missing_authentic_policy_targets_or_capabilities_cannot_qualify", async (t) => {
  const f = await fixture(t)
  for (const mode of ["missing-target", "missing-capabilities", "capabilities-unproved"]) {
    const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, mode), cli: f.cli, env: f.env,
      cliMetadata: metadata, resolveExec: f.resolveExec, runDiagnostic: diagnostic,
      policyReaders: { read: (request) => {
        const evidence = readers.read(request)
        if (mode === "missing-target") delete evidence.sources[0].path
        if (mode === "missing-capabilities") delete evidence.capabilities
        if (mode === "capabilities-unproved") evidence.capabilities = {}
        return evidence
      } }, spawn: observedSpawn(), probeSpawn: authSpawn() })
    assert.equal(result.state, "blocked")
  }
})

test("R6_1_native_platform_adapter_rejects_each_unverified_platform_dimension", async (t) => {
  const f = await fixture(t)
  const realRead = fsNative.readFileSync, realPath = fsNative.realpathSync, realList = fsNative.readdirSync, realStat = fsNative.lstatSync, realOpen = fsNative.openSync
  const platform = Object.getOwnPropertyDescriptor(process, "platform"), arch = Object.getOwnPropertyDescriptor(process, "arch")
  let mode = "valid"
  const binary = Buffer.alloc(192)
  binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(1, 16)
  binary.writeUInt32LE(0xc, 32); binary.writeUInt32LE(160, 36); binary.writeUInt32LE(24, 40); binary.write("/usr/lib/probe.dylib", 56)
  const cache = Buffer.alloc(160); cache.write("dyld_v1  arm64e"); cache.fill(1, 88, 104); cache.writeBigUInt64LE(1n, 128)
  const cacheFixture = path.join(f.dir, "cache"); writeFileSync(cacheFixture, cache)
  t.mock.method(fsNative, "readFileSync", (file, ...args) => {
    if (String(file) === f.cli) return binary
    if (String(file).endsWith("dyld_shared_cache_arm64e")) {
      const value = Buffer.from(cache)
      if (mode === "bad_magic") value.write("invalid")
      if (mode === "missing_loader") value.writeBigUInt64LE(0n, 128)
      return value
    }
    if (String(file).endsWith("dyld_shared_cache_arm64e.map")) return Buffer.from(mode === "missing_dependency" ? "" : "/usr/lib/probe.dylib\n")
    if (String(file) === "/usr/lib/dyld") { const value = Buffer.alloc(32); value.writeUInt32BE(0xcafebabe); return value }
    return realRead(file, ...args)
  })
  t.mock.method(fsNative, "realpathSync", (file, ...args) => {
    if (String(file) === "/usr/lib/probe.dylib") throw Object.assign(new Error("not on disk"), { code: mode === "unreadable_dependency" ? "EACCES" : "ENOENT" })
    if (String(file) === "/usr/lib/dyld") return String(file)
    return realPath(file, ...args)
  })
  t.mock.method(fsNative, "readdirSync", (file, ...args) => {
    if (String(file).endsWith("/System/Library/dyld")) return mode === "oversize_inventory" ?
      Array.from({ length: 129 }, (_, i) => `dyld_shared_cache_arm64e.${i}`) : ["dyld_shared_cache_arm64e", "dyld_shared_cache_arm64e.map"]
    return realList(file, ...args)
  })
  t.mock.method(fsNative, "lstatSync", (file, ...args) => {
    if (String(file).includes("/System/Library/dyld/")) return { isFile: () => mode !== "not_cache_file",
      uid: mode === "wrong_owner" ? 501 : 0, mode: mode === "writable_cache" ? 0o777 : 0o755, dev: 1, ino: 2, size: 160, ctimeMs: 1 }
    return realStat(file, ...args)
  })
  t.mock.method(fsNative, "openSync", (file, ...args) => realOpen(String(file).includes("/System/Library/dyld/") ? cacheFixture : file, ...args))
  t.mock.method(childProcess, "execFileSync", (command, args, opts) => {
    assert.equal(opts.timeout, 5000)
    assert.equal(opts.env.DESK_FACTORY_HEADLESS, "1")
    if (command.endsWith("codesign")) {
      assert.equal(args[0], "--verify")
      if (mode === "bad_signature") throw new Error("signature rejected")
      return ""
    }
    if (command.endsWith("diskutil")) return "root-plist"
    if (command.endsWith("plutil")) return JSON.stringify({ Sealed: mode === "unsealed" ? "No" : "Yes",
      WritableVolume: mode === "writable_root", MountPoint: mode === "wrong_root" ? "/other" : "/",
      APFSSnapshotUUID: mode === "unknown_snapshot" ? "" : "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" })
    if (command.endsWith("csrutil")) {
      if (args[0] === "status") return mode === "sip_disabled" ? "disabled" : "System Integrity Protection status: enabled."
      return mode === "root_auth_disabled" ? "disabled" : "Authenticated Root status: enabled"
    }
    assert.equal(command, "/usr/bin/sw_vers")
    return mode === "unknown_build" ? "unknown build with spaces" : "26A434"
  })
  syncBuiltinESMExports()
  t.after(() => { Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", arch); t.mock.restoreAll(); syncBuiltinESMExports() })
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  Object.defineProperty(process, "arch", { value: "arm64", configurable: true })
  assert.equal(runner.inspectLaunchChain({ ...f, resolveExec: undefined }).state, "inspected")
  for (const next of ["bad_signature", "unsealed", "writable_root", "wrong_root", "unknown_snapshot", "sip_disabled",
    "root_auth_disabled", "unknown_build", "bad_magic", "missing_loader", "missing_dependency", "oversize_inventory",
    "not_cache_file", "wrong_owner", "writable_cache", "unreadable_dependency"]) {
    mode = next
    assert.equal(runner.inspectLaunchChain({ ...f, resolveExec: undefined }).state, "scope_unqualified", next)
  }
  mode = "valid"
  Object.defineProperty(process, "platform", { value: "linux", configurable: true })
  assert.equal(runner.inspectLaunchChain({ ...f, resolveExec: undefined }).state, "scope_unqualified")
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  Object.defineProperty(process, "arch", { value: "x64", configurable: true })
  assert.equal(runner.inspectLaunchChain({ ...f, resolveExec: undefined }).state, "scope_unqualified")
})

test("R6_1_default_policy_adapter_connects_native_source_plists_mcp_and_resolved_delivery", async (t) => {
  const f = await fixture(t), policy = runner.triagePolicy({ ...f, cliMetadata: metadata })
  const realRead = fsNative.readFileSync, realHash = cryptoNative.createHash
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  let mode = "valid", converted = 0
  // Controlled parser boundary only: simulate the pinned signed source bytes
  // and OS plist converter here. The independent actual installed-host
  // non-model assertion is retained outside Git; this is NOT native proof.
  t.mock.method(cryptoNative, "createHash", (...args) => {
    const hash = realHash(...args); let engine = false
    return { update(value) { engine = Buffer.isBuffer(value) && value.toString() === "PINNED_ENGINE_FIXTURE"; hash.update(value); return this },
      digest(format) { return engine ? "c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937" : hash.digest(format) } }
  })
  t.mock.method(fsNative, "readFileSync", (file, ...args) => {
    const name = String(file)
    if (name === f.cli) return Buffer.from("PINNED_ENGINE_FIXTURE")
    if (name.endsWith("com.anthropic.claudecode.plist")) return mode === "oversize_os_policy" ? Buffer.alloc(2 * 1024 * 1024 + 1) : Buffer.from("native-plist-fixture")
    if (name.endsWith("remote-settings.json")) return Buffer.from(mode === "cache_invalid" ? "true" : mode === "cache_unresolved" ? '{"unknownCache":true}' : "{}")
    if (name.endsWith("managed-settings.json") && mode === "managed_invalid") return Buffer.from("true")
    if (name.endsWith("managed-mcp.json")) return Buffer.from(mode === "mcp_widens" ? '{"mcpServers":{"outside":{"command":"never"}}}' : '{"mcpServers":{}}')
    if (name === path.join(f.env.HOME, ".claude", "settings.json")) {
      if (mode === "oversize_user") return Buffer.alloc(2 * 1024 * 1024 + 1)
      if (mode === "invalid_user") return Buffer.from("invalid-json")
      if (mode === "malformed_user") return Buffer.from('{"hooks":{"ignored":"not executed"}}')
      return Buffer.from(mode === "user_provider" ? '{"env":{"ANTHROPIC_API_KEY":"do-not-copy"}}' :
        '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"not executed"}]}]},"permissions":{"allow":["Edit"]},"theme":"ignored"}')
    }
    return realRead(file, ...args)
  })
  t.mock.method(childProcess, "execFileSync", (command, args, opts) => {
    if (command.endsWith("codesign")) {
      assert.ok(args.includes("--strict")); assert.ok(args.includes("-R"))
      if (mode === "invalid_signature") throw new Error("unsigned")
      return ""
    }
    assert.equal(command, "/usr/bin/plutil"); assert.equal(opts.input.toString(), "native-plist-fixture")
    converted += 1
    return mode === "os_invalid" ? "true" : mode === "os_helper" ? '{"policyHelpers":{"darwin":{"command":"never"}}}' : "{}"
  })
  syncBuiltinESMExports()
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  t.after(() => { Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports() })
  const admitted = await runner.collectTriageAdmission({ ...f, argv: policy.argv, runDiagnostic: diagnostic })
  assert.equal(admitted.state, "admitted")
  assert.equal(admitted.capabilities.result_is_data_only, true)
  assert.equal(admitted.sources.filter((source) => source.kind === "os").length, 2)
  assert.ok(converted >= 4, "actual native-listed OS sources are inspected before and after doctor")
  for (const next of ["managed_invalid", "cache_invalid", "os_invalid", "malformed_user"]) {
    mode = next
    let calls = 0
    const rejected = await runner.collectTriageAdmission({ ...f, argv: policy.argv,
      runDiagnostic: async () => { calls += 1; return diagnostic() } })
    assert.equal(rejected.state, "scope_unqualified", next)
    assert.deepEqual(rejected.validation_errors, ["invalid_policy_document"], next)
    assert.equal(rejected.capabilities, null, next)
    assert.equal(calls, 0, next)
  }
  for (const [next, reason] of [["oversize_os_policy", "effective_policy_unknown"], ["oversize_user", "effective_policy_unknown"],
    ["invalid_user", "effective_policy_unknown"], ["invalid_signature", "effective_policy_unknown"],
    ["user_provider", "billing_unresolved"], ["os_helper", "active_hook_or_helper"],
    ["mcp_widens", "unsafe_permission_grant"], ["cache_unresolved", "effective_policy_unknown"]]) {
    mode = next
    assert.equal((await runner.collectTriageAdmission({ ...f, argv: policy.argv, runDiagnostic: diagnostic })).reason, reason, next)
  }
  mode = "valid"
  for (const flag of ["--restricted", "--safe-mode", "--strict-mcp-config"]) {
    assert.equal((await runner.collectTriageAdmission({ ...f, argv: policy.argv.filter((value) => value !== flag), runDiagnostic: diagnostic })).state, "scope_unqualified")
  }
  assert.equal((await runner.collectTriageAdmission({ ...f, argv: policy.argv,
    runDiagnostic: async () => ({ kind: "closed", code: 0, stdout: "Managed settings (remote): loaded" }) })).state, "scope_unqualified")
  assert.equal((await runner.collectTriageAdmission({ ...f, argv: policy.argv,
    runDiagnostic: async () => ({ kind: "closed", code: 0, stdout: "Managed settings (remote): none configured for this organization" }) })).state, "admitted")
})

test("R6_4_refusal_of_an_admitted_absent_policy_source_still_requires_real_triggers", async (t) => {
  const f = await fixture(t)
  const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, "absent-policy"), cli: f.cli, env: f.env,
    cliMetadata: metadata, resolveExec: f.resolveExec, runDiagnostic: diagnostic,
    policyReaders: { read: (request) => {
      const evidence = readers.read(request)
      evidence.sources[0].path = path.join(f.dir, "not-installed-managed-policy.json")
      evidence.sources[0].revision = hash("absent")
      return evidence
    } }, spawn: observedSpawn(), probeSpawn: authSpawn() })
  assert.equal(result.state, "qualified")
  assert.equal(result.cases.find((row) => row.operation === "policy_mutation").bytes_unchanged, null)
  assert.equal(result.cases.filter((row) => row.operation === "customization_dispatch").every((row) =>
    row.enforcement === "capability_absent" && row.attempted), true)
})

test("R6_5_actual_search_patterns_paths_and_returned_matches_cannot_escape_globally", async (t) => {
  const f = await fixture(t)
  for (const mode of ["glob_absolute_outside", "glob_absolute_override", "glob_parent_escape",
    "glob_safe_pattern_outside_match", "glob_symlink_prefix_escape", "glob_relative_symlink_match",
    "grep_default_outside_match", "grep_count_outside_match", "grep_symlink_path_escape", "read_parent_escape",
    "grep_content_outside_match", "grep_context_outside_match", "grep_unnumbered_outside_match", "grep_count_alias_outside_match"]) {
    const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, mode), cli: f.cli, env: f.env,
      cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
      spawn: observedSpawn(mode), probeSpawn: authSpawn() })
    assert.equal(result.state, "blocked", mode)
    assert.equal(result.cases.some((row) => row.result === "failed"), true)
  }
})

test("R6_5_genuine_safe_relative_default_absolute_override_and_content_searches_remain_valid", async (t) => {
  const f = await fixture(t)
  for (const mode of ["safe_glob_relative", "safe_glob_absolute_override", "safe_glob_parent_normalized",
    "safe_grep_content", "safe_grep_default", "safe_grep_unnumbered", "safe_grep_context",
    "safe_grep_file_content", "safe_grep_count_alias", "native_glob_probe_shape"]) {
    const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, mode), cli: f.cli, env: f.env,
      cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
      spawn: observedSpawn(mode), probeSpawn: authSpawn() })
    assert.equal(result.state, "qualified", mode)
  }
})

test("R6_5_unknown_search_shapes_and_unresolvable_paths_fail_closed_without_rejecting_native_safe_results", async (t) => {
  const f = await fixture(t), real = fsNative.realpathSync
  t.mock.method(fsNative, "realpathSync", (name, ...args) => {
    if (name === "/permission-unknown") throw Object.assign(new Error("private error"), { code: "EACCES" })
    if (name === "/no-ancestor" || name === "/") throw Object.assign(new Error("private error"), { code: "ENOENT" })
    return real(name, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  for (const mode of ["read_no_input", "read_null_path", "read_nul_path", "read_home_escape", "read_home_root_escape",
    "read_permission_unknown", "read_no_ancestor", "glob_empty_pattern", "glob_missing_pattern",
    "glob_root_pattern", "glob_invalid_search_path", "glob_invalid_content", "glob_untyped_content", "grep_invalid_mode",
    "grep_unknown_content", "grep_empty_filename", "grep_invalid_count", "safe_glob_plain", "safe_glob_plain_absolute",
    "safe_glob_no_match", "safe_grep_list_alias", "safe_grep_count_string_alias", "safe_grep_file_alias",
    "safe_grep_missing_file"]) {
    const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, mode), cli: f.cli, env: f.env,
      cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
      spawn: observedSpawn(mode), probeSpawn: authSpawn() })
    assert.equal(result.state, mode.startsWith("safe_") ? "qualified" : "blocked", mode)
  }
  const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, "missing-home"), cli: f.cli,
    env: { ...f.env, HOME: undefined }, cliMetadata: metadata, resolveExec: f.resolveExec,
    policyReaders: readers, runDiagnostic: diagnostic, spawn: observedSpawn("read_home_escape"), probeSpawn: authSpawn() })
  assert.equal(result.state, "blocked")
})

test("R6_5_ambiguous_filename_delimiters_do_not_hide_sibling_matches", async (t) => {
  const f = await fixture(t)
  for (const mode of ["grep_unnumbered_sibling_match", "grep_numbered_sibling_match"]) {
    await t.test(mode, async () => {
      const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, mode), cli: f.cli, env: f.env,
        cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
        spawn: observedSpawn(mode), probeSpawn: authSpawn() })
      assert.equal(result.state, "blocked")
    })
  }
})

test("R6_5_native_tool_input_normalization_cannot_hide_success_after_refused_outside_probe", async (t) => {
  const f = await fixture(t)
  for (const mode of ["padded_read_outside", "unicode_whitespace_read_outside", "padded_read_home",
    "padded_read_parent", "unstable_read_after_dot_resolution", "padded_edit_outside", "padded_grep_outside", "padded_grep_alias_outside",
    "padded_glob_path_outside", "glob_derived_dir_trim_escape", "glob_absolute_nul_dir", "literal_result_symlink_with_spaces"]) {
    await t.test(mode, async () => {
      const out = path.join(f.dir, mode)
      const result = await qualifier.qualifyTriageRunner({ out, cli: f.cli, env: f.env,
        cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: normalizationReaders(out, mode), runDiagnostic: diagnostic,
        spawn: observedSpawn(mode), probeSpawn: authSpawn() })
      assert.equal(result.state, "blocked", mode)
      assert.equal(result.cases.filter((row) => row.operation !== "customization_dispatch").every((row) => row.result === "failed"), true)
      assert.equal(result.cases.find((row) => row.operation === "prepared_trigger_read").enforcement, "succeeded")
      assert.equal(result.cases.find((row) => row.operation === "permitted_result_trigger").enforcement, "succeeded")
      if (mode === "padded_read_outside") {
        const stream = JSON.parse(readFileSync(path.join(out, "stream-1.json"))).stdout.trim().split("\n").map((line) => JSON.parse(line))
        const blocks = stream.flatMap((event) => event.message?.content ?? [])
        const calls = blocks.filter((block) => block.type === "tool_use" && block.name === "Read")
        const refused = calls.find((call) => call.input.path === path.join(out, "outside.txt"))
        const success = calls.find((call) => call.input.file_path === " /outside/private ")
        assert.equal(blocks.find((block) => block.tool_use_id === refused.id).is_error, true)
        assert.equal(blocks.find((block) => block.tool_use_id === success.id).is_error, false)
        assert.ok(calls.indexOf(success) > calls.indexOf(refused), "later contradictory success must invalidate the earlier refused probe")
      }
    })
  }
})

test("R6_5_native_normalized_probe_inputs_match_but_returned_filenames_remain_literal", async (t) => {
  const f = await fixture(t)
  for (const mode of ["normalization_probe_inputs", "safe_padded_read", "safe_padded_edit", "safe_blank_grep_path",
    "safe_padded_glob_path", "safe_relative_glob_pattern_spaces", "safe_literal_result_spaces",
    "safe_literal_result_tilde", "safe_posix_backslash", "safe_unicode_slash"]) {
    await t.test(mode, async () => {
      const out = path.join(f.dir, `${mode}-\u00e9`)
      const result = await qualifier.qualifyTriageRunner({ out, cli: f.cli, env: f.env,
        cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: normalizationReaders(out, mode), runDiagnostic: diagnostic,
        spawn: observedSpawn(mode), probeSpawn: authSpawn() })
      assert.equal(result.state, "qualified", mode)
      assert.equal(result.cases.every((row) => row.result === "passed"), true)
    })
  }
})

test("R6_5_probe_correlation_does_not_collapse_a_literal_glob_filter_tail", async (t) => {
  const f = await fixture(t)
  const result = await qualifier.qualifyTriageRunner({ out: path.join(f.dir, "literal-pattern-tail"), cli: f.cli, env: f.env,
    cliMetadata: metadata, resolveExec: f.resolveExec, policyReaders: readers, runDiagnostic: diagnostic,
    spawn: observedSpawn("glob_literal_pattern_tail"), probeSpawn: authSpawn() })
  assert.equal(result.state, "blocked")
  assert.equal(result.cases.find((row) => row.operation === "outside_Glob").enforcement, "not_exercised")
})

// Prepare real filename fixtures before the runner captures directory nlink.
// APFS counts file entries too; adding them during a fake model call would
// instead exercise input drift and falsely label it a search-audit rejection.
function normalizationReaders(out, mode) {
  let prepared = false
  return { read: (request) => {
    const inputDir = path.join(out, "input")
    const filename = mode === "safe_literal_result_spaces" ? " link-out " :
      mode === "safe_literal_result_tilde" ? "~" : mode === "literal_result_symlink_with_spaces" ? " link-with-spaces " :
        mode === "safe_posix_backslash" ? "\\outside\\private" : mode === "safe_unicode_slash" ? "\uff0foutside\uff0fprivate" : null
    if (filename && !prepared) {
      if (mode === "literal_result_symlink_with_spaces") symlinkSync(path.join(out, "outside.txt"), path.join(inputDir, filename))
      else writeFileSync(path.join(inputDir, filename), "prepared literal bytes")
      prepared = true
    }
    return readers.read(request)
  } }
}

test("R6_6_policy_documents_and_supported_value_types_require_validation_before_admission", async (t) => {
  const f = await fixture(t)
  for (const settings of [true, 1, "private malformed prose", [], null,
    { permissions: true }, { permissions: { allow: "Read" } }, { permissions: { deny: [true] } },
    { disableAllHooks: "true" }, { hooks: true }, { hooks: { SessionStart: "not an array" } },
    { hooks: { SessionStart: [{ hooks: "not an array" }] } },
    { hooks: { SessionStart: [{ matcher: 7, hooks: [] }] } },
    { env: true }, { env: { SECRET: 7 } }, { mcpServers: true }, { mcpServers: { server: false } }]) {
    let calls = 0
    const result = await runner.collectTriageAdmission({ ...f, argv: [],
      runDiagnostic: async () => { calls += 1; return diagnostic() },
      policyReaders: { read: () => ({ ...readers.read(), sources: [{ ...source, settings }] }) } })
    assert.equal(result.state, "scope_unqualified", JSON.stringify(settings))
    assert.deepEqual(result.validation_errors, ["invalid_policy_document"])
    assert.equal(calls, 0)
    assert.equal(JSON.stringify(result).includes("private malformed prose"), false)
    assert.equal(result.capabilities, null)
  }
})

test("R6_6_post_diagnostic_validation_errors_are_fixed_code_and_invalidate_admission", async (t) => {
  const f = await fixture(t)
  let calls = 0
  const result = await runner.collectTriageAdmission({ ...f, argv: [], runDiagnostic: diagnostic,
    policyReaders: { read: () => ({ ...readers.read(), validation_errors: ++calls === 1 ? [] : ["private error detail"] }) } })
  assert.equal(calls, 2)
  assert.equal(result.state, "scope_unqualified")
  assert.deepEqual(result.validation_errors, ["invalid_effective_settings"])
  assert.equal(result.capabilities, null)
  assert.equal(JSON.stringify(result).includes("private error detail"), false)
})

test("R6_6_native_invalid_settings_diagnostic_never_admits_or_echoes_private_errors", async (t) => {
  const f = await fixture(t)
  for (const label of ["Invalid settings", "\u001b[33mInvalid settings\u001b[39m"]) {
    const result = await runner.collectTriageAdmission({ ...f, argv: [], policyReaders: readers,
      runDiagnostic: async () => ({ kind: "closed", code: 0, stdout: doctor + `\n${label}\n- private raw policy value\n` }) })
    assert.equal(result.state, "scope_unqualified")
    assert.deepEqual(result.validation_errors, ["invalid_native_settings"])
    assert.equal(JSON.stringify(result).includes("private raw policy"), false)
    assert.equal(result.capabilities, null)
  }
})
