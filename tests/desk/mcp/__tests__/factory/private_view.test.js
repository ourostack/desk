// private-view.js: the local copy of the factory site with this desk's real task names.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { factoryStateRoot, readMachineSecret } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { keyedJobId } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { SITE, main, runIfMain, taskNames, viewDir } from "../../../../../plugins/desk/mcp/scripts/private-view.js"

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

test("main copies the site and writes the names privately", () => scratch(async ({ env, home }) => {
  await readMachineSecret(env)
  const fetched = []
  const dir = viewDir(env)
  assert.equal(await main({ env, fetchFile: async (url) => { fetched.push(url); return `copy of ${url}` } }), path.join(dir, "index.html"))
  assert.equal(dir, path.join(home, ".local", "state", "desk-private-view", "factory"))
  assert.ok(fetched.every((url) => url.startsWith(SITE)))
  assert.equal(readFileSync(path.join(dir, "app.js"), "utf8"), `copy of ${SITE}app.js`)
  assert.equal(Object.keys(JSON.parse(readFileSync(path.join(dir, "local-names.json"), "utf8")).jobs).length, 5)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(path.join(dir, "local-names.json")).mode & 0o777, 0o600)
  assert.equal(statSync(path.join(dir, "data.json")).mode & 0o777, 0o600)
}))

test("viewDir honors XDG_STATE_HOME and falls back to the home folder", () => {
  assert.equal(viewDir({ XDG_STATE_HOME: "/x/state" }), "/x/state/desk-private-view/factory")
  assert.equal(viewDir({}), path.join(os.homedir(), ".local", "state", "desk-private-view", "factory"))
})

test("main refuses when no desk is bound and writes nothing", () => scratch(async ({ env, home }) => {
  const bare = { HOME: home, DESK: path.join(home, "missing") }
  await assert.rejects(main({ env: bare, fetchFile: async () => "x" }), /no desk is bound/u)
}))

test("main uses the global fetch and fails on a bad response", () => scratch(async ({ env }) => {
  await readMachineSecret(env)
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: true, text: async () => "page" })
    assert.equal(typeof (await main({ env })), "string")
    globalThis.fetch = async () => ({ ok: false, status: 503 })
    await assert.rejects(main({ env }), /503/u)
  } finally {
    globalThis.fetch = original
  }
}))

test("runIfMain runs only as the entry point, printing the path or the failure", async () => {
  const url = "file:///x/private-view.js"
  assert.equal(await runIfMain(url, undefined, async () => "p"), false)
  assert.equal(await runIfMain(url, "/elsewhere.js", async () => "p"), false)
  const code = process.exitCode
  const { write: stdout } = process.stdout
  const { write: stderr } = process.stderr
  const out = []
  process.stdout.write = (text) => { out.push(text); return true }
  process.stderr.write = (text) => { out.push(text); return true }
  try {
    assert.equal(await runIfMain(url, "/x/private-view.js", async () => "/a/index.html"), true)
    assert.equal(await runIfMain(url, "/x/private-view.js", async () => { throw new Error("nope") }), true)
    assert.equal(process.exitCode, 1)
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
    process.exitCode = code
  }
  assert.deepEqual(out, ["/a/index.html\n", "nope\n"])
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
