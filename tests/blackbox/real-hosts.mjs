#!/usr/bin/env node
// The real-host layer: one real session on each host, with Desk as the person has it installed, in a throwaway desk.
// Local only (it spends model requests and needs signed-in hosts), never in CI. Each session boots, records a personal
// lesson, finds it with search and opens and closes a fresh browser; the files and commits on the throwaway desk are the
// proof. A second session on the same desk then quotes the lesson from its own session start: the lesson's body carries a
// secret the second prompt does not, so only a session start that printed the lesson can give it back.
//
//   node tests/blackbox/real-hosts.mjs [--hosts copilot,claude] [--out <dir>] [--copilot-user <gh user>] [--scenario lessons|progress-note] [--plugin local:<desk plugin folder>]
//
// `--plugin` loads that Desk folder for Copilot instead of the installed one (and skips the configured plugins), so a branch's
// own Desk is what runs.
// `progress-note` is one session that records a progress note with task_update on a desk whose pre-commit hook is slow (longer
// than Desk's 10 s card-commit budget). The prompt says nothing about timeouts or routes; it passes when the note reaches the
// remote and the answer does not say it cannot be recorded or is not in effect.
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
const scenario = option("--scenario", "lessons")
const plugin = option("--plugin", null)
if (!["lessons", "progress-note"].includes(scenario)) throw new Error(`unknown --scenario ${scenario}`)

function prompt(tag, secret) {
  return [
    `Black-box check ${tag}. Use only the Desk tools named here, in order, and do not edit files yourself.`,
    "1. Call desk_status and note its state and root path.",
    `2. Call lesson_add with scope "personal", topic "Blackbox ${tag}" and body "Real-host check ${tag} ${secret}."`,
    `3. Call desk_search with query "${tag}" and note whether AGENTS.md is among the results.`,
    "4. Call browser_context with action open and browser fresh, then browser_command with args [\"goto\",\"https://example.com\"], then browser_context with action close and the contextId.",
    `Finish with exactly one line: RESULT ${tag} {"state":"...","root":"...","search_found":true|false,"browser_title":"...","browser_closed":true|false}`,
  ].join("\n")
}

// The next session: nothing but its own start. It must not read files, so the secret can only come from the boot output.
function nextPrompt(tag) {
  return [
    `Black-box check ${tag}-next. Start the session the way Desk's startup tells you to, and do not read or search any file yourself.`,
    `Your session start output has a lesson whose topic is "Blackbox ${tag}". Its body ends with a word that starts with "sec".`,
    `Finish with exactly one line: RESULT ${tag}-next {"secret":"<that word, or none if your session start did not show the lesson>"}`,
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
    const stat = fs.existsSync(file) ? fs.statSync(file) : null
    // A short check's own log is small; another session's log can pass Node's string limit (1.85 GB seen) and crash the read.
    if (stat === null || stat.mtimeMs < since || stat.size > 100 * 1024 * 1024) continue
    const text = fs.readFileSync(file, "utf8")
    if (!text.includes(tag)) continue
    const messages = text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    // Only the session this script started: its first user message carries the tag (another session may quote it).
    if (!messages.some((event) => event.type === "user.message" && JSON.stringify(event.data ?? {}).includes(`Black-box check ${tag}`))) continue
    // The answer is the assistant's text, or the summary it passes to task_complete when it ends with that tool.
    const replies = messages.filter((event) => /assistant\.message/u.test(event.type ?? "")).flatMap((event) => [event.data?.content ?? "", ...(event.data?.toolRequests ?? []).map((request) => request.arguments?.summary ?? "")])
    const tools = messages.filter((event) => /tool\.execution_start/u.test(event.type ?? "")).map((event) => event.data?.toolName ?? event.data?.name)
    if (!tools.some((name) => /desk_status|desk-desk_status/u.test(name))) replies.push("(the desk server's tools were not called; see the tools list)")
    return { sessionId: id, answer: replies.join("\n"), tools }
  }
  return { sessionId: null, answer: "", tools: [] }
}

function parseResult(tag, text) {
  const line = text.split("\n").reverse().find((l) => l.includes(`RESULT ${tag}`))
  if (!line) return null
  try { return JSON.parse(line.slice(line.indexOf("{"))) } catch { return null }
}

// The person's terminal, not this process: drop the session variables a parent Claude Code or Copilot session set, so the child is a new top-level session.
function personEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CLAUDECODE|COPILOT_AGENT|COPILOT_TASK|DESK)/u.test(key)))
}

async function hostRun(host, tag, text, desk) {
  const since = Date.now()
  let result
  if (host === "copilot") {
    const token = execFileSync("gh", ["auth", "token", "--user", copilotUser], { encoding: "utf8" }).trim()
    const pluginArgs = plugin ? ["--no-config-plugins", "--plugin", plugin] : []
    // A fresh session per run: without it, agency resumes the last session, which carries the earlier run's context.
    result = await run("agency", ["copilot", "--allow-all", "--session-id", randomUUID(), ...pluginArgs, "-p", text], { cwd: desk, env: { ...personEnv(), COPILOT_GITHUB_TOKEN: token } })
    Object.assign(result, copilotAnswer(tag, since))
  } else {
    result = await run("claude", ["-p", "--permission-mode", "bypassPermissions", "--output-format", "json", text], { cwd: desk, env: personEnv() })
    try {
      const parsed = JSON.parse(result.stdout)
      result.answer = parsed.result ?? ""
      result.sessionId = parsed.session_id
    } catch {
      result.answer = result.stdout
    }
  }
  return result
}

async function session(host) {
  const tag = `bbx${randomUUID().slice(0, 8)}`
  const secret = `sec${randomUUID().slice(0, 8)}`
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `desk-real-${host}-`))
  const { desk } = makeDesk({ root, env: process.env })
  const result = await hostRun(host, tag, prompt(tag, secret), desk)
  const lessons = path.join(desk, "AGENTS.md")
  const reported = parseResult(tag, result.answer)
  const next = await hostRun(host, `${tag}-next`, nextPrompt(tag), desk)
  const seen = parseResult(`${tag}-next`, next.answer)
  const log = git(desk, ["log", "--format=%s", "-n", "20"], process.env)
  const checks = {
    exited_ok: result.code === 0 && next.code === 0,
    // The session's project folder is a desk, so Desk must write there and nowhere else.
    bound_this_desk: fs.existsSync(lessons),
    status_ready: reported?.state === "ready",
    lesson_written: fs.existsSync(lessons) && fs.readFileSync(lessons, "utf8").includes(`- **Blackbox ${tag}.** Real-host check ${tag} ${secret}.`),
    lesson_committed: git(desk, ["log", "--format=%H", "-n", "1", "--", "AGENTS.md"], process.env) !== "",
    search_found: reported?.search_found === true,
    browser_opened: /example domain/iu.test(reported?.browser_title ?? ""),
    browser_closed: reported?.browser_closed === true,
    next_session_start_printed_lesson: seen?.secret === secret,
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.rmSync(root, { recursive: true, force: true }); break } catch { await new Promise((resolve) => setTimeout(resolve, 1000)) }
  }
  return { host, tag, ms: Math.round(result.ms + next.ms), sessionId: result.sessionId, nextSessionId: next.sessionId, nextAnswerTail: next.answer.slice(-400), checks, reported, answerTail: result.answer.slice(-600), stderrTail: result.stderr.slice(-400), commits: log.split("\n") }
}

const TRACK = "search-quality"
const SLUG = "rank-recent-cards-higher"
const TASK_CARD = [
  "---",
  "schema_version: 1",
  "title: Rank recent cards higher",
  `track: ${TRACK}`,
  "status: drafting",
  "created: \"2026-11-01T09:00:00Z\"",
  "updated: \"2026-11-01T09:00:00Z\"",
  "---",
  "",
  "# Rank recent cards higher",
  "",
  "## Goal",
  "",
  "Make recent cards rank higher in desk search.",
  "",
].join("\n")

// One session records a progress note on a live task while the desk's pre-commit hook is slow. The person's own hook is the slow
// one: Desk's session start keeps a pre-commit hook it finds and chains it after Desk's card guard.
async function progressNoteSession(host) {
  const tag = `bbx${randomUUID().slice(0, 8)}`
  const note = `Progress check ${tag}: the recency boost is measured.`
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `desk-real-${host}-`))
  const { desk, remote } = makeDesk({ root, env: process.env })
  fs.mkdirSync(path.join(desk, TRACK, SLUG), { recursive: true })
  fs.writeFileSync(path.join(desk, TRACK, "track.md"), `# ${TRACK}\n`)
  fs.writeFileSync(path.join(desk, TRACK, SLUG, "task.md"), TASK_CARD)
  git(desk, ["add", "-A"], process.env)
  git(desk, ["commit", "-q", "-m", "Add the progress-check task"], process.env)
  git(desk, ["push", "-q", "origin", "main"], process.env)
  const hooks = path.resolve(desk, git(desk, ["rev-parse", "--git-path", "hooks"], process.env))
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nsleep 11\n", { mode: 0o755 })

  const text = `Black-box check ${tag}. Call desk_status first and note its state. Record this progress note on the task "${SLUG}" in track "${TRACK}" with task_update: "${note}". Then tell me in one sentence whether it's saved.`
  const result = await hostRun(host, tag, text, desk)
  const answer = result.answer.trim()
  const onRemote = (() => {
    try { return git(root, ["--git-dir", remote, "show", `main:${TRACK}/${SLUG}/task.md`], process.env) } catch { return "" }
  })()
  const checks = {
    exited_ok: result.code === 0,
    answered: answer !== "",
    note_on_remote: onRemote.includes(note),
    answer_not_failure: !/can(?:'|no)t|cannot|not in effect/iu.test(answer),
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.rmSync(root, { recursive: true, force: true }); break } catch { await new Promise((resolve) => setTimeout(resolve, 1000)) }
  }
  return { host, tag, ms: Math.round(result.ms), sessionId: result.sessionId, checks, answer, stderrTail: result.stderr.slice(-400) }
}

const runs = []
for (const host of hosts) {
  console.log(`Running a real ${host} session (${scenario})…`)
  runs.push(scenario === "progress-note" ? await progressNoteSession(host) : await session(host))
  const last = runs.at(-1)
  console.log(`${host}: ${Object.values(last.checks).filter(Boolean).length}/${Object.keys(last.checks).length} in ${last.ms} ms`, last.checks)
}
fs.mkdirSync(out, { recursive: true })
const file = path.join(out, scenario === "lessons" ? `blackbox-real-hosts-${process.platform}.json` : `blackbox-real-hosts-${scenario}-${process.platform}.json`)
fs.writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), runs }, null, 2)}\n`)
const md = ["| Check | " + runs.map((r) => r.host).join(" | ") + " |", "| --- | " + runs.map(() => "---").join(" | ") + " |"]
for (const key of Object.keys(runs[0]?.checks ?? {})) md.push(`| ${key} | ${runs.map((r) => (r.checks[key] ? "pass" : "FAIL")).join(" | ")} |`)
md.push(`| seconds | ${runs.map((r) => Math.round(r.ms / 1000)).join(" | ")} |`)
fs.writeFileSync(file.replace(/\.json$/u, ".md"), `# Real-host sessions\n\n${md.join("\n")}\n`)
console.log(`Wrote ${file}`)
process.exitCode = runs.every((r) => Object.values(r.checks).every(Boolean)) ? 0 : 1
