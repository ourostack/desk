import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { guardShellCommand, protectCheckout, protectedCheckoutHook, WORKTREE_GUIDANCE } from "../../src/runtime/protected-checkout.js"
import { inspectionEnvironment, readInspectionGit, resolveInspectionGit } from "../../src/runtime/git-inspection.js"
import { inspectGitOptions } from "../../src/runtime/git-guard-options.js"
import { inspectShell } from "../../src/runtime/shell-commands.js"
import { inspectPowerShell } from "../../src/runtime/powershell-commands.js"

const plugin = fileURLToPath(new URL("../../../", import.meta.url))
const hook = path.join(plugin, "hooks", "protected-checkout.cjs")
const q = (text) => `'${text.replaceAll("'", "'\\''")}'`
const psq = (text) => `'${text.replaceAll("'", "''")}'`
const gitExecutable = process.platform === "win32"
  ? execFileSync("where.exe", ["git.exe"], { encoding: "utf8" }).trim().split(/\r?\n/u)[0]
  : "/usr/bin/git"

function fixture(t, sharedName = "shared") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-guard-review-")))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "no-global") }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|CONFIG_(?:COUNT|KEY_|VALUE_))/u.test(key)) delete env[key]
  const git = (dir, ...args) => execFileSync(gitExecutable, ["-C", dir, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const ordinary = path.join(root, "ordinary"), shared = path.join(root, sharedName)
  for (const dir of [ordinary, shared]) {
    mkdirSync(path.join(dir, "child"), { recursive: true })
    git(dir, "init", "-q", "-b", "main")
    writeFileSync(path.join(dir, "file.txt"), "base\n")
    git(dir, "add", "file.txt")
    git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
  }
  git(shared, "config", "--local", "desk.protected", "true")
  return {
    root, ordinary, shared, env, git,
    guard: (command, extra = {}) => guardShellCommand({ command, cwd: ordinary, env, ...extra }),
  }
}

test("A3-C01: candidate PATH and loader variables never select an inspection executable, even for absolute Git", async (t) => {
  const f = fixture(t)
  const bin = path.join(f.root, "candidate-bin"), sentinel = path.join(f.root, "executed")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed");\nconst r = require("node:child_process").spawnSync(${JSON.stringify(gitExecutable)}, process.argv.slice(2), {encoding:"utf8"});\nprocess.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || ""); process.exit(r.status ?? 1);\n`, { mode: 0o700 })
  const preload = path.join(f.root, "preload.cjs")
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "preload");\n`)
  for (const executable of ["git", q(gitExecutable)]) {
    const command = `PATH=${q(bin)} NODE_OPTIONS=${q(`--require=${preload}`)} GIT_EXEC_PATH=${q(bin)} ${executable} -C ${q(f.shared)} checkout --detach HEAD`
    const response = await f.guard(command)
    assert.equal(existsSync(sentinel), false, "inspection must not execute candidate-selected code")
    assert.equal(response.reason, WORKTREE_GUIDANCE)
    for (const host of ["claude", "copilot"]) {
      const input = host === "claude" ? { tool_name: "Bash", tool_input: { command }, cwd: f.ordinary }
        : { toolName: "bash", toolArgs: { command }, cwd: f.ordinary }
      const result = spawnSync(process.execPath, [hook, host], { input: JSON.stringify(input), env: f.env, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(existsSync(sentinel), false)
      const output = JSON.parse(result.stdout)
      assert.equal((output.hookSpecificOutput ?? output).permissionDecision, "deny")
    }
  }
  assert.equal((await f.guard(`git -C ${q(f.shared)} checkout HEAD`, { env: { ...f.env, PATH: bin } })).deny, true)
  assert.equal(existsSync(sentinel), false)
})

test("A3-I01: physical Git traversal and logical/physical cd inspect the same checkout as the real shell", async (t) => {
  const f = fixture(t)
  for (const [issuer, target, deny] of [[f.ordinary, f.shared, true], [f.shared, f.ordinary, false]]) {
    const link = path.join(issuer, "link")
    symlinkSync(path.join(target, "child"), link, process.platform === "win32" ? "junction" : "dir")
    const commands = [
      [`git -C ${q(link)} -C .. checkout --detach HEAD`, deny, target],
      [`cd -P ${q(link + "/..")} && git checkout --detach HEAD`, deny, target],
      [`cd -P ${q(link)} && cd .. && git checkout --detach HEAD`, deny, target],
      [`cd ${q(link)} && git -C .. checkout --detach HEAD`, deny, target],
      [`cd ${q(link)} && cd .. && git checkout --detach HEAD`, !deny, issuer],
    ]
    for (const [command, expected, actualTarget] of commands) {
      f.git(actualTarget, "checkout", "main")
      const before = f.git(actualTarget, "reflog", "--format=%H %gs")
      assert.equal((await f.guard(command)).deny, expected, command)
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", command], { cwd: f.ordinary, env: f.env, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      assert.notEqual(f.git(actualTarget, "reflog", "--format=%H %gs"), before)
    }
  }
})

test("A3-I02: accepted Git option abbreviations mutate while option values remain read-only", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.shared, "file.txt"), "changed\n")
  assert.equal((await f.guard(`git -C ${q(f.shared)} restore --sour=HEAD -- file.txt`)).deny, true)
  f.git(f.shared, "restore", "--sour=HEAD", "--", "file.txt")
  assert.equal(readFileSync(path.join(f.shared, "file.txt"), "utf8"), "base\n")
  assert.equal((await f.guard(`git -C ${q(f.shared)} branch --forc topic HEAD`)).deny, true)
  f.git(f.shared, "branch", "--forc", "topic", "HEAD")
  assert.equal(f.git(f.shared, "rev-parse", "topic"), f.git(f.shared, "rev-parse", "HEAD"))
  for (const args of ["branch --format -f", "branch --format --force", "branch --format=--forc", "branch --list --format -f"]) {
    assert.equal((await f.guard(`git -C ${q(f.shared)} ${args}`)).deny, false, args)
  }
  assert.match(f.git(f.shared, "branch", "--format", "-f"), /^-f/mu)
  const victim = path.join(f.root, "remove-me")
  f.git(f.ordinary, "worktree", "add", "--detach", victim, "HEAD")
  await protectCheckout({ root: victim })
  assert.equal((await f.guard(`git worktree remove --forc ${q(victim)}`)).deny, true)
  f.git(f.ordinary, "worktree", "remove", "--forc", victim)
  assert.equal(existsSync(victim), false)
})

test("A3-I03: ANSI-C quotes and unquoted parameter fields retain Bash command semantics", async (t) => {
  const f = fixture(t)
  const commands = [
    `git -C $'${f.shared}' checkout --detach HEAD`,
    `git -C $'${f.shared.replaceAll("/", "\\x2f")}' checkout --detach HEAD`,
    `G='git -C ${f.shared}'; $G checkout --detach HEAD`,
    `G='git -C ${f.shared}'; \${G} checkout --detach HEAD`,
  ]
  for (const command of commands) {
    assert.equal((await f.guard(command)).deny, true, command)
    f.git(f.shared, "checkout", "main")
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", command], { cwd: f.ordinary, env: f.env, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(f.git(f.shared, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
  }
  assert.equal((await f.guard(`G='git -C ${f.shared}'; "$G" checkout HEAD`)).deny, false)
  await assert.rejects(f.guard('git -C "$(opaque-command)" checkout HEAD'), /unresolved/u)
  await assert.rejects(f.guard('cd "$(opaque-command)" && git checkout HEAD'), /unresolved/u)
})

test("A3-I04: PowerShell assignment, aliases, variables and parameters are case-insensitive", async (t) => {
  const f = fixture(t)
  const commands = [
    `$repo = ${psq(f.shared)}; git -C $repo checkout --detach HEAD`,
    `$RePo=${psq(f.shared)}; git -C $REPO checkout --detach HEAD`,
    `sl ${psq(f.shared)}; git checkout --detach HEAD`,
    `Set-Location -literalpath ${psq(f.shared)}; git checkout --detach HEAD`,
    `sEt-LoCaTiOn -lItErAlPaTh ${psq(f.shared)}; git checkout --detach HEAD`,
  ]
  for (const command of commands) {
    assert.equal((await f.guard(command, { powershell: true })).deny, true, command)
    // A native interpreter is useful additional proof where already available.
    const version = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" })
    if (!version.error) {
      f.git(f.shared, "checkout", "main")
      const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { cwd: f.ordinary, env: f.env, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(f.git(f.shared, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
    }
  }
  assert.equal((await f.guard(`$repo=${psq(f.ordinary)}; Set-Location -path $REPO; git checkout HEAD`, { powershell: true, cwd: f.shared })).deny, false)
})

test("A3-I05: the worktree victim's policy wins over the issuer's GIT_DIR", async (t) => {
  const f = fixture(t)
  const victim = path.join(f.root, "victim")
  f.git(f.ordinary, "worktree", "add", "--detach", victim, "HEAD")
  await protectCheckout({ root: victim })
  assert.equal(f.git(victim, "config", "--local", "--includes", "--bool", "desk.protected"), "true")
  const command = `GIT_DIR=${q(path.join(f.ordinary, ".git"))} git worktree remove --force ${q(victim)}`
  assert.equal((await f.guard(command)).deny, true)
  assert.equal(existsSync(victim), true)
  const actual = spawnSync("bash", ["-c", command], { cwd: f.ordinary, env: f.env, encoding: "utf8" })
  assert.equal(actual.status, 0, actual.stderr)
  assert.equal(existsSync(victim), false)
})

test("A3-I06: valid case syntax is non-applicable unless its selected arm invokes protected Git", async (t) => {
  const f = fixture(t)
  for (const cwd of [f.ordinary, f.shared]) {
    for (const host of ["claude", "copilot"]) {
      for (const child of [false, true]) {
        const command = "case x in x) echo harmless;; esac"
        const input = host === "claude" ? { tool_name: "Bash", tool_input: { command }, cwd, agent_id: child ? "child" : undefined }
          : { toolName: "bash", toolArgs: { command }, cwd, agentId: child ? "child" : undefined }
        const result = spawnSync(process.execPath, [hook, host], { input: JSON.stringify(input), env: f.env, encoding: "utf8" })
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(JSON.parse(result.stdout), {})
      }
    }
  }
  assert.equal((await f.guard(`case x in y) echo no;; x) git -C ${q(f.shared)} checkout HEAD;; esac`)).deny, true)
  assert.equal((await f.guard(`case x in y) git -C ${q(f.shared)} checkout HEAD;; *) echo harmless;; esac`)).deny, false)
  await assert.rejects(f.guard(`case x in x) git -C ${q(f.shared)} checkout HEAD;`), /shell|case/u)
})

test("A3-I07: Claude's native PowerShell registration selects PowerShell for parent and child payloads", async (t) => {
  const f = fixture(t)
  const manifest = JSON.parse(readFileSync(path.join(plugin, "hooks", "hooks.json")))
  assert.ok(manifest.hooks.PreToolUse.some((entry) => new RegExp(`^(?:${entry.matcher})$`, "u").test("PowerShell")))
  for (const child of [false, true]) {
    const input = { tool_name: "PowerShell", tool_input: { command: `$repo = ${psq(f.shared)}; git -C $repo checkout HEAD` }, cwd: f.ordinary, agent_id: child ? "child" : undefined }
    assert.equal((await protectedCheckoutHook(input, "claude")).hookSpecificOutput.permissionDecision, "deny")
    const result = spawnSync(process.execPath, [hook, "claude"], { input: JSON.stringify(input), env: f.env, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, WORKTREE_GUIDANCE)
  }
})

test("reviewer controls: CDPATH selects the destination and exit makes later Git unreachable", async (t) => {
  const f = fixture(t)
  assert.equal((await f.guard("cd shared && git checkout HEAD", { env: { ...f.env, CDPATH: f.root } })).deny, true)
  assert.equal((await f.guard(`exit 0; git -C ${q(f.shared)} checkout HEAD`)).deny, false)
  assert.equal((await f.guard(`(exit 0); git -C ${q(f.shared)} checkout HEAD`)).deny, true)
  assert.equal((await f.guard(`cd -LP ${q(f.shared)} && git checkout HEAD`)).deny, true)
})

test("PowerShell hook command is invokable on every PowerShell host, not only Windows", async (t) => {
  const f = fixture(t)
  const manifest = JSON.parse(readFileSync(path.join(plugin, "hooks", "copilot-hooks.json")))
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"])
  if (probe.error) { t.skip("PowerShell is not installed"); return }
  const command = manifest.hooks.preToolUse[0].powershell.replaceAll("${PLUGIN_ROOT}", plugin)
  const input = { toolName: "powershell", toolArgs: { command: "git checkout HEAD" }, cwd: f.shared }
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { cwd: f.ordinary, env: f.env, input: JSON.stringify(input), encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).permissionDecisionReason, WORKTREE_GUIDANCE)
})

test("inspection trust is independent of candidate runtime search and fails explicitly without trusted Git", async (t) => {
  const f = fixture(t)
  const ignored = "/candidate-only"
  const inspected = inspectionEnvironment({ PATH: ignored, HOME: ignored, NODE_OPTIONS: ignored, LD_PRELOAD: ignored, GIT_EXEC_PATH: ignored, GIT_CONFIG_COUNT: "1", GIT_DIR: f.shared + "/.git" })
  for (const key of ["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "GIT_EXEC_PATH"]) assert.notEqual(inspected[key], ignored)
  assert.equal(inspected.GIT_DIR, f.shared + "/.git")
  assert.equal(inspected.GIT_CONFIG_COUNT, undefined)
  assert.throws(() => inspectionEnvironment({ GIT_DIR: "\0" }), /unresolved Git location/u)
  assert.equal(resolveInspectionGit({ platform: "win32", env: { ProgramFiles: "C:\\Trusted", "ProgramFiles(x86)": "C:\\Alternate", PATH: ignored }, accessible: (file) => file === "C:\\Alternate\\Git\\cmd\\git.exe" }), "C:\\Alternate\\Git\\cmd\\git.exe")
  assert.throws(() => resolveInspectionGit({ platform: "win32", env: { ProgramFiles: "/missing-trusted-location" } }), /trusted Git is unavailable/u)
  assert.throws(() => resolveInspectionGit({ platform: "win32", env: {} }), /trusted Git is unavailable/u)
  assert.throws(() => resolveInspectionGit({ platform: "linux", accessible: () => false }), /trusted Git is unavailable/u)
  await assert.rejects(readInspectionGit(f.root + "/absent", ["status"], {}), /ENOENT/u)
  await assert.rejects(readInspectionGit(f.ordinary, ["hash-object", "--stdin"], {}), /Command failed/u)
})

test("operation option parsing consumes values, detects unambiguous prefixes and respects negation", () => {
  const cases = [
    ["restore", ["--sour", "HEAD", "--", "file"], true],
    ["restore", ["--source=HEAD", "--no-source", "file"], false],
    ["restore", ["--s"], false],
    ["restore", ["--source"], false],
    ["restore", ["-s"], false],
    ["restore", ["-sHEAD"], true],
    ["restore", ["-U", "2", "-sHEAD"], true],
    ["restore", ["--conflict", "-sHEAD"], false],
    ["branch", ["--forc", "topic"], true],
    ["branch", ["--for"], false],
    ["branch", ["--format", "--force"], false],
    ["branch", ["--format=-f"], false],
    ["branch", ["--format"], false],
    ["branch", ["-u", "-f"], false],
    ["branch", ["--force", "--no-force", "topic"], false],
    ["branch", ["--contains", "HEAD", "-f", "topic"], true],
    ["branch", ["--contains", "-f", "topic"], true],
    ["branch", ["--contains"], false],
    ["branch", ["--contains=HEAD"], false],
    ["branch", ["--color=never", "-f", "topic"], true],
    ["branch", ["-", "--force"], true],
    ["remove", ["--forc", "victim"], true],
    ["remove", ["--force", "--no-force", "victim"], false],
    ["remove", ["--", "--force"], false],
  ]
  for (const [operation, args, enabled] of cases) assert.equal(inspectGitOptions(operation, args).enabled, enabled, `${operation} ${args.join(" ")}`)
})

test("ANSI-C literal escapes decode without executing code or expanding quoted variables", async (t) => {
  const f = fixture(t)
  for (const command of [
    `git -C $'${f.shared.replaceAll("/", "\\057")}' checkout HEAD`,
    `git -C $'${f.shared.replaceAll("/", "\\u002f")}' checkout HEAD`,
    `git -C $'${f.shared.replaceAll("/", "\\U0000002f")}' checkout HEAD`,
    `$'g\\x69t' -C ${q(f.shared)} checkout HEAD`,
  ]) assert.equal((await f.guard(command)).deny, true, command)
  for (const command of ["printf $'\\a\\b\\e\\E\\f\\n\\r\\t\\v\\\\\\'\\\"'", "printf $'\\cA\\z'"]) assert.equal((await f.guard(command)).deny, false)
  for (const command of ["echo $'unterminated", "echo $'\\x'", "echo $'\\c"]) await assert.rejects(f.guard(command), /ANSI-C/u)
  await assert.rejects(f.guard('$(opaque-command) status'), /unresolved shell command/u)
  assert.equal((await f.guard(`G='git:-C:${f.shared}'; IFS=:; $G checkout HEAD`)).deny, true)
  assert.equal((await f.guard(`G='git -C ${f.shared}'; IFS=; $G checkout HEAD`)).deny, false)
})

test("case patterns, branch fallthrough and subshell boundaries match reachable commands", async (t) => {
  const f = fixture(t), git = `git -C ${q(f.shared)} checkout HEAD`
  for (const [command, deny] of [
    [`case x in (x|y) ${git};; esac`, true],
    [`case xyz in x*) ${git};; esac`, true],
    [`case x in ?) ${git};; esac`, true],
    [`case x in '*') ${git};; x) echo safe;; esac`, false],
    [`case x in x) echo safe;& y) ${git};; esac`, true],
    [`case x in x) echo safe;;& y) ${git};; esac`, false],
    [`case x in x) echo safe;;& x) ${git};; esac`, true],
    [`case "$(opaque-command)" in x) ${git};; esac`, true],
    [`case x in\nx) ${git};; esac`, true],
    [`case x in [xyz]) ${git};; esac`, true],
    [`case z in [!xy]) ${git};; esac`, true],
    [`case x in [!xy]) ${git};; esac`, false],
  ]) assert.equal((await f.guard(command)).deny, deny, command)
})

test("PowerShell non-Git expressions and redirects are allowed; computed targets and calls fail safely", async (t) => {
  const f = fixture(t)
  for (const command of ["", '"git checkout HEAD"', "Write-Output harmless > result.txt", "$unused = 1 + 2; Write-Output ok"]) {
    assert.equal((await f.guard(command, { powershell: true })).deny, false, command)
  }
  for (const command of ["&", "$name = 1 + 2; & $name", "$repo = 1 + 2; sl $repo", `sl -unsupported ${psq(f.shared)}`, `git -C "$(opaque-command)" checkout HEAD`]) {
    await assert.rejects(f.guard(command, { powershell: true }), /unresolved/u, command)
  }
  assert.equal((await f.guard(`Write-Output $(git -C ${psq(f.shared)} checkout HEAD)`, { powershell: true })).deny, true)
  assert.equal((await f.guard(`$repo=${psq(f.shared)}; Write-Output $(git -C $repo checkout HEAD)`, { powershell: true })).deny, true)
  assert.equal((await f.guard(`pwsh -Command ${q(`sl ${psq(f.shared)}; git checkout HEAD`)}`)).deny, true)
  await assert.rejects(inspectPowerShell({ command: "echo ok", cwd: f.ordinary, env: f.env, visit() {}, depth: 17 }), /nesting exceeds/u)
})

test("PowerShell keeps environment, local variables, conditional reachability and nested grammar distinct", async (t) => {
  const f = fixture(t), p = psq(f.shared)
  const cases = [
    [`$env:GIT_DIR=${psq(path.join(f.shared, ".git"))}; git checkout HEAD`, true],
    [`$GIT_DIR=${psq(path.join(f.shared, ".git"))}; git checkout HEAD`, false],
    [`$env:ROOT=${p}; git -C "\${env:root}" checkout HEAD`, true],
    [`$env:ROOT=${p}; $env:root=${psq(f.ordinary)}; git -C $env:ROOT checkout HEAD`, false],
    ["Write-Output $missing $env:MISSING", false],
    [`Write-Output ok || git -C ${p} checkout HEAD`, false],
    [`sl '/definitely-missing' && git -C ${p} checkout HEAD`, false],
    [`sl '/definitely-missing' || git -C ${p} checkout HEAD`, true],
    [`exit 0; git -C ${p} checkout HEAD`, false],
    [`pwsh -Command ${psq(`git -C ${p} checkout HEAD`)}`, true],
    [`powershell -c ${psq(`git -C ${p} checkout HEAD`)}`, true],
    [`bash -c ${psq(`git -C ${q(f.shared)} checkout HEAD`)}`, true],
    ["pwsh", false],
    ["pwsh -Command", false],
    [`Write-Output "ok" > "$(git -C ${p} checkout HEAD)"`, true],
    [`Write-Output $(Write-Output 'quoted )')`, false],
  ]
  for (const [command, deny] of cases) assert.equal((await f.guard(command, { powershell: true })).deny, deny, command)
  assert.equal((await f.guard("sl; git checkout HEAD", { powershell: true, env: { USERPROFILE: f.shared } })).deny, true)
  assert.equal((await f.guard("sl; echo no-home", { powershell: true, env: {} })).deny, false)
  assert.equal((await f.guard("sl '~'; echo no-home", { powershell: true, env: {} })).deny, false)
  assert.equal((await f.guard("echo harmless", { powershell: true, cwd: f.root + "/absent" })).deny, false)
  assert.equal((await f.guard("git -C $(Get-Location) checkout HEAD", { powershell: true, cwd: f.shared })).deny, true)
  for (const command of ["Write-Output >", "(opaque)", "Write-Output $(echo (x))", "Write-Output $(Write-Output `)"]) {
    await assert.rejects(f.guard(command, { powershell: true }), /unresolved|unterminated/u, command)
  }
  const calls = []
  await inspectPowerShell({ command: "Write-Output ok", cwd: f.ordinary, env: {}, visit: (call) => calls.push(call.name) })
  assert.deepEqual(calls, ["write-output"])
})

test("Bash scalar and field expansion preserve empty values, literal dollars and case fallthrough", async (t) => {
  const f = fixture(t), git = `git -C ${q(f.shared)} checkout HEAD`
  for (const [command, deny] of [
    [`case x in x) ${git}; esac`, true],
    [`case x in "$(opaque-command)") ${git};; esac`, true],
    [`case xyz in "x"*) ${git};; esac`, true],
    [`G='  git  -C  ${f.shared}  '; $G checkout HEAD`, true],
    ["echo '$' \"$\" $$", false],
    [`env --chdir /definitely-missing ${git}`, false],
    [`cd -- ${q(f.shared)} && git checkout HEAD`, true],
  ]) assert.equal((await f.guard(command)).deny, deny, command)
  assert.equal((await f.guard("echo harmless", { cwd: f.root + "/absent" })).deny, false)
  const calls = []
  await inspectShell({ command: "G='a  b'; printf '%s' prefix${G}suffix", cwd: f.ordinary, env: f.env, visit: (call) => calls.push(call.args) })
  assert.deepEqual(calls, [["%s", "prefixa", "bsuffix"]])
})

function assertHookDecision(f, command, deny, { cwd = f.ordinary, powershell = false } = {}) {
  const before = f.git(f.shared, "reflog", "--format=%H %gs")
  for (const host of ["claude", "copilot"]) {
    for (const child of [false, true]) {
      const input = host === "claude"
        ? { tool_name: powershell ? "PowerShell" : "Bash", tool_input: { command }, cwd, agent_id: child ? "child" : undefined }
        : { toolName: powershell ? "powershell" : "bash", toolArgs: { command }, cwd, agentId: child ? "child" : undefined }
      const result = spawnSync(process.execPath, [hook, host], { cwd, env: f.env, input: JSON.stringify(input), encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      const output = JSON.parse(result.stdout)
      if (deny) {
        const decision = output.hookSpecificOutput ?? output
        assert.equal(decision.permissionDecision, "deny")
        assert.equal(decision.permissionDecisionReason, WORKTREE_GUIDANCE)
      } else assert.deepEqual(output, {})
    }
  }
  assert.equal(f.git(f.shared, "reflog", "--format=%H %gs"), before, "hook inspection must leave the protected reflog unchanged")
}

function assertDirectCheckout(t, f, command, { cwd = f.ordinary, powershell = false, target = f.shared } = {}) {
  f.git(target, "checkout", "main")
  const before = f.git(target, "reflog", "--format=%H %gs")
  const args = powershell ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : ["--noprofile", "--norc", "-c", command]
  const result = spawnSync(powershell ? "pwsh" : "bash", args, { cwd, env: f.env, encoding: "utf8", timeout: 10000 })
  if (powershell && result.error?.code === "ENOENT") { t.diagnostic("native PowerShell unavailable; hook and interpreter assertions still ran"); return }
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.git(target, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
  assert.notEqual(f.git(target, "reflog", "--format=%H %gs"), before)
}

test("A3-I06 round 2: multiline and empty case forms remain non-applicable in either checkout", async (t) => {
  const f = fixture(t)
  const cases = [
    "case x in\n  x) echo harmless;;\nesac",
    "case x in\nesac",
    "case x in\n\n\t# no arms\n  esac",
    "case x in\n x) echo harmless;;\n\n # end\n esac",
    "case x in\n x) echo harmless\n ;;\n esac",
  ]
  for (const cwd of [f.shared, f.ordinary]) {
    for (const command of cases) {
      assert.equal((await f.guard(command, { cwd })).deny, false, command)
      assertHookDecision(f, command, false, { cwd })
      const actual = spawnSync("bash", ["--noprofile", "--norc", "-c", command], { cwd, env: f.env, encoding: "utf8" })
      assert.equal(actual.status, 0, actual.stderr)
    }
  }
  const mutation = `case x in\n  x) git -C ${q(f.shared)} checkout --detach HEAD;;\nesac`
  assert.equal((await f.guard(mutation)).deny, true)
  assertDirectCheckout(t, f, mutation)
})

test("A3-R1-I01: quoted PowerShell results are data but their executable interpolation is inspected", async (t) => {
  const f = fixture(t)
  for (const command of [
    `"$(git -C ${psq(f.shared)} checkout --detach HEAD)"`,
    `"prefix$(git -C ${psq(f.shared)} checkout --detach HEAD)suffix"`,
  ]) {
    assert.equal((await f.guard(command, { powershell: true })).deny, true, command)
    assertHookDecision(f, command, true, { powershell: true })
    assertDirectCheckout(t, f, command, { powershell: true })
  }
  for (const command of ['"git checkout HEAD"', psq(`$(git -C ${psq(f.shared)} checkout HEAD)`), '"`$(git checkout HEAD)"']) {
    assert.equal((await f.guard(command, { powershell: true })).deny, false, command)
    assertHookDecision(f, command, false, { powershell: true })
  }
})

test("A3-R1-I02: unknown PowerShell status retains both conditional location and variable states", async (t) => {
  const f = fixture(t)
  const command = `git -C ${psq(path.join(f.root, "missing"))} status && Set-Location ${psq(f.ordinary)}; git checkout --detach HEAD`
  assert.equal((await f.guard(command, { cwd: f.shared, powershell: true })).deny, true)
  assertHookDecision(f, command, true, { cwd: f.shared, powershell: true })
  assertDirectCheckout(t, f, command, { cwd: f.shared, powershell: true })
  for (const operator of ["&&", "||"]) {
    const calls = []
    await inspectPowerShell({ command: `external-command ${operator} Set-Location ${psq(f.ordinary)}; git status`, cwd: f.shared, env: f.env, visit: (call) => { if (call.name === "git") calls.push(call.cwd) } })
    assert.deepEqual([...new Set(calls)].sort(), [f.ordinary, f.shared].sort())
    const variable = `$repo=${psq(f.shared)}; external-command ${operator} $repo=${psq(f.ordinary)}; git -C $repo checkout HEAD`
    assert.equal((await f.guard(variable, { powershell: true })).deny, true)
    const multiline = `external-command ${operator}\n Set-Location ${psq(f.ordinary)};\n git checkout HEAD`
    assert.equal((await f.guard(multiline, { cwd: f.shared, powershell: true })).deny, true)
    const environment = `$env:GIT_DIR=${psq(path.join(f.shared, ".git"))}; external-command ${operator} $env:GIT_DIR=${psq(path.join(f.ordinary, ".git"))}; git checkout HEAD`
    assert.equal((await f.guard(environment, { powershell: true })).deny, true)
  }
  assert.equal((await f.guard("\n\nWrite-Output harmless\n\n", { powershell: true })).deny, false)
  assert.equal((await f.guard(`Write-Output ok && Set-Location ${psq(f.ordinary)}; git checkout HEAD`, { cwd: f.shared, powershell: true })).deny, false)
})

test("A3-R1-I03: every leading Bash assignment is scalar before command argument splitting", async (t) => {
  const f = fixture(t, "shared checkout")
  for (const command of [
    `X=${q(f.shared)}; A=1 P=$X; git -C "$P" checkout --detach HEAD`,
    `X=${q(f.shared)}; A=1 B=2 P=$X; git -C "$P" checkout --detach HEAD`,
    `A=${q(f.shared)} P=$A; git -C "$P" checkout --detach HEAD`,
  ]) {
    assert.equal((await f.guard(command)).deny, true, command)
    assertHookDecision(f, command, true)
    assertDirectCheckout(t, f, command)
  }
  const control = `P=${q(f.ordinary)}; X=${q(f.shared)}; A=1 P=$X git -C "$P" checkout --detach HEAD`
  assert.equal((await f.guard(control)).deny, false, "command arguments expand before command-local assignments are applied")
  assertDirectCheckout(t, f, control, { target: f.ordinary })
})

test("A3-R1-I04: case has its own status, including successful unmatched and empty arms", async (t) => {
  const f = fixture(t)
  const git = `git -C ${q(f.shared)} checkout --detach HEAD`
  const cases = [
    [`false; case x in y) echo unreachable;; esac && ${git}`, true],
    [`false; case x in esac && ${git}`, true],
    [`false; case x in x) ;; esac && ${git}`, true],
    [`true; case x in x) false;; esac && ${git}`, false],
    [`true; case x in x) false;; esac || ${git}`, true],
    [`false; case x in y) echo unreachable;; esac || ${git}`, false],
  ]
  for (const [command, deny] of cases) {
    assert.equal((await f.guard(command)).deny, deny, command)
    assertHookDecision(f, command, deny)
    if (deny) assertDirectCheckout(t, f, command)
    else {
      const before = f.git(f.shared, "reflog", "--format=%H %gs")
      spawnSync("bash", ["--noprofile", "--norc", "-c", command], { cwd: f.ordinary, env: f.env, encoding: "utf8" })
      assert.equal(f.git(f.shared, "reflog", "--format=%H %gs"), before)
    }
  }
})

test("A3-R1-I05: only negatable options compete for negative prefixes and ambiguity retains recognized mutation", async (t) => {
  const f = fixture(t)
  for (const option of ["--no-o", "--no-ov", "--no-overlay"]) {
    const command = `git -C ${q(f.shared)} restore --source=HEAD ${option} -- file.txt`
    writeFileSync(path.join(f.shared, "file.txt"), "changed\n")
    assert.equal((await f.guard(command)).deny, true, command)
    assertHookDecision(f, command, true)
    f.git(f.shared, "restore", "--source=HEAD", option, "--", "file.txt")
    assert.equal(readFileSync(path.join(f.shared, "file.txt"), "utf8"), "base\n")
  }
  for (const args of [
    ["--source=HEAD", "--no-o"],
    ["--source=HEAD", "--unrecognized"],
    ["--source=HEAD", "--s"],
    ["--unrecognized", "--source=HEAD"],
  ]) assert.equal(inspectGitOptions("restore", args).enabled, true, args.join(" "))
  assert.equal(inspectGitOptions("restore", ["--source=HEAD", "--no-source"]).enabled, false)
  assert.equal((await f.guard(`git -C ${q(f.shared)} branch --format --no-o`)).deny, false)
})
