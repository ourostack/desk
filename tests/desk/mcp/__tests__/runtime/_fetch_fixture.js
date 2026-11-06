import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { randomBytes } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { readProcessStart, runForText } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"

const startOf = pid => readProcessStart(pid, { run: (file, args, options) => runForText(file, args, { ...options, timeout: 500 }) })
export function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true } catch (error) { if (error.code === "ESRCH") return false; throw error }
}

export function fixtureGit(root, args, env) {
  const result = spawnSync("/usr/bin/git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

export async function fetchFixture(t, bytes = 128 * 1024) {
  const space = await fs.statfs(os.tmpdir())
  assert.ok(space.bavail * space.bsize > 2 * 1024 ** 3, "fixture allocation paused: preserve 2 GiB shared-disk headroom")
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "desk-fetch-owner-"))
  console.log(`owned fetch fixture created: ${base}`)
  const env = { ...process.env, HOME: path.join(base, "home"), PATH: "/usr/bin:/bin", LC_ALL: "C" }
  for (const key of Object.keys(env)) if (/^GIT_/u.test(key)) delete env[key]
  Object.assign(env, { GIT_CONFIG_GLOBAL: path.join(env.HOME, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" })
  await fs.mkdir(env.HOME)
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, "[user]\nname = Fetch Test\nemail = fetch@example.invalid\n[init]\ndefaultBranch = main\n[credential]\nhelper =\n")
  const seed = path.join(base, "seed"), root = path.join(base, "source"), bare = path.join(base, "repo.git")
  await fs.mkdir(seed)
  const git = (cwd, args) => fixtureGit(cwd, args, env)
  git(seed, ["init", "-q"])
  await fs.writeFile(path.join(seed, "kept.md"), "base\n")
  git(seed, ["add", "kept.md"])
  git(seed, ["commit", "-qm", "base"])
  const baseline = git(seed, ["rev-parse", "HEAD"])
  git(seed, ["clone", "-q", "--bare", seed, bare])
  git(seed, ["clone", "-q", "--no-local", bare, root])
  await fs.writeFile(path.join(seed, "payload.bin"), randomBytes(bytes))
  git(seed, ["add", "payload.bin"])
  git(seed, ["commit", "-qm", "payload"])
  const incoming = git(seed, ["rev-parse", "HEAD"])
  git(seed, ["push", "-q", bare, "main"])
  const sockets = new Set(), children = new Set()
  const state = { payloads: 0, interval: 0, stallAds: false, stallAfter: Infinity, afterBody: null, afterChunk: null, auth: false, secretError: null,
    requests: [], controllers: new Set(), groups: new Map() }
  const server = http.createServer((request, response) => {
    state.requests.push(request.url)
    if (state.stallAds && request.url.includes("info/refs")) return
    const url = new URL(request.url, "http://127.0.0.1")
    if (state.auth) { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }).end(); return }
    if (state.secretError) { response.writeHead(500).end(state.secretError); return }
    if (!/^\/repo\.git\/(?:info\/refs|git-upload-pack)$/u.test(url.pathname)) { response.writeHead(404).end(); return }
    const child = spawn("/usr/bin/git", ["http-backend"], {
      env: { ...env, GIT_PROJECT_ROOT: base, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: request.method, PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers["content-type"] ?? "", CONTENT_LENGTH: request.headers["content-length"] ?? "",
        ...(request.headers["git-protocol"] ? { GIT_PROTOCOL: request.headers["git-protocol"] } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    })
    children.add(child)
    console.log(`owned fetch backend created: ${child.pid}; root: ${base}`)
    const buffers = []
    child.stdout.on("data", data => buffers.push(data))
    child.stderr.resume()
    request.pipe(child.stdin)
    child.stdin.on("error", error => { if (error.code !== "EPIPE") response.destroy(error) })
    let timer
    response.on("close", () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM") })
    child.on("close", code => {
      children.delete(child)
      console.log(`owned fetch backend closed: ${child.pid}; code: ${code}; root: ${base}`)
      if (response.destroyed) return
      if (code !== 0) { response.writeHead(500).end(); return }
      const all = Buffer.concat(buffers), split = all.indexOf("\r\n\r\n")
      const headers = {}
      for (const line of all.subarray(0, split).toString().split("\r\n")) {
        const i = line.indexOf(":")
        if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1).trim()
      }
      response.writeHead(200, headers)
      const body = all.subarray(split + 4)
      const large = request.method === "POST" && body.length > 32768
      if (large) state.payloads += 1
      let offset = 0
      const pump = () => {
        if (response.destroyed) return
        if (offset >= body.length) { if (large) state.afterBody?.(); response.end(); return }
        if (large && offset >= state.stallAfter) return
        const end = Math.min(offset + (large ? 16384 : body.length), body.length)
        response.write(body.subarray(offset, end)); offset = end
        if (large) state.afterChunk?.(offset)
        timer = setTimeout(pump, large ? state.interval : 0)
      }
      pump()
    })
  })
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}/repo.git`
  console.log(`owned fetch server created: ${endpoint}; root: ${base}`)
  git(root, ["remote", "set-url", "origin", endpoint])
  const activation = path.join(base, "activation.json")
  await fs.writeFile(activation, JSON.stringify({ schema_version: 1, desk: { root, state_branch: "main" } }))
  env.DESK_ACTIVATION_CONFIG = activation
  t.after(async () => {
    const controllers = [...state.controllers]
    const controllerClosed = controllers.map(child => new Promise(resolve => child.once("close", resolve)))
    for (const child of controllers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await Promise.all(controllerClosed)
    for (const [pid, start] of state.groups) {
      if (!processGroupExists(pid)) continue
      assert.equal(await startOf(pid), start, "owned group generation changed; fixture retained")
      process.kill(-pid, "SIGKILL")
      const end = performance.now() + 2000
      while (processGroupExists(pid) && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(processGroupExists(pid), false, "owned group did not close; fixture retained")
    }
    for (const socket of sockets) socket.destroy()
    const backendClosed = [...children].map(child => new Promise(resolve => child.once("close", resolve)))
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await new Promise(resolve => server.close(resolve))
    await Promise.all(backendClosed)
    console.log(`owned fetch server closed: ${endpoint}; root: ${base}`)
    await fs.rm(base, { recursive: true, force: true })
  })
  const trackGroup = async pid => {
    const start = await startOf(pid)
    assert.ok(start, "owned group generation unavailable")
    state.groups.set(pid, start)
    console.log(`owned fetch process group recorded: ${pid}; start: ${start}; root: ${base}`)
  }
  return { base, root, bare, seed, env, state, endpoint, activation, baseline, incoming, git, trackGroup }
}
