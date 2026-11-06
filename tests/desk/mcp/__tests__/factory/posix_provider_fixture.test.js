import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { writePosixNodeProvider } from "./_private_state_helpers.js"

test("POSIX provider shim retains Node options, literal arguments, stdin, diagnostics and exit status", {
  skip: process.platform === "win32" ? "POSIX stand-in contract; native Windows uses the actual provider" : false,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "provider fixture-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const providerPath = path.join(root, "powershell.exe")
  const marker = "--stack-trace-limit=51"
  const priorOptions = process.env.NODE_OPTIONS ?? ""
  const imports = [...priorOptions.matchAll(/--import=(\S+)/gu)].map((match) => match[1])
  await writePosixNodeProvider(providerPath, `
let input = ""
process.stdin.on("data", chunk => { input += chunk })
process.stdin.on("end", () => {
  const options = process.env.NODE_OPTIONS || ""
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2), input,
    marker: options.includes(${JSON.stringify(marker)}),
    inheritedImports: ${JSON.stringify(imports)}.every(value => options.includes(value))
  }))
  process.stderr.write("fixture diagnostic\\n")
  process.exitCode = 7
})
`)
  const args = ["--literal", "spaces here", "quote'\""]
  const result = spawnSync(providerPath, args, {
    cwd: root, encoding: "utf8", input: "fixture input",
    env: { ...process.env, NODE_OPTIONS: `${priorOptions} ${marker}`.trim() },
  })
  assert.equal(result.status, 7, result.stderr)
  assert.equal(result.stderr, "fixture diagnostic\n")
  assert.deepEqual(JSON.parse(result.stdout), {
    args, input: "fixture input", marker: true, inheritedImports: true,
  })
  assert.equal(process.env.NODE_OPTIONS ?? "", priorOptions)
})

const POSIX_ONLY = {
  skip: process.platform === "win32" ? "POSIX stand-in contract; native Windows uses the actual provider" : false,
  timeout: 30000,
}

async function writeWithOptions(providerPath, body, options) {
  const previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = options
  try {
    await writePosixNodeProvider(providerPath, body)
    assert.equal(process.env.NODE_OPTIONS, options, "fixture creation must not rewrite Node options")
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previous
  }
}

async function withOwnedProviders(t, body) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "provider fixture-"))
  const children = []
  t.diagnostic(JSON.stringify({ fixtureRoot: root }))
  const start = (executable, args, env) => {
    const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] })
    const state = { child, stdout: "", stderr: "", error: null, inputError: null }
    child.stdout.setEncoding("utf8").on("data", chunk => { state.stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", chunk => { state.stderr += chunk })
    child.once("error", error => { state.error = error })
    child.stdin.on("error", error => { state.inputError = error })
    state.closed = new Promise(resolve => child.once("close", (code, signal) => {
      t.diagnostic(JSON.stringify({ childPid: child.pid, code, signal, error: state.error?.code ?? null }))
      resolve({ code, signal })
    }))
    state.abort = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
    t.signal.addEventListener("abort", state.abort, { once: true })
    children.push(state)
    t.diagnostic(JSON.stringify({ childPid: child.pid, executable }))
    return state
  }
  try {
    await body(root, start)
  } finally {
    for (const state of children) state.abort()
    await Promise.all(children.map(state => state.closed))
    for (const state of children) t.signal.removeEventListener("abort", state.abort)
    await fs.rm(root, { recursive: true, force: true })
    t.diagnostic(JSON.stringify({ fixtureRemoved: root }))
  }
}

const CONTRACT_BODY = `
const fs = require("node:fs")
fs.writeFileSync(__filename + ".entered", "entered\\n")
let input = ""
process.stdin.on("data", chunk => { input += chunk })
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2), input, filename: __filename,
    cjs: typeof require, nodeOptions: process.env.NODE_OPTIONS || ""
  }))
  process.stderr.write("fixture diagnostic\\n")
  process.exitCode = 7
})
`
const CONTRACT_ARGS = ["--literal", "spaces here", "quote'\""]

async function contractResult(state, providerPath) {
  assert.deepEqual(await state.closed, { code: 7, signal: null }, state.stderr)
  assert.equal(state.error, null)
  assert.equal(state.inputError, null)
  assert.equal(state.stderr, "fixture diagnostic\n")
  const result = JSON.parse(state.stdout)
  assert.deepEqual(result.args, CONTRACT_ARGS)
  assert.equal(result.input, "fixture input")
  assert.equal(result.cjs, "function")
  assert.equal(result.filename, `${providerPath}.cjs`)
  return result
}

test("POSIX provider selects direct or legacy execution from inherited Node options", POSIX_ONLY, async (t) => {
  const cases = [
    ["ordinary", "--stack-trace-limit=51", true],
    ["unrelated symlink option", "--preserve-symlinks", true],
    ["enabled", "--preserve-symlinks-main", false],
    ["quoted", '"--preserve-symlinks-main"', false],
    ["quoted fragment", '--preserve-"symlinks"-main', false],
    ["escaped", '--preserve-symlinks-\\main', false],
    ["escaped quote", '--title="a\\"--preserve-symlinks-main"', false],
    ["underscores", "--preserve_symlinks_main", false],
    ["negative", "--no-preserve-symlinks-main", false],
    ["negative underscores", "--no_preserve_symlinks_main", false],
    ["negative last", "--preserve-symlinks-main --no-preserve-symlinks-main", false],
    ["enabled last", "--no-preserve-symlinks-main --preserve-symlinks-main", false],
    ["option value mention", "--title=--preserve-symlinks-main", false],
  ]
  await withOwnedProviders(t, async root => {
    for (const [name, options, direct] of cases) {
      const provider = path.join(root, `${name}.exe`)
      await writeWithOptions(provider, CONTRACT_BODY, options)
      const actual = (await fs.lstat(provider)).isSymbolicLink()
      t.diagnostic(JSON.stringify({ name, options, route: actual ? "direct" : "legacy" }))
      assert.equal(actual, direct, `${name}: enabled preserve-main must never select an .exe main`)
      if (direct) assert.equal(await fs.readlink(provider), `${name}.exe.cjs`)
    }
  })
})

test("POSIX provider direct execution bypasses a gated legacy shell with the same genuine CJS contract", POSIX_ONLY, async (t) => {
  await withOwnedProviders(t, async (root, start) => {
    const legacy = path.join(root, "legacy.exe")
    const direct = path.join(root, "direct.exe")
    // Select the compatibility writer explicitly; both children later inherit the same actual options.
    await writeWithOptions(legacy, CONTRACT_BODY, "--preserve-symlinks-main")
    await writePosixNodeProvider(direct, CONTRACT_BODY)
    assert.equal((await fs.lstat(direct)).isSymbolicLink(), true, "normal execution must bypass the shell")
    const legacyShim = await fs.readFile(legacy, "utf8")
    await fs.writeFile(legacy, legacyShim.replace("#!/bin/sh\n",
      '#!/bin/sh\nprintf "ready\\n" >&4\nIFS= read -r gate <&3\n'))
    const env = { ...process.env }
    const old = start(legacy, CONTRACT_ARGS, env)
    const ready = once(old.child.stdio[4], "data")
    old.child.stdin.end("fixture input")
    const [message] = await Promise.race([ready, old.closed.then(() => {
      throw new Error(`legacy shell closed before gate readiness: ${old.stderr}`)
    })])
    assert.equal(message.toString(), "ready\n")
    const current = start(direct, CONTRACT_ARGS, env)
    current.child.stdin.end("fixture input")
    const directResult = await contractResult(current, direct)
    assert.equal(old.child.exitCode, null, "legacy shell must still be held before exec")
    assert.equal(old.stdout, "")
    await assert.rejects(fs.stat(`${legacy}.cjs.entered`), { code: "ENOENT" })
    assert.equal(await fs.readFile(`${direct}.cjs.entered`, "utf8"), "entered\n")
    t.diagnostic("direct CJS completed while the legacy pre-exec gate remained closed")
    old.child.stdio[3].end("continue\n")
    const legacyResult = await contractResult(old, legacy)
    assert.deepEqual({ ...legacyResult, filename: directResult.filename }, directResult)
  })
})

test("POSIX provider legacy compatibility executes enabled quoted and negative preserve-main options", POSIX_ONLY, async (t) => {
  await withOwnedProviders(t, async (root, start) => {
    const priorOptions = process.env.NODE_OPTIONS ?? ""
    for (const [name, flag] of [
      ["enabled", "--preserve-symlinks-main"],
      ["quoted underscores", '"--preserve_symlinks_main"'],
      ["negative", "--no-preserve-symlinks-main"],
    ]) {
      const options = `${priorOptions} ${flag}`.trim()
      const provider = path.join(root, `${name}.exe`)
      await writeWithOptions(provider, CONTRACT_BODY, options)
      assert.equal((await fs.lstat(provider)).isSymbolicLink(), false, `${name}: explicit compatibility route`)
      t.diagnostic(JSON.stringify({ name, flag, route: "legacy" }))
      const child = start(provider, CONTRACT_ARGS, { ...process.env, NODE_OPTIONS: options })
      child.child.stdin.end("fixture input")
      const result = await contractResult(child, provider)
      assert.ok(result.nodeOptions.includes(flag), "child must retain the selected Node options")
      for (const value of [...priorOptions.matchAll(/--import=(\S+)/gu)].map(match => match[1]))
        assert.ok(result.nodeOptions.includes(value), "child must retain inherited imports")
    }
    assert.equal(process.env.NODE_OPTIONS ?? "", priorOptions)
  })
})

test("POSIX provider direct alias preserves permission denial of the selected executable", POSIX_ONLY, async (t) => {
  await withOwnedProviders(t, async (root, start) => {
    const provider = path.join(root, "unrunnable.exe")
    await writePosixNodeProvider(provider, CONTRACT_BODY)
    assert.equal((await fs.lstat(provider)).isSymbolicLink(), true)
    await fs.chmod(provider, 0o644)
    const child = start(provider, CONTRACT_ARGS, { ...process.env })
    child.child.stdin.end("fixture input")
    const terminal = await child.closed
    assert.equal(child.error?.code, "EACCES")
    assert.notEqual(terminal.code, 0)
    assert.equal(child.stdout, "")
    await assert.rejects(fs.stat(`${provider}.cjs.entered`), { code: "ENOENT" })
  })
})
