// session-sync.js names why a failed pull failed (round 5): an unreachable origin used to be reported as
// "a git conflict", so agents ran `git status`, saw a clean tree and dismissed the degraded state.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, existsSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { classifyPullFailure, syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function mkOriginWithClone() {
  const origin = await mkTempRoot("desk-sync-cause-origin-")
  git(origin, ["init", "--bare", "-q"])
  const root = await mkTempRoot("desk-sync-cause-a-")
  git(root, ["clone", "-q", origin, "."])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["symbolic-ref", "HEAD", "refs/heads/main"])
  await fs.writeFile(path.join(root, ".gitignore"), "_cache/\n")
  await fs.writeFile(path.join(root, "seed.md"), "seed\n")
  git(root, ["add", "--", ".gitignore", "seed.md"])
  git(root, ["commit", "-q", "-m", "seed"])
  git(root, ["push", "-q", "-u", "origin", "main"])
  return { origin, root }
}

// Real git for everything, except the pull, which answers with a scripted failure.
function failingPull(result) {
  return (command, args, options) => {
    if (args[2] === "pull") return { stdout: "", stderr: "", ...result }
    return spawnSync(command, args, options)
  }
}

const env = process.env
const fileProblem = () => ({ file: "filing in background" })

test("an unreachable origin is reported as unreachable with its URL and git's own words, and nothing is quarantined", async () => {
  const { root } = await mkOriginWithClone()
  const gone = path.join(await mkTempRoot("desk-sync-cause-gone-"), "no-such-origin.git")
  git(root, ["remote", "set-url", "origin", gone])
  await fs.writeFile(path.join(root, "stray.txt"), "local only\n")

  const result = await syncWorkspace({ root, env, fileProblem })

  assert.equal(result.state, "unresolved")
  assert.equal(result.cause, "unreachable")
  assert.equal(result.remote, gone)
  assert.match(result.error, /does not appear to be a git repository|Could not read from remote|fatal/iu)
  assert.deepEqual(result.conflicted, [])
  assert.equal(result.quarantinedPaths, undefined)
  assert.ok(existsSync(path.join(root, "stray.txt")), "the stray file stays where it was")
  assert.ok(!existsSync(path.join(root, "_cache")), "no quarantine directory appears for a network failure")
  assert.match(result.diagnostic, /`git status` will read clean/u)
  assert.equal(git(root, ["status", "--porcelain"]).trim(), "?? stray.txt")
})

test("a genuine conflict keeps the conflict cause, the conflicted paths and the remote URL", async () => {
  const { origin, root } = await mkOriginWithClone()
  const other = await mkTempRoot("desk-sync-cause-b-")
  git(other, ["clone", "-q", origin, "."])
  git(other, ["config", "user.email", "t@example.com"])
  git(other, ["config", "user.name", "T"])
  await fs.writeFile(path.join(other, "seed.md"), "seed\nfrom origin\n")
  git(other, ["commit", "-q", "-am", "origin edit"])
  git(other, ["push", "-q"])
  await fs.writeFile(path.join(root, "seed.md"), "seed\nfrom local\n")
  git(root, ["commit", "-q", "-am", "local edit"])

  const result = await syncWorkspace({ root, env, fileProblem })

  assert.equal(result.cause, "conflict")
  assert.deepEqual(result.conflicted, ["seed.md"])
  assert.equal(result.remote, origin)
  assert.match(result.diagnostic, /`git status`/u)
  assert.doesNotMatch(result.diagnostic, /will read clean/u)
})

for (const [name, failure, cause, tell] of [
  ["rejected credentials", { status: 128, stderr: "remote: Invalid username or password.\nfatal: Authentication failed for 'https://user:secret-token@github.com/o/r.git/'\n" }, "auth_failed", /refused this host's credentials/u],
  ["an SSH key the host refuses", { status: 128, stderr: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n" }, "auth_failed", /refused this host's credentials/u],
  ["a network timeout reported by spawnSync", { status: null, error: { code: "ETIMEDOUT" }, stderr: "" }, "unreachable", /could not be reached/u],
  ["a killed git process", { status: null, signal: "SIGTERM", stderr: "" }, "unreachable", /could not be reached/u],
  ["a DNS failure", { status: 128, stderr: "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com\n" }, "unreachable", /could not be reached/u],
  ["a diverged history", { status: 1, stderr: "hint: You have divergent branches\nfatal: Need to specify how to reconcile divergent branches.\n" }, "diverged", /`git status`/u],
  ["an unknown failure", { status: 1, stderr: "something new and strange\n" }, "other", /`git status`/u],
]) {
  test(`a pull that fails with ${name} is classified ${cause}, and the URL shown never carries credentials`, async () => {
    const { root } = await mkOriginWithClone()
    git(root, ["remote", "set-url", "origin", "https://user:secret-token@github.com/o/r.git"])
    const result = await syncWorkspace({ root, env, fileProblem, spawnGit: failingPull(failure) })
    assert.equal(result.state, "unresolved")
    assert.equal(result.cause, cause)
    assert.equal(result.remote, "https://github.com/o/r.git")
    assert.doesNotMatch(JSON.stringify(result), /secret-token/u)
    assert.match(result.diagnostic, tell)
    assert.ok(!/^hint:/iu.test(result.error), "hint lines are skipped")
  })
}

test("the error line is empty when git said nothing, and the remote is null when origin has no URL", async () => {
  const { root } = await mkOriginWithClone()
  const scripted = (command, args, options) => {
    if (args[2] === "pull") return { status: 1, stdout: "", stderr: undefined }
    if (args[2] === "remote" && args[3] === "get-url") return { status: 1, stdout: "", stderr: "" }
    return spawnSync(command, args, options)
  }
  const result = await syncWorkspace({ root, env, fileProblem, spawnGit: scripted })
  assert.equal(result.error, "")
  assert.equal(result.remote, null)
  const blank = (command, args, options) => (args[2] === "remote" && args[3] === "get-url" ? { status: 0, stdout: "  \n", stderr: "" } : scripted(command, args, options))
  assert.equal((await syncWorkspace({ root, env, fileProblem, spawnGit: blank })).remote, null)
})

test("a pull that fails with a conflict message but no conflicted paths still classifies as a conflict", async () => {
  const { root } = await mkOriginWithClone()
  const result = await syncWorkspace({ root, env, fileProblem, spawnGit: failingPull({ status: 1, stderr: "error: could not apply abc123... local edit\n" }) })
  assert.equal(result.cause, "conflict")
})

test("an exhausted budget is reported as a deadline, not as a conflict", async () => {
  const { root } = await mkOriginWithClone()
  let tick = 0
  const result = await syncWorkspace({ root, env, fileProblem, now: () => (tick += 60_000) })
  assert.equal(result.state, "unresolved")
  assert.equal(result.cause, "deadline")
  assert.match(result.diagnostic, /ran out of time/u)
})

test("classifyPullFailure tolerates no arguments at all", () => {
  assert.equal(classifyPullFailure(), "other")
  assert.equal(classifyPullFailure({ conflicted: ["a.md"] }), "conflict")
  assert.equal(classifyPullFailure({ deadline: true, stderr: "CONFLICT" }), "deadline")
  assert.equal(classifyPullFailure({ timedOut: true }), "unreachable")
})
