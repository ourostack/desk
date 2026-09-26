import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { guardShellCommand, protectedCheckoutHook, protectCheckout } from "../../src/runtime/protected-checkout.js"
import { inspectShell, tokenizeShell } from "../../src/runtime/shell-commands.js"

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-guard-edges-"))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-q")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "initial")
  git("config", "desk.protected", "true")
  return { root, git, guard: (command, extra = {}) => guardShellCommand({ command, cwd: root, ...extra }) }
}

test("Git option operands, default environment, empty -C and bare control flags keep the actual target", async (t) => {
  const { root, guard } = fixture(t)
  const denies = [
    "git -C '' checkout HEAD", "git -- checkout HEAD", "git -cdesk.protected=false reset",
    `git --git-dir "${root}/.git" --work-tree "${root}" --namespace test checkout HEAD`,
    "git --namespace=test checkout HEAD", "git --config-env=desk.protected=X checkout HEAD",
    "git --no-optional-locks checkout HEAD", "git -c checkout", "git worktree remove -f",
  ]
  for (const command of denies.slice(0, -2)) assert.equal((await guard(command)).deny, true, command)
  for (const command of [
    ...denies.slice(-2), "git", "git -c", "git -C", "git -C \"$(echo unknown)\" checkout HEAD", "git --git-dir",
    "git --work-tree", "git --namespace", "git --bare status",
  ]) assert.equal((await guard(command)).deny, false, command)
  const dir = path.join(root, "not-a-repo")
  mkdirSync(dir)
  assert.equal((await guard("git --git-dir ./missing checkout HEAD")).deny, false)
  const removed = path.join(root, "removable")
  addWorktree(root, removed)
  assert.equal((await guard("git worktree remove -f removable")).deny, true)
  assert.equal((await guard("git worktree remove -f does-not-exist")).deny, false)
  await assert.rejects(guard(`git worktree remove -f ${"a".repeat(1000)}`), /ENAMETOOLONG/u)
})

function addWorktree(root, destination) {
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", destination, "HEAD"], { stdio: "ignore" })
}

test("invalid saved policy and missing Git produce explicit errors, never a fabricated allow", async (t) => {
  const { guard, git, root } = fixture(t)
  git("config", "desk.protected", "not-a-boolean")
  await assert.rejects(guard("git checkout HEAD"), /cannot read checkout protection/u)
  await assert.rejects(guard("git checkout HEAD", { env: { PATH: "" } }), /ENOENT/u)
  await assert.rejects(protectCheckout({ root, git: async ({ args }) => args[0] === "rev-parse"
    ? { ok: true, stdout: path.join(root, ".git") }
    : { ok: false, stderr: "configuration is read-only" } }), /could not protect checkout.*configuration is read-only/u)
})

test("the hook leaves non-shell, empty and allowed inputs to the host's normal permission policy", async (t) => {
  const { root } = fixture(t)
  for (const input of [
    { toolName: "view", toolArgs: { command: "git checkout HEAD" } },
    { toolName: "bash" }, { toolName: "bash", toolArgs: {} },
    { toolName: "bash", toolArgs: { command: "echo ok", cwd: root } },
    { tool_name: "Bash", tool_input: { command: "echo ok" } },
    { toolName: "bash", toolArgs: '{"command":"echo ok"}', cwd: root },
  ]) assert.deepEqual(await protectedCheckoutHook(input, "copilot"), {})
  const decision = await protectedCheckoutHook({ toolName: "powershell", toolArgs: { command: "git checkout HEAD", cwd: root } }, "copilot")
  assert.equal(decision.permissionDecision, "deny")
  await assert.rejects(protectedCheckoutHook({ toolName: "bash", toolArgs: "bad JSON" }, "copilot"), SyntaxError)
})

test("literal shell forms exercise expansion without running any interpolated program", async (t) => {
  const { root, guard } = fixture(t)
  const env = { ...process.env, HOME: root, OLDPWD: root }
  const deny = [
    "git -C $(pwd) checkout HEAD", "git -C ${PWD} checkout HEAD",
    "echo $( (git checkout HEAD) )", "env -u UNUSED git checkout HEAD",
    `env --chdir "${root}" git checkout HEAD`, "builtin git checkout HEAD",
    "export PWD; cd; git checkout HEAD", "cd - && git checkout HEAD", "cd ~ && git checkout HEAD",
    "cat <<-EOF\n\t$(git checkout HEAD)\n\tEOF",
    "cat <<EOF\n$(git checkout HEAD)",
    "if false; then echo no; elif true; then git checkout HEAD; else echo no; fi",
    "if true; then git checkout HEAD; else echo no; fi",
  ]
  for (const command of deny) assert.equal((await guard(command, { env })).deny, true, command)
  const allow = [
    "echo $ABSENT", "env", "bash", "bash -c", "echo \\",
    "cd /definitely-missing && git checkout HEAD", "cd .git/config && git checkout HEAD",
    'cd "$(echo not-executed)" && git checkout HEAD', 'cd "$(date)" && git checkout HEAD', "echo >",
    "cat <<'END'\nliteral text\nEND", "echo \"\\q\"", "printf '$HOME'",
    "for ref in; do git checkout HEAD; done", "false && git checkout HEAD",
  ]
  for (const command of allow) assert.equal((await guard(command, { env })).deny, false, command)
  assert.equal((await guard("cd && git checkout HEAD", { env: {} })).deny, false)
  assert.equal((await guard("cd - && git checkout HEAD", { env: { OLDPWD: "" } })).deny, false)
  await assert.rejects(guard(`cd ${"a".repeat(1000)} && git checkout HEAD`), /ENAMETOOLONG/u)
})

test("malformed shell syntax is reported without ever executing text", async () => {
  for (const text of ["echo '", "echo `missing", "echo $(missing", "(echo ok", ")", "if true; echo missing"]) {
    await assert.rejects(inspectShell({ command: text, cwd: tmpdir(), env: {}, visit() {} }), /unterminated|expected shell|unexpected shell/u, text)
  }
  assert.ok(tokenizeShell("echo ${PWD}").length)
  assert.ok(tokenizeShell("echo ${").length)
  await assert.rejects(inspectShell({ command: "echo ok", cwd: tmpdir(), env: {}, visit() {}, depth: 17 }), /nesting exceeds/u)
})

test("a literal shell alias outside a repository stays outside a repository", async (t) => {
  const { root } = fixture(t)
  const outside = path.join(root, "..")
  assert.equal((await guardShellCommand({ command: "git -c 'alias.message=!echo safe' message", cwd: outside })).deny, false)
})

test("uninvoked functions and false loops are data, invoked functions and reachable loops are guarded", async (t) => {
  const { guard } = fixture(t)
  for (const [command, deny] of [
    ["move() { git checkout HEAD; }; echo defined", false],
    ["move() { git checkout HEAD; }; move", true],
    ["while false; do git checkout HEAD; done", false],
    ["while true; do git checkout HEAD; break; done", true],
    ["until true; do git checkout HEAD; done", false],
    ["until false; do git checkout HEAD; break; done", true],
  ]) assert.equal((await guard(command)).deny, deny, command)
})

test("shell wrappers and positional arguments preserve Git's target", async (t) => {
  const { root, guard } = fixture(t)
  for (const command of [
    "time git checkout HEAD", "timeout 5 git checkout HEAD", "nice -n 5 git checkout HEAD",
    "sudo -n git checkout HEAD",
    `sh -c 'git -C "$1" checkout HEAD' shell '${root}'`,
    `move() { git -C "$1" checkout HEAD; }; move '${root}'`,
    `git -C "$(printf '%s' '${root}')" checkout HEAD`,
  ]) assert.equal((await guard(command)).deny, true, command)
  await assert.rejects(guard("again() { again; }; again"), /inspection budget/u)
})
