// session-sync.js names why a failed fetch failed: an unreachable origin used to be reported as
// "a git conflict", so agents ran `git status`, saw a clean tree and dismissed the degraded state.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, existsSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { classifyPullFailure, syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"

// These tests are about the fetch; the detached delivery a pull may start is covered in sync_deliver.test.js.
const noDelivery = () => {}


function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function pushFromOther(origin, file, content) {
  const other = await mkTempRoot("desk-sync-cause-b-")
  git(other, ["clone", "-q", origin, "."])
  git(other, ["config", "user.email", "t@example.com"])
  git(other, ["config", "user.name", "T"])
  await fs.writeFile(path.join(other, file), content)
  git(other, ["add", "--", file])
  git(other, ["commit", "-q", "-m", "origin edit"])
  git(other, ["push", "-q"])
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

// Real git for everything, except the fetch, which answers with a scripted failure.
function failingPull(result) {
  return (command, args, options) => {
    if (args[2] === "fetch") return { stdout: "", stderr: "", ...result }
    return spawnSync(command, args, options)
  }
}

const env = process.env

test("an unreachable origin is reported as unreachable with its URL and git's own words", async () => {
  const { root } = await mkOriginWithClone()
  const gone = path.join(await mkTempRoot("desk-sync-cause-gone-"), "no-such-origin.git")
  git(root, ["remote", "set-url", "origin", gone])
  await fs.writeFile(path.join(root, "stray.txt"), "local only\n")

  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env })

  assert.equal(result.state, "unresolved")
  assert.equal(result.cause, "unreachable")
  assert.equal(result.remote, gone)
  assert.match(result.error, /does not appear to be a git repository|Could not read from remote|fatal/iu)
  assert.deepEqual(result.conflicted, [])
  assert.ok(existsSync(path.join(root, "stray.txt")), "the stray file stays where it was")
  assert.match(result.diagnostic, /`git status` will read clean/u)
  assert.equal(git(root, ["status", "--porcelain"]).trim(), "?? stray.txt")
})

test("a checkout that is only behind is caught up, never rebased or stashed", async () => {
  const { origin, root } = await mkOriginWithClone()
  await pushFromOther(origin, "seed.md", "seed\nfrom origin\n")
  await fs.writeFile(path.join(root, "mine.txt"), "uncommitted and untracked\n")

  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env })

  assert.equal(result.state, "synced")
  assert.equal(await fs.readFile(path.join(root, "seed.md"), "utf8"), "seed\nfrom origin\n")
  assert.equal(await fs.readFile(path.join(root, "mine.txt"), "utf8"), "uncommitted and untracked\n")
  assert.equal(git(root, ["stash", "list"]), "")
})

test("an uncommitted edit to a file the remote also changed is left alone, and named, instead of conflicting (#436, #572)", async () => {
  const { origin, root } = await mkOriginWithClone()
  await pushFromOther(origin, "seed.md", "seed\nfrom origin\n")
  await fs.writeFile(path.join(root, "seed.md"), "seed\nfrom local\n")
  const before = git(root, ["rev-parse", "HEAD"])

  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env })

  assert.equal(result.state, "unresolved")
  assert.equal(result.cause, "local_changes")
  assert.deepEqual(result.conflicted, ["seed.md"])
  assert.match(result.diagnostic, /status` to see them/u)
  assert.equal(await fs.readFile(path.join(root, "seed.md"), "utf8"), "seed\nfrom local\n")
  assert.equal(git(root, ["rev-parse", "HEAD"]), before)
  assert.equal(git(root, ["stash", "list"]), "")
  assert.ok(!existsSync(path.join(root, ".git", "rebase-merge")), "no rebase is left in progress")
  assert.equal(git(root, ["diff", "--name-only", "--diff-filter=U"]), "")
})

test("local commits the remote lacks leave the checkout as it is for delivery to replay", async () => {
  const { origin, root } = await mkOriginWithClone()
  await pushFromOther(origin, "other.md", "from origin\n")
  await fs.writeFile(path.join(root, "mine.md"), "mine\n")
  git(root, ["add", "mine.md"])
  git(root, ["commit", "-q", "-m", "local"])
  const before = git(root, ["rev-parse", "HEAD"])
  let scheduled = 0

  const result = await syncWorkspace({ scheduleDelivery: () => { scheduled += 1 }, root, env })

  assert.equal(result.state, "synced")
  assert.equal(git(root, ["rev-parse", "HEAD"]), before)
  assert.deepEqual(result.unpushed, { count: 1, delivering: true, reason: null, paths: [] })
  assert.equal(scheduled, 1)
})

for (const [name, failure, cause, tell] of [
  ["rejected credentials", { status: 128, stderr: "remote: Invalid username or password.\nfatal: Authentication failed for 'https://user:secret-token@github.com/o/r.git/'\n" }, "auth_failed", /refused this host's credentials/u],
  ["an SSH key the host refuses", { status: 128, stderr: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n" }, "auth_failed", /refused this host's credentials/u],
  ["a network timeout reported by spawnSync", { status: null, error: { code: "ETIMEDOUT" }, stderr: "" }, "deadline", /ran out of time/u],
  ["a killed git process", { status: null, signal: "SIGTERM", stderr: "" }, "deadline", /ran out of time/u],
  ["an unknown SSH host key", { status: 128, stderr: "Host key verification failed.\nfatal: Could not read from remote repository.\n" }, "auth_failed", /refused this host's credentials/u],
  ["a local permission error", { status: 128, stderr: "fatal: unable to access '/home/u/.config/git/config': Permission denied\n" }, "other", /fetch` to see git's own answer/u],
  ["an HTTPS URL that cannot be reached", { status: 128, stderr: "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443\n" }, "unreachable", /could not be reached/u],
  ["a DNS failure", { status: 128, stderr: "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com\n" }, "unreachable", /could not be reached/u],
  ["a diverged history", { status: 1, stderr: "hint: You have divergent branches\nfatal: Need to specify how to reconcile divergent branches.\n" }, "diverged", /fetch` to see git's own answer/u],
  ["an unknown failure", { status: 1, stderr: "something new and strange\n" }, "other", /fetch` to see git's own answer/u],
]) {
  test(`a fetch that fails with ${name} is classified ${cause}, and the URL shown never carries credentials`, async () => {
    const { root } = await mkOriginWithClone()
    git(root, ["remote", "set-url", "origin", "https://user:secret-token@github.com/o/r.git"])
    const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env, spawnGit: failingPull(failure) })
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
    if (args[2] === "fetch") return { status: 1, stdout: "", stderr: undefined }
    if (args[2] === "remote" && args[3] === "get-url") return { status: 1, stdout: "", stderr: "" }
    return spawnSync(command, args, options)
  }
  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env, spawnGit: scripted })
  assert.equal(result.error, "")
  assert.equal(result.remote, null)
  const blank = (command, args, options) => (args[2] === "remote" && args[3] === "get-url" ? { status: 0, stdout: "  \n", stderr: "" } : scripted(command, args, options))
  assert.equal((await syncWorkspace({ scheduleDelivery: noDelivery, root, env, spawnGit: blank })).remote, null)
})

test("a fetch that fails with a conflict message still classifies as a conflict", async () => {
  const { root } = await mkOriginWithClone()
  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env, spawnGit: failingPull({ status: 1, stderr: "error: could not apply abc123... local edit\n" }) })
  assert.equal(result.cause, "conflict")
})

test("an exhausted budget is reported as a deadline, not as a conflict", async () => {
  const { root } = await mkOriginWithClone()
  let tick = 0
  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env, now: () => (tick += 60_000) })
  assert.equal(result.state, "unresolved")
  assert.equal(result.cause, "deadline")
  assert.match(result.diagnostic, /ran out of time/u)
})

test("classifyPullFailure tolerates no arguments at all", () => {
  assert.equal(classifyPullFailure(), "other")
  assert.equal(classifyPullFailure({ conflicted: ["a.md"] }), "conflict")
  assert.equal(classifyPullFailure({ deadline: true, stderr: "CONFLICT" }), "deadline")
  assert.equal(classifyPullFailure({ timedOut: true }), "deadline")
})
