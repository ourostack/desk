// private-view.js: the local copy of the factory site with this desk's real task names.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as http from "node:http"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { factoryStateRoot, readMachineSecret } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { keyedJobId } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { runJobLinkCommand } from "../../../../../plugins/desk/mcp/scripts/factory.js"
import { SITE, SITE_FILES, main, runIfMain, taskNames, viewDir } from "../../../../../plugins/desk/mcp/scripts/private-view.js"

const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/private-view.js", import.meta.url))

function card(root, relative, text) {
  mkdirSync(path.join(root, relative), { recursive: true })
  writeFileSync(path.join(root, relative, "task.md"), text)
}

async function scratch(run) {
  const home = mkdtempSync(path.join(os.tmpdir(), "private-view-"))
  const root = path.join(home, "desk")
  card(root, "track-a/first", "---\ntitle: First task\n---\nbody\n")
  card(root, "track-a/_archive/old", "---\ntitle: Old task\n---\n")
  card(root, "track-a/untitled", "---\nstatus: ready\n---\n")
  mkdirSync(path.join(root, "track-a/_hidden"), { recursive: true })
  mkdirSync(path.join(root, "track-a/no-card"), { recursive: true })
  mkdirSync(path.join(root, "_meta"), { recursive: true })
  mkdirSync(path.join(root, ".git-like"), { recursive: true })
  mkdirSync(path.join(root, "track-a/.dot"), { recursive: true })
  card(root, "track-b/plain", "---\ntitle: Plain\n---\n")
  card(root, "track-a/blank", "---\ntitle: \"\"\n---\n")
  const env = { HOME: home, DESK: root }
  try {
    return await run({ env, root, home })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test("a desk not known private publishes keyed job IDs, so the names map keyed IDs", () => scratch(async ({ env, root }) => {
  const secret = await readMachineSecret(env)
  const plain = (track, slug) => jobId({ deskRemote: `local:${root}`, personPrefix: "", track, slug })
  const jobs = await taskNames({ root, env })
  assert.deepEqual(jobs, {
    [keyedJobId(plain("track-b", "plain"), secret)]: { title: "Plain", track: "track-b", task: "plain" },
    [keyedJobId(plain("track-a", "first"), secret)]: { title: "First task", track: "track-a", task: "first" },
    [keyedJobId(plain("track-a", "old"), secret)]: { title: "Old task", track: "track-a", task: "old" },
    [keyedJobId(plain("track-a", "blank"), secret)]: { title: "blank", track: "track-a", task: "blank" },
    [keyedJobId(plain("track-a", "untitled"), secret)]: { title: "untitled", track: "track-a", task: "untitled" },
  })
}))

test("a desk with no secret yet, or an unknown visibility, is refused", () => scratch(async ({ env, root }) => {
  await assert.rejects(taskNames({ root, env }), /secret, which does not exist/u)
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["remote", "add", "origin", "git@github.com:example-user/example-desk.git"], { cwd: root })
  await assert.rejects(taskNames({ root, env }), /visibility is not known/u)
}))

test("a desk known private maps plain job IDs", () => scratch(async ({ env, root }) => {
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["remote", "add", "origin", "git@github.com:example-user/example-desk.git"], { cwd: root })
  writeFileSync(path.join(await factoryStateRoot(env), "visibility.json"), JSON.stringify({ "example-user/example-desk": { visibility: "private", checked_at: new Date().toISOString() } }))
  const jobs = await taskNames({ root, env })
  const first = jobId({ deskRemote: "git@github.com:example-user/example-desk.git", personPrefix: "", track: "track-a", slug: "first" })
  assert.equal(jobs[first].title, "First task")
}))

const fakeFetch = (fail = () => false) => async (url) => {
  if (fail(url)) throw new Error(`${url}: 503`)
  return `copy of ${url}`
}

async function run(options) {
  const { server, url } = await main({ log: () => {}, ...options })
  server.close()
  return url
}

test("main copies the site, serves it on loopback and writes the names privately", () => scratch(async ({ env, home, root }) => {
  await readMachineSecret(env)
  mkdirSync(path.join(root, "desks/someone"), { recursive: true })
  const lines = []
  const { server, url } = await main({ env, fetchFile: fakeFetch(), log: (line) => lines.push(line) })
  try {
    const dir = viewDir(env)
    assert.equal(dir, path.join(home, ".local", "state", "desk-private-view", "factory"))
    assert.deepEqual(lines, ["private-view: crew desks (desks/) are not mapped"])
    for (const name of SITE_FILES) assert.equal(readFileSync(path.join(dir, name), "utf8"), `copy of ${SITE}${name}`)
    assert.equal(Object.keys(JSON.parse(readFileSync(path.join(dir, "local-names.json"), "utf8")).jobs).length, 5)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    for (const name of [...SITE_FILES, "local-names.json"]) assert.equal(statSync(path.join(dir, name)).mode & 0o777, 0o600)
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/u)
    assert.equal(server.address().address, "127.0.0.1")
    const page = await fetch(url)
    assert.equal(await page.text(), `copy of ${SITE}index.html`)
    assert.match(page.headers.get("content-type"), /text\/html/u)
    assert.equal((await fetch(`${url}local-names.json`)).status, 200)
    assert.equal((await fetch(`${url}../secret`)).status, 404)
    assert.equal((await fetch(`${url}task.md`)).status, 404)
    assert.equal((await fetch(url, { method: "POST" })).status, 404)
    // A request whose Host is not this loopback address and port is refused, even for a known file.
    const port = server.address().port
    const ask = (host) => new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: "/local-names.json", headers: { host } }, (res) => { res.resume(); resolve(res.statusCode) }))
    assert.equal(await ask(`localhost:${port}`), 200)
    assert.equal(await ask(`evil.example:${port}`), 404)
    assert.equal(await ask("127.0.0.1"), 404)
    // A file that vanished answers 404 rather than crashing the server.
    rmSync(path.join(viewDir(env), "data.json"))
    assert.equal((await fetch(`${url}data.json`)).status, 404)
  } finally {
    server.close()
  }
}))

test("leftover temporary folders of the target are removed, and nothing else", () => scratch(async ({ env }) => {
  await readMachineSecret(env)
  const parent = path.dirname(viewDir(env))
  mkdirSync(path.join(parent, "factory.tmp-old"), { recursive: true })
  mkdirSync(path.join(parent, "keep-me"))
  await run({ env, fetchFile: fakeFetch() })
  assert.deepEqual(readdirSync(parent).sort(), ["factory", "keep-me"])
}))

test("a fetch failure writes nothing and leaves the previous folder untouched", () => scratch(async ({ env }) => {
  await readMachineSecret(env)
  await run({ env, fetchFile: fakeFetch() })
  const dir = viewDir(env)
  const before = readFileSync(path.join(dir, "app.js"), "utf8")
  await assert.rejects(main({ env, fetchFile: fakeFetch((url) => url.endsWith("data.json")) }), /503/u)
  assert.equal(readFileSync(path.join(dir, "app.js"), "utf8"), before)
  assert.deepEqual(readdirSync(path.dirname(dir)), ["factory"])
}))

test("a write failure removes the temporary folder and keeps the previous one", () => scratch(async ({ env }) => {
  await readMachineSecret(env)
  await run({ env, fetchFile: fakeFetch() })
  const dir = viewDir(env)
  await assert.rejects(main({ env, fetchFile: async (url) => (url.endsWith("data.json") ? 42n : "x") }), /string|Buffer|argument/iu)
  assert.equal(readFileSync(path.join(dir, "app.js"), "utf8"), `copy of ${SITE}app.js`)
  assert.deepEqual(readdirSync(path.dirname(dir)), ["factory"])
}))

test("a rerun replaces a folder with loose modes and a symlinked names file", () => scratch(async ({ env, home }) => {
  await readMachineSecret(env)
  await run({ env, fetchFile: fakeFetch() })
  const dir = viewDir(env)
  const outside = path.join(home, "outside.json")
  rmSync(path.join(dir, "local-names.json"))
  symlinkSync(outside, path.join(dir, "local-names.json"))
  chmodSync(dir, 0o755)
  await run({ env, fetchFile: fakeFetch() })
  assert.equal(existsSync(outside), false)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(lstatSync(path.join(dir, "local-names.json")).isSymbolicLink(), false)
}))

test("a symlinked target is refused", () => scratch(async ({ env, home }) => {
  await readMachineSecret(env)
  const dir = viewDir(env)
  mkdirSync(path.dirname(dir), { recursive: true })
  mkdirSync(path.join(home, "elsewhere"))
  symlinkSync(path.join(home, "elsewhere"), dir)
  await assert.rejects(main({ env, fetchFile: fakeFetch() }), /symbolic link/u)
  assert.deepEqual(readdirSync(path.join(home, "elsewhere")), [])
}))

test("an output folder inside a Git work tree or the factory state folder is refused", () => scratch(async ({ env, home, root }) => {
  await readMachineSecret(env)
  execFileSync("git", ["init", "-q"], { cwd: root })
  await assert.rejects(main({ env: { ...env, XDG_STATE_HOME: path.join(root, ".state") }, fetchFile: fakeFetch() }), /inside the Git work tree/u)
  assert.equal(existsSync(path.join(root, ".state")), false)
  // A symlinked parent that lands the view in the factory's state folder cannot hide it.
  const state = path.join(home, "other-state")
  const aliased = { ...env, XDG_STATE_HOME: state }
  await readMachineSecret(aliased)
  symlinkSync(path.join(state, "ouroboros-skills", "desk"), path.join(state, "desk-private-view"))
  await assert.rejects(main({ env: aliased, fetchFile: fakeFetch() }), /factory's state folder/u)
}))

test("viewDir honors XDG_STATE_HOME and falls back to the home folder", () => {
  assert.equal(viewDir({ XDG_STATE_HOME: "/x/state" }), "/x/state/desk-private-view/factory")
  assert.equal(viewDir({}), path.join(os.homedir(), ".local", "state", "desk-private-view", "factory"))
})

test("the names agree with factory.js job-link --this-machine, including for a renamed card", () => scratch(async ({ env, root }) => {
  await readMachineSecret(env)
  const git = (...args) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=n", ...args], { cwd: root })
  git("init", "-q")
  git("add", "-A")
  git("commit", "-qm", "init")
  git("mv", "track-a/first", "track-a/renamed")
  git("commit", "-qam", "rename")
  const jobs = await taskNames({ root, env })
  const link = await runJobLinkCommand({ env, argv: ["--store", "ourostack/factory", "--desk-remote", `local:${root}`, "--desk", root, "--track", "track-a", "--slug", "renamed", "--this-machine"] })
  assert.ok(link.link.endsWith(`${Object.entries(jobs).find(([, value]) => value.task === "renamed")[0]}.md`))
}))

test("a folder name that cannot be a job ID is refused by name", () => scratch(async ({ env, root }) => {
  await readMachineSecret(env)
  card(root, "track-a/bad\\name", "---\ntitle: Bad\n---\n")
  await assert.rejects(taskNames({ root, env }), /track-a\/bad\\name/u)
}))

test("main refuses when no desk is bound and creates nothing", () => scratch(async ({ home }) => {
  const bare = { HOME: home, DESK: path.join(home, "missing") }
  await assert.rejects(main({ env: bare, fetchFile: async () => "x", log: () => {} }), /no desk is bound/u)
  assert.equal(existsSync(path.join(home, ".local")), false)
}))

test("main uses the global fetch with a timeout and fails on a bad response", () => scratch(async ({ env }) => {
  await readMachineSecret(env)
  const original = globalThis.fetch
  const signals = []
  try {
    globalThis.fetch = async (url, options) => { signals.push(options.signal instanceof AbortSignal); return { ok: true, text: async () => "page" } }
    assert.match(await run({ env }), /^http:/u)
    assert.ok(signals.length === 6 && signals.every(Boolean))
    globalThis.fetch = async () => ({ ok: false, status: 503 })
    await assert.rejects(main({ env }), /503/u)
  } finally {
    globalThis.fetch = original
  }
}))

test("runIfMain runs only as the entry point, printing the URL or the failure", async () => {
  const url = "file:///x/private-view.js"
  assert.equal(await runIfMain(url, undefined, async () => ({})), false)
  assert.equal(await runIfMain(url, "/elsewhere.js", async () => ({})), false)
  const code = process.exitCode
  const { write: stdout } = process.stdout
  const { write: stderr } = process.stderr
  const out = []
  process.stdout.write = (text) => { out.push(text); return true }
  process.stderr.write = (text) => { out.push(text); return true }
  try {
    assert.equal(await runIfMain(url, "/x/private-view.js", async ({ log }) => { log("note"); return { url: "http://127.0.0.1:1/" } }), true)
    assert.equal(await runIfMain(url, "/x/private-view.js", async () => { throw new Error("nope") }), true)
    assert.equal(process.exitCode, 1)
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
    process.exitCode = code
  }
  assert.deepEqual(out, ["note\n", "http://127.0.0.1:1/\n", "Serving until Ctrl-C: an agent should run this command in the background and read the URL above.\n", "nope\n"])
})

test("run as a process, an unbound desk exits 1 with the reason", () => scratch(({ home }) => {
  const result = (() => {
    try {
      return execFileSync(process.execPath, [SCRIPT], { env: { HOME: home, PATH: process.env.PATH }, cwd: home, stdio: "pipe" })
    } catch (error) {
      return error
    }
  })()
  assert.equal(result.status, 1)
  assert.match(String(result.stderr), /no desk is bound/u)
}))
