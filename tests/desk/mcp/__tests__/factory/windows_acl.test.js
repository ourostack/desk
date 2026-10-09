// Windows ACL primitive for private state (the readiness journal and the factory outbox).
//
// Two layers of proof live here:
//
//  1. Adapter proof (runs everywhere). The helper's argument handling, its
//     command construction, and its refusal to accept a success-shaped result
//     that was not actually verified. Some of these drive a real child process
//     through a stand-in provider executable, so the spawn/stdin/stdout/exit
//     path is genuinely exercised on POSIX hosts rather than stubbed.
//  2. Native proof (Windows only, skipped elsewhere). Real NTFS ACLs on real
//     directories and files. Nothing below claims a stand-in provider proves
//     anything about NTFS — only the win32 test does that.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn as spawnProcess, spawnSync } from "node:child_process"

import {
  assertWindowsAclAvailable,
  protectWindowsPaths,
} from "../../../../../plugins/desk/mcp/src/factory/windows-acl.js"
import { nativeProbe, writePosixNodeProvider } from "./_private_state_helpers.js"

const PROVIDER_SEGMENTS = ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"]
const isWindows = process.platform === "win32"
const posixProvider = { skip: isWindows ? "stand-in executable uses a POSIX shebang; native Windows transport is tested separately" : false }

async function mkBase() {
  return fs.mkdtemp(path.join(os.tmpdir(), "desk-winacl-"))
}

/**
 * A stand-in provider executable at the exact location the helper resolves.
 * It is NOT PowerShell and proves nothing about NTFS — it exists so the real
 * spawn/stdin/stdout/exit-code path can be exercised on POSIX hosts.
 */
async function mkProvider(base, body) {
  const dir = path.join(base, ...PROVIDER_SEGMENTS.slice(0, -1))
  await fs.mkdir(dir, { recursive: true })
  const providerPath = path.join(dir, PROVIDER_SEGMENTS.at(-1))
  await writePosixNodeProvider(providerPath, body)
  return providerPath
}

// The provider is a long-lived process: one request per line in, one answer per line out, until stdin closes.
const ECHO_PROVIDER = `
const readline = require("node:readline")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  const results = request.paths.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    owner_sid: "S-1-5-21-1111111111-2222222222-3333333333-1001",
    owner_reassigned: false,
    protected: true,
    rule_count: 1,
  }))
  process.stdout.write(JSON.stringify({ status: "ok", results }) + "\\n")
})
`

const DIR_ENTRY = { path: "C:\\Users\\participant\\state\\feedback", kind: "directory", created: true }
const FILE_ENTRY = { path: "C:\\Users\\participant\\state\\feedback\\feedback.sqlite", kind: "file", created: true }

function runnerReturning(response, { code = 0, stderr = "" } = {}) {
  const calls = []
  const runner = async (invocation) => {
    calls.push(invocation)
    return { code, stdout: typeof response === "string" ? response : JSON.stringify(response), stderr }
  }
  runner.calls = calls
  return runner
}

test("assertWindowsAclAvailable resolves the fixed provider under SystemRoot", async () => {
  const base = await mkBase()
  try {
    const providerPath = await mkProvider(base, ECHO_PROVIDER)
    assert.equal(assertWindowsAclAvailable({ env: { SystemRoot: base } }), providerPath)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("assertWindowsAclAvailable finds SystemRoot under any capitalization, as a Git Bash child's copied environment spells it", async () => {
  const base = await mkBase()
  try {
    const providerPath = await mkProvider(base, ECHO_PROVIDER)
    for (const name of ["SYSTEMROOT", "systemroot", "SystemRoot"]) {
      assert.equal(assertWindowsAclAvailable({ env: { [name]: base } }), providerPath, name)
    }
    assert.throws(() => assertWindowsAclAvailable({ env: { SystemRoot: 5, SYSTEMROOT: undefined } }), /%SystemRoot% to locate/u, "a value that is not text is not a SystemRoot")
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("a verified path is not protected again until its identity or change time moves, and a path created in this call always is", async () => {
  const base = await mkBase()
  try {
    const dir = path.join(base, "state")
    await fs.mkdir(dir)
    const entry = { path: dir, kind: "directory", created: false }
    const ok = (paths) => ({ status: "ok", results: paths.map((e) => ({ path: e.path, kind: e.kind, owner_sid: "S-1-5-21-1-2-3-1001", owner_reassigned: false, protected: true, rule_count: 1 })) })
    const runner = runnerReturning(ok([entry]))
    const env = { SystemRoot: base }
    await mkProvider(base, ECHO_PROVIDER)
    const first = await protectWindowsPaths([entry], { env, runner, memoize: true })
    const second = await protectWindowsPaths([entry], { env, runner, memoize: true })
    assert.equal(runner.calls.length, 1, "the second call is answered from what was verified")
    assert.deepEqual(second, first)
    // A change to the folder moves its change time, so it is protected again.
    await fs.rm(dir, { recursive: true })
    await fs.mkdir(dir)
    const recreated = runnerReturning(ok([entry]))
    await protectWindowsPaths([entry], { env, runner: recreated, memoize: true })
    assert.equal(recreated.calls.length, 1, "a replaced folder is protected again")
    // created: true is never skipped, and a mixed batch asks only for what is stale.
    const fresh = path.join(base, "fresh")
    await fs.mkdir(fresh)
    const mixed = runnerReturning(ok([{ path: fresh, kind: "directory" }]))
    const results = await protectWindowsPaths([entry, { path: fresh, kind: "directory", created: true }], { env, runner: mixed, memoize: true })
    assert.equal(mixed.calls.length, 1)
    assert.deepEqual(results.map((r) => r.path), [dir, fresh])
    const again = runnerReturning(ok([{ path: fresh, kind: "directory" }]))
    await protectWindowsPaths([{ path: fresh, kind: "directory", created: true }], { env, runner: again, memoize: true })
    assert.equal(again.calls.length, 1, "created: true always runs")
    await fs.rm(fresh, { recursive: true })
    await fs.rm(dir, { recursive: true })
    const gone = runnerReturning(ok([entry]))
    await protectWindowsPaths([entry], { env, runner: gone, memoize: true })
    assert.equal(gone.calls.length, 1, "a path that no longer exists is never answered from memory")
  } finally {
      await fs.rm(base, { recursive: true, force: true })
  }
})

test("a verified file whose change time moved, with the same file id, is protected again", async () => {
  const base = await mkBase()
  try {
    const file = path.join(base, "leaf.json")
    await fs.writeFile(file, "{}")
    const entry = { path: file, kind: "file", created: false }
    const ok = { status: "ok", results: [{ path: file, kind: "file", owner_sid: "S-1-5-21-1-2-3-1001", owner_reassigned: false, protected: true, rule_count: 1 }] }
    const runner = runnerReturning(ok)
    const env = { SystemRoot: base }
    await mkProvider(base, ECHO_PROVIDER)
    await protectWindowsPaths([entry], { env, runner, memoize: true })
    await protectWindowsPaths([entry], { env, runner, memoize: true })
    assert.equal(runner.calls.length, 1, "unchanged: answered from what was verified")
    // The same file, written in place: its id is unchanged and only its change time moves, as an ACL edit moves it.
    const before = (await fs.lstat(file)).ctimeMs
    for (let wait = 5; (await fs.lstat(file)).ctimeMs === before && wait < 2000; wait *= 2) {
      await new Promise((resolve) => setTimeout(resolve, wait))
      await fs.appendFile(file, " ")
    }
    assert.notEqual((await fs.lstat(file)).ctimeMs, before, "the host moved the change time")
    await protectWindowsPaths([entry], { env, runner, memoize: true })
    assert.equal(runner.calls.length, 2, "a moved change time is protected again")
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("a verified file is remembered like a verified folder", async () => {
  const base = await mkBase()
  try {
    const file = path.join(base, "status.json")
    await fs.writeFile(file, "{}")
    const entry = { path: file, kind: "file", created: false }
    const okResult = { status: "ok", results: [{ path: file, kind: "file", owner_sid: "S-1-5-21-1-2-3-1001", owner_reassigned: false, protected: true, rule_count: 1 }] }
    const runner = runnerReturning(okResult)
    const env = { SystemRoot: base }
    await mkProvider(base, ECHO_PROVIDER)
    await protectWindowsPaths([entry], { env, runner, memoize: true })
    await protectWindowsPaths([entry], { env, runner, memoize: true })
    assert.equal(runner.calls.length, 1)
  } finally {
      await fs.rm(base, { recursive: true, force: true })
  }
})

test("identical protection requests made at the same time share one run, and a failed run is not remembered", async () => {
  const base = await mkBase()
  try {
    const dir = path.join(base, "state")
    await fs.mkdir(dir)
    const entry = { path: dir, kind: "directory", created: false }
    const okResult = { status: "ok", results: [{ path: dir, kind: "directory", owner_sid: "S-1-5-21-1-2-3-1001", owner_reassigned: false, protected: true, rule_count: 1 }] }
    const env = { SystemRoot: base }
    await mkProvider(base, ECHO_PROVIDER)
    let calls = 0
    const slow = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { code: 0, stdout: JSON.stringify(okResult), stderr: "", timedOut: false }
    }
    const both = await Promise.all([1, 2, 3].map(() => protectWindowsPaths([entry], { env, runner: slow, memoize: true })))
    assert.equal(calls, 1, "three concurrent requests started one run")
    assert.deepEqual(both[1], both[0])
    // A second folder, because the first is now remembered as verified.
    const other = path.join(base, "other")
    await fs.mkdir(other)
    const otherEntry = { path: other, kind: "directory", created: false }
    const failing = async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false })
    await assert.rejects(protectWindowsPaths([otherEntry], { env, runner: failing, memoize: true }))
    const after = runnerReturning({ status: "ok", results: [{ ...okResult.results[0], path: other }] })
    await protectWindowsPaths([otherEntry], { env, runner: after, memoize: true })
    assert.equal(after.calls.length, 1, "a later request runs again after a failed one")
  } finally {
      await fs.rm(base, { recursive: true, force: true })
  }
})

test("assertWindowsAclAvailable fails when SystemRoot is absent or blank", () => {
  for (const env of [{}, { SystemRoot: "" }, { SystemRoot: "   " }]) {
    assert.throws(() => assertWindowsAclAvailable({ env }), /SystemRoot/u)
  }
})

test("assertWindowsAclAvailable rejects a relative provider root", () => {
  assert.throws(() => assertWindowsAclAvailable({ env: { SystemRoot: "relative-provider" } }), /absolute/u)
})

test("assertWindowsAclAvailable fails when the provider is missing or not a regular file", async () => {
  const base = await mkBase()
  try {
    assert.throws(() => assertWindowsAclAvailable({ env: { SystemRoot: base } }), /not available/u)
    await fs.mkdir(path.join(base, ...PROVIDER_SEGMENTS), { recursive: true })
    assert.throws(
      () => assertWindowsAclAvailable({ env: { SystemRoot: base } }),
      /not a regular file/u,
    )
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("assertWindowsAclAvailable defaults to the ambient environment", () => {
  if (isWindows) {
    assert.match(assertWindowsAclAvailable(), /powershell\.exe$/iu)
    return
  }
  assert.throws(() => assertWindowsAclAvailable(), /SystemRoot|not available/u)
})

test("protectWindowsPaths rejects a malformed batch before touching the provider", async () => {
  const runner = runnerReturning({ status: "ok", results: [] })
  const env = { SystemRoot: "unused" }
  const cases = [
    [null, /array/u],
    [[], /at least one path/u],
    [[null], /object/u],
    [[{ ...DIR_ENTRY, extra: 1 }], /unknown field/u],
    [[{ kind: "directory", created: true }], /path/u],
    [[{ ...DIR_ENTRY, path: "" }], /path/u],
    [[{ ...DIR_ENTRY, path: "relative\\dir" }], /absolute/u],
    [[{ ...DIR_ENTRY, path: "C:\\bad\0name" }], /path/u],
    [[{ ...DIR_ENTRY, kind: "symlink" }], /kind/u],
    [[{ ...DIR_ENTRY, created: "yes" }], /created/u],
    [Array.from({ length: 65 }, () => DIR_ENTRY), /too many/u],
  ]
  for (const [paths, expected] of cases) {
    await assert.rejects(() => protectWindowsPaths(paths, { env, runner }), expected)
  }
  assert.equal(runner.calls.length, 0, "a malformed batch must never reach the provider")
})

test("protectWindowsPaths invokes one fixed, non-interpolating provider command", async () => {
  const base = await mkBase()
  try {
    const providerPath = await mkProvider(base, ECHO_PROVIDER)
    const runner = runnerReturning({
      status: "ok",
      results: [DIR_ENTRY, FILE_ENTRY].map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        owner_sid: "S-1-5-21-9-9-9-1001",
        owner_reassigned: entry.kind === "directory",
        protected: true,
        rule_count: 1,
      })),
    })

    const result = await protectWindowsPaths([DIR_ENTRY, FILE_ENTRY], {
      env: { SystemRoot: base },
      runner,
    })

    assert.equal(runner.calls.length, 1, "one provider process per batch")
    const [call] = runner.calls
    assert.equal(call.executable, providerPath)
    assert.deepEqual(result, [
      {
        path: DIR_ENTRY.path,
        kind: "directory",
        owner_sid: "S-1-5-21-9-9-9-1001",
        owner_reassigned: true,
      },
      {
        path: FILE_ENTRY.path,
        kind: "file",
        owner_sid: "S-1-5-21-9-9-9-1001",
        owner_reassigned: false,
      },
    ])

    assert.ok(call.args.includes("-NoProfile"))
    assert.ok(call.args.includes("-NonInteractive"))
    assert.ok(call.args.includes("-EncodedCommand"))
    for (const forbidden of ["-ExecutionPolicy", "Bypass", "-Command", "RunAs"]) {
      assert.ok(!call.args.includes(forbidden), `${forbidden} must not appear in the argv`)
    }

    const encoded = call.args[call.args.indexOf("-EncodedCommand") + 1]
    const script = Buffer.from(encoded, "base64").toString("utf16le")
    // Protect the DACL and do NOT copy inherited rules, then prove the result
    // was actually applied rather than trusting Set-Acl.
    assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/u)
    assert.match(script, /if \(-not \$applied\.AreAccessRulesProtected\)/u)
    assert.match(script, /ReparsePoint/u)
    // Never load or write the audit section (SACL): that needs SeSecurityPrivilege,
    // which a non-elevated Windows user does not hold, and the Get-Acl and Set-Acl cmdlets touch it.
    assert.match(script, /GetAccessControl\('Access,Owner'\)/u)
    assert.match(script, /\$item\.SetAccessControl\(\$acl\)/u)
    assert.ok(!/\bSet-Acl\b/u.test(script), "Set-Acl would write the audit section")
    assert.ok(!/GetAccessControl\([^)]*Audit/iu.test(script))
    assert.match(script, /FileSystemRights\]::FullControl/u)
    assert.match(script, /\[Console\]::InputEncoding = \$utf8/u)
    assert.match(script, /\[Console\]::OutputEncoding = \$utf8/u)
    assert.ok(!/-ExecutionPolicy|Start-Process|runas/iu.test(script))
    for (const entry of [DIR_ENTRY, FILE_ENTRY]) {
      assert.ok(
        !script.includes(entry.path),
        "paths must travel as JSON data, never interpolated into the program",
      )
    }
    assert.deepEqual(JSON.parse(call.payload), { paths: [DIR_ENTRY, FILE_ENTRY] })
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("protectWindowsPaths refuses every result the provider did not actually verify", async () => {
  const base = await mkBase()
  await mkProvider(base, ECHO_PROVIDER)
  const env = { SystemRoot: base }
  const ok = {
    path: DIR_ENTRY.path,
    kind: "directory",
    owner_sid: "S-1-5-21-9-9-9-1001",
    owner_reassigned: false,
    protected: true,
    rule_count: 1,
  }
  const cases = [
    [{ status: "ok", results: [] }, /reported 0 of 1/u],
    [{ status: "ok", results: [ok, ok] }, /reported 2 of 1/u],
    [{ status: "ok", results: [{ ...ok, path: "C:\\elsewhere" }] }, /different path/u],
    [{ status: "ok", results: [{ ...ok, kind: "file" }] }, /different kind/u],
    [{ status: "ok", results: [{ ...ok, protected: false }] }, /protected/u],
    [{ status: "ok", results: [{ ...ok, rule_count: 2 }] }, /exactly one/u],
    [{ status: "ok", results: [{ ...ok, owner_sid: "administrators" }] }, /owner SID/u],
    [{ status: "ok", results: [{ ...ok, owner_reassigned: "no" }] }, /owner_reassigned/u],
    [{ status: "ok", results: [null] }, /no result for/u],
    [{ status: "ok", results: "nope" }, /results/u],
    [{ status: "weird", results: [ok] }, /unreadable|status/u],
    ["not json at all", /unreadable/u],
    ["", /unreadable/u],
  ]
  for (const [response, expected] of cases) {
    await assert.rejects(
      () => protectWindowsPaths([DIR_ENTRY], { env, runner: runnerReturning(response) }),
      expected,
      `expected refusal for ${JSON.stringify(response)}`,
    )
  }
  await fs.rm(base, { recursive: true, force: true })
})

test("protectWindowsPaths surfaces a provider failure instead of succeeding quietly", async () => {
  const base = await mkBase()
  await mkProvider(base, ECHO_PROVIDER)
  const env = { SystemRoot: base }
  await assert.rejects(
    () =>
      protectWindowsPaths([DIR_ENTRY], {
        env,
        runner: runnerReturning({ status: "error", message: "reparse point refused" }, { code: 1 }),
      }),
    /reparse point refused/u,
  )
  await assert.rejects(
    () =>
      protectWindowsPaths([DIR_ENTRY], {
        env,
        runner: runnerReturning("", { code: 5, stderr: "Get-Acl : access denied" }),
      }),
    /exited with code 5[\s\S]*access denied/u,
  )
  await assert.rejects(
    () => protectWindowsPaths([DIR_ENTRY], { env, runner: runnerReturning("", { code: 9 }) }),
    /exited with code 9: no diagnostic output/u,
    "a silent provider failure must still be an explicit failure",
  )
  await assert.rejects(
    () =>
      protectWindowsPaths([DIR_ENTRY], {
        env,
        runner: async () => {
          throw new Error("spawn ENOENT")
        },
      }),
    /spawn ENOENT/u,
  )
  await fs.rm(base, { recursive: true, force: true })
})

test("protectWindowsPaths drives a real child process over stdin by default", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, ECHO_PROVIDER)
    const result = await protectWindowsPaths([DIR_ENTRY, FILE_ENTRY], {
      env: { SystemRoot: base },
    })
    assert.equal(result.length, 2)
    assert.equal(result[0].path, DIR_ENTRY.path)
    assert.equal(result[1].kind, "file")
    assert.match(result[0].owner_sid, /^S-1-5-21-/u)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("the provider isolates Windows PowerShell module discovery from its parent", posixProvider, async () => {
  const base = await mkBase()
  const keys = ["PSModulePath", "PSMODULEPATH"]
  const previous = keys.map((key) => process.env[key])
  try {
    for (const key of keys) process.env[key] = "incompatible-parent-modules"
    const modules = path.join(base, ...PROVIDER_SEGMENTS.slice(0, -1), "Modules")
    await mkProvider(base, `
const keys = Object.keys(process.env).filter(key => key.toLowerCase() === "psmodulepath");
if (keys.length !== 1 || keys[0] !== "PSModulePath" || process.env.PSModulePath !== ${JSON.stringify(modules)}) {
  process.stdin.resume();
  process.stdout.write(JSON.stringify({status:"error",message:"module discovery was inherited"}) + "\\n");
} else {
  ${ECHO_PROVIDER}
}
`)
    const result = await protectWindowsPaths([DIR_ENTRY], { env: { SystemRoot: base } })
    assert.equal(result[0].path, DIR_ENTRY.path)
    assert.ok(keys.every((key) => process.env[key] === "incompatible-parent-modules"), "the parent's environment must remain unchanged")
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    })
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("the default runner bounds how long it waits and how much it reads", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, `setTimeout(() => {}, 60000)`)
    await assert.rejects(
      () => protectWindowsPaths([DIR_ENTRY], { env: { SystemRoot: base }, timeoutMs: 250 }),
      /timed out/u,
    )
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }

  const noisy = await mkBase()
  try {
    await mkProvider(
      noisy,
      `process.stdin.resume(); process.stdout.write("x".repeat(4096))`,
    )
    await assert.rejects(
      () =>
        protectWindowsPaths([DIR_ENTRY], {
          env: { SystemRoot: noisy },
          maxOutputBytes: 2048,
        }),
      /too much output/u,
    )
  } finally {
    await fs.rm(noisy, { recursive: true, force: true })
  }
})

test("the default runner keeps provider diagnostics and refuses an unrunnable provider", posixProvider, async () => {
  const noisy = await mkBase()
  try {
    await mkProvider(
      noisy,
      `process.stdin.once("data", () => {
  process.stderr.write("WARNING: Set-Acl fell back")
  setTimeout(() => process.exit(3), 20)
})`,
    )
    await assert.rejects(
      () => protectWindowsPaths([DIR_ENTRY], { env: { SystemRoot: noisy } }),
      /exited with code 3[\s\S]*Set-Acl fell back/u,
      "stderr must reach the caller so a provider failure is diagnosable",
    )
  } finally {
    await fs.rm(noisy, { recursive: true, force: true })
  }

  const unrunnable = await mkBase()
  try {
    const providerPath = await mkProvider(unrunnable, ECHO_PROVIDER)
    await fs.chmod(providerPath, 0o644)
    await assert.rejects(
      () => protectWindowsPaths([DIR_ENTRY], { env: { SystemRoot: unrunnable } }),
      /EACCES|EPIPE|spawn/u,
      "a provider that cannot be executed must fail, not resolve",
    )
  } finally {
    await fs.rm(unrunnable, { recursive: true, force: true })
  }
})

test("the default runner reports an error answer and keeps serving the next request", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(
      base,
      `let first = true
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  if (first) {
    first = false
    process.stdout.write(JSON.stringify({ status: "error", message: "owner is not the current user" }) + "\\n")
    return
  }
  const results = request.paths.map((entry) => ({ path: entry.path, kind: entry.kind, owner_sid: "S-1-5-21-1-2-3-1001", owner_reassigned: false, protected: true, rule_count: 1 }))
  process.stdout.write(JSON.stringify({ status: "ok", results }) + "\\n")
})`,
    )
    await assert.rejects(
      () => protectWindowsPaths([DIR_ENTRY], { env: { SystemRoot: base } }),
      /owner is not the current user/u,
    )
    const next = await protectWindowsPaths([DIR_ENTRY], { env: { SystemRoot: base } })
    assert.equal(next[0].path, DIR_ENTRY.path)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("the default runner measures its output budget in UTF-8 bytes", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, `process.stdin.resume(); process.stdout.write("\\u00e9".repeat(800))`)
    await assert.rejects(
      () => protectWindowsPaths([DIR_ENTRY], { env: { SystemRoot: base }, maxOutputBytes: 1000 }),
      /too much output/u,
    )
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

// A stand-in provider that reports its own process id as the owner SID, so a test can tell which process answered.
const PID_PROVIDER = `
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  const results = request.paths.map((entry) => ({ path: entry.path, kind: entry.kind, owner_sid: "S-1-5-21-" + process.pid, owner_reassigned: false, protected: true, rule_count: 1 }))
  process.stdout.write(JSON.stringify({ status: "ok", results }) + "\\n")
})
`
const pidOf = (result) => Number(result.owner_sid.split("-").at(-1))
const entryAt = (n) => ({ path: `C:\\Users\\participant\\state\\file-${n}`, kind: "file", created: true })
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const untilDead = async (pid) => {
  for (let i = 0; i < 100 && isAlive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  return !isAlive(pid)
}

test("one provider process answers many requests, in order, and many requests made at once never cross answers", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, PID_PROVIDER)
    const env = { SystemRoot: base }
    const first = await protectWindowsPaths([entryAt(0)], { env })
    const concurrent = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => protectWindowsPaths([entryAt(n)], { env })))
    concurrent.forEach((result, index) => assert.equal(result[0].path, entryAt(index + 1).path, "each caller gets its own answer"))
    for (const result of concurrent) assert.equal(pidOf(result[0]), pidOf(first[0]), "the same process served every request")
    assert.ok(isAlive(pidOf(first[0])), "the provider stays up between requests")
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("a timeout kills the provider and refuses, and the next request starts a fresh one that works", posixProvider, async () => {
  const base = await mkBase()
  try {
    const marker = path.join(base, "answered-once")
    await mkProvider(base, `
const fs = require("node:fs")
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, process.pid + ""); return }
  const request = JSON.parse(line)
  const results = request.paths.map((entry) => ({ path: entry.path, kind: entry.kind, owner_sid: "S-1-5-21-" + process.pid, owner_reassigned: false, protected: true, rule_count: 1 }))
  process.stdout.write(JSON.stringify({ status: "ok", results }) + "\\n")
})
`)
    const env = { SystemRoot: base }
    // The second request is queued behind the stalled first; it must not be answered by, or lost with, the dead process.
    const stalled = protectWindowsPaths([entryAt(1)], { env, timeoutMs: 6000 })
    const queued = protectWindowsPaths([entryAt(2)], { env, timeoutMs: 20000 })
    await assert.rejects(() => stalled, /desk_feedback: Windows ACL provider timed out after 6000ms/u)
    const answered = await queued
    assert.equal(answered[0].path, entryAt(2).path)
    const stalledPid = Number(await fs.readFile(marker, "utf8"))
    assert.notEqual(pidOf(answered[0]), stalledPid, "a fresh process answered")
    assert.ok(await untilDead(stalledPid), "the stalled provider was killed")
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("a provider that dies between requests is replaced, and a death during a request refuses with its diagnostics", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, `
let served = 0
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  served += 1
  if (served === 2) { process.stderr.write("lost the console"); setTimeout(() => process.exit(5), 20); return }
  const request = JSON.parse(line)
  const results = request.paths.map((entry) => ({ path: entry.path, kind: entry.kind, owner_sid: "S-1-5-21-" + process.pid, owner_reassigned: false, protected: true, rule_count: 1 }))
  process.stdout.write(JSON.stringify({ status: "ok", results }) + "\\n")
})
`)
    const env = { SystemRoot: base }
    const first = await protectWindowsPaths([entryAt(1)], { env })
    await assert.rejects(() => protectWindowsPaths([entryAt(2)], { env }), /exited with code 5: lost the console/u)
    const third = await protectWindowsPaths([entryAt(3)], { env })
    assert.notEqual(pidOf(third[0]), pidOf(first[0]), "the dead process is not reused")
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("an answer with anything after its line, or output nobody asked for, is not trusted and the process is replaced", posixProvider, async () => {
  const base = await mkBase()
  try {
    // The count lives in a file because each refused request replaces the process.
    const counter = path.join(base, "served")
    await mkProvider(base, `
const fs = require("node:fs")
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const served = (fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0) + 1
  fs.writeFileSync(${JSON.stringify(counter)}, String(served))
  const request = JSON.parse(line)
  const results = request.paths.map((entry) => ({ path: entry.path, kind: entry.kind, owner_sid: "S-1-5-21-" + process.pid, owner_reassigned: false, protected: true, rule_count: 1 }))
  const answer = JSON.stringify({ status: "ok", results }) + "\\n"
  if (served === 1) process.stdout.write(answer + "junk")
  else if (served === 2) { process.stdout.write(answer); setTimeout(() => process.stdout.write("a late banner\\n"), 30) }
  else process.stdout.write(answer)
})
`)
    const env = { SystemRoot: base }
    await assert.rejects(() => protectWindowsPaths([entryAt(1)], { env }), /returned unreadable output/u)
    const second = await protectWindowsPaths([entryAt(2)], { env })
    assert.ok(await untilDead(pidOf(second[0])), "a process that speaks out of turn is killed")
    const third = await protectWindowsPaths([entryAt(3)], { env })
    assert.notEqual(pidOf(third[0]), pidOf(second[0]))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("diagnostics on stderr count toward the output budget of the request that caused them", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, `process.stdin.once("data", () => process.stderr.write("w".repeat(4096)))`)
    await assert.rejects(
      () => protectWindowsPaths([entryAt(1)], { env: { SystemRoot: base }, maxOutputBytes: 2048 }),
      /too much output/u,
    )
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("an answer that arrives in pieces is read once it is whole, and diagnostics written while idle are kept quietly", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, `
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  const results = request.paths.map((entry) => ({ path: entry.path, kind: entry.kind, owner_sid: "S-1-5-21-" + process.pid, owner_reassigned: false, protected: true, rule_count: 1 }))
  const answer = JSON.stringify({ status: "ok", results }) + "\\n"
  process.stdout.write(answer.slice(0, 20))
  setTimeout(() => {
    process.stdout.write(answer.slice(20))
    setTimeout(() => process.stderr.write("a warning after the answer"), 10)
  }, 30)
})
`)
    const env = { SystemRoot: base }
    const first = await protectWindowsPaths([entryAt(1)], { env })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const second = await protectWindowsPaths([entryAt(2)], { env })
    assert.equal(pidOf(second[0]), pidOf(first[0]), "a late diagnostic is not an answer and does not replace the process")
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("an idle provider exits by itself and the next request starts another", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, PID_PROVIDER)
    const env = { SystemRoot: base }
    const first = await protectWindowsPaths([entryAt(1)], { env, idleMs: 100 })
    assert.ok(await untilDead(pidOf(first[0])), "the idle provider was stopped")
    const second = await protectWindowsPaths([entryAt(2)], { env, idleMs: 100 })
    assert.notEqual(pidOf(second[0]), pidOf(first[0]))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("the provider never keeps its parent alive and is stopped when the parent exits", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, PID_PROVIDER)
    const module = new URL("../../../../../plugins/desk/mcp/src/factory/windows-acl.js", import.meta.url).href
    const script = `
import { protectWindowsPaths } from ${JSON.stringify(module)}
const result = await protectWindowsPaths([${JSON.stringify(entryAt(1))}], { env: { SystemRoot: ${JSON.stringify(base)} } })
process.stdout.write(result[0].owner_sid)
`
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20000 })
    assert.equal(child.status, 0, child.stderr)
    assert.ok(await untilDead(Number(child.stdout.split("-").at(-1))), "the provider did not outlive its parent")
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

function sequencedRunner(responses) {
  const calls = []
  const runner = async (invocation) => {
    calls.push(invocation)
    const response = responses[Math.min(calls.length, responses.length) - 1]
    return { code: 0, stdout: JSON.stringify(response), stderr: "" }
  }
  runner.calls = calls
  return runner
}
const OK_DIR = { status: "ok", results: [{ path: DIR_ENTRY.path, kind: "directory", owner_sid: "S-1-5-21-1-2-3-1001", owner_reassigned: false, protected: true, rule_count: 1 }] }

test("a readback that caught another process mid-rewrite is protected and verified once more, and a second refusal is final", async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, ECHO_PROVIDER)
    const env = { SystemRoot: base }
    for (const message of ["inherited access rules still apply: C:\\state\\desk", "expected exactly one access rule, found 2: C:\\state\\desk"]) {
      const runner = sequencedRunner([{ status: "error", message }, OK_DIR])
      const result = await protectWindowsPaths([DIR_ENTRY], { env, runner })
      assert.equal(result[0].path, DIR_ENTRY.path)
      assert.equal(runner.calls.length, 2, "one retry, with the same request")
      assert.equal(runner.calls[0].payload, runner.calls[1].payload)

      const stuck = sequencedRunner([{ status: "error", message }])
      await assert.rejects(() => protectWindowsPaths([DIR_ENTRY], { env, runner: stuck }), /inherited access rules still apply|expected exactly one access rule/u)
      assert.equal(stuck.calls.length, 2, "never a third pass")
    }
    // Every other refusal, and an unverified answer, is not retried.
    for (const message of ["refusing a path owned by another user (S-1-5-32-544): x", "refusing a reparse point: x", "access rule grants another identity (S-1-1-0): x"]) {
      const runner = sequencedRunner([{ status: "error", message }, OK_DIR])
      await assert.rejects(() => protectWindowsPaths([DIR_ENTRY], { env, runner }), (error) => error.message.includes(message))
      assert.equal(runner.calls.length, 1, message)
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("requests made at once by one process reach the provider one at a time, so they never rewrite one folder together", posixProvider, async () => {
  const base = await mkBase()
  try {
    // The stand-in answers late, and answers an error if a second request arrives while one is still being worked on.
    await mkProvider(base, `
let busy = false
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  if (busy) { process.stdout.write(JSON.stringify({ status: "error", message: "overlapping requests" }) + "\\n"); return }
  busy = true
  const request = JSON.parse(line)
  setTimeout(() => {
    busy = false
    const results = request.paths.map((entry) => ({ path: entry.path, kind: entry.kind, owner_sid: "S-1-5-21-" + process.pid, owner_reassigned: false, protected: true, rule_count: 1 }))
    process.stdout.write(JSON.stringify({ status: "ok", results }) + "\\n")
  }, 25)
})
`)
    const env = { SystemRoot: base }
    // Same folder, different created flags: the shape that is not shared as one run, as 16 first callers of one state root produce.
    const results = await Promise.all(Array.from({ length: 16 }, (_, n) => protectWindowsPaths([{ ...DIR_ENTRY, created: n === 0 }], { env })))
    assert.equal(results.length, 16)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("native: many callers, in one process and in several, protecting one folder at once all end with the same verified owner-only list", {
  skip: isWindows ? false : "requires a native Windows host",
}, async () => {
  const base = await mkBase()
  try {
    const parent = path.join(base, "state")
    const dir = path.join(parent, "desk")
    await fs.mkdir(dir, { recursive: true })
    const entries = (created) => [
      { path: parent, kind: "directory", created },
      { path: dir, kind: "directory", created },
    ]
    // One process: sixteen callers, the first of which "created" the folders, as sixteen first callers of one state root do.
    const inProcess = await Promise.all(Array.from({ length: 16 }, (_, n) => protectWindowsPaths(entries(n === 0))))
    assert.equal(inProcess.length, 16)
    // Several processes: each runs its own provider, so nothing serializes them; the retry on a half-applied readback is what settles them.
    const module = new URL("../../../../../plugins/desk/mcp/src/factory/windows-acl.js", import.meta.url).href
    const script = `
import { protectWindowsPaths } from ${JSON.stringify(module)}
const entries = ${JSON.stringify(entries(false))}
for (let i = 0; i < 8; i += 1) await protectWindowsPaths(entries, { memoize: false })
`
    const children = Array.from({ length: 6 }, () => new Promise((resolve) => {
      const child = spawnProcess(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] })
      let stderr = ""
      child.stderr.on("data", (chunk) => { stderr += chunk })
      child.on("close", (code) => resolve({ code, stderr }))
    }))
    for (const outcome of await Promise.all(children)) assert.equal(outcome.code, 0, outcome.stderr)
    for (const target of [parent, dir]) {
      const acl = nativeProbe(
        "$a=Get-Acl -LiteralPath $request.path;" +
          "$r=@($a.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]));" +
          "ConvertTo-Json -Compress -InputObject ([pscustomobject]@{protected=$a.AreAccessRulesProtected;count=$r.Count;" +
          "identity=$r[0].IdentityReference.Value;owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value})",
        { path: target },
      )
      assert.equal(acl.protected, true, target)
      assert.equal(acl.count, 1, target)
      assert.equal(acl.identity, acl.owner, target)
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("a provider that never answers costs several waiting callers one limit in total, not one limit each", posixProvider, async () => {
  const base = await mkBase()
  try {
    await mkProvider(base, `process.stdin.resume()`)
    const started = Date.now()
    const outcomes = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => protectWindowsPaths([entryAt(n)], { env: { SystemRoot: base }, timeoutMs: 500 })))
    const elapsed = Date.now() - started
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected")
      assert.match(outcome.reason.message, /desk_feedback: Windows ACL provider timed out after 500ms/u)
    }
    assert.ok(elapsed < 1800, `five callers waited ${elapsed} ms; one limit is 500 ms`)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("two processes protecting one folder at once, each answered a half-applied readback, both settle on one more pass", posixProvider, async () => {
  const base = await mkBase()
  try {
    const shared = path.join(base, "shared")
    await fs.mkdir(shared)
    // Each process runs its own provider. Its first request waits until the other process's request is in flight too, so the two overlap
    // for certain, and is then answered the transient refusal a real overlap produces; the repeat request is answered normally.
    await mkProvider(base, `
const fs = require("node:fs")
const shared = ${JSON.stringify(shared)}
let first = true
require("node:readline").createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line)
  let answer
  if (first) {
    first = false
    fs.writeFileSync(shared + "/inflight-" + process.pid, "")
    for (let i = 0; i < 300 && fs.readdirSync(shared).filter((name) => name.startsWith("inflight-")).length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    const overlapped = fs.readdirSync(shared).filter((name) => name.startsWith("inflight-")).length >= 2
    fs.writeFileSync(shared + "/overlapped-" + process.pid, String(overlapped))
    answer = overlapped ? { status: "error", message: "inherited access rules still apply: " + request.paths[0].path } : null
  }
  fs.appendFileSync(shared + "/requests-" + process.pid, "x")
  answer ??= { status: "ok", results: request.paths.map((entry) => ({ path: entry.path, kind: entry.kind, owner_sid: "S-1-5-21-" + process.pid, owner_reassigned: false, protected: true, rule_count: 1 })) }
  process.stdout.write(JSON.stringify(answer) + "\\n")
})
`)
    const module = new URL("../../../../../plugins/desk/mcp/src/factory/windows-acl.js", import.meta.url).href
    const script = `
import { protectWindowsPaths } from ${JSON.stringify(module)}
await protectWindowsPaths([{ path: "C:\\\\Users\\\\participant\\\\state", kind: "directory", created: false }], { env: { SystemRoot: ${JSON.stringify(base)} } })
`
    const children = [1, 2].map(() => new Promise((resolve) => {
      const child = spawnProcess(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] })
      let stderr = ""
      child.stderr.on("data", (chunk) => { stderr += chunk })
      child.on("close", (code) => resolve({ code, stderr }))
    }))
    for (const outcome of await Promise.all(children)) assert.equal(outcome.code, 0, outcome.stderr)
    const names = await fs.readdir(shared)
    const overlaps = names.filter((name) => name.startsWith("overlapped-"))
    assert.equal(overlaps.length, 2)
    for (const name of overlaps) assert.equal(await fs.readFile(path.join(shared, name), "utf8"), "true", "the two requests were in flight together")
    for (const name of names.filter((n) => n.startsWith("requests-"))) assert.equal((await fs.readFile(path.join(shared, name), "utf8")).length, 2, "each process asked twice: the refused pass and one more")
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

function findPowerShellParser() {
  for (const candidate of ["pwsh", "powershell"]) {
    const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
    if (probe.status === 0) return candidate
  }
  return null
}

async function encodedProgram() {
  const base = await mkBase()
  try {
    await mkProvider(base, ECHO_PROVIDER)
    const runner = runnerReturning({
      status: "ok",
      results: [
        {
          path: DIR_ENTRY.path,
          kind: "directory",
          owner_sid: "S-1-5-21-9-9-9-1001",
          owner_reassigned: false,
          protected: true,
          rule_count: 1,
        },
      ],
    })
    await protectWindowsPaths([DIR_ENTRY], { env: { SystemRoot: base }, runner })
    const { args } = runner.calls[0]
    return Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le")
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
}

// A real PowerShell parser check. It proves the embedded program is syntactically
// valid PowerShell — nothing more. It does NOT execute it and says nothing about
// NTFS behaviour; only the win32 test below does that.
const powerShellParser = findPowerShellParser()
test(
  "the embedded ACL program is syntactically valid PowerShell",
  { skip: powerShellParser ? false : "no PowerShell parser on this host" },
  async () => {
    const script = await encodedProgram()
    const parsed = spawnSync(
      powerShellParser,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$errors = $null;" +
          "[void][System.Management.Automation.Language.Parser]::ParseInput(" +
          "[Console]::In.ReadToEnd(), [ref]$null, [ref]$errors);" +
          "if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }",
      ],
      { input: script, encoding: "utf8" },
    )
    assert.equal(parsed.status, 0, `PowerShell reported a parse error:\n${parsed.stdout}`)
  },
)

test("native: Windows ACL protection refuses junctions without changing their targets", {
  skip: isWindows ? false : "requires a native Windows host",
}, async () => {
  const base = await mkBase()
  try {
    const target = path.join(base, "target")
    const junction = path.join(base, "junction")
    await fs.mkdir(target)
    await fs.symlink(target, junction, "junction")
    const readSddl = "ConvertTo-Json -Compress -InputObject (Get-Acl -LiteralPath $request.path).Sddl"
    const before = nativeProbe(readSddl, { path: target })
    await assert.rejects(
      () => protectWindowsPaths([{ path: junction, kind: "directory", created: false }]),
      /reparse point/u,
    )
    assert.equal(nativeProbe(readSddl, { path: target }), before)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("native: Windows ACL protection distinguishes an existing foreign owner from new default group ownership", {
  skip: isWindows ? false : "requires a native Windows host",
}, async (t) => {
  // Assigning the Administrators group as owner needs the elevated token; a standard user can only own what they own.
  const elevated = nativeProbe(
    "$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent());" +
      "ConvertTo-Json -Compress -InputObject ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))",
    {},
  )
  if (elevated !== true) {
    t.skip("a non-elevated user cannot assign the Administrators group as a folder's owner")
    return
  }
  const base = await mkBase()
  try {
    const target = path.join(base, "new-directory")
    await fs.mkdir(target)
    const assigned = nativeProbe(
      "$a=Get-Acl -LiteralPath $request.path;" +
        "$a.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')));" +
        "Set-Acl -LiteralPath $request.path -AclObject $a;" +
        "$a=Get-Acl -LiteralPath $request.path;" +
        "ConvertTo-Json -Compress -InputObject ([pscustomobject]@{" +
        "owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;sddl=$a.Sddl})",
      { path: target },
    )
    assert.equal(assigned.owner, "S-1-5-32-544")
    await assert.rejects(
      () => protectWindowsPaths([{ path: target, kind: "directory", created: false }]),
      /owned by another user/u,
    )
    assert.equal(nativeProbe(
      "ConvertTo-Json -Compress -InputObject (Get-Acl -LiteralPath $request.path).Sddl",
      { path: target },
    ), assigned.sddl)
    const result = await protectWindowsPaths([{ path: target, kind: "directory", created: true }])
    assert.equal(result[0].owner_reassigned, true)
    assert.notEqual(result[0].owner_sid, assigned.owner)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

// --- Native proof: real NTFS ACLs. Skipped off Windows; nothing above substitutes for it.
test(
  "native: protectWindowsPaths applies and verifies an owner-only NTFS DACL",
  { skip: isWindows ? false : "requires a native Windows host" },
  async () => {
    const base = await mkBase()
    try {
      const dir = path.join(base, "feedback-\u03b4-\u53cd\u9988-'quoted'")
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, "feedback.sqlite")
      await fs.writeFile(file, "")

      const result = await protectWindowsPaths([
        { path: dir, kind: "directory", created: true },
        { path: file, kind: "file", created: true },
      ])
      assert.equal(result.length, 2)

      for (const target of [dir, file]) {
        const acl = nativeProbe(
          "$a=Get-Acl -LiteralPath $request.path;" +
            "$r=@($a.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]));" +
            "ConvertTo-Json -Compress -InputObject ([pscustomobject]@{" +
            "owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;" +
            "protected=$a.AreAccessRulesProtected;count=$r.Count;" +
            "identity=$r[0].IdentityReference.Value;rights=$r[0].FileSystemRights.ToString()})",
          { path: target },
        )
        const self = result[0].owner_sid
        assert.equal(acl.owner, self, `${target} must be owned by the current user`)
        assert.equal(acl.protected, true, `${target} must not inherit rules`)
        assert.equal(acl.count, 1, `${target} must carry exactly one access rule`)
        assert.equal(acl.identity, self)
        assert.match(acl.rights, /FullControl/u)
      }

      await assert.rejects(
        () => protectWindowsPaths([{ path: path.join(base, "missing"), kind: "directory", created: false }]),
        /desk_feedback/u,
      )
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  },
)

test("protectWindowsPaths uses the ambient environment and the real runner when given no options", async () => {
  // An empty batch is refused before either default is used to start a process.
  await assert.rejects(() => protectWindowsPaths([]), /at least one path/u)
})
