// The destructive-command guard refuses shell commands that remove or move away a git checkout, a linked worktree or a Colima/Lima VM, and allows everything else.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const { decide, judgeShellCommand } = createRequire(import.meta.url)(path.join(plugin, "hooks", "lib", "destructive-command-guard.cjs"))

// Forward slashes keep the commands readable to the guard's shell reader on Windows too.
const slash = (value) => value.replaceAll("\\", "/")
const ROOT = slash(realpathSync(mkdtempSync(path.join(tmpdir(), "destructive-guard-"))))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
}
const MAIN = `${ROOT}/main`
const TREE = `${ROOT}/tree`
const SCRATCH = `${ROOT}/scratch`
mkdirSync(MAIN, { recursive: true })
mkdirSync(`${SCRATCH}/inner`, { recursive: true })
writeFileSync(`${SCRATCH}/inner/file.txt`, "x")
git(MAIN, "init", "-q")
git(MAIN, "commit", "-q", "--allow-empty", "-m", "first")
git(MAIN, "worktree", "add", "-q", TREE, "-b", "side")

const refused = (command, cwd = ROOT) => judgeShellCommand(command, cwd, {})
const allowed = (command, cwd = ROOT) => assert.equal(judgeShellCommand(command, cwd, {}), null, command)

test("a git main checkout is refused for rm and mv, with a reason that says what to do instead", () => {
  for (const command of [`rm -rf ${MAIN}`, `rm -rf ${MAIN}/`, `mv ${MAIN} ${ROOT}/old-main`, `/bin/rm -r -f -- ${MAIN}`, `rm -rf ${MAIN}/.git`]) {
    const message = refused(command)
    assert.match(message ?? "", /git checkout/u, command)
    assert.match(message, /Leave it where it is\. If it really has to go, ask its owner/u)
  }
})

test("a linked worktree is refused for rm and points to git worktree remove", () => {
  const message = refused(`rm -rf ${TREE}`)
  assert.match(message, /linked git worktree/u)
  assert.ok(slash(message).includes(`git worktree remove ${TREE}`), message)
})

test("cd X && rm -rf Y, relative paths, wildcards, variables, wrappers, subshells and substitutions are all resolved", () => {
  for (const command of [
    `cd ${ROOT} && rm -rf main`,
    `cd ${ROOT}; rm -rf ./main/`,
    `cd ${ROOT}/scratch && cd .. && rm -rf main`,
    `cd ${ROOT}/scratch && rm -rf ../tree`,
    `cd ${ROOT} && rm -rf ma*`,
    `D=${MAIN}; rm -rf $D`,
    `D=${ROOT}; rm -rf \${D}/main`,
    `sudo rm -rf ${MAIN}`,
    `env FOO=1 rm -rf ${MAIN}`,
    `bash -c "cd ${ROOT} && rm -rf main"`,
    `sh -lc 'rm -rf ${TREE}'`,
    `eval "rm -rf ${MAIN}"`,
    `echo $(rm -rf ${MAIN})`,
    `(cd ${ROOT} && rm -rf main)`,
    `true && { rm -rf ${MAIN}; }`,
    `rm -rf ${MAIN} 2>/dev/null`,
    `cat <<EOF\nnotes\nEOF\nrm -rf ${MAIN}`,
  ]) assert.ok(refused(command), command);
  assert.ok(refused("rm -rf main", ROOT), "a relative path resolves against the session folder")
})

test("a folder that holds a checkout is refused, and the reason names the checkout", () => {
  const message = refused(`rm -rf ${ROOT}`)
  assert.ok(slash(message).includes(`${ROOT} holds ${MAIN}, which is a git checkout`), message)
})

test("ordinary removal is allowed: temp files, scratch folders, a folder inside a checkout, git's own commands, text that only mentions rm", () => {
  for (const command of [
    "rm -rf /tmp/x",
    "rm -f /tmp/x/y.txt",
    `rm -rf ${SCRATCH}`,
    `cd ${SCRATCH} && rm -rf ./*`,
    `cd ${SCRATCH}/inner && rm file.txt`,
    `rm -rf ${MAIN}/node_modules ${MAIN}/dist`,
    `rm -f ${MAIN}/.git/index.lock`,
    `mv ${SCRATCH}/inner ${SCRATCH}/other`,
    `mv ${SCRATCH}/other ${MAIN}`,
    `git worktree remove ${TREE}`,
    `git -C ${MAIN} rm -r --cached x`,
    `echo rm -rf ${MAIN}`,
    `cat > notes.sh <<'EOF'\nrm -rf ${MAIN}\nEOF`,
    `rm -rf $(mktemp -d)`,
    `rm -rf $UNKNOWN/main`,
    `rm -rf "${MAIN}`,
    "rm -rf",
    "command -v rm",
    "colima start -p mine",
    "colima list",
    "limactl list",
  ]) allowed(command);
})

test("colima delete and limactl delete are refused for every profile, with a dedicated profile name suggested", () => {
  for (const command of ["colima delete -f", "colima delete default", "colima -p work delete", "limactl delete colima", "limactl rm -f default", "cd ~ && colima delete -p mine"]) {
    const message = refused(command)
    assert.match(message ?? "", /whole VM/u, command)
    assert.match(message, /new name/u)
    assert.match(message, /ask its owner/u)
  }
})

test("variables from the session's environment resolve, and ~ resolves to the home folder", () => {
  assert.ok(judgeShellCommand("rm -rf $BASE/main", ROOT, { BASE: ROOT }))
  assert.equal(judgeShellCommand("rm -rf ~/definitely-not-a-checkout-xyz", ROOT, {}), null)
})

test("the hook answers in each host's shape and allows what it does not judge", () => {
  const command = `rm -rf ${MAIN}`
  const copilot = decide({ toolName: "bash", toolArgs: { command }, cwd: ROOT, agentId: "sub-1" }, "copilot")
  assert.equal(copilot.permissionDecision, "deny")
  assert.match(copilot.permissionDecisionReason, /git checkout/u)
  assert.equal(decide({ toolName: "bash", toolArgs: JSON.stringify({ command }), cwd: ROOT }, "copilot").permissionDecision, "deny")
  const claude = decide({ tool_name: "Bash", tool_input: { command }, cwd: ROOT }, "claude")
  assert.equal(claude.hookSpecificOutput.hookEventName, "PreToolUse")
  assert.equal(claude.hookSpecificOutput.permissionDecision, "deny")
  assert.deepEqual(decide({ toolName: "view", toolArgs: { path: MAIN }, cwd: ROOT }, "copilot"), {})
  assert.deepEqual(decide({ toolName: "bash", toolArgs: { command: "ls" }, cwd: ROOT }, "copilot"), {})
  assert.deepEqual(decide(null, "copilot"), {})
})

test("the registered entry reads stdin, denies, and fails open on input it cannot read", () => {
  const run = (input) => spawnSync(process.execPath, [path.join(plugin, "hooks", "destructive-command-guard.cjs"), "copilot"], { input, encoding: "utf8" })
  const denied = run(JSON.stringify({ toolName: "bash", toolArgs: { command: `cd ${ROOT} && rm -rf main` }, cwd: ROOT }))
  assert.equal(denied.status, 0)
  assert.equal(JSON.parse(denied.stdout).permissionDecision, "deny")
  assert.deepEqual(JSON.parse(run("not json").stdout), {})
  assert.deepEqual(JSON.parse(run("").stdout), {})
})

test("both hosts register the guard on shell calls only where the guard can read them", () => {
  const copilot = JSON.parse(readFileSync(path.join(plugin, "hooks", "copilot-hooks.json"), "utf8"))
  const [entry] = copilot.hooks.preToolUse
  assert.match(entry.bash, /destructive-command-guard\.cjs" copilot$/u)
  assert.equal(entry.powershell, undefined, "the guard reads Bash only, so Windows pays no hook process per tool call")
  const claude = JSON.parse(readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8"))
  const [group] = claude.hooks.PreToolUse
  assert.equal(group.matcher, "Bash")
  assert.match(group.hooks[0].command, /destructive-command-guard\.cjs" claude$/u)
})
