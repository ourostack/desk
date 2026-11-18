// fastGitAnswer and readUpstreamRefs read `.git` files instead of starting Git; every shape of checkout they accept or hand
// back to Git is pinned here against hand-built `.git` folders.

import { after, test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { waitingLogs } from "../../../../../plugins/desk/mcp/src/runtime/append-lane.js"
import { remoteIdentityEnv } from "../../../../../plugins/desk/mcp/src/runtime/remote-identity.js"
import { fetchAhead, startBackgroundFetch, syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { fastGitAnswer, readUpstreamRefs, stripspace } from "../../../../../plugins/desk/mcp/src/runtime/fast-refs.js"

const made = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
function mkTempRoot(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(dir)
  return dir
}

const A = "a".repeat(40)
const B = "b".repeat(40)

function put(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function checkout(overrides = {}) {
  const root = mkTempRoot("fast-refs-")
  const git = path.join(root, ".git")
  put(path.join(git, "HEAD"), "ref: refs/heads/main\n")
  put(path.join(git, "config"), overrides.config ?? '[remote "origin"]\n\turl = https://example.com/x.git\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n')
  put(path.join(git, "refs/heads/main"), `${A}\n`)
  put(path.join(git, "refs/remotes/origin/main"), `${B}\n`)
  return { root, git }
}

// A HOME with no Git configuration, so the user's own settings cannot change an answer.
async function quiet(run) {
  const keep = { ...process.env }
  const home = mkTempRoot("fast-refs-home-")
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key]
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: path.join(home, "none"), GIT_CONFIG_SYSTEM: path.join(home, "none") })
  delete process.env.XDG_CONFIG_HOME
  try {
    return await run(home)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in keep)) delete process.env[key]
    Object.assign(process.env, keep)
  }
}

test("readUpstreamRefs reads loose and packed refs and gives up on anything unusual", () => {
  const { root, git } = checkout()
  assert.deepEqual(readUpstreamRefs(root), { branch: "main", remote: "origin", merge: "refs/heads/main", tracking: "refs/remotes/origin/main", head: A, target: B })
  writeFileSync(path.join(git, "refs/remotes/origin/main"), "")
  assert.equal(readUpstreamRefs(root), null)
  writeFileSync(path.join(git, "packed-refs"), `# pack-refs\n${B} refs/remotes/origin/main\n`)
  assert.equal(readUpstreamRefs(root).target, B)
  writeFileSync(path.join(git, "HEAD"), `${A}\n`)
  assert.equal(readUpstreamRefs(root), null)
  assert.equal(readUpstreamRefs(mkTempRoot("fast-refs-none-")), null)
  for (const config of ['[branch "main"]\n\tremote = .\n\tmerge = refs/heads/main\n', '[branch "main"]\n\tremote = origin\n\tmerge = refs/tags/x\n', '[branch "other"]\n\tremote = origin\n', ""]) {
    const other = checkout({ config })
    assert.equal(readUpstreamRefs(other.root), null)
  }
})

test("a linked worktree's HEAD and shared folder are found through its .git file", () => {
  const main = checkout()
  const linked = mkTempRoot("fast-refs-linked-")
  const gitDir = path.join(main.git, "worktrees", "w")
  put(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n")
  put(path.join(gitDir, "commondir"), "../..\n")
  put(path.join(linked, ".git"), `gitdir: ${gitDir}\n`)
  assert.equal(readUpstreamRefs(linked).head, A)
  const lone = mkTempRoot("fast-refs-lone-")
  const loneDir = path.join(lone, "elsewhere")
  put(path.join(loneDir, "HEAD"), "ref: refs/heads/main\n")
  put(path.join(lone, ".git"), `gitdir: ${loneDir}\n`)
  assert.equal(readUpstreamRefs(lone), null)
  const bad = mkTempRoot("fast-refs-bad-")
  put(path.join(bad, ".git"), "nonsense\n")
  assert.equal(readUpstreamRefs(bad), null)
  assert.equal(fastGitAnswer(bad, ["rev-parse", "HEAD"]), null)
  assert.equal(fastGitAnswer(linked, ["rev-parse", "--git-path", "HEAD"]).stdout, `${path.join(gitDir, "HEAD")}\n`)
})

test("fastGitAnswer answers branch, commit and path questions from files", async () => {
  await quiet(() => {
    const { root, git } = checkout()
    const out = (args, input) => fastGitAnswer(root, args, input)?.stdout
    assert.equal(out(["symbolic-ref", "--short", "-q", "HEAD"]), "main\n")
    assert.equal(out(["symbolic-ref", "--quiet", "--short", "HEAD"]), "main\n")
    for (const args of [["rev-parse", "--verify", "-q", "HEAD"], ["rev-parse", "HEAD"], ["rev-parse", "--verify", "HEAD^{commit}"]]) assert.equal(out(args), `${A}\n`)
    assert.equal(out(["rev-parse", "--verify", "-q", "refs/heads/main"]), `${A}\n`)
    assert.equal(fastGitAnswer(root, ["rev-parse", "--verify", "-q", "refs/heads/nope"]), null)
    assert.equal(fastGitAnswer(root, ["rev-parse", "--verify", "-q", "refs/heads/a..b"]), null)
    assert.equal(out(["rev-parse", "--is-inside-work-tree"]), "true\n")
    assert.equal(out(["rev-parse", "--show-toplevel"]), `${root.replaceAll("\\", "/")}\n`)
    assert.equal(out(["rev-parse", "--show-prefix"]), "\n")
    assert.equal(out(["rev-parse", "--git-path", "hooks/pre-commit"]), `${path.join(git, "hooks/pre-commit")}\n`)
    assert.equal(out(["rev-parse", "--path-format=absolute", "--git-path", "HEAD", "--git-path", "config"]), `${path.join(git, "HEAD")}\n${path.join(git, "config")}\n`)
    assert.equal(fastGitAnswer(root, ["rev-parse", "--path-format=absolute", "--git-path", "HEAD", "--oops"]), null)
    assert.equal(out(["stripspace"], "a  \n\n\n\nb\n\n"), "a\n\nb\n")
    assert.equal(fastGitAnswer(root, ["stripspace"]), null)
    assert.equal(out(["config", "--get", "remote.origin.url"]), "https://example.com/x.git\n")
    assert.equal(out(["config", "--get", "branch.main.remote"]), "origin\n")
    assert.equal(fastGitAnswer(root, ["config", "--get", "remote.origin.pushurl"]), null)
    assert.equal(fastGitAnswer(root, ["log"]), null)
    writeFileSync(path.join(git, "config"), '[remote "origin"]\n\turl = a"b\n')
    assert.equal(fastGitAnswer(root, ["config", "--get", "remote.origin.url"]), null)
    writeFileSync(path.join(git, "config"), '[remote "origin"]\n\turl =\n')
    assert.equal(fastGitAnswer(root, ["config", "--get", "remote.origin.url"]), null)
    writeFileSync(path.join(git, "config"), '[include]\n\tpath = x\n[remote "origin"]\n\turl = u\n')
    assert.equal(fastGitAnswer(root, ["config", "--get", "remote.origin.url"]), null)
  })
})

test("runGit answers a branch question from files and asks Git for the rest", async () => {
  const { runGit } = await import("../../../../../plugins/desk/mcp/src/runtime/state-branch.js")
  const { root } = checkout()
  assert.deepEqual(await runGit({ cwd: root, args: ["symbolic-ref", "--quiet", "--short", "HEAD"] }), { ok: true, stdout: "main", stderr: "" })
  assert.equal((await runGit({ cwd: root, args: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/zzz"] })).ok, false)
})

test("origin/HEAD, detached HEAD, a missing ref and a broken path hand the question to Git", async () => {
  await quiet(() => {
    const { root, git } = checkout()
    assert.equal(fastGitAnswer(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]), null)
    assert.equal(fastGitAnswer(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]), null)
    put(path.join(git, "refs/remotes/origin/HEAD"), "ref: refs/remotes/origin/main\n")
    assert.equal(fastGitAnswer(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).stdout, "origin/main\n")
    assert.equal(fastGitAnswer(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]).stdout, "refs/remotes/origin/main\n")
    writeFileSync(path.join(git, "refs/heads/main"), "")
    assert.equal(fastGitAnswer(root, ["rev-parse", "HEAD"]), null)
    assert.equal(fastGitAnswer(root, ["rev-parse", "--verify", "HEAD^{commit}"]), null)
    writeFileSync(path.join(git, "HEAD"), `${A}\n`)
    for (const args of [["symbolic-ref", "--short", "-q", "HEAD"], ["rev-parse", "HEAD"], ["rev-parse", "--verify", "HEAD^{commit}"]]) assert.equal(fastGitAnswer(root, args), null)
    assert.equal(fastGitAnswer(`${root}\0`, ["rev-parse", "HEAD"]), null)
    assert.equal(fastGitAnswer(mkTempRoot("fast-refs-none-"), ["rev-parse", "HEAD"]), null)
  })
})

test("a checkout Git must be asked about is left to Git", async () => {
  await quiet(() => {
    const { root, git } = checkout()
    mkdirSync(path.join(git, "reftable"))
    assert.equal(fastGitAnswer(root, ["rev-parse", "HEAD"]), null)
    const other = checkout()
    process.env.GIT_DIR = other.git
    assert.equal(fastGitAnswer(other.root, ["rev-parse", "HEAD"]), null)
    delete process.env.GIT_DIR
    assert.equal(fastGitAnswer(other.root, ["rev-parse", "HEAD"]).stdout, `${A}\n`)
  })
})

test("a missing hook and an unset gpgSign are answered from files, any mention anywhere is left to Git", async () => {
  await quiet((home) => {
    const { root, git } = checkout()
    const gpg = ["config", "--type=bool", "--get", "commit.gpgSign"]
    const hook = ["hook", "run", "--ignore-missing", "pre-commit"]
    assert.deepEqual([fastGitAnswer(root, gpg).status, fastGitAnswer(root, gpg).stdout], [1, ""])
    assert.equal(fastGitAnswer(root, hook).skipped, true)
    assert.equal(fastGitAnswer(root, ["hook", "run", "--ignore-missing", "Bad Name"]), null)
    assert.equal(fastGitAnswer(root, ["hook", "run", "--ignore-missing"]), null)
    put(path.join(git, "hooks/pre-commit"), "#!/bin/sh\n")
    assert.equal(fastGitAnswer(root, hook), null)
    const quietHook = ["hook", "run", "--ignore-missing", "commit-msg"]
    writeFileSync(path.join(git, "config"), "[core]\n\thooksPath = h\n")
    assert.equal(fastGitAnswer(root, quietHook), null)
    writeFileSync(path.join(git, "config"), "[commit]\n\tgpgSign = true\n")
    assert.equal(fastGitAnswer(root, gpg), null)
    writeFileSync(path.join(git, "config"), "")
    put(path.join(git, "config.worktree"), "[commit]\n\tgpgsign = true\n")
    assert.equal(fastGitAnswer(root, gpg), null)
    writeFileSync(path.join(git, "config.worktree"), "")

    put(path.join(home, "inc"), "[commit]\n\tgpgsign = true\n")
    put(path.join(home, ".gitconfig"), "[include]\n\tpath = ~/inc\n")
    assert.equal(fastGitAnswer(root, gpg), null)
    put(path.join(home, ".gitconfig"), "[include]\n\tpath = inc\n")
    assert.equal(fastGitAnswer(root, gpg), null)
    put(path.join(home, "inc"), "[include]\n\tpath = inc\n")
    assert.equal(fastGitAnswer(root, gpg), null)
    writeFileSync(path.join(home, ".gitconfig"), "")

    process.env.XDG_CONFIG_HOME = path.join(home, "xdg")
    put(path.join(home, "xdg/git/config"), "[commit]\n\tgpgsign = true\n")
    assert.equal(fastGitAnswer(root, gpg), null)
    delete process.env.XDG_CONFIG_HOME
    put(path.join(home, ".config/git/config"), "[commit]\n\tgpgsign = true\n")
    assert.equal(fastGitAnswer(root, gpg), null)
    writeFileSync(path.join(home, ".config/git/config"), "")

    process.env.GIT_CONFIG_COUNT = "1"
    process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign"
    process.env.GIT_CONFIG_VALUE_0 = "true"
    assert.equal(fastGitAnswer(root, gpg), null)
    delete process.env.GIT_CONFIG_COUNT
    delete process.env.GIT_CONFIG_KEY_0
    delete process.env.GIT_CONFIG_VALUE_0

    delete process.env.GIT_CONFIG_SYSTEM
    delete process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    fastGitAnswer(root, gpg)

    put(path.join(home, "global"), "[include]\n\tpath = global-inc\n")
    put(path.join(home, "global-inc"), "[user]\n\tname = x\n")
    process.env.GIT_CONFIG_GLOBAL = path.join(home, "global")
    delete process.env.HOME
    fastGitAnswer(root, gpg)
  })
})

test("stripspace trims, collapses and ends with one newline", () => {
  assert.equal(stripspace("\n\n  a \t\n\n\n b\n\n\n"), "  a\n\n b\n")
  assert.equal(stripspace("\n \n"), "")
})

test("waitingLogs outside a repository folder reads Git's diff and untracked lists", () => {
  const root = mkTempRoot("fast-refs-logs-")
  put(path.join(root, "a/log.md"), "x\n")
  put(path.join(root, "a/task.md"), "y\n")
  assert.deepEqual(waitingLogs(root, (_git, args) => ({ status: 0, stdout: args.includes("diff") ? "a/log.md\0" : "" })), ["a/log.md"])
})

test("a remote lookup the files cannot answer still goes to Git", () => {
  const { root, git } = checkout()
  mkdirSync(path.join(git, "reftable"))
  const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "" }
  assert.equal(remoteIdentityEnv({ root, args: ["fetch"], env, spawn: spawnSync, cache: new Map() }), env)
})

test("fetchAhead gives up quietly on a root it cannot read", async () => {
  assert.equal(await fetchAhead({ root: "bad\0root" }), "failed")
  assert.equal(await fetchAhead({ root: mkTempRoot("fast-refs-nofetch-") }), "skipped")
})

test("the background fetch repeats on a timer, once per root, and stops when asked", async () => {
  const calls = []
  const fetchFn = async ({ root }) => { calls.push(root) }
  const root = mkTempRoot("fast-refs-timer-")
  assert.equal(typeof startBackgroundFetch({ root, env: { NODE_TEST_CONTEXT: "child" }, fetchFn }), "function")
  startBackgroundFetch({ root })()
  startBackgroundFetch({ root, env: { NODE_TEST_CONTEXT: "child" }, intervalMs: 5 })()
  const stop = startBackgroundFetch({ root, env: {}, intervalMs: 5, fetchFn })
  startBackgroundFetch({ root, env: {}, intervalMs: 5, fetchFn })()
  for (let waited = 0; calls.length < 2 && waited < 5000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(calls.length >= 2, "the fetch ran more than once")
  stop()
  const seen = calls.length
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(calls.length <= seen + 1)
  const slow = startBackgroundFetch({ root, env: {}, intervalMs: 1, fetchFn: async () => { stop2(); await new Promise((resolve) => setTimeout(resolve, 20)) } })
  const stop2 = () => slow()
  await new Promise((resolve) => setTimeout(resolve, 80))
})

const run = (cwd, args) => {
  const answer = spawnSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" })
  assert.equal(answer.status, 0, `git ${args.join(" ")}: ${answer.stderr}`)
  return answer.stdout.trim()
}

function cloneOf(origin) {
  const dir = mkTempRoot("fast-refs-clone-")
  run(dir, ["clone", "-q", origin, "."])
  return dir
}

test("fetchAhead records a fetch that found nothing, a fast-forward, a divergence and a lost remote", async () => {
  await quiet(async () => {
    const origin = mkTempRoot("fast-refs-origin-")
    run(origin, ["init", "-q", "--bare", "-b", "main"])
    const seed = cloneOf(origin)
    writeFileSync(path.join(seed, "a.txt"), "one\n")
    run(seed, ["add", "."])
    run(seed, ["commit", "-q", "-m", "one"])
    run(seed, ["push", "-q", "origin", "HEAD:main"])
    const mine = cloneOf(origin)
    const env = { ...process.env }
    assert.equal(await fetchAhead({ root: mine, env }), "fetched")

    writeFileSync(path.join(seed, "a.txt"), "two\n")
    run(seed, ["commit", "-q", "-am", "two"])
    run(seed, ["push", "-q", "origin", "HEAD:main"])
    assert.equal(await fetchAhead({ root: mine, env }), "fetched")
    assert.notEqual(readUpstreamRefs(mine).head, readUpstreamRefs(mine).target)

    writeFileSync(path.join(mine, "b.txt"), "mine\n")
    run(mine, ["add", "."])
    run(mine, ["commit", "-q", "-m", "mine"])
    assert.equal(await fetchAhead({ root: mine, env }), "fetched")

    run(mine, ["remote", "set-url", "origin", path.join(origin, "gone")])
    assert.equal(await fetchAhead({ root: mine, env }), "failed")
  })
})

test("a pull whose waiting task log cannot be committed leaves the log for the next pull", async () => {
  await quiet(async () => {
    const root = mkTempRoot("fast-refs-log-")
    run(root, ["init", "-q", "-b", "main"])
    put(path.join(root, "t/task.md"), "card\n")
    run(root, ["add", "."])
    run(root, ["commit", "-q", "-m", "seed"])
    put(path.join(root, "t/log.md"), "entry\n")
    const hook = path.join(root, ".git/hooks/pre-commit")
    put(hook, "#!/bin/sh\nexit 1\n")
    chmodSync(hook, 0o755)
    await syncWorkspace({ root, env: { ...process.env } })
    assert.equal(run(root, ["status", "--porcelain", "--", "t/log.md"]).length > 0, true)
  })
})
