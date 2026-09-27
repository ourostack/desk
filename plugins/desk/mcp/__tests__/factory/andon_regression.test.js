// Andon regression fixture: a test store whose latest Desk release makes
// tool failures clearly worse. The store build's `andon` command, run
// through the same gh API routes the store's workflow uses, opens one andon
// issue, leaves it alone while nothing changes, and closes it once a later
// release brings the measure back.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { runAndonCommand } from "../../scripts/factory.js"

const REPO = "example/test-factory"
const TOKEN = "ghs_SENTINEL"
const BOT = "github-actions[bot]"

// A gh runner over an in-memory repository: only the REST routes the issues client sends.
function fakeGitHub() {
  const issues = []
  const comments = []
  const runner = async (args, { token, input } = {}) => {
    assert.equal(token, TOKEN)
    const method = args[args.indexOf("--method") + 1]
    const route = args[args.indexOf("X-GitHub-Api-Version: 2022-11-28") + 1]
    const body = input === undefined ? undefined : JSON.parse(input)
    const answer = (json) => ({ code: 0, stdout: json === undefined ? "" : JSON.stringify(json), stderr: "" })
    const view = (issue) => ({ number: issue.number, title: issue.title, body: issue.body, labels: issue.labels.map((name) => ({ name })), state: issue.state, user: { login: BOT } })
    let match
    if (method === "GET" && (match = /^repos\/example\/test-factory\/issues\?state=(\w+)&labels=(\w+)&per_page=100&page=(\d+)$/u.exec(route))) {
      const [, state, label, page] = match
      return answer(page === "1" ? issues.filter((issue) => issue.labels.includes(label) && (state === "all" || issue.state === state)).map(view) : [])
    }
    if (method === "POST" && route === `repos/${REPO}/issues`) {
      const issue = { number: issues.length + 1, title: body.title, body: body.body, labels: [...body.labels], state: "open" }
      issues.push(issue)
      return answer({ number: issue.number, html_url: `https://github.com/${REPO}/issues/${issue.number}` })
    }
    if (method === "PATCH" && (match = /^repos\/example\/test-factory\/issues\/(\d+)$/u.exec(route))) {
      Object.assign(issues[Number(match[1]) - 1], body)
      return answer({})
    }
    if (method === "GET" && (match = /^repos\/example\/test-factory\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/u.exec(route))) {
      return answer(match[2] === "1" ? comments.filter((comment) => comment.issue === Number(match[1])).map((comment) => ({ id: comment.id, user: { login: BOT }, body: comment.body })) : [])
    }
    if (method === "POST" && (match = /^repos\/example\/test-factory\/issues\/(\d+)\/comments$/u.exec(route))) {
      comments.push({ id: comments.length + 1, issue: Number(match[1]), body: body.body })
      return answer({})
    }
    throw new Error(`unexpected gh call: ${method} ${route}`)
  }
  return { runner, issues, comments }
}

let sessions = 0

// One finished job of one session on Desk `version`, with `failures` failed shell calls.
function writeJob(store, { version, failures }) {
  sessions += 1
  const serial = String(sessions).padStart(12, "0")
  const id = `20000000-0000-4000-8000-${serial}`
  const job = serial.padStart(32, "a")
  const fact = {
    schema: "desk.factory.published/1",
    session: { host: "claude-code", id, host_version: "2.1.0", entrypoint: "cli", duration_ms: 10000, ended: true, end_reason: "complete" },
    plugins: [{ name: "desk", version }],
    models: [],
    agents: [{ n: 0, parent: null, model: "model-alpha" }],
    intervals: [{ kind: "turn", agent: 0, start_ms: 0, end_ms: 10000 }],
    counts: { tool_calls: { shell: failures + 5 }, tool_failures: { shell: failures }, tool_retries: 0, api_retries: 0, compactions: 0 },
    refs: { prs: [], commits: [], private: { prs: 0, commits: 0 } },
    jobs: [{ job, basis: ["desk_tool"], session_offset_ms: 0, transitions: [{ to: "processing", offset_ms: 0 }, { to: "done", offset_ms: 10000 }], observed: null }],
    unavailable: [],
  }
  mkdirSync(path.join(store, "facts"), { recursive: true })
  writeFileSync(path.join(store, "facts", `claude-code-${id}.json`), `${JSON.stringify(fact)}\n`)
}

async function andon(store, github) {
  return runAndonCommand({ argv: ["--store", store, "--repo", REPO], env: { GH_TOKEN: TOKEN }, runner: github.runner })
}

test("andon opens one issue when a release makes tool failures clearly worse, and closes it when a later release recovers", async () => {
  const store = mkdtempSync(path.join(os.tmpdir(), "desk-andon-regression-"))
  try {
    const github = fakeGitHub()
    for (const failures of [1, 2, 1]) writeJob(store, { version: "3.3.0", failures })
    for (const failures of [9, 10, 11]) writeJob(store, { version: "3.4.0", failures })

    const opened = await andon(store, github)
    assert.deepEqual(opened.alarms.map(({ title, action }) => ({ title, action })), [{ title: "Andon: desk 3.4.0 tool_failures", action: "opened" }])
    assert.equal(github.issues.length, 1)
    assert.deepEqual(github.issues[0].labels, ["andon"])
    assert.equal(github.issues[0].state, "open")
    assert.match(github.issues[0].body, /3\.3\.0/u)

    // Nothing new: the same alarm, no second issue.
    assert.deepEqual((await andon(store, github)).alarms.map(({ action }) => action), ["unchanged"])
    assert.equal(github.issues.length, 1)

    // A later release brings tool failures back down.
    for (const failures of [1, 2]) writeJob(store, { version: "3.5.0", failures })
    const closed = await andon(store, github)
    assert.deepEqual(closed.alarms.map(({ title, action }) => ({ title, action })), [{ title: "Andon: desk 3.4.0 tool_failures", action: "closed" }])
    assert.equal(github.issues[0].state, "closed")
    assert.equal(github.comments.length, 1)
    assert.match(github.comments[0].body, /3\.5\.0/u)
    assert.equal(github.issues.length, 1)
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})
