// writeCardCommitted: the one commit path for card files. Git and the push are fakes; one test uses a real throwaway repository.

import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { writeCardCommitted, cardCommitMessage, stagingAllowed, stageAndCommitFile, COMMIT_CODES } from "../../../../../plugins/desk/mcp/src/tools/_card-commit.js"

const ROOT = "/desk"
const CARDS = "/desk/_meta/improvement"
const NAME = "andon--0123456789ab.md"

// A scripted Git: answers by sub-command and records every call.
function fakeGit(opts = {}) {
  const calls = []
  const spawn = (cmd, args) => {
    assert.equal(cmd, "git")
    assert.equal(args[0], "-C")
    const rest = args.slice(2)
    calls.push(rest)
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" })
    if (rest[0] === "rev-parse") return opts.repo === false ? { status: 128, stdout: "", stderr: "fatal" } : ok("true\n")
    if (rest[0] === "diff" && rest.includes("--cached")) return ok((opts.staged ?? []).join("\0"))
    if (rest[0] === "diff") return opts.diffFails ? { status: 1, stdout: "", stderr: "x" } : ok((opts.dirty ?? []).join("\0"))
    if (rest[0] === "ls-files" && rest.includes("--others")) return ok((opts.untracked ?? []).join("\0"))
    if (rest[0] === "ls-files") return ok((opts.tracked ?? []).includes(rest.at(-1)) ? `${rest.at(-1)}\n` : "")
    if (rest[0] === "add") return opts.addFails ? { status: 1, stdout: "", stderr: "x" } : ok()
    if (rest[0] === "symbolic-ref") return rest.includes("refs/remotes/origin/HEAD") ? { status: 1, stdout: "", stderr: "" } : ok(`${opts.branch ?? "main"}\n`)
    if (rest[0] === "commit") return opts.commitFails ? { status: 1, stdout: "", stderr: "x" } : ok()
    throw new Error(`unexpected git ${rest.join(" ")}`)
  }
  return { spawn, calls }
}

const run = (git, over = {}, written = { result: "opened", file: path.join(CARDS, NAME) }) => {
  const pushes = []
  return writeCardCommitted({ deskRoot: ROOT, personPrefix: "", write: async () => written, message: "m", spawnGit: git.spawn, schedulePush: (arg) => pushes.push(arg), ...over }).then((out) => ({ ...out, pushes }))
}
const verbs = (git) => git.calls.map((call) => call[0])

test("a written card is staged by exact path, committed with the fixed message and pushed once", async () => {
  const git = fakeGit({ untracked: [`_meta/improvement/${NAME}`] })
  const out = await run(git, { message: (result) => `improvement: open ${result.file_name}` })
  assert.deepEqual(out.result, { result: "opened", file_name: NAME })
  assert.equal(out.commit, "committed")
  assert.deepEqual(out.pushes, [{ root: ROOT }])
  assert.deepEqual(git.calls.find((call) => call[0] === "add"), ["add", "--", `_meta/improvement/${NAME}`])
  assert.deepEqual(git.calls.find((call) => call[0] === "commit"), ["commit", "-m", `improvement: open ${NAME}`, "--", `_meta/improvement/${NAME}`])
  assert.equal(JSON.stringify({ result: out.result, commit: out.commit }).includes(ROOT), false, "no absolute path comes back")
  assert.ok(COMMIT_CODES.includes(out.commit))
  assert.equal(COMMIT_CODES.includes("already_dirty"), false)
})

test("a string message works, and a person prefix moves the folder", async () => {
  const git = fakeGit({ untracked: ["desks/ari/_meta/improvement/andon--0123456789ab.md"] })
  const out = await run(git, { personPrefix: "desks/ari" }, { result: "opened", file: "/desk/desks/ari/_meta/improvement/andon--0123456789ab.md" })
  assert.equal(out.commit, "committed")
  assert.deepEqual(git.calls.find((call) => call[0] === "commit").slice(-1), ["desks/ari/_meta/improvement/andon--0123456789ab.md"])
  assert.equal(git.calls.find((call) => call[0] === "commit")[2], "m")
})

test("leftover card files and set-aside moves in the card folder are committed with the new write", async () => {
  const git = fakeGit({ dirty: ["_meta/improvement/bad.md", "_meta/improvement/andon--aaaaaaaaaaaa.md"], untracked: [`_meta/improvement/${NAME}`, "_meta/improvement/invalid/bad.md.aaaaaa"] })
  const out = await run(git, {}, { result: "opened", file: `${CARDS}/${NAME}`, set_aside: 1, set_aside_files: [`${CARDS}/bad.md`, `${CARDS}/invalid/bad.md.aaaaaa`] })
  assert.equal(out.commit, "committed")
  assert.equal(out.left_alone, 0)
  assert.equal(out.result.set_aside, 1)
  assert.equal("set_aside_files" in out.result, false)
  assert.deepEqual(git.calls.find((call) => call[0] === "add"), ["add", "--", "_meta/improvement/bad.md", "_meta/improvement/andon--aaaaaaaaaaaa.md", `_meta/improvement/${NAME}`, "_meta/improvement/invalid/bad.md.aaaaaa"])
})

test("something in the card folder that is not a card file or a set-aside file is left alone and counted", async () => {
  const git = fakeGit({ dirty: ["_meta/improvement/notes.txt", "_meta/improvement/invalid/notes.txt", "_meta/improvement/.improvement-1-ab.tmp", "_meta/improvement/sub/andon--0123456789ab.md", `_meta/improvement/${NAME}`] })
  const out = await run(git)
  assert.equal(out.commit, "committed")
  assert.equal(out.left_alone, 4)
  assert.deepEqual(git.calls.find((call) => call[0] === "add"), ["add", "--", `_meta/improvement/${NAME}`])
  const only = fakeGit({ dirty: ["_meta/improvement/notes.txt"] })
  const nothing = await run(only, {}, { result: "none_open" })
  assert.deepEqual({ commit: nothing.commit, left_alone: nothing.left_alone }, { commit: "no_files", left_alone: 1 })
  assert.equal(only.calls.some((call) => call[0] === "add"), false)
})

test("a result with no card file still commits leftover card files", async () => {
  const git = fakeGit({ dirty: [`_meta/improvement/${NAME}`] })
  const out = await run(git, {}, { result: "none_open" })
  assert.equal(out.commit, "committed")
  assert.equal("file_name" in out.result, false)
})

test("a result that names nothing, in a folder with nothing to commit, commits nothing", async () => {
  const git = fakeGit()
  const out = await run(git, {}, { result: "none_open" })
  assert.equal(out.commit, "no_files")
  assert.deepEqual(out.pushes, [])
  assert.equal(verbs(git).includes("add"), false)
  const same = await run(fakeGit(), {}, { result: "duplicate", file: `${CARDS}/${NAME}` })
  assert.equal(same.commit, "no_change")
})

test("a lock file, a temp file, a path outside the card folder and a relative path never reach Git", async () => {
  for (const file of ["/desk/_meta/.improvement.lock", "/desk/_meta/.improvement-1-ab.tmp", `${CARDS}/.improvement-1-ab.tmp`, "/desk/_meta/friction.md", "/elsewhere/improvement/x.md", `${CARDS}`, "improvement/x.md"]) {
    const git = fakeGit()
    const out = await run(git, {}, { result: "opened", file })
    assert.equal(out.commit, "unsafe_path", file)
    assert.equal(verbs(git).includes("add"), false, file)
  }
  const git = fakeGit()
  assert.equal((await run(git, {}, { result: "x", set_aside_files: [`${CARDS}/a.md`, "/desk/_meta/.improvement.lock"] })).commit, "unsafe_path")
})

test("a desk that is not a Git repository keeps the card uncommitted and schedules no push", async () => {
  const git = fakeGit({ repo: false })
  const out = await run(git)
  assert.equal(out.commit, "not_git")
  assert.deepEqual(out.pushes, [])
  assert.equal((await run(git, {}, { result: "none_open" })).commit, "no_files")
  const relative = await run(git, { deskRoot: "relative/desk" })
  assert.equal(relative.commit, "unsafe_path")
})

test("a Git that cannot list the folder, stage or commit gives its code and keeps the card", async () => {
  assert.equal((await run(fakeGit({ diffFails: true }))).commit, "stage_failed")
  assert.equal((await run(fakeGit({ addFails: true, dirty: [`_meta/improvement/${NAME}`] }))).commit, "stage_failed")
  const failed = fakeGit({ commitFails: true, dirty: [`_meta/improvement/${NAME}`] })
  const out = await run(failed)
  assert.equal(out.commit, "commit_failed")
  assert.deepEqual(out.pushes, [])
  assert.deepEqual(out.result, { result: "opened", file_name: NAME })
})

test("a writer that throws propagates and nothing is staged", async () => {
  const git = fakeGit()
  await assert.rejects(writeCardCommitted({ deskRoot: ROOT, write: async () => { throw new Error("boom") }, message: "m", spawnGit: git.spawn, schedulePush: () => {} }), /boom/)
  assert.equal(verbs(git).includes("add"), false)
})

test("the default seams are real functions", async () => {
  const deskRoot = await mkTempRoot("desk-commit-")
  const out = await writeCardCommitted({ deskRoot, write: async () => ({ result: "none_open" }), message: "m" })
  assert.equal(out.commit, "no_files")
})

test("cardCommitMessage is a fixed verb plus the file name only", () => {
  assert.equal(cardCommitMessage("open", `/a/b/${NAME}`), `improvement: open ${NAME}`)
  assert.equal(cardCommitMessage("claim", NAME), `improvement: claim ${NAME}`)
  for (const verb of ["", "Open", "open card", "1x", undefined, "a".repeat(30)]) assert.throws(() => cardCommitMessage(verb, NAME), /invalid_verb/)
})

test("the friction helpers keep their old behaviour", () => {
  const git = fakeGit()
  assert.equal(stagingAllowed("/desk/_meta/friction.md", git.spawn), true)
  assert.equal(stagingAllowed("/desk/_meta/friction.md", fakeGit({ repo: false }).spawn), false)
  assert.equal(stageAndCommitFile("/desk/_meta/friction.md", "m", git.spawn), undefined)
  assert.deepEqual(stageAndCommitFile("/desk/_meta/friction.md", "m", fakeGit({ addFails: true }).spawn), { status: "failed", reason: "x" })
  assert.deepEqual(stageAndCommitFile("/desk/_meta/friction.md", "m", fakeGit({ commitFails: true }).spawn), { status: "failed", reason: "x" })
})

test("on a real repository the card and a moved-aside file land in one commit and nothing else is staged", async () => {
  const deskRoot = await mkTempRoot("desk-commit-real-")
  const git = (...args) => { const r = spawnSync("git", ["-C", deskRoot, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout }
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "T")
  const folder = path.join(deskRoot, "_meta", "improvement")
  await fs.mkdir(path.join(folder, "invalid"), { recursive: true })
  await fs.writeFile(path.join(folder, "bad.md"), "x")
  await fs.writeFile(path.join(deskRoot, "unrelated.txt"), "x")
  git("add", "_meta/improvement/bad.md"); git("commit", "-q", "-m", "seed", "--", "_meta/improvement/bad.md")
  const pushes = []
  const out = await writeCardCommitted({
    deskRoot,
    message: "improvement: open card",
    schedulePush: (arg) => pushes.push(arg),
    write: async () => {
      await fs.rename(path.join(folder, "bad.md"), path.join(folder, "invalid", "bad.md.aaaaaa"))
      await fs.writeFile(path.join(folder, NAME), "card")
      return { result: "opened", file: path.join(folder, NAME), set_aside: 1, set_aside_files: [path.join(folder, "bad.md"), path.join(folder, "invalid", "bad.md.aaaaaa")] }
    },
  })
  assert.equal(out.commit, "committed")
  assert.deepEqual(pushes, [{ root: deskRoot }])
  assert.deepEqual(git("show", "--no-renames", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort(), [`_meta/improvement/${NAME}`, "_meta/improvement/bad.md", "_meta/improvement/invalid/bad.md.aaaaaa"])
  assert.equal(git("log", "-1", "--format=%s").trim(), "improvement: open card")
  assert.match(git("status", "--short"), /\?\? unrelated\.txt/)
})

async function realRepo(prefix) {
  const deskRoot = await mkTempRoot(prefix)
  const git = (...args) => { const r = spawnSync("git", ["-C", deskRoot, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout }
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "T")
  const folder = path.join(deskRoot, "_meta", "improvement")
  await fs.mkdir(path.join(folder, "invalid"), { recursive: true })
  return { deskRoot, git, folder }
}

test("on a real repository a moved-aside file that was never committed does not block the valid card", async () => {
  const { deskRoot, git, folder } = await realRepo("desk-commit-untracked-")
  await fs.writeFile(path.join(folder, "bad.md"), "x")
  const out = await writeCardCommitted({
    deskRoot,
    message: "improvement: open card",
    schedulePush: () => {},
    write: async () => {
      await fs.rename(path.join(folder, "bad.md"), path.join(folder, "invalid", "bad.md.aaaaaa"))
      await fs.writeFile(path.join(folder, NAME), "card")
      return { result: "opened", file: path.join(folder, NAME), set_aside: 1, set_aside_files: [path.join(folder, "bad.md"), path.join(folder, "invalid", "bad.md.aaaaaa")] }
    },
  })
  assert.equal(out.commit, "committed")
  assert.deepEqual(git("show", "--no-renames", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort(), [`_meta/improvement/${NAME}`, "_meta/improvement/invalid/bad.md.aaaaaa"])
  assert.equal(git("status", "--short"), "")
})

test("on a real repository a card left uncommitted by a failed commit is committed by the next write, and a stray file is left alone", async () => {
  const { deskRoot, git, folder } = await realRepo("desk-commit-heal-")
  const failing = (cmd, args, opts) => (args.includes("commit") ? { status: 1, stdout: "", stderr: "" } : spawnSync(cmd, args, opts))
  const first = await writeCardCommitted({ deskRoot, message: "m", spawnGit: failing, schedulePush: () => {}, write: async () => { await fs.writeFile(path.join(folder, NAME), "one"); return { result: "opened", file: path.join(folder, NAME) } } })
  assert.equal(first.commit, "commit_failed")
  assert.match(git("status", "--short"), /improvement/)
  await fs.writeFile(path.join(folder, "notes.txt"), "stray")
  const second = "andon--bbbbbbbbbbbb.md"
  const pushes = []
  const out = await writeCardCommitted({ deskRoot, message: "improvement: open two", schedulePush: (arg) => pushes.push(arg), write: async () => { await fs.writeFile(path.join(folder, second), "two"); return { result: "opened", file: path.join(folder, second) } } })
  assert.deepEqual({ commit: out.commit, left_alone: out.left_alone }, { commit: "committed", left_alone: 1 })
  assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort(), [`_meta/improvement/${NAME}`, `_meta/improvement/${second}`])
  assert.match(git("status", "--short"), /\?\? _meta\/improvement\/notes\.txt/)
  assert.equal(pushes.length, 1)
})
