// improvement_open, improvement_next, improvement_update. Git and the push are fakes (one test uses a real throwaway
// repository); the machine is a throwaway factory state folder; no agent CLI is started.

import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, readdirSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { improvement_open, improvement_next, improvement_update, AUTHORITY, NEXT_REFUSALS, AGENT_CLOSE_REASONS } from "../../../../../plugins/desk/mcp/src/tools/improvement.js"
import { callTool, TOOL_IMPLS } from "../../../../../plugins/desk/mcp/src/server.js"
import { TOOL_NAMES, TOOL_DESCRIPTIONS } from "../../../../../plugins/desk/mcp/src/tool-names.js"
import { TOOL_INPUT_SCHEMAS } from "../../../../../plugins/desk/mcp/src/tool-schemas.js"
import { SOURCES, CLOSE_REASONS, cardKey, readCards } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { READ_ONLY_TOOLS } from "../../../../../plugins/desk/mcp/src/factory/headless-flag.js"

const JOB = "0123456789abcdef0123456789abcdef"
const FP = "fedcba9876543210fedcba9876543210"
const PR = "https://github.com/ourostack/desk/pull/12"
const ANDON = { source: "andon", id: "ourostack/factory#1", evidence: [`job:${JOB}`] }

function scan(root, folder) {
  const out = []
  const walk = (rel) => {
    let entries = []
    try { entries = readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
    for (const entry of entries) entry.isDirectory() ? walk(path.join(rel, entry.name)) : out.push(path.join(rel, entry.name))
  }
  walk(folder)
  return out
}

function fakeGit(opts = {}) {
  const calls = []
  const spawn = (cmd, args) => {
    const rest = args.slice(2)
    calls.push(rest)
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" })
    if (rest[0] === "rev-parse") return opts.repo === false ? { status: 128, stdout: "", stderr: "" } : ok("true\n")
    if (rest[0] === "diff") return ok("")
    // Everything in the card folder is uncommitted unless the test says the folder is clean.
    if (rest[0] === "ls-files" && rest.includes("--others")) return ok((opts.untracked ?? (opts.clean ? [] : scan(args[1], rest.at(-1)))).join("\0"))
    if (rest[0] === "symbolic-ref") return rest.includes("refs/remotes/origin/HEAD") ? { status: 1, stdout: "", stderr: "" } : ok("main\n")
    if (rest[0] === "commit") return opts.commitFails ? { status: 1, stdout: "", stderr: "secret text" } : ok()
    return ok()
  }
  return { spawn, calls, verbs: () => calls.map((call) => call[0]), commits: () => calls.filter((call) => call[0] === "commit") }
}

async function where() {
  const deskRoot = await mkTempRoot("desk-impr-")
  const state = await mkTempRoot("desk-impr-state-")
  const pushes = []
  const git = fakeGit()
  const env = { HOME: state, XDG_STATE_HOME: path.join(state, "state") }
  const seams = { spawnGit: git.spawn, schedulePush: (arg) => pushes.push(arg) }
  return { deskRoot, env, pushes, git, seams, state, folder: path.join(deskRoot, "_meta", "improvement") }
}
const open = (w, input, extra = {}) => improvement_open({ deskRoot: w.deskRoot, input, ...w.seams, ...extra })
const next = (w, input = {}, extra = {}) => improvement_next({ deskRoot: w.deskRoot, input, env: w.env, ...w.seams, ...extra })
const update = (w, input, extra = {}) => improvement_update({ deskRoot: w.deskRoot, input, ...w.seams, ...extra })
async function claimed(w, input = ANDON) {
  await open(w, input)
  return next(w)
}

test("improvement_open writes and commits exactly the one card file and reports its file name", async () => {
  const w = await where()
  const answer = await open(w, ANDON)
  assert.equal(answer.status, "ok")
  assert.equal(answer.result, "opened")
  assert.match(answer.file_name, /^andon--[0-9a-f]{12}\.md$/u)
  assert.equal("commit" in answer, false)
  assert.deepEqual(await fs.readdir(w.folder), [answer.file_name])
  assert.deepEqual(w.git.commits(), [["commit", "-m", `improvement: open ${answer.file_name}`, "--", `_meta/improvement/${answer.file_name}`]])
  assert.deepEqual(w.pushes, [{ root: w.deskRoot }])
  assert.equal(JSON.stringify(answer).includes(w.deskRoot), false)
})

test("a second open of the same key is a duplicate and commits nothing", async () => {
  const w = await where()
  await open(w, ANDON)
  w.seams.spawnGit = fakeGit({ clean: true }).spawn
  const again = await open(w, ANDON)
  assert.deepEqual({ status: again.status, result: again.result }, { status: "ok", result: "duplicate" })
  assert.equal(w.git.commits().length, 1)
  assert.equal(w.pushes.length, 1)
})

test("a closed card reopens through improvement_open", async () => {
  const w = await where()
  const held = await claimed(w)
  assert.equal((await update(w, { key: held.card.key, claim_id: held.claim_id, state: "closed_unverified", close_reason: "wont_fix" })).state, "closed_unverified")
  const again = await open(w, { ...ANDON, evidence: [`job:${FP}`] })
  assert.equal(again.result, "reopened")
})

test("no source takes a caller title; every source gets a library title", async () => {
  const w = await where()
  const supplied = await open(w, { source: "friction_candidate", id: FP, title: "Tool answers hide the failing step", evidence: [`fingerprint:${FP}`], plugin: "desk", signal: null })
  assert.deepEqual(supplied, { status: "refused", result: "title_not_allowed" })
  const friction = await open(w, { source: "friction_candidate", id: FP, evidence: [`fingerprint:${FP}`], plugin: "desk", signal: null })
  assert.equal(friction.result, "opened")
  const refused = await open(w, { ...ANDON, title: "my own words" })
  assert.deepEqual(refused, { status: "refused", result: "title_not_allowed" })
  const stored = (await readCards({ deskRoot: w.deskRoot, personPrefix: "" })).cards
  assert.deepEqual(stored.map((card) => card.source), ["friction_candidate"])
})

test("improvement_open refuses a bad source, a bad id and bad evidence with a stable code", async () => {
  const w = await where()
  assert.deepEqual(await open(w, { source: "nope", id: "x" }), { status: "refused", result: "invalid_source" })
  assert.deepEqual(await open(w, undefined), { status: "refused", result: "invalid_source" })
  assert.deepEqual(await open(w, { source: "andon", id: "not an id" }), { status: "refused", result: "invalid_source" })
  assert.deepEqual(await open(w, { ...ANDON, evidence: ["/Users/someone/secret"] }), { status: "refused", result: "invalid_evidence" })
  assert.deepEqual(await open(w, { source: "andon", id: "ourostack/factory#2" }), { status: "ok", result: "opened", file_name: (await fs.readdir(w.folder))[0] })
  assert.equal(w.git.verbs().includes("add"), true)
})

test("a commit failure reports a code and never loses the card or the library's answer", async () => {
  const w = await where()
  w.git = fakeGit({ commitFails: true })
  w.seams.spawnGit = w.git.spawn
  const answer = await open(w, ANDON)
  assert.equal(answer.status, "ok")
  assert.equal(answer.commit, "commit_failed")
  assert.equal(JSON.stringify(answer).includes("secret"), false)
  assert.equal((await fs.readdir(w.folder)).length, 1)
  assert.deepEqual(w.pushes, [])
})

test("a card file left uncommitted is committed with the next write", async () => {
  const w = await where()
  const name = await (async () => { await open(w, ANDON); return (await fs.readdir(w.folder))[0] })()
  const dirty = fakeGit({ untracked: [`_meta/improvement/${name}`] })
  w.seams.spawnGit = dirty.spawn
  const held = await next(w)
  assert.equal(held.status, "claimed")
  assert.equal("commit" in held, false)
  assert.deepEqual(dirty.calls.find((call) => call[0] === "add"), ["add", "--", `_meta/improvement/${name}`])
  assert.equal(dirty.commits().length, 1)
})

test("something odd in the card folder is reported as a count, not committed", async () => {
  const w = await where()
  w.seams.spawnGit = fakeGit({ untracked: ["_meta/improvement/notes.txt"] }).spawn
  const answer = await open(w, ANDON)
  assert.equal(answer.left_alone, 1)
  const held = await next(w)
  assert.equal(held.left_alone, 1)
  const upd = await update(w, { key: held.card.key, claim_id: held.claim_id, state: "open" })
  assert.equal(upd.left_alone, 1)
  const refused = await update(w, { key: held.card.key, claim_id: "bad", state: "open" })
  assert.equal("left_alone" in refused, false)
})

test("a desk that is not a Git repository keeps the card file and says not_git", async () => {
  const w = await where()
  w.seams.spawnGit = fakeGit({ repo: false }).spawn
  const answer = await open(w, ANDON)
  assert.equal(answer.status, "ok")
  assert.equal(answer.commit, "not_git")
  assert.equal((await fs.readdir(w.folder)).length, 1)
  assert.deepEqual(w.pushes, [])
})

test("a crew desk person writes under desks/<alias>", async () => {
  const w = await where()
  const answer = await open(w, ANDON, { person: "ari" })
  assert.equal(answer.status, "ok")
  assert.equal((await fs.readdir(path.join(w.deskRoot, "desks", "ari", "_meta", "improvement"))).length, 1)
  assert.deepEqual(w.git.commits()[0].slice(-1), [`desks/ari/_meta/improvement/${answer.file_name}`])
  const held = await next(w, {}, { person: "ari" })
  assert.equal(held.status, "claimed")
  await assert.rejects(open(w, ANDON, { person: "../x" }), /invalid --person/)
})

test("the card write is recorded with the readiness controller when there is one", async () => {
  const w = await where()
  const changes = []
  const readiness = { recordChange: async (change) => { changes.push(change.path); return { recorded: true } } }
  const answer = await open(w, ANDON, { readiness })
  assert.deepEqual(changes, [`_meta/improvement/${answer.file_name}`])
  const refused = await open(w, { source: "nope", id: "x" }, { readiness })
  assert.equal(refused.status, "refused")
  assert.equal(changes.length, 1)
})

test("a moved-aside invalid card is reported as a count and committed with the card", async () => {
  const w = await where()
  await fs.mkdir(w.folder, { recursive: true })
  await fs.writeFile(path.join(w.folder, "andon--000000000000.md"), "not a card")
  const answer = await open(w, ANDON)
  assert.equal(answer.status, "ok")
  assert.equal(answer.set_aside, 1)
  const [commit] = w.git.commits()
  assert.equal(commit.length, 4 + 2)
  assert.equal(commit.slice(4).filter((entry) => entry.includes("invalid/")).length, 1)
  assert.equal(JSON.stringify(answer).includes("andon--000000000000"), false)
})

test("improvement_next claims the oldest card and answers with the authority paragraph, the evidence pointers and no absolute path", async () => {
  const w = await where()
  await open(w, ANDON)
  const answer = await next(w, { session: "0b3a8c34-6d3a-4c1e-9a4e-6d2f6d0a1e11" })
  assert.equal(answer.status, "claimed")
  assert.equal(answer.authority, "This card is standing, pre-authorized work. Decide and fix under the desk's own rules: open the pull request, run the checks, and merge where the repository lets you merge and the desk's instructions say to. Ask the operator only for a true gate: spending money on their payment methods, credentials or accounts only they can act in, or an irreversible destructive action. Record every ruling in the countermeasure pull request; the card links to it.")
  assert.equal(AUTHORITY, answer.authority)
  assert.match(answer.claim_id, /\S/u)
  assert.deepEqual(answer.card.evidence, [`job:${JOB}`])
  assert.equal(answer.card.key, cardKey("andon", "ourostack/factory#1"))
  assert.equal(answer.card.state, "claimed")
  assert.equal(answer.card.source, "andon")
  assert.match(answer.card.title, /\S/u)
  const text = JSON.stringify(answer)
  for (const secret of [w.deskRoot, w.state, "/Users", "/private", "/tmp"]) assert.equal(text.includes(secret), false, secret)
  assert.equal(w.git.commits().length, 2)
  assert.match(w.git.commits()[1][2], /^improvement: claim andon--[0-9a-f]{12}\.md$/u)
})

test("improvement_next explains each refusal in one fixed sentence", async () => {
  const w = await where()
  assert.deepEqual(await next(w), { status: "none_open", meaning: NEXT_REFUSALS.none_open })
  const held = await claimed(w)
  const again = await next(w)
  assert.deepEqual(again, { status: "claim_held", meaning: NEXT_REFUSALS.claim_held, key: held.card.key })
  assert.equal(JSON.stringify(again).includes(held.claim_id), false)
  // the cap: two claims a day on one machine
  const capped = await where()
  for (const id of ["ourostack/factory#1", "ourostack/factory#2"]) {
    const got = await claimed(capped, { source: "andon", id })
    await update(capped, { key: got.card.key, claim_id: got.claim_id, state: "open" })
  }
  await open(capped, { source: "andon", id: "ourostack/factory#3" })
  assert.deepEqual(await next(capped), { status: "cap_reached", meaning: NEXT_REFUSALS.cap_reached })
  assert.deepEqual(Object.keys(NEXT_REFUSALS).sort(), ["cap_reached", "claim_held", "machine_key_unavailable", "none_open", "noninteractive", "too_many_cards"])
  for (const sentence of Object.values(NEXT_REFUSALS)) assert.match(sentence, /^[^\n]+\.$/u)
})

test("improvement_next refuses without a readable machine state and for a bad session", async () => {
  const w = await where()
  await open(w, ANDON)
  const blocker = path.join(w.deskRoot, "a-file")
  await fs.writeFile(blocker, "x")
  const none = await next(w, {}, { env: { ...w.env, XDG_STATE_HOME: path.join(blocker, "state") } })
  assert.deepEqual(none, { status: "machine_key_unavailable", meaning: NEXT_REFUSALS.machine_key_unavailable })
  assert.deepEqual(await next(w, { session: "nope" }), { status: "invalid_session" })
  assert.equal((await next(w, undefined)).status, "claimed")
})

test("improvement_next refuses in a noninteractive environment and in a headless factory session, and claims nothing", async () => {
  const w = await where()
  await open(w, ANDON)
  const before = await fs.readFile(path.join(w.folder, (await fs.readdir(w.folder))[0]), "utf8")
  for (const extra of [{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { CI: "true" }, { CLAUDE_CODE_SESSION_ATTENDED: "0" }, { DESK_FACTORY_HEADLESS: "1" }]) {
    assert.deepEqual(await next(w, {}, { env: { ...w.env, ...extra } }), { status: "noninteractive", meaning: NEXT_REFUSALS.noninteractive }, JSON.stringify(extra))
  }
  assert.equal(await fs.readFile(path.join(w.folder, (await fs.readdir(w.folder))[0]), "utf8"), before)
  assert.equal(w.git.commits().length, 1)
})

test("improvement_update ships a card with a countermeasure URL and commits it", async () => {
  const w = await where()
  const held = await claimed(w)
  const answer = await update(w, { key: held.card.key, claim_id: held.claim_id, countermeasure: PR })
  assert.deepEqual(answer, { status: "updated", state: "shipped" })
  assert.match(w.git.commits().at(-1)[2], /^improvement: update andon--[0-9a-f]{12}\.md$/u)
  const [card] = (await readCards({ deskRoot: w.deskRoot, personPrefix: "" })).cards
  assert.equal(card.state, "shipped")
  assert.equal(card.countermeasure, PR)
})

test("improvement_update releases a claim and closes with an agent close reason", async () => {
  const w = await where()
  const held = await claimed(w)
  assert.deepEqual(await update(w, { key: held.card.key, claim_id: held.claim_id, state: "open" }), { status: "updated", state: "open" })
  const second = await next(w)
  assert.deepEqual(await update(w, { key: second.card.key, claim_id: second.claim_id, state: "closed_unverified", close_reason: "duplicate" }), { status: "updated", state: "closed_unverified" })
  assert.deepEqual(AGENT_CLOSE_REASONS.filter((reason) => !CLOSE_REASONS.includes(reason)), [])
})

test("improvement_update cannot use the system-only close reason source_recovered", async () => {
  const w = await where()
  const held = await claimed(w)
  assert.equal(AGENT_CLOSE_REASONS.includes("source_recovered"), false)
  const refused = await update(w, { key: held.card.key, claim_id: held.claim_id, state: "closed_unverified", close_reason: "source_recovered" })
  assert.equal(refused.status, "refused")
})

test("improvement_update closing without a countermeasure or reason is refused, and the verify step's fields are out of reach", async () => {
  const w = await where()
  const held = await claimed(w)
  const base = { key: held.card.key, claim_id: held.claim_id }
  const refused = { status: "refused", result: "invalid_patch" }
  assert.deepEqual(await update(w, { ...base, state: "closed_unverified" }), refused)
  assert.deepEqual(await update(w, { ...base, state: "closed_unverified", close_reason: "confirmed" }), refused)
  assert.deepEqual(await update(w, { ...base, state: "closed_unverified", close_reason: "wont_fix", countermeasure: PR }), refused)
  assert.deepEqual(await update(w, { ...base, state: "closed_confirmed", close_reason: "confirmed" }), refused)
  assert.deepEqual(await update(w, { ...base, state: "verifying", countermeasure: PR }), refused)
  assert.deepEqual(await update(w, { ...base, state: "open", countermeasure: PR }), refused)
  assert.deepEqual(await update(w, { ...base, state: "shipped", countermeasure: PR, close_reason: "wont_fix" }), refused)
  assert.deepEqual(await update(w, { ...base, state: "shipped" }), refused)
  assert.deepEqual(await update(w, base), refused)
  assert.deepEqual(await update(w, undefined), refused)
  // fields the tool does not read are ignored, never forwarded
  assert.deepEqual(await update(w, { ...base, countermeasure: PR, shipped_version: "9.9.9", kaizen_url: "https://github.com/a/b/issues/1", closed_confirmed: true, checks_run: 5 }), { status: "updated", state: "shipped" })
  const [card] = (await readCards({ deskRoot: w.deskRoot, personPrefix: "" })).cards
  assert.equal(card.shipped_version, null)
  assert.equal(card.kaizen_url, null)
  assert.equal(card.checks_run, 0)
  assert.equal(w.git.commits().length, 3)
})

test("improvement_update refuses a card that is not yours, not found, not claimed, or a bad URL", async () => {
  const w = await where()
  const held = await claimed(w)
  assert.deepEqual(await update(w, { key: held.card.key, claim_id: "wrong", state: "open" }), { status: "refused", result: "not_your_claim" })
  assert.deepEqual(await update(w, { key: held.card.key, state: "open" }), { status: "refused", result: "not_your_claim" })
  assert.deepEqual(await update(w, { claim_id: held.claim_id, state: "open" }), { status: "refused", result: "not_your_claim" })
  assert.deepEqual(await update(w, { key: "andon:ourostack/factory#99", claim_id: held.claim_id, state: "open" }), { status: "refused", result: "not_found" })
  assert.deepEqual(await update(w, { key: held.card.key, claim_id: held.claim_id, countermeasure: "http://evil.example/x" }), { status: "refused", result: "invalid_countermeasure" })
  await update(w, { key: held.card.key, claim_id: held.claim_id, countermeasure: PR })
  // shipped: the verify step owns it now; the old claim id does not reach it
  assert.deepEqual(await update(w, { key: held.card.key, claim_id: held.claim_id, state: "closed_unverified", close_reason: "wont_fix" }), { status: "refused", result: "not_your_claim" })
})

test("improvement_update refuses when the card folder cannot be read", async () => {
  const w = await where()
  const held = await claimed(w)
  await fs.rm(path.join(w.folder, "invalid"), { recursive: true, force: true })
  await fs.writeFile(path.join(w.folder, "invalid"), "x")
  assert.deepEqual(await update(w, { key: held.card.key, claim_id: held.claim_id, state: "open" }), { status: "refused", result: "unreadable_folder" })
})

test("improvement_update reports moved-aside files and a commit failure", async () => {
  const w = await where()
  const held = await claimed(w)
  await fs.writeFile(path.join(w.folder, "andon--000000000000.md"), "not a card")
  const failing = fakeGit({ commitFails: true })
  w.seams.spawnGit = failing.spawn
  const answer = await update(w, { key: held.card.key, claim_id: held.claim_id, state: "open" })
  assert.deepEqual({ status: answer.status, state: answer.state, commit: answer.commit, set_aside: answer.set_aside }, { status: "updated", state: "open", commit: "commit_failed", set_aside: 1 })
})

test("a refused update still reports a moved-aside file", async () => {
  const w = await where()
  const held = await claimed(w)
  await fs.writeFile(path.join(w.folder, "andon--000000000000.md"), "not a card")
  const answer = await update(w, { key: held.card.key, claim_id: held.claim_id, countermeasure: "nope" })
  assert.deepEqual({ status: answer.status, result: answer.result, set_aside: answer.set_aside }, { status: "refused", result: "invalid_countermeasure", set_aside: 1 })
})

test("the three tools appear in the tool names, descriptions, schemas and server dispatch, and are refused under the headless flag", async () => {
  for (const name of ["improvement_open", "improvement_next", "improvement_update"]) {
    assert.ok(TOOL_NAMES.includes(name))
    assert.ok(TOOL_DESCRIPTIONS[name].length > 0)
    assert.ok(TOOL_INPUT_SCHEMAS[name])
    assert.equal(typeof TOOL_IMPLS[name], "function")
    assert.equal(READ_ONLY_TOOLS.includes(name), false)
  }
  assert.deepEqual(TOOL_INPUT_SCHEMAS.improvement_open.properties.source.enum, [...SOURCES])
  assert.deepEqual(TOOL_INPUT_SCHEMAS.improvement_update.properties.close_reason.enum, [...AGENT_CLOSE_REASONS])
  for (const sentence of Object.keys(NEXT_REFUSALS)) assert.ok(TOOL_DESCRIPTIONS.improvement_next.includes(sentence), sentence)
  const w = await where()
  for (const name of ["improvement_open", "improvement_next", "improvement_update"]) {
    const refused = await callTool({ deskRoot: w.deskRoot, name, input: ANDON, env: { DESK_FACTORY_HEADLESS: "1" } })
    assert.equal(refused.isError, true, name)
    assert.equal(JSON.parse(refused.content[0].text).code, "headless_session", name)
  }
  assert.equal(/\d+ hours|four hours/u.test(TOOL_DESCRIPTIONS.improvement_next), false)
  assert.deepEqual(await fs.readdir(w.deskRoot), [])
})

test("on a real repository one open commits exactly the card file", async () => {
  const w = await where()
  const git = (...args) => { const r = spawnSync("git", ["-C", w.deskRoot, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout }
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "T")
  await fs.writeFile(path.join(w.deskRoot, "other.txt"), "x")
  const answer = await improvement_open({ deskRoot: w.deskRoot, input: ANDON, schedulePush: (arg) => w.pushes.push(arg) })
  assert.equal(answer.status, "ok")
  assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean), [`_meta/improvement/${answer.file_name}`])
  assert.equal(git("log", "-1", "--format=%s").trim(), `improvement: open ${answer.file_name}`)
  assert.match(git("status", "--short"), /\?\? other\.txt/)
  assert.equal(w.pushes.length, 1)
})
