import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { GUARD_INSPECTION_BUDGET_MS, guardShellCommand, protectedCheckoutHook, protectCheckout } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout.js"
import { inspectShell, tokenizeShell } from "../../../../../plugins/desk/mcp/src/runtime/shell-commands.js"
import { readInspectionGit } from "../../../../../plugins/desk/mcp/src/runtime/git-inspection.js"

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
    "git -C '' checkout HEAD", "git -- checkout HEAD", "git -cdesk.protected=false reset --hard",
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
  assert.match((await guard(`git worktree remove -f ${"a".repeat(1000)}`)).reason, /could not inspect a Git command.*ENAMETOOLONG/u)
})

function addWorktree(root, destination) {
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", destination, "HEAD"], { stdio: "ignore" })
}

test("invalid saved policy and marker failures produce explicit errors independent of candidate PATH", async (t) => {
  const { guard, git, root } = fixture(t)
  git("config", "desk.protected", "not-a-boolean")
  assert.match((await guard("git checkout HEAD")).reason, /cannot read checkout protection/u)
  assert.match((await guard("git checkout HEAD", { env: { PATH: "" } })).reason, /cannot read checkout protection/u)
  assert.equal((await guard("git status")).deny, false, "an allowed operation needs no policy read")
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
    'cd "$(echo not-executed)" && git checkout HEAD', "echo >",
    "cat <<'END'\nliteral text\nEND", "echo \"\\q\"", "printf '$HOME'",
    "for ref in; do git checkout HEAD; done", "false && git checkout HEAD",
  ]
  for (const command of allow) assert.equal((await guard(command, { env })).deny, false, command)
  assert.match((await guard('cd "$(date)" && git checkout HEAD', { env })).reason, /could not resolve which checkout/u)
  assert.equal((await guard('cd "$(date)" && git status', { env })).deny, false)
  assert.equal((await guard("cd && git checkout HEAD", { env: {} })).deny, false)
  assert.equal((await guard("cd - && git checkout HEAD", { env: { OLDPWD: "" } })).deny, false)
  assert.match((await guard(`cd ${"a".repeat(1000)} && git checkout HEAD`)).reason, /could not inspect this shell command \(ENAMETOOLONG/u)
  assert.equal((await guard(`cd ${"a".repeat(1000)} && echo ok`)).deny, false)
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
  // Round 4 ruling: running out of the step budget fails closed, with or without Git.
  for (const command of ["again() { again; }; again", "again() { again; git status; }; again"]) {
    assert.match((await guard(command)).reason, /^Desk stopped inspecting this shell command after 20000 steps/u, command)
  }
})

// A loop body whose commands have unknown exit statuses leaves the same few states after every
// iteration, so a long loop costs steps in proportion to its length, not 2^n: the guard decides
// it instead of failing closed on its step budget.
test("long loops over commands with unknown exit statuses stay within the inspection budget", async (t) => {
  const { root, guard } = fixture(t)
  const values = Array.from({ length: 60 }, (_, index) => `v${index}`).join(" ")
  assert.equal((await guard(`for f in ${values}; do wc -l "$f" && grep -c x "$f" || true; done`)).deny, false)
  assert.equal((await guard(`for f in ${values}; do wc -l "$f"; done; git checkout HEAD`)).deny, true)
  assert.equal((await guard(`for f in ${values}; do if test -f "$f"; then git -C '${root}' checkout HEAD; fi; done`)).deny, true)
  assert.equal((await guard(`for f in ${values}; do while read line; do wc -l "$line"; done < "$f"; done`)).deny, false)

  // A while loop merges identical exit states too: the command after `||` is walked once for the one failed state, not once per path that failed.
  const visited = []
  await inspectShell({ command: "while read line; do wc -l \"$line\"; done || touch marker", cwd: tmpdir(), env: {}, visit({ name }) { visited.push(name) } })
  assert.deepEqual(visited.filter((name) => name === "touch"), ["touch"])
})

// ourostack/factory#39 (closing comment): the guard's cache key for a Git call included the whole modeled shell
// environment, loop variable included, so a loop that called Git every iteration spent one real Git read per
// iteration even when the call's actual target and behavior never changed. The guard's work must instead be
// bounded by the command's distinct Git targets.
test("a long loop of identical, always-allowed Git calls costs reads proportional to its one distinct target, not its length", async (t) => {
  const { guard } = fixture(t)
  let reads = 0
  const countingGit = (cwd, args, env, options) => { reads++; return readInspectionGit(cwd, args, env, options) }
  const iterations = 200
  const values = Array.from({ length: iterations }, (_, index) => `v${index}`).join(" ")
  // The loop variable is read but never used to change the Git call's target or arguments: every iteration runs
  // the exact same "git push", which the policy always allows here (no force, no remote configured).
  const result = await guard(`for f in ${values}; do echo "$f" > /dev/null; git push; done`, { readGit: countingGit })
  assert.equal(result.deny, false)
  assert.ok(reads > 0 && reads <= 4, `expected the guard's Git reads to stay bounded by the command's one distinct target, got ${reads} reads for ${iterations} identical iterations`)
})

test("a loop containing a dangerous Git call on the protected checkout is still denied, without walking the rest of the loop", async (t) => {
  const { guard } = fixture(t)
  const iterations = 200
  const values = Array.from({ length: iterations }, (_, index) => `v${index}`).join(" ")
  let reads = 0
  const countingGit = (cwd, args, env, options) => { reads++; return readInspectionGit(cwd, args, env, options) }
  const result = await guard(`for f in ${values}; do git reset --hard; done`, { readGit: countingGit })
  assert.equal(result.deny, true)
  assert.match(result.reason, /this would discard other sessions' uncommitted work/u)
  assert.ok(reads <= 4, `expected the denial to short-circuit instead of walking all ${iterations} iterations, got ${reads} reads`)
})

test("a loop over many distinct repositories costs reads proportional to its distinct targets, and a budget too small to finish says why and what to do", async (t) => {
  const { root, guard } = fixture(t)
  const repoCount = 15
  const dirs = []
  for (let index = 0; index < repoCount; index++) {
    const dir = path.join(root, `repo-${index}`)
    mkdirSync(dir)
    execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" })
    execFileSync("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "initial"], { stdio: "ignore" })
    dirs.push(dir)
  }
  const command = `for d in ${dirs.map((dir) => `'${dir}'`).join(" ")}; do git -C "$d" push; done`

  let reads = 0
  const countingGit = (cwd, args, env, options) => { reads++; return readInspectionGit(cwd, args, env, options) }
  const result = await guard(command, { readGit: countingGit })
  assert.equal(result.deny, false)
  assert.equal(reads, repoCount * 2, `expected two Git reads per distinct repository, got ${reads} reads for ${repoCount} repositories`)

  // A budget that cannot finish checking every distinct target is denied, and says why and what to do about it,
  // rather than just "retry it": retrying an inherently large loop would only time out again the same way.
  let clock = 0
  const spentGit = (cwd, args, env) => { clock += GUARD_INSPECTION_BUDGET_MS; return readInspectionGit(cwd, args, env) }
  const tooSlow = await guard(command, { readGit: spentGit, now: () => clock })
  assert.equal(tooSlow.deny, true)
  assert.match(tooSlow.reason, new RegExp(`within its ${GUARD_INSPECTION_BUDGET_MS / 1000} s budget`, "u"))
  assert.match(tooSlow.reason, /split it into fewer targets|run it as a script file/u)
})

// Review of the ourostack/factory#39 fix found this pre-existing gap: target resolution used only the
// modeled cwd plus -C, never GIT_DIR/GIT_WORK_TREE, so a nonexistent modeled directory hid a real target
// those variables named. Repro from review: a cwd the guard cannot find on disk, with GIT_DIR/GIT_WORK_TREE
// naming a real, protected checkout.
test("GIT_DIR/GIT_WORK_TREE name the real target even when the modeled cwd does not exist", async (t) => {
  const { root, guard } = fixture(t)
  const missing = path.join(root, "does-not-exist-at-all")
  const result = await guard("git reset --hard", { cwd: missing, env: { ...process.env, GIT_DIR: path.join(root, ".git"), GIT_WORK_TREE: root } })
  assert.equal(result.deny, true, "GIT_DIR/GIT_WORK_TREE name a real, protected checkout; a nonexistent cwd must not hide it")
  assert.match(result.reason, /this would discard other sessions' uncommitted work/u)
})

// GIT_DIR alone, without GIT_WORK_TREE, must still name the checkout: its parent directory for a plain ".git",
// or the directory itself for a bare repository. Neither the command line nor the ambient cwd names anywhere
// protected, so only GIT_DIR finding the target proves the command is still checked.
test("a relative GIT_DIR/GIT_WORK_TREE resolves against the directory the Git call runs in, not the hook's own", async (t) => {
  const { root } = fixture(t)
  const relDir = await guardShellCommand({ command: `cd "${root}" && GIT_DIR=.git git reset --hard`, cwd: tmpdir(), env: process.env })
  assert.equal(relDir.deny, true, "GIT_DIR=.git inside the protected checkout names that checkout")
  assert.match(relDir.reason, /this would discard other sessions' uncommitted work/u)
  const relTree = await guardShellCommand({ command: `cd "${root}" && GIT_WORK_TREE=. git reset --hard`, cwd: tmpdir(), env: process.env })
  assert.equal(relTree.deny, true, "GIT_WORK_TREE=. inside the protected checkout names that checkout")
})

test("GIT_DIR alone names the checkout, non-bare or bare", async (t) => {
  const { root } = fixture(t)
  const elsewhere = mkdtempSync(path.join(tmpdir(), "desk-guard-edges-elsewhere-"))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))

  const nonBare = await guardShellCommand({ command: "git reset --hard", cwd: elsewhere, env: { ...process.env, GIT_DIR: path.join(root, ".git") } })
  assert.equal(nonBare.deny, true, "a plain .git GIT_DIR names its parent directory as the checkout")
  assert.match(nonBare.reason, /this would discard other sessions' uncommitted work/u)

  const bareRoot = mkdtempSync(path.join(tmpdir(), "desk-guard-edges-bare-"))
  t.after(() => rmSync(bareRoot, { recursive: true, force: true, maxRetries: 5 }))
  execFileSync("git", ["init", "-q", "--bare", bareRoot], { stdio: "ignore" })
  execFileSync("git", ["-C", bareRoot, "config", "desk.protected", "true"], { stdio: "ignore" })
  const bare = await guardShellCommand({ command: "git reset --hard", cwd: elsewhere, env: { ...process.env, GIT_DIR: bareRoot } })
  assert.equal(bare.deny, true, "a bare GIT_DIR names itself as the checkout")
  assert.match(bare.reason, /this would discard other sessions' uncommitted work/u)
})

// Mutation check named in review: replacing the cache key's environment filter with one that always returns
// {} still passed every existing guard test, because no test proved a GIT_DIR/GIT_WORK_TREE difference forces
// a fresh Git read rather than reusing an unrelated iteration's cached answer. The loop's own command text and
// modeled cwd never change here - only the location its environment names does - so this test only passes when
// the guard's cache key actually depends on that environment.
test("a loop that only changes GIT_DIR/GIT_WORK_TREE is checked once per distinct location, not merged into one cached answer", async (t) => {
  const { root: danger, guard } = fixture(t)
  const safe = mkdtempSync(path.join(tmpdir(), "desk-guard-edges-safe-"))
  t.after(() => rmSync(safe, { recursive: true, force: true, maxRetries: 5 }))
  execFileSync("git", ["-C", safe, "init", "-q"], { stdio: "ignore" })
  execFileSync("git", ["-C", safe, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "initial"], { stdio: "ignore" })

  let reads = 0
  const countingGit = (cwd, args, env, options) => { reads++; return readInspectionGit(cwd, args, env, options) }
  const command = `for d in "${safe}" "${danger}"; do GIT_DIR="$d/.git" GIT_WORK_TREE="$d" git reset --hard; done`
  const result = await guard(command, { cwd: safe, readGit: countingGit })
  assert.equal(result.deny, true, "the protected checkout's own GIT_DIR/GIT_WORK_TREE must still be checked, even though an earlier iteration's Git call looked identical")
  assert.match(result.reason, /this would discard other sessions' uncommitted work/u)
  assert.equal(reads, 4, "two distinct GIT_DIR/GIT_WORK_TREE locations, two Git reads each: caching by target, not by iteration count")
})

test("home expansion respects quoting and inline alias cache keys include alias definitions", async (t) => {
  const { root, guard } = fixture(t)
  const env = { ...process.env, HOME: root }
  for (const command of ["git -C ~ checkout HEAD", "git -C ~/ checkout HEAD", 'git -C ~/"." checkout HEAD']) {
    assert.equal((await guard(command, { env })).deny, true, command)
  }
  for (const command of ["git -C '~' checkout HEAD", 'git -C "~" checkout HEAD', "cd '~' && git checkout HEAD"]) {
    assert.equal((await guard(command, { env })).deny, false, command)
  }
  assert.equal((await guard("git -c alias.act=status act; git -c 'alias.act=checkout HEAD' act")).deny, true)
})
