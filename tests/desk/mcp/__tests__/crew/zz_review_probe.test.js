// Reviewer probes (not part of the PR).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CIT_SHAPED, fakeGh, git, mainFiles, noWait, onMain, pushFromElsewhere, teamRepo } from "./_fixtures.js"
import { crewStatus, joinWorkspace, startWorkspace } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { readCrewRoster } from "../../../../../plugins/desk/mcp/src/desk/crew-roster.js"

const NOW = () => 1767225600000
function memberClone(repo, name = "member") {
  const clone = path.join(repo.base, name)
  spawnSync("git", ["clone", "-q", repo.bare, clone])
  git(clone, ["config", "user.email", "new@example.com"])
  git(clone, ["config", "user.name", "New Member"])
  git(clone, ["remote", "set-url", "origin", "https://github.com/acme/team.git"])
  return { ...repo, clone }
}
async function adopted(files = CIT_SHAPED, tooling = { repo: "acme/team-tooling" }) {
  const repo = await teamRepo(files)
  const { gh } = fakeGh(repo.bare)
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh, wait: noWait, now: NOW, apply: true, tooling, founder: { alias: "test-founder", identity: "test-founder-placeholder" } })
  assert.equal(result.state, "published", result.message)
  return memberClone(repo)
}
const join = (repo, extra = {}) => ({ repo: repo.clone, spawnGit: repo.spawnGit, identity: "newbie_example", alias: "newbie", wait: noWait, now: NOW, ...extra })

function racingGh(repo, files) {
  let created = false
  const { gh } = fakeGh(repo.bare)
  return async (args) => {
    const answer = await gh(args)
    if (args[1] === "create" && !created) {
      created = true
      await pushFromElsewhere(repo, typeof files === "function" ? files() : files)
    }
    return answer
  }
}

test("P1 concurrent join, same alias, different identity", async () => {
  const repo = await adopted()
  const gh = racingGh(repo, () => ({ "_meta/desks.md": `${onMain(repo.bare, "_meta/desks.md")}| newbie | someone_else | desks/newbie | acme/team | crew | desks/newbie |\n` }))
  const result = await joinWorkspace(join(repo, { apply: true, gh }))
  console.log("P1", result.state, JSON.stringify(readCrewRoster(repo.clone)))
})

test("P2 concurrent join, same identity from two machines", async () => {
  const repo = await adopted()
  const gh = racingGh(repo, () => ({ "_meta/desks.md": `${onMain(repo.bare, "_meta/desks.md")}| newbie2 | newbie_example | desks/newbie2 | acme/team | crew | desks/newbie2 |\n` }))
  const result = await joinWorkspace(join(repo, { apply: true, gh }))
  console.log("P2", result.state, JSON.stringify(readCrewRoster(repo.clone)))
})

test("P3 start rebuild when AGENTS.md appeared meanwhile", async () => {
  const files = { ...CIT_SHAPED }
  delete files["AGENTS.md"]
  const repo = await teamRepo(files)
  const gh = racingGh(repo, { "AGENTS.md": "# Teammate's own agent rules\n\nKEEP ME.\n" })
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh, wait: noWait, now: NOW, apply: true, tooling: { repo: "acme/team-tooling" } })
  const agents = onMain(repo.bare, "AGENTS.md")
  console.log("P3", result.state, "teammate text kept:", agents.includes("KEEP ME"))
})

test("P4 monorepo with two plugins", async () => {
  const files = { ...CIT_SHAPED, "plugins/alpha-helpers/plugin.json": "{}", "plugins/team/plugin.json": "{}" }
  const repo = await adopted(files, {})
  const status = await crewStatus({ repo: repo.clone, spawnGit: repo.spawnGit })
  console.log("P4", status.setup, status.tooling?.plugin, status.tooling?.install?.copilot)
})

test("P5 join pr_open then rerun", async () => {
  const repo = await adopted()
  const stuck = fakeGh(repo.bare, { merge: () => ({ code: 1, stdout: "", stderr: "blocked" }), view: () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }) }) })
  const first = await joinWorkspace(join(repo, { apply: true, gh: stuck.gh }))
  const second = await joinWorkspace(join(repo, { apply: true, gh: stuck.gh, now: () => 1767225600999 }))
  console.log("P5", first.state, second.state, "prs created:", stuck.calls.filter((c) => c[1] === "create").length, "status member:", (await crewStatus({ repo: repo.clone, identity: "newbie_example", spawnGit: repo.spawnGit })).member)
})

test("P6 another identity takes over a pushed desk whose roster row is still pending", async () => {
  const repo = await adopted()
  await pushFromElsewhere(repo, { "desks/newbie/AGENTS.md": "x", "desks/newbie/README.md": "x", "desks/newbie/_meta/friction.md": "x" })
  const fresh = memberClone(repo, "fresh")
  const result = await joinWorkspace(join(fresh, { identity: "intruder_example", apply: true, gh: fakeGh(repo.bare).gh }))
  console.log("P6", result.state, result.resumed, JSON.stringify(readCrewRoster(fresh.clone)))
})

test("P7 alias with uppercase from EMU login", async () => {
  const repo = await adopted()
  const r = await joinWorkspace(join(repo, { identity: "JDoe_microsoft", alias: "JDoe" }))
  console.log("P7", r.state, r.message)
})

test("P8 start with a CRLF AGENTS.md", async () => {
  const repo = await teamRepo({ ...CIT_SHAPED, "AGENTS.md": "# Rules\r\n\r\nLine.\r\n" })
  const r = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true })
  const t = onMain(repo.bare, "AGENTS.md")
  console.log("P8", r.state, "CRLF lines:", (t.match(/\r\n/g) || []).length, "LF-only lines:", (t.match(/(?<!\r)\n/g) || []).length)
})

test("P9 first push to an empty repository refused, then rerun", async () => {
  const repo = await teamRepo({})
  const refuse = (cmd, args, options) => (args.includes("push") ? { status: 1, stdout: "", stderr: "remote: Permission denied" } : repo.spawnGit(cmd, args, options))
  const r1 = await startWorkspace({ repo: repo.clone, spawnGit: refuse, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true })
  const head = spawnSync("git", ["-C", repo.clone, "log", "--oneline"], { encoding: "utf8" }).stdout.trim()
  const r2 = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true })
  console.log("P9", r1.state, "|", r1.message, "| local log:", JSON.stringify(head), "| rerun:", r2.state, "| remote files:", mainFiles(repo.bare).length)
})
