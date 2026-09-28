// The desk-health boot check (A5): one agent line from the bound root's last
// Desk start, and a detached fast-forward of a clean state branch that never
// touches a dirty or diverged branch. Git repositories here are throwaway
// fixtures with a local bare upstream; nothing reaches the network.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"

import { mkTempRoot } from "../_temp_roots.js"
import { lastStartPath, resolveDeskStateDir, writeLastStart } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { runGit } from "../../../../../plugins/desk/mcp/src/runtime/state-branch.js"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/runtime/desk-health.js", import.meta.url)
async function load() {
  assert.ok(existsSync(moduleUrl), "the desk-health check must exist")
  return import(moduleUrl)
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

async function fixture() {
  const base = await mkTempRoot("desk-health-")
  const env = { ...process.env, HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  delete env.DESK_ACTIVATION_CONFIG
  return { base, env, stateDir: resolveDeskStateDir({ env }) }
}

async function repository(base, name = "desk") {
  const upstream = path.join(base, `${name}-upstream.git`)
  const root = path.join(base, name)
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", upstream])
  execFileSync("git", ["clone", "-q", upstream, root], { stdio: "ignore" })
  git(root, "checkout", "-q", "-b", "main")
  await fs.writeFile(path.join(root, "README.md"), "desk\n")
  git(root, "add", "README.md")
  git(root, "commit", "-q", "-m", "init")
  git(root, "push", "-q", "-u", "origin", "main")
  return { root: await fs.realpath(root), upstream }
}

async function advanceUpstream(base, upstream, count = 1) {
  const other = path.join(base, `other-${Math.random().toString(16).slice(2)}`)
  execFileSync("git", ["clone", "-q", upstream, other], { stdio: "ignore" })
  for (let n = 0; n < count; n += 1) {
    await fs.writeFile(path.join(other, `file-${path.basename(other)}-${n}.md`), `${n}\n`)
    git(other, "add", ".")
    git(other, "commit", "-q", "-m", `upstream ${n}`)
  }
  git(other, "push", "-q", "origin", "main")
}

const record = (stateDir, root, snapshot) => writeLastStart({ stateDir, root, snapshot: { repair: null, fix: null, code: null, ...snapshot } })

// ---------------------------------------------------------------------------
// The boot line.
// ---------------------------------------------------------------------------

test("no last-start record for the root says nothing and starts nothing", async () => {
  const { deskHealthCheck } = await load()
  const { base, env } = await fixture()
  const { root } = await repository(base)
  assert.deepEqual(deskHealthCheck({ env, root }), {})
  assert.deepEqual(deskHealthCheck({ env, root: "relative" }), {})
  assert.deepEqual(deskHealthCheck({ env, root: null }), {})
})

test("a degraded state-branch record becomes one agent line naming the checkout and desk_doctor", async () => {
  const { deskHealthCheck } = await load()
  const { base, env, stateDir } = await fixture()
  const { root } = await repository(base)
  git(root, "checkout", "-q", "-b", "feature-x")
  record(stateDir, root, { state: "degraded:state_branch_mismatch", code: "state_branch_mismatch" })
  assert.deepEqual(deskHealthCheck({ env, root }), { line: "Desk: degraded (desk checkout on feature-x; writes paused); run desk_doctor" })
  await fs.mkdir(path.join(root, "desks"))
  assert.deepEqual(deskHealthCheck({ env, root }), { line: "Desk: degraded (crew checkout on feature-x; writes paused); run desk_doctor" })
  git(root, "checkout", "-q", "--detach")
  assert.deepEqual(deskHealthCheck({ env, root }), { line: "Desk: degraded (crew checkout on another branch; writes paused); run desk_doctor" })
  record(stateDir, root, { state: "degraded:state_branch_detached", code: "state_branch_detached" })
  assert.deepEqual(deskHealthCheck({ env, root }), { line: "Desk: degraded (crew checkout detached; writes paused); run desk_doctor" })
})

test("other degraded codes point at desk_status, say when writes are paused, and never echo a malformed code", async () => {
  const { deskHealthCheck } = await load()
  const { base, env, stateDir } = await fixture()
  const root = await fs.realpath(await fs.mkdir(path.join(base, "plain"), { recursive: true }).then(() => path.join(base, "plain")))
  record(stateDir, root, { state: "degraded:crew_state_not_main", code: "crew_state_not_main" })
  assert.deepEqual(deskHealthCheck({ env, root }), { line: "Desk: degraded (crew_state_not_main; writes paused); run desk_status for the fix" })
  record(stateDir, root, { state: "degraded:runtime_pack_missing", code: "runtime_pack_missing" })
  assert.deepEqual(deskHealthCheck({ env, root }), { line: "Desk: degraded (runtime_pack_missing); run desk_status for the fix" })
  record(stateDir, root, { state: "degraded:x", code: "Bad Code; rm -rf /" })
  assert.deepEqual(deskHealthCheck({ env, root }), { line: "Desk: degraded (unknown); run desk_status for the fix" })
  record(stateDir, root, { state: "degraded:x", code: null })
  assert.deepEqual(deskHealthCheck({ env, root }), { line: "Desk: degraded (unknown); run desk_status for the fix" })
})

test("a ready or admitting root with a branch checked out asks for the detached fast-forward; a detached HEAD does not", async () => {
  const { deskHealthCheck, checkedOutBranch } = await load()
  const { base, env, stateDir } = await fixture()
  const { root } = await repository(base)
  record(stateDir, root, { state: "ready" })
  assert.deepEqual(deskHealthCheck({ env, root }), { fastForward: true })
  record(stateDir, root, { state: "admitting" })
  assert.deepEqual(deskHealthCheck({ env, root }), { fastForward: true })
  git(root, "checkout", "-q", "--detach")
  assert.deepEqual(deskHealthCheck({ env, root }), {})
  assert.equal(checkedOutBranch(path.join(base, "nowhere")), null)
})

test("the record is found under the root's real path, and torn or foreign records say nothing", async () => {
  const { deskHealthCheck } = await load()
  const { base, env, stateDir } = await fixture()
  const { root } = await repository(base)
  const alias = path.join(base, "alias")
  await fs.symlink(root, alias)
  record(stateDir, root, { state: "degraded:runtime_pack_missing", code: "runtime_pack_missing" })
  assert.match(deskHealthCheck({ env, root: alias }).line, /runtime_pack_missing/u)
  const file = lastStartPath({ stateDir, root })
  await fs.writeFile(file, "{ torn")
  assert.deepEqual(deskHealthCheck({ env, root }), {})
  await fs.writeFile(file, JSON.stringify({ state: 7 }))
  assert.deepEqual(deskHealthCheck({ env, root }), {})
  await fs.writeFile(file, "x".repeat(17 * 1024))
  assert.deepEqual(deskHealthCheck({ env, root }), {})
  await fs.rm(file)
  await fs.symlink(path.join(base, "elsewhere.json"), file)
  await fs.writeFile(path.join(base, "elsewhere.json"), JSON.stringify({ state: "degraded:x", code: "x" }))
  assert.deepEqual(deskHealthCheck({ env, root }), {}, "a symlinked record is never followed")
  assert.deepEqual(deskHealthCheck({ env, root: path.join(base, "missing-root") }), {})
})

test("a linked worktree's branch is read through its .git file", async () => {
  const { checkedOutBranch } = await load()
  const { base } = await fixture()
  const { root } = await repository(base)
  const worktree = path.join(base, "worktree")
  git(root, "worktree", "add", "-q", "-b", "topic", worktree)
  assert.equal(checkedOutBranch(worktree), "topic")
  const broken = path.join(base, "broken")
  await fs.mkdir(broken)
  await fs.writeFile(path.join(broken, ".git"), "not a pointer\n")
  assert.equal(checkedOutBranch(broken), null)
})

// ---------------------------------------------------------------------------
// The detached fast-forward.
// ---------------------------------------------------------------------------

test("a clean state branch behind its upstream is fetched and fast-forwarded, and the repair is logged", async () => {
  const { fastForwardStateBranch } = await load()
  const { base, env, stateDir } = await fixture()
  const { root, upstream } = await repository(base)
  await advanceUpstream(base, upstream, 2)
  const before = git(root, "rev-parse", "HEAD")
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "fast_forwarded", commits: 2 })
  assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "origin/main"))
  assert.notEqual(git(root, "rev-parse", "HEAD"), before)
  assert.match(readFileSync(path.join(stateDir, "repairs.log"), "utf8"), /fast-forwarded main to origin\/main \(2 commits\)/u)
  await advanceUpstream(base, upstream, 1)
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "fast_forwarded", commits: 1 })
  assert.match(readFileSync(path.join(stateDir, "repairs.log"), "utf8"), /\(1 commit\)/u)
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "up_to_date" })
})

test("a dirty, diverged, busy or off-branch checkout is never touched", async () => {
  const { fastForwardStateBranch } = await load()
  const { base, env } = await fixture()
  const { root, upstream } = await repository(base)
  await advanceUpstream(base, upstream)
  const head = () => git(root, "rev-parse", "HEAD")
  const start = head()

  await fs.writeFile(path.join(root, "README.md"), "changed\n")
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "skipped", reason: "tracked_changes" })
  git(root, "checkout", "-q", "--", "README.md")

  await fs.writeFile(path.join(root, ".git", "MERGE_HEAD"), `${start}\n`)
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "skipped", reason: "operation_in_progress" })
  await fs.rm(path.join(root, ".git", "MERGE_HEAD"))

  git(root, "checkout", "-q", "-b", "side")
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "skipped", reason: "not_on_state_branch" })
  git(root, "checkout", "-q", "main")

  await fs.writeFile(path.join(root, "local.md"), "local\n")
  git(root, "add", "local.md")
  git(root, "commit", "-q", "-m", "local only")
  const local = head()
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "skipped", reason: "diverged" })
  assert.equal(head(), local, "a diverged branch keeps its commits")
  assert.notEqual(local, start)
})

test("no upstream, a failed fetch, another state branch, a subfolder and a non-checkout are skipped with a reason", async () => {
  const { fastForwardStateBranch } = await load()
  const { base, env } = await fixture()
  const { root } = await repository(base)
  assert.deepEqual(await fastForwardStateBranch({ env, root, stateBranch: "trunk" }), { result: "skipped", reason: "not_on_state_branch" })
  assert.deepEqual(await fastForwardStateBranch({ env, root, stateBranch: "bad..name" }), { result: "skipped", reason: "no_state_branch" })
  await fs.mkdir(path.join(root, "sub"))
  assert.deepEqual(await fastForwardStateBranch({ env, root: path.join(root, "sub") }), { result: "skipped", reason: "not_a_checkout" })
  const plain = path.join(base, "plain")
  await fs.mkdir(plain)
  assert.deepEqual(await fastForwardStateBranch({ env, root: plain }), { result: "skipped", reason: "not_a_checkout" })
  git(root, "remote", "set-url", "origin", path.join(base, "missing.git"))
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "skipped", reason: "fetch_failed" })
  git(root, "branch", "--unset-upstream")
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "skipped", reason: "no_upstream" })
  git(root, "config", "branch.main.remote", ".")
  git(root, "config", "branch.main.merge", "refs/heads/main")
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "skipped", reason: "no_upstream" })
})

test("a HEAD that moves during the fetch, a refused merge and unreadable counts leave the branch alone", async () => {
  const { fastForwardStateBranch } = await load()
  const { base, env } = await fixture()
  const { root, upstream } = await repository(base)
  await advanceUpstream(base, upstream)
  const moving = async (options) => {
    const result = await runGit(options)
    if (options.args[0] === "fetch") {
      await fs.writeFile(path.join(root, "during.md"), "x\n")
      git(root, "add", "during.md")
      git(root, "commit", "-q", "-m", "during fetch")
    }
    return result
  }
  assert.deepEqual(await fastForwardStateBranch({ env, root, git: moving }), { result: "skipped", reason: "head_moved" })
  git(root, "reset", "-q", "--hard", "HEAD~1")
  const dirtying = async (options) => {
    const result = await runGit(options)
    if (options.args[0] === "fetch") await fs.writeFile(path.join(root, "README.md"), "edited during fetch\n")
    return result
  }
  assert.deepEqual(await fastForwardStateBranch({ env, root, git: dirtying }), { result: "skipped", reason: "tracked_changes" })
  git(root, "checkout", "-q", "--", "README.md")
  const refuse = (verb, answer) => async (options) => (options.args[0] === verb ? answer : runGit(options))
  assert.deepEqual(await fastForwardStateBranch({ env, root, git: refuse("merge", { ok: false, stdout: "", stderr: "no" }) }), { result: "skipped", reason: "merge_refused" })
  assert.deepEqual(await fastForwardStateBranch({ env, root, git: refuse("rev-list", { ok: true, stdout: "x y", stderr: "" }) }), { result: "skipped", reason: "no_upstream" })
  assert.deepEqual(await fastForwardStateBranch({ env, root, git: refuse("rev-list", { ok: false, stdout: "", stderr: "" }) }), { result: "skipped", reason: "no_upstream" })
  assert.deepEqual(await fastForwardStateBranch({ env, root, git: async () => { throw new Error("git exploded") } }), { result: "skipped", reason: "unexpected" })
  const blocked = { ...env, XDG_STATE_HOME: path.join(root, "README.md", "state") }
  assert.deepEqual(await fastForwardStateBranch({ env: blocked, root }), { result: "fast_forwarded", commits: 1 }, "an unwritable repair log never undoes the fast-forward")
})

test("the state branch comes from the activation config when one is set", async () => {
  const { fastForwardStateBranch } = await load()
  const { base, env } = await fixture()
  const { root } = await repository(base)
  const config = path.join(base, "activation.json")
  await fs.writeFile(config, JSON.stringify({ schema_version: 1, desk: { root, state_branch: "trunk" } }))
  assert.deepEqual(await fastForwardStateBranch({ env: { ...env, DESK_ACTIVATION_CONFIG: config }, root }), { result: "skipped", reason: "not_on_state_branch" })
})

test("both entry points default to this process's environment", async () => {
  const { deskHealthCheck, fastForwardStateBranch } = await load()
  const { base } = await fixture()
  assert.deepEqual(deskHealthCheck({ root: path.join(base, "none") }), {})
  const plain = path.join(base, "plain-default")
  await fs.mkdir(plain)
  assert.deepEqual(await fastForwardStateBranch({ root: plain }), { result: "skipped", reason: "not_a_checkout" })
})
