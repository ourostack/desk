import { test, before, after } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const source = new URL("../../src/runtime/protected-checkout.js", import.meta.url)
const plugin = fileURLToPath(new URL("../../../", import.meta.url))
const guidance = 'shared checkout: use git worktree add --detach "$(mktemp -d)" <ref>'
let root, protectedRoot, ordinary, child
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "desk-guard-"))
  protectedRoot = path.join(root, "shared repo's checkout")
  ordinary = path.join(root, "owned")
  for (const dir of [protectedRoot, ordinary]) {
    mkdirSync(dir)
    git(dir, "init", "-q")
    git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "initial")
  }
  child = path.join(protectedRoot, "nested")
  mkdirSync(child)
  git(protectedRoot, "config", "--local", "desk.protected", "true")
})
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

async function guard(command, cwd = ordinary, extra = {}) {
  assert.ok(existsSync(source), "the protected-checkout guard must exist")
  const { guardShellCommand } = await import(source)
  return guardShellCommand({ command, cwd, env: process.env, ...extra })
}

test("named operations alone are denied in a locally protected checkout", async () => {
  const deny = [
    "checkout HEAD", "switch main", "reset --hard", "rebase main", "pull", "merge main", "stash list", "clean -nd",
    "restore --source HEAD file", "restore --source=HEAD file", "restore -s HEAD file", "restore -sHEAD file",
    "branch -f topic HEAD", "branch --force topic", "branch -fD topic",
  ]
  const allow = [
    "status", "diff", "log -1", "show HEAD", "fetch", "add file", "commit -m checkout", "push",
    "restore file", "restore --staged file", "restore -- --source", "branch", "branch --list",
    "branch -d topic", "branch -- topic-f", "worktree list", "worktree add --detach /tmp/new HEAD",
  ]
  for (const args of deny) {
    assert.equal((await guard(`git ${args}`, protectedRoot)).reason, guidance, args)
    assert.equal((await guard(`git ${args}`, ordinary)).deny, false, `unprotected: ${args}`)
  }
  for (const args of allow) assert.equal((await guard(`git ${args}`, protectedRoot)).deny, false, args)
})

test("command table follows quoting, chained directories, wrappers and Git location options", async () => {
  const p = quote(protectedRoot), o = quote(ordinary)
  const cases = [
    [`cd ${p} && git checkout HEAD`, true],
    [`cd ${p}; git switch main`, true],
    [`cd ${p}\ngit reset --hard`, true],
    [`cd ${p} && cd nested && git rebase main`, true],
    [`cd ${p} && cd ${o} && git checkout HEAD`, false],
    [`git -C ${p} checkout HEAD`, true],
    [`git -C ${p} -C nested reset --hard`, true],
    [`git -C${p} checkout HEAD`, true],
    [`git -C ${p} -c desk.protected=false checkout HEAD`, true],
    [`git --no-pager -C ${p} checkout HEAD`, true],
    [`git --git-dir=${p}/.git --work-tree=${p} checkout HEAD`, true],
    [`GIT_DIR=${p}/.git git checkout HEAD`, true],
    [`env GIT_DIR=${p}/.git git reset --hard`, true],
    [`command git -C ${p} checkout HEAD`, true],
    [`command -- git -C ${p} checkout HEAD`, true],
    [`env FOO=bar git -C ${p} checkout HEAD`, true],
    [`/usr/bin/git -C ${p} checkout HEAD`, true],
    [`'git' -C ${p} 'check'out HEAD`, true],
    [`git -C ${p} check\\\nout HEAD`, true],
    [`git -C ${p} checkout HEAD 2>/dev/null`, true],
    [`2>/dev/null git -C ${p} checkout HEAD`, true],
    [`(cd ${p} && git checkout HEAD)`, true],
    [`(cd ${p}); git checkout HEAD`, false],
    [`{ cd ${p}; }; git checkout HEAD`, true],
    [`echo ok | git -C ${p} checkout HEAD`, true],
    [`cd ${p} | cat; git checkout HEAD`, false],
    [`false && git -C ${p} checkout HEAD`, false],
    [`true || git -C ${p} checkout HEAD`, false],
    [`false || git -C ${p} checkout HEAD`, true],
    [`cd ${quote(path.join(root, "missing"))} && git -C ${p} checkout HEAD`, false],
    [`printf '%s' ${quote(`git -C ${p} checkout HEAD`)}`, false],
    [`echo "git checkout HEAD"`, false],
    [`# git -C ${p} checkout HEAD\ngit status`, false],
    [`printf checkout; git status`, false],
    [`P=${p}; cd "$P" && git checkout HEAD`, true],
    [`export P=${p}; git -C "\${P}" checkout HEAD`, true],
    [`sh -c ${quote(`cd ${p} && git checkout HEAD`)}`, true],
    [`bash -lc ${quote(`git -C ${p} checkout HEAD`)}`, true],
    [`eval ${quote(`git -C ${p} checkout HEAD`)}`, true],
    [`echo "$(git -C ${p} checkout HEAD)"`, true],
    [`echo '$(git checkout HEAD)'`, false],
    [`cat <<'EOF'\ngit -C ${p} checkout HEAD\nEOF\n`, false],
    [`cat <<EOF\n$(git -C ${p} checkout HEAD)\nEOF\n`, true],
    [`git -C ${p} -c 'alias.move=checkout' move HEAD`, true],
    [`git -C ${p} -c ${quote(`alias.move=!git checkout HEAD`)} move`, true],
  ]
  for (const [command, deny] of cases) {
    try { assert.equal((await guard(command)).deny, deny, command) }
    catch (error) { error.message = `${command}: ${error.message}`; throw error }
  }
})

test("force-removing a worktree checks the removed checkout, not just the invoking checkout", async () => {
  const worktree = path.join(root, "remove-me")
  git(ordinary, "worktree", "add", "--detach", worktree, "HEAD")
  git(ordinary, "config", "extensions.worktreeConfig", "true")
  git(worktree, "config", "--worktree", "desk.protected", "true")
  for (const flag of ["--force", "-f", "-ff"]) {
    assert.equal((await guard(`git worktree remove ${flag} ${quote(worktree)}`)).deny, true)
  }
  assert.equal((await guard(`git worktree remove ${quote(worktree)}`)).deny, false)
  assert.equal((await guard(`git worktree remove --force ${quote(ordinary)}`)).deny, false)
})

test("global and command-scope config do not opt an unrelated checkout in or out", async () => {
  const global = path.join(root, "global.config")
  writeFileSync(global, "[desk]\nprotected = true\n")
  assert.equal((await guard("git checkout HEAD", ordinary, { env: { ...process.env, GIT_CONFIG_GLOBAL: global } })).deny, false)
  assert.equal((await guard("git checkout HEAD", protectedRoot, { env: {
    ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "desk.protected", GIT_CONFIG_VALUE_0: "false",
  } })).deny, true)
  assert.equal((await guard("git checkout HEAD", child)).deny, true)
})

test("both plugin hook registrations deny parent and child payloads without moving HEAD or the reflog", () => {
  const beforeHead = git(protectedRoot, "rev-parse", "HEAD")
  const beforeLog = git(protectedRoot, "reflog", "--format=%H %gs")
  for (const host of ["claude", "copilot"]) {
    const manifest = JSON.parse(readFileSync(path.join(plugin, "hooks", host === "claude" ? "hooks.json" : "copilot-hooks.json")))
    const entries = manifest.hooks[host === "claude" ? "PreToolUse" : "preToolUse"]
    assert.ok(entries?.length, `${host} must register the guard at plugin scope`)
    for (const childAgent of [false, true]) {
      const input = host === "claude"
        ? { tool_name: "Bash", tool_input: { command: "git checkout HEAD" }, cwd: protectedRoot, ...(childAgent ? { agent_id: "child", agent_type: "reviewer" } : {}) }
        : { toolName: "bash", toolArgs: JSON.stringify({ command: "git checkout HEAD" }), cwd: protectedRoot, ...(childAgent ? { agentId: "child" } : {}) }
      const command = host === "claude" ? entries[0].hooks[0].command : entries[0].bash
      const result = spawnSync("bash", ["-c", command], {
        cwd: ordinary, input: JSON.stringify(input), encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin, PLUGIN_ROOT: plugin },
      })
      assert.equal(result.status, 0, result.stderr)
      const output = JSON.parse(result.stdout)
      const decision = host === "claude" ? output.hookSpecificOutput : output
      assert.equal(decision.permissionDecision, "deny")
      assert.equal(decision.permissionDecisionReason, guidance)
    }
  }
  assert.equal(git(protectedRoot, "rev-parse", "HEAD"), beforeHead)
  assert.equal(git(protectedRoot, "reflog", "--format=%H %gs"), beforeLog)
  // No Git hook is installed: a human invoking Git directly is unaffected.
  git(protectedRoot, "checkout", "--detach", "HEAD")
  assert.equal(git(protectedRoot, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
})

test("binding marks only the bound checkout, preserves Git layout and leaves new worktrees usable", async () => {
  assert.ok(existsSync(source), "the protected-checkout marker must exist")
  const { protectCheckout } = await import(source)
  const bound = path.join(root, "bound [shared]")
  mkdirSync(bound)
  git(bound, "init", "-q")
  git(bound, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "initial")
  assert.equal((await protectCheckout({ root: bound })).protected, true)
  assert.equal(git(bound, "config", "--local", "--includes", "--bool", "desk.protected"), "true")
  assert.equal((await guard("git checkout HEAD", bound)).deny, true)
  const owned = path.join(root, "bound-worktree")
  git(bound, "worktree", "add", "--detach", owned, "HEAD")
  assert.equal((await guard("git checkout HEAD", owned)).deny, false)
  assert.equal((await protectCheckout({ root: owned })).protected, true)
  assert.equal((await guard("git checkout HEAD", owned)).deny, true)
  const plain = path.join(root, "not-git")
  mkdirSync(plain)
  assert.equal((await protectCheckout({ root: plain })).protected, false)
  assert.equal(existsSync(path.join(plain, ".git")), false)
})

test("Desk admission marks launcher-bound roots before activation, and marks a newly bound root too", async () => {
  const { createDeskSession } = await import("../../src/runtime/desk-session.js")
  const roots = [path.join(root, "session-a"), path.join(root, "session-b")]
  for (const dir of roots) { mkdirSync(dir); git(dir, "init", "-q") }
  let bound = roots[0]
  const session = createDeskSession({
    args: {}, deskStateDir: path.join(root, "session-state"), stderr: { write() {} },
    resolveInputs: async () => ({ root: { root: bound }, activationError: { message: "fixture activation fails" } }),
  })
  try {
    for (const dir of roots) {
      bound = dir
      await session.admission.refresh({ force: true })
      assert.equal((await guard("git checkout HEAD", dir)).deny, true, "even a degraded bound root stays protected")
    }
  } finally { await session.dispose() }
})

test("shell control flow, command substitutions and PowerShell invocation cannot hide a named operation", async () => {
    const p = quote(protectedRoot)
    const cases = [
      [`if true; then git -C ${p} checkout HEAD; fi`, true],
      [`if false; then git -C ${p} checkout HEAD; fi`, false],
      [`if false; then echo safe; else git -C ${p} checkout HEAD; fi`, true],
      [`for ref in HEAD main; do git -C ${p} checkout "$ref"; done`, true],
      [`echo \`git -C ${p} checkout HEAD\``, true],
      [`echo "\\$(git -C ${p} checkout HEAD)"`, false],
      [`git -C ${p} checkout HEAD & echo queued`, true],
      [`cd ${p} & git checkout HEAD`, false],
      [`! git -C ${p} checkout HEAD`, true],
      [`git -C ${p} -c alias.status=checkout status`, false],
      [`git -C ${p} restore --source HEAD -- file`, true],
      [`git -C ${p} branch --format=-f`, false],
      [`git -C ${p} --config-env desk.protected=IGNORED checkout HEAD`, true],
      [`git -C ${p} --help`, false],
      [`git -C ${p} --version`, false],
      [`git -C ${p} status; echo ok`, false],
      [`echo "quoted )" "$(printf '%s' "$(git -C ${p} checkout HEAD)")"`, true],
    ]
    for (const [command, deny] of cases) {
      try { assert.equal((await guard(command)).deny, deny, command) }
      catch (error) { error.message = `${command}: ${error.message}`; throw error }
    }
    const ps = `'${protectedRoot.replaceAll("'", "''")}'`
    for (const command of [`& git -C ${ps} checkout HEAD`, `Set-Location -LiteralPath ${ps}; git checkout HEAD`, `git -C ${ps} check\`out HEAD`]) {
      assert.equal((await guard(command, ordinary, { powershell: true })).deny, true, command)
    }
})
