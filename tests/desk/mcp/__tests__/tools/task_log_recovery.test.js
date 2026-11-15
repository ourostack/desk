import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { drainAppendLanes, flushAppends } from "../../../../../plugins/desk/mcp/src/runtime/append-lane.js"
import { gitSeam } from "../../../../../plugins/desk/mcp/src/desk/content-home.js"
import { catchUpBehind } from "../../../../../plugins/desk/mcp/src/runtime/deliver.js"

// The ways one small append to a repository that publishes through checked pull requests used to cost five calls.

const POLICY = {
  schema_version: 1,
  mode: "declared-purpose",
  repository: "sample/context",
  context_purposes: ["coordination"],
  product_purposes: ["product-contract"],
}
const CARD = "---\nschema_version: 1\ntitle: Work\nstatus: processing\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Work\n\n**Next step:** Keep going.\n"
const content_home = { purpose: "coordination", lifecycle: "current" }
const git = (root, args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`)
  return result.stdout.trim()
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-append-recovery-"))
  t.after(async () => {
    gitSeam.spawn = spawnSync
    await drainAppendLanes()
    await fs.rm(root, { recursive: true, force: true })
  })
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["config", "user.email", "test@example.com"])
  await fs.mkdir(path.join(root, "track/work"), { recursive: true })
  await fs.mkdir(path.join(root, ".desk"))
  await fs.writeFile(path.join(root, "track/work/task.md"), CARD)
  await fs.writeFile(path.join(root, ".desk/content-home.json"), JSON.stringify(POLICY))
  await fs.writeFile(path.join(root, "shared.md"), "one\n")
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Published"])
  git(root, ["remote", "add", "origin", "https://github.com/sample/context.git"])
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"])
  git(root, ["config", "branch.main.remote", "origin"])
  git(root, ["config", "branch.main.merge", "refs/heads/main"])
  return root
}

// The upstream moves ahead by `files` (path to content), as the remote does when other writers' pull requests merge; HEAD stays where it was.
function upstreamMoves(root, files) {
  const base = git(root, ["rev-parse", "HEAD"])
  for (const [name, text] of Object.entries(files)) {
    spawnSync("sh", ["-c", `printf '%s' "$1" > "$2"`, "sh", text, path.join(root, name)])
    git(root, ["add", "--", name])
  }
  git(root, ["commit", "-qm", "Merged elsewhere"])
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"])
  git(root, ["reset", "-q", "--hard", base])
  return git(root, ["rev-parse", "refs/remotes/origin/main"])
}
const call = (root, input, extra = {}) => task_update({ deskRoot: root, input: { track: "track", slug: "work", content_home, ...input }, schedulePush() {}, ...extra })

test("1: a checkout that is only behind its upstream is fast-forwarded and the write goes ahead", async (t) => {
  const root = await fixture(t)
  const tip = upstreamMoves(root, { "incoming.md": "from elsewhere\n" })
  const answer = await call(root, { log: "Ruling: go." })
  assert.equal(answer.status, "logged")
  assert.equal(git(root, ["rev-parse", "HEAD"]), tip)
  assert.equal(await fs.readFile(path.join(root, "incoming.md"), "utf8"), "from elsewhere\n")
  flushAppends(root)
  assert.equal(git(root, ["rev-parse", "HEAD^"]), tip)
  assert.equal(git(root, ["status", "--porcelain"]), "")
})

test("1: a file another session changed holds the fast-forward, and the write still goes ahead without touching it", async (t) => {
  const root = await fixture(t)
  const tip = upstreamMoves(root, { "shared.md": "two\n" })
  const base = git(root, ["rev-parse", "HEAD"])
  await fs.writeFile(path.join(root, "shared.md"), "their edit\n")
  assert.equal((await call(root, { log: "Ruling: go." })).status, "logged")
  assert.equal(git(root, ["rev-parse", "HEAD"]), base)
  assert.notEqual(base, tip)
  assert.equal(await fs.readFile(path.join(root, "shared.md"), "utf8"), "their edit\n")
  assert.deepEqual(catchUpBehind({ root }).state, "behind")
})

test("1: a checkout that holds a commit the upstream does not is left alone by the fast-forward", async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, "held.md"), "held\n")
  git(root, ["add", "held.md"])
  git(root, ["commit", "-qm", "held"])
  const head = git(root, ["rev-parse", "HEAD"])
  assert.equal(catchUpBehind({ root }).state, "diverged")
  assert.equal(git(root, ["rev-parse", "HEAD"]), head)
})

test("2: an upstream the branch names but `@{upstream}` cannot map is still resolved, so the published policy is found", async (t) => {
  const root = await fixture(t)
  git(root, ["config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other"])
  const answer = await call(root, { log: "Ruling: go." })
  assert.equal(answer.status, "logged")
  assert.equal(answer.content_admission.policy_commit, git(root, ["rev-parse", "refs/remotes/origin/main"]))
})

test("2: a Git call cut off by the clock is asked again with more room before the upstream counts as unresolved", async (t) => {
  const root = await fixture(t)
  const seen = []
  let cut = false
  gitSeam.spawn = (command, args, options) => {
    if (args.includes("@{upstream}^{commit}")) {
      seen.push(options.timeout)
      if (!cut) {
        cut = true
        return { status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" }
      }
    }
    return spawnSync(command, args, options)
  }
  const answer = await call(root, { log: "Ruling: go." })
  assert.equal(answer.status, "logged")
  assert.ok(seen.length >= 2 && seen[1] > seen[0], `the second ask had more room: ${seen}`)
})

test("3: a commit the clock cut off is read back and run once more, not handed back as a failure with route-around steps", async (t) => {
  const root = await fixture(t)
  const timeouts = []
  let cut = false
  const spawnGit = (command, args, options) => {
    if (args[2] === "commit" && args.includes("-m")) {
      timeouts.push(options.timeout)
      if (!cut) {
        cut = true
        return { status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" }
      }
    }
    return spawnSync(command, args, options)
  }
  const answer = await call(root, { log: "Ruling: go." }, { spawnGit })
  assert.equal(answer.status, "logged")
  assert.equal(flushAppends(root), "committed")
  assert.equal(timeouts.length, 2)
  assert.ok(timeouts[1] > timeouts[0])
  assert.match(git(root, ["log", "-1", "--format=%s"]), /task_update: log track\/work/u)
  assert.equal(git(root, ["status", "--porcelain"]), "")
})

test("5: a call that logs a small entry starts a bounded number of Git processes and waits on no commit or push", async (t) => {
  const root = await fixture(t)
  let processes = 0
  const spawnGit = (command, args, options) => {
    processes += 1
    return spawnSync(command, args, options)
  }
  gitSeam.spawn = (command, args, options) => {
    processes += 1
    return spawnSync(command, args, options)
  }
  const started = Date.now()
  await call(root, { log: "Ruling: go." }, { spawnGit })
  assert.ok(Date.now() - started < 30_000)
  assert.ok(processes <= 8, `${processes} Git processes`)
  assert.equal(git(root, ["rev-list", "--count", "HEAD"]), "1", "nothing was committed inside the call")
})

test("3: a commit that landed and was reported cut off is not made twice, and the lane counts it committed", async (t) => {
  const root = await fixture(t)
  const spawnGit = (command, args, options) => {
    if (args[2] === "commit" && args.includes("-m")) {
      spawnSync(command, args, options)
      return { status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" }
    }
    return spawnSync(command, args, options)
  }
  await call(root, { log: "Ruling: go." }, { spawnGit })
  assert.equal(flushAppends(root), "committed")
  assert.equal(git(root, ["rev-list", "--count", "HEAD"]), "2")
  assert.equal(flushAppends(root), "empty")
})
