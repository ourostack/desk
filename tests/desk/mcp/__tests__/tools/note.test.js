// note_leave and note_ack: a teammate's agent leaves another member a dated, attributed note in their `_inbox/`, through
// a pull request it merges; the recipient acknowledges it on their own desk. Git runs for real against a local bare
// repository that stands in for GitHub; `gh` and the account choice are fakes that act on that repository, as in
// lesson_team.test.js.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { note_ack, note_leave, localIso, noteFileName } from "../../../../../plugins/desk/mcp/src/tools/note.js"
import { parseNote, renderNote } from "../../../../../plugins/desk/mcp/src/runtime/inbox.js"
import { mkTempDeskRoot } from "./_helpers.js"

const URL = "https://github.com/acme/cit"
const PR = `${URL}/pull/9`
const ROSTER = "| alias | identity | path |\n| --- | --- | --- |\n| ari | ari@example.com | desks/ari |\n| saranya | saranya@example.com | desks/saranya |\n"

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

const toBare = (bare, inner = spawnSync) => (cmd, args, options) => inner(cmd, args, { ...options, env: { ...options.env, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: `${URL}.git`, GIT_CONFIG_KEY_1: `url.${bare}.pushInsteadOf`, GIT_CONFIG_VALUE_1: `${URL}.git` } })

// A Crew workspace on a bare "GitHub" repository, and Ari's clone of it, which is the desk.
async function workspace(files = {}) {
  const base = await mkTempDeskRoot()
  const bare = path.join(base, "origin.git")
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  const seed = path.join(base, "seed")
  spawnSync("git", ["init", "-q", "-b", "main", seed])
  git(seed, ["config", "user.email", "t@example.com"])
  git(seed, ["config", "user.name", "Seed"])
  const all = { "AGENTS.md": "# Crew\n", "_meta/desks.md": ROSTER, "desks/ari/AGENTS.md": "# Ari\n", "desks/saranya/AGENTS.md": "# Saranya\n", "_shared/tracks/plan.md": "# Plan\n", ...files }
  for (const [name, content] of Object.entries(all)) {
    await fs.mkdir(path.dirname(path.join(seed, name)), { recursive: true })
    await fs.writeFile(path.join(seed, name), content, "utf8")
  }
  git(seed, ["add", "-A"])
  git(seed, ["commit", "-q", "-m", "seed"])
  git(seed, ["push", "-q", bare, "main"])
  const clone = path.join(base, "clone")
  spawnSync("git", ["clone", "-q", bare, clone])
  git(clone, ["config", "user.email", "t@example.com"])
  git(clone, ["config", "user.name", "Ari"])
  git(clone, ["remote", "set-url", "origin", URL])
  return { base, bare, seed, clone, spawnGit: toBare(bare) }
}

function fakeGh(bare, { merge, view } = {}) {
  const calls = []
  const state = { head: null, merged: false, merges: 0, closed: false }
  const gh = async (args) => {
    calls.push(args)
    const [a, b] = args
    if (a === "auth" && b === "token") return { code: 0, stdout: "tok\n" }
    if (a === "api") return { code: 0, stdout: JSON.stringify({ base: "main", parent: null }) }
    if (a === "pr" && b === "close") {
      state.closed = true
      return { code: 0 }
    }
    if (a === "pr" && b === "create") {
      state.head = args[args.indexOf("--head") + 1]
      return { code: 0, stdout: `${PR}\n` }
    }
    if (a === "pr" && b === "merge") {
      state.merges += 1
      if (merge !== undefined) return merge(state)
      const ok = spawnSync("git", ["--git-dir", bare, "merge-base", "--is-ancestor", "main", state.head]).status === 0
      if (ok) {
        spawnSync("git", ["--git-dir", bare, "update-ref", "refs/heads/main", `refs/heads/${state.head}`])
        state.merged = true
      }
      return { code: ok ? 0 : 1 }
    }
    if (a === "pr" && b === "view") {
      if (view !== undefined) return view(state)
      const oid = spawnSync("git", ["--git-dir", bare, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim()
      return { code: 0, stdout: JSON.stringify(state.merged ? { state: "MERGED", mergeCommit: { oid } } : { state: "OPEN", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) }
    }
    throw new Error(`unexpected gh ${args.join(" ")}`)
  }
  return { gh, calls, state }
}

const direct = async () => ({ result: "account_found", account: "arimendelow", route: "direct" })
const at = (iso, offset) => Object.assign(new Date(iso), { getTimezoneOffset: () => offset })
const INPUT = { to: "saranya", subject: "Your tracker is being extended", body: "Here's my understanding of what Ari was thinking: the tracker grows into the one customer store.", related: ["_shared/tracks/plan.md", "https://example.com/plan"] }
const leave = (ws, extra = {}) => note_leave({ deskRoot: ws.clone, person: "ari", input: INPUT, spawnGit: ws.spawnGit, chooseAccount: direct, wait: async () => {}, now: () => at("2026-10-30T20:05:06Z", 420), ...extra })
const inbox = (bare) => spawnSync("git", ["--git-dir", bare, "ls-tree", "--name-only", "main", "desks/saranya/_inbox/"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean)
const onMain = (bare, file) => spawnSync("git", ["--git-dir", bare, "show", `main:${file}`], { encoding: "utf8" }).stdout
const branches = (bare) => spawnSync("git", ["--git-dir", bare, "branch", "--list", "note/*"], { encoding: "utf8" }).stdout.trim()

test("localIso gives the local time with its offset, either side of UTC", () => {
  assert.equal(localIso(at("2026-10-30T20:05:06Z", 420)), "2026-10-30T13:05:06-07:00")
  assert.equal(localIso(at("2026-10-30T20:05:06Z", -330)), "2026-10-31T01:35:06+05:30")
  assert.equal(localIso(at("2026-10-30T20:05:06Z", 0)), "2026-10-30T20:05:06+00:00")
})

test("noteFileName dates, attributes and slugs the note, with a unique ending", () => {
  assert.equal(noteFileName({ date: "2026-10-30", from: "ari", subject: "The tracker: being extended!", unique: "a1b2c3" }), "2026-10-30-ari-the-tracker-being-extended-a1b2c3.md")
  assert.equal(noteFileName({ date: "2026-10-30", from: "ari", subject: "x".repeat(80), unique: "a1b2c3" }), `2026-10-30-ari-${"x".repeat(40)}-a1b2c3.md`)
  assert.equal(noteFileName({ date: "2026-10-30", from: "ari", subject: "!!!", unique: "a1b2c3" }), "2026-10-30-ari-note-a1b2c3.md")
  assert.equal(noteFileName({ date: "2026-10-30", from: "ari", subject: `${"x".repeat(39)} y`, unique: "a1b2c3" }), `2026-10-30-ari-${"x".repeat(39)}-a1b2c3.md`, "no dash left where the cut falls")
})

test("note_leave writes only the recipient's inbox, through a pull request it merges, and says the note is left", async () => {
  const ws = await workspace()
  const fake = fakeGh(ws.bare)
  const result = await leave(ws, { gh: fake.gh })
  assert.equal(result.status, "merged")
  assert.equal(result.to, "saranya")
  assert.equal(result.pr, PR)
  assert.equal(result.commit, git(ws.bare, ["rev-parse", "main"]))
  assert.match(result.note, /^desks\/saranya\/_inbox\/2026-10-30-ari-your-tracker-is-being-extended-[0-9a-f]{6}\.md$/u)
  assert.match(result.message, /^Left for saranya: merged in https:\/\/github\.com\/acme\/cit\/pull\/9\. saranya's session start lists it until they acknowledge it with note_ack\. Everyone in the workspace can read it\.$/u)
  assert.deepEqual(inbox(ws.bare), [result.note])
  const written = parseNote(onMain(ws.bare, result.note))
  assert.deepEqual([written.from, written.to, written.created, written.status, written.subject, written.related], ["ari", "saranya", "2026-10-30T13:05:06-07:00", "open", INPUT.subject, INPUT.related])
  assert.match(written.content, /^\nHere's my understanding of what Ari was thinking: [^\n]+\n\nRelated:\n\n- _shared\/tracks\/plan\.md\n- https:\/\/example\.com\/plan\n\nari left this note with note_leave\. Ask ari if anything here is unclear\.\n$/u)
  // The pull request's title and text, and only the note in the merged change.
  const create = fake.calls.find((args) => args[1] === "create")
  assert.equal(create[create.indexOf("--title") + 1], `Note for saranya: ${INPUT.subject}`)
  assert.match(create[create.indexOf("--body") + 1], /^Leaves saranya a note from ari, written by Desk's note_leave: desks\/saranya\/_inbox\//u)
  assert.equal(git(ws.bare, ["diff", "--name-only", "main~1", "main"]), result.note)
  // The desk's own checkout and branches are as they were, and the pushed branch is gone.
  assert.equal(git(ws.clone, ["status", "--short"]), "")
  assert.equal(git(ws.clone, ["worktree", "list"]).split("\n").length, 1)
  assert.equal(branches(ws.bare), "")
})

test("note_leave refuses, before any remote work, what a teammate's note cannot be", async () => {
  const ws = await workspace()
  const gh = async () => assert.fail("no gh call")
  const run = (input, extra = {}) => leave(ws, { gh, input: { ...INPUT, ...input }, ...extra })
  // With nothing injected, the real gh runner and account choice are only set up: input is checked first.
  await assert.rejects(() => note_leave({ deskRoot: ws.clone, input: INPUT }), /this session has no person/u)
  const solo = await mkTempDeskRoot()
  await assert.rejects(() => run({}, { deskRoot: solo }), /a Crew shared workspace/u)
  await assert.rejects(() => run({}, { person: "  " }), /this session has no person/u)
  await assert.rejects(() => run({ to: undefined }), /`to` is required/u)
  await assert.rejects(() => run({ to: "../x" }), /`to` must be a member's alias/u)
  await assert.rejects(() => run({ to: "bo" }), /bo has not joined this workspace \(no row in _meta\/desks\.md\)/u)
  await assert.rejects(() => run({ to: "ari" }), /a note to yourself/u)
  await assert.rejects(() => run({ subject: "" }), /`subject` is required/u)
  await assert.rejects(() => run({ subject: "two\nlines" }), /`subject` must be one line of at most 120 characters/u)
  await assert.rejects(() => run({ subject: "x".repeat(121) }), /at most 120 characters/u)
  await assert.rejects(() => run({ body: " " }), /`body` is required/u)
  await assert.rejects(() => run({ body: "x".repeat(8001) }), /`body` must be at most 8000 characters/u)
  await assert.rejects(() => run({ related: "one" }), /`related` must be a list/u)
  await assert.rejects(() => run({ related: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`) }), /at most 10/u)
  for (const bad of [7, "", "http://example.com", "https://user:pw@example.com/x", "https://", "/etc/passwd", "../outside.md", "a/../../b", "a\\b", "C:/x", "two\nlines", "."]) {
    await assert.rejects(() => run({ related: [bad] }), /each `related` entry must be an https URL or a path in this repository/u, JSON.stringify(bad))
  }
  git(ws.clone, ["remote", "set-url", "origin", ws.bare])
  await assert.rejects(() => run({}), /origin is not on GitHub/u)
})

test("note_leave reports where the remote work stopped, with the note not left", async () => {
  // The recipient is on this clone's roster but not on the default branch's (they left, or the roster moved on).
  const ws = await workspace()
  await fs.writeFile(path.join(ws.seed, "_meta", "desks.md"), "| alias | identity |\n| --- | --- |\n| ari | ari@example.com |\n", "utf8")
  git(ws.seed, ["commit", "-q", "-am", "saranya left"])
  git(ws.seed, ["push", "-q", ws.bare, "main"])
  const gone = await leave(ws, { gh: fakeGh(ws.bare).gh })
  assert.deepEqual([gone.status, gone.stage], ["failed", "member"])
  assert.equal(gone.message, "Not left: the note stopped at member (saranya is not on the roster in _meta/desks.md on the default branch of acme/cit).")
  git(ws.seed, ["rm", "-q", "_meta/desks.md"])
  git(ws.seed, ["commit", "-q", "-m", "no roster"])
  git(ws.seed, ["push", "-q", ws.bare, "main"])
  assert.equal((await leave(ws, { gh: fakeGh(ws.bare).gh })).stage, "member")
  // A related path that is not on the default branch.
  const missing = await workspace()
  const result = await leave(missing, { gh: fakeGh(missing.bare).gh, input: { ...INPUT, related: ["_shared/tracks/nope.md"] } })
  assert.deepEqual([result.status, result.stage], ["failed", "related"])
  assert.match(result.reason, /_shared\/tracks\/nope\.md is not on the default branch of acme\/cit/u)
  assert.deepEqual(inbox(missing.bare), [])
  // An account that cannot push: nothing opened.
  const noAccount = await leave(missing, { gh: fakeGh(missing.bare).gh, chooseAccount: async () => ({ result: "no_account_can_deliver" }) })
  assert.deepEqual([noAccount.stage, noAccount.pr], ["account", undefined])
  // A failure after the pull request opened names it.
  let pushes = 0
  const spawnGit = toBare(missing.bare, (cmd, args, options) => (args.includes("push") && args.includes("--force") && (pushes += 1) === 2 ? { status: 1, stdout: "", stderr: "remote: denied" } : spawnSync(cmd, args, options)))
  const late = await leave(missing, { gh: fakeGh(missing.bare, { merge: () => ({ code: 1 }) }).gh, spawnGit })
  assert.equal(late.stage, "push")
  assert.match(late.message, new RegExp(`^Not left: the note stopped at push \\(the push was refused: remote: denied\\)\\. The pull request ${PR} is open, on branch note/saranya-`, "u"))
  // A bug is thrown, not reported.
  await assert.rejects(() => leave(missing, { gh: fakeGh(missing.bare, { merge: () => { throw new Error("gh crashed") } }).gh }), /gh crashed/u)
})

test("note_leave leaves the pull request open, and says the note is not delivered yet, when it cannot merge now", async () => {
  const ws = await workspace()
  const blocked = fakeGh(ws.bare, { merge: () => ({ code: 1 }), view: () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }) }) })
  const result = await leave(ws, { gh: blocked.gh })
  assert.deepEqual([result.status, result.reason, result.pr], ["pr_open", "BLOCKED", PR])
  assert.equal(result.message, `Not delivered yet: the pull request ${PR} is open on branch ${result.branch} and has not merged (BLOCKED). saranya sees the note once it merges.`)
  assert.equal(branches(ws.bare), result.branch)
})

test("note_leave refuses an exact duplicate of a note already in the recipient's inbox, open or acknowledged", async () => {
  const ws = await workspace()
  const first = await leave(ws, { gh: fakeGh(ws.bare).gh })
  const fake = fakeGh(ws.bare)
  const again = await leave(ws, { gh: fake.gh, now: () => at("2026-10-31T09:00:00Z", 420) })
  assert.deepEqual([again.status, again.note, again.note_status], ["duplicate", first.note, "open"])
  assert.equal(again.message, `Not left: saranya already has this note from you (${first.note}, open).`)
  assert.equal(fake.calls.some((args) => args[1] === "create"), false)
  // Another subject, body or set of links is a new note.
  const other = await leave(ws, { gh: fakeGh(ws.bare).gh, input: { to: INPUT.to, subject: INPUT.subject, body: INPUT.body } })
  assert.equal(other.status, "merged")
  assert.equal(inbox(ws.bare).length, 2)
  // The same note landing while this one's pull request is open: closed, nothing added.
  const race = await workspace()
  const raced = fakeGh(race.bare)
  const gh = async (args) => {
    if (args[0] === "pr" && args[1] === "merge" && raced.state.merges === 0) {
      const text = renderNote({ from: "ari", to: "saranya", created: "2026-10-29T10:00:00-07:00", subject: INPUT.subject, related: INPUT.related, body: INPUT.body })
      await fs.mkdir(path.join(race.seed, "desks", "saranya", "_inbox"), { recursive: true })
      await fs.writeFile(path.join(race.seed, "desks", "saranya", "_inbox", "2026-10-29-ari-same-ffffff.md"), text.replace("status: open", "status: acknowledged"), "utf8")
      await fs.writeFile(path.join(race.seed, "desks", "saranya", "_inbox", "0-readme.md"), "not a note", "utf8")
      git(race.seed, ["add", "-A"])
      git(race.seed, ["commit", "-q", "-m", "same note"])
      git(race.seed, ["push", "-q", race.bare, "main"])
    }
    return raced.gh(args)
  }
  const late = await leave(race, { gh })
  assert.deepEqual([late.status, late.note, late.note_status, raced.state.closed], ["duplicate", "desks/saranya/_inbox/2026-10-29-ari-same-ffffff.md", "acknowledged", true])
  assert.equal(branches(race.bare), "")
})

// ── note_ack ────────────────────────────────────────────────────────────

async function saranyaDesk({ gitDesk = true } = {}) {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.writeFile(path.join(root, "_meta", "desks.md"), ROSTER)
  const dir = path.join(root, "desks", "saranya", "_inbox")
  await fs.mkdir(dir, { recursive: true })
  const name = "2026-10-30-ari-your-tracker-abcdef.md"
  await fs.writeFile(path.join(dir, name), renderNote({ from: "ari", to: "saranya", created: "2026-10-30T13:00:00-07:00", subject: INPUT.subject, related: [], body: INPUT.body }))
  if (gitDesk) {
    spawnSync("git", ["init", "-q", "-b", "main", root])
    git(root, ["config", "user.email", "t@example.com"])
    git(root, ["config", "user.name", "Saranya"])
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "seed"])
  }
  return { root, dir, name, rel: `desks/saranya/_inbox/${name}` }
}

test("note_ack marks the person's own note acknowledged, commits it and pushes, and keeps the file", async () => {
  const desk = await saranyaDesk()
  const pushes = []
  const changes = []
  const ack = (note, extra = {}) => note_ack({ deskRoot: desk.root, person: "saranya", input: { note }, schedulePush: (args) => pushes.push(args), search: { noteChange: (rel) => changes.push(rel) }, now: () => at("2026-10-31T16:00:00Z", 420), ...extra })
  const result = await ack(desk.rel)
  assert.deepEqual(result, { status: "acknowledged", note: desk.rel, from: "ari", subject: INPUT.subject, committed: true, message: `Acknowledged ${desk.rel} from ari. It is committed, and ari sees it once your desk syncs.` })
  const text = await fs.readFile(path.join(desk.dir, desk.name), "utf8")
  assert.match(text, /\nstatus: acknowledged\nacknowledged: "2026-10-31T09:00:00-07:00"\n/u)
  assert.equal(git(desk.root, ["status", "--short"]), "")
  assert.equal(git(desk.root, ["log", "-1", "--format=%s"]), `note_ack: ${desk.name}`)
  assert.deepEqual([pushes, changes], [[{ root: desk.root }], [desk.rel]])
  // The bare file name works too, and a second acknowledgement changes nothing.
  const again = await ack(desk.name)
  assert.deepEqual([again.status, again.committed], ["unchanged", true])
  assert.equal(again.message, `${desk.rel} is already acknowledged.`)
  assert.equal(pushes.length, 1)
})

test("note_ack writes but does not commit when it cannot, and says why", async () => {
  const plain = await saranyaDesk({ gitDesk: false })
  const run = (desk, extra = {}) => note_ack({ deskRoot: desk.root, person: "saranya", input: { note: desk.rel }, schedulePush: () => assert.fail("no push"), ...extra })
  const notGit = await run(plain)
  assert.deepEqual([notGit.status, notGit.committed], ["acknowledged", false])
  assert.match(notGit.message, /^Acknowledged desks\/saranya\/_inbox\/[^ ]+ from ari on this machine, but not committed \(this desk is not a Git checkout\), so ari does not see it yet\.$/u)
  const dirty = await saranyaDesk()
  await fs.appendFile(path.join(dirty.dir, dirty.name), "My own line.\n")
  const held = await run(dirty)
  assert.match(held.message, /not committed \(the note already held uncommitted changes, so Desk left it for you to commit\)/u)
  assert.match(await fs.readFile(path.join(dirty.dir, dirty.name), "utf8"), /status: acknowledged[^]*My own line\./u)
  const failing = await saranyaDesk()
  const spawnGit = (cmd, args, options) => (args.includes("commit") ? { status: 1, stdout: "", stderr: "hook said no" } : spawnSync(cmd, args, options))
  const refused = await run(failing, { spawnGit })
  assert.deepEqual([refused.committed, refused.commit], [false, { status: "failed", reason: "hook said no" }])
  assert.match(refused.message, /not committed \(the commit failed: hook said no\)/u)
})

test("note_ack refuses anything but a note in the person's own inbox", async () => {
  const desk = await saranyaDesk()
  const run = (note, extra = {}) => note_ack({ deskRoot: desk.root, person: "saranya", input: { note }, ...extra })
  // With nothing injected, the real Git, push and clock are only set up: input is checked first.
  await assert.rejects(() => note_ack({ deskRoot: desk.root, input: { note: desk.name } }), /this session has no person/u)
  const solo = await mkTempDeskRoot()
  await assert.rejects(() => run(desk.name, { deskRoot: solo }), /a Crew shared workspace/u)
  await assert.rejects(() => run(undefined), /`note` is required/u)
  await assert.rejects(() => run("desks/ari/_inbox/x.md"), /only a note in your own inbox, desks\/saranya\/_inbox\//u)
  await assert.rejects(() => run("../x.md"), /only a note in your own inbox/u)
  await assert.rejects(() => run("x.txt"), /only a note in your own inbox/u)
  await assert.rejects(() => run("missing.md"), /no note desks\/saranya\/_inbox\/missing\.md/u)
  await fs.writeFile(path.join(desk.dir, "plain.md"), "no frontmatter\n")
  await assert.rejects(() => run("plain.md"), /desks\/saranya\/_inbox\/plain\.md is not a note/u)
})
