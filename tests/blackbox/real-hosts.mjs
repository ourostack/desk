#!/usr/bin/env node
// The real-host layer: one real session on each host, with Desk as the person has it installed, in a throwaway desk.
// Local only (it spends model requests and needs signed-in hosts), never in CI. Each session boots, writes a note,
// finds it with search and opens and closes a fresh browser; the files and commits on the throwaway desk are the proof.
//
//   node tests/blackbox/real-hosts.mjs [--hosts copilot,claude] [--out <dir>] [--copilot-user <gh user>]
//
// Copilot is started as `agency copilot --allow-all -p`; its answer is read from ~/.copilot/session-state/<id>/events.jsonl,
// found by the unique tag in the prompt. Claude Code is started as `claude -p --output-format json`.

import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { git, makeDesk } from "./lib/world.mjs"

const args = process.argv.slice(2)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const hosts = option("--hosts", "copilot,claude").split(",")
const out = path.resolve(option("--out", path.join(os.tmpdir(), "desk-blackbox-results")))
const copilotUser = option("--copilot-user", "arimendelow_microsoft")
const timeoutMs = Number(option("--timeout", "600")) * 1000

function prompt(tag) {
  return [
    `Black-box check ${tag}. Use only the Desk tools named here, in order, and do not edit files yourself.`,
    "1. Call desk_status and note its state and root path.",
    `2. Call lesson_add with topic "blackbox-real" and body "Real-host check ${tag}".`,
    `3. Call desk_search with query "${tag}" and note whether the lesson file is among the results.`,
    "4. Call browser_context with action open and browser fresh, then browser_command with args [\"goto\",\"https://example.com\"], then browser_context with action close and the contextId.",
    `Finish with exactly one line: RESULT ${tag} {"state":"...","root":"...","search_found":true|false,"browser_title":"...","browser_closed":true|false}`,
  ].join("\n")
}

function run(command, argv, { cwd, env }) {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(command, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ms: performance.now() - started })
    })
  })
}

function copilotAnswer(tag, since) {
  const root = path.join(os.homedir(), ".copilot", "session-state")
  for (const id of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const file = path.join(root, id, "events.jsonl")
    if (!fs.existsSync(file) || fs.statSync(file).mtimeMs < since) continue
    const text = fs.readFileSync(file, "utf8")
    if (!text.includes(tag)) continue
    const messages = text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    const replies = messages.filter((event) => /assistant\.message/u.test(event.type ?? "")).map((event) => event.data?.content ?? "")
    const tools = messages.filter((event) => /tool\.execution_start/u.test(event.type ?? "")).map((event) => event.data?.toolName ?? event.data?.name)
    return { sessionId: id, answer: replies.join("\n"), tools }
  }
  return { sessionId: null, answer: "", tools: [] }
}

function parseResult(tag, text) {
  const line = text.split("\n").reverse().find((l) => l.includes(`RESULT ${tag}`))
  if (!line) return null
  try { return JSON.parse(line.slice(line.indexOf("{"))) } catch { return null }
}

async function session(host) {
  const tag = `bbx${randomUUID().slice(0, 8)}`
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `desk-real-${host}-`))
  const { desk } = makeDesk({ root, env: process.env })
  const since = Date.now()
  let result
  if (host === "copilot") {
    const token = execFileSync("gh", ["auth", "token", "--user", copilotUser], { encoding: "utf8" }).trim()
    result = await run("agency", ["copilot", "--allow-all", "-p", prompt(tag)], { cwd: desk, env: { ...process.env, COPILOT_GITHUB_TOKEN: token } })
    Object.assign(result, copilotAnswer(tag, since))
  } else {
    result = await run("claude", ["-p", "--permission-mode", "bypassPermissions", "--output-format", "json", prompt(tag)], { cwd: desk, env: process.env })
    try {
      const parsed = JSON.parse(result.stdout)
      result.answer = parsed.result ?? ""
      result.sessionId = parsed.session_id
    } catch {
      result.answer = result.stdout
    }
  }
  const lesson = path.join(desk, "_meta", "tips", "blackbox-real.md")
  const reported = parseResult(tag, result.answer)
  const log = git(desk, ["log", "--format=%s", "-n", "20"], process.env)
  const checks = {
    exited_ok: result.code === 0,
    bound_this_desk: (() => { try { return fs.realpathSync(reported.root).toLowerCase() === fs.realpathSync(desk).toLowerCase() } catch { return false } })(),
    status_ready: reported?.state === "ready",
    lesson_written: fs.existsSync(lesson) && fs.readFileSync(lesson, "utf8").includes(tag),
    lesson_committed: git(desk, ["log", "--format=%H", "-n", "1", "--", "_meta/tips/blackbox-real.md"], process.env) !== "",
    search_found: reported?.search_found === true,
    browser_opened: /example domain/iu.test(reported?.browser_title ?? ""),
    browser_closed: reported?.browser_closed === true,
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  return { host, tag, ms: Math.round(result.ms), sessionId: result.sessionId, checks, reported, answerTail: result.answer.slice(-600), stderrTail: result.stderr.slice(-400), commits: log.split("\n") }
}

const runs = []
for (const host of hosts) {
  console.log(`Running a real ${host} session…`)
  runs.push(await session(host))
  const last = runs.at(-1)
  console.log(`${host}: ${Object.values(last.checks).filter(Boolean).length}/${Object.keys(last.checks).length} in ${last.ms} ms`, last.checks)
}
fs.mkdirSync(out, { recursive: true })
const file = path.join(out, `blackbox-real-hosts-${process.platform}.json`)
fs.writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), runs }, null, 2)}\n`)
const md = ["| Check | " + runs.map((r) => r.host).join(" | ") + " |", "| --- | " + runs.map(() => "---").join(" | ") + " |"]
for (const key of Object.keys(runs[0]?.checks ?? {})) md.push(`| ${key} | ${runs.map((r) => (r.checks[key] ? "pass" : "FAIL")).join(" | ")} |`)
md.push(`| seconds | ${runs.map((r) => Math.round(r.ms / 1000)).join(" | ")} |`)
fs.writeFileSync(file.replace(/\.json$/u, ".md"), `# Real-host sessions\n\n${md.join("\n")}\n`)
console.log(`Wrote ${file}`)
process.exitCode = runs.every((r) => Object.values(r.checks).every(Boolean)) ? 0 : 1
