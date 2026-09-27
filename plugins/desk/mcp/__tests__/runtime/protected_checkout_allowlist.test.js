// A3b fix round 4 (controller ruling after re-review 3): PowerShell Git runs only in a closed set of plain forms,
// one step and time budget bounds every inspection, a script piped or redirected into a shell that Desk cannot read
// literally fails closed, and a created tag counts unless a local branch has its name. Rows marked in comments are
// re-review 3's findings (S1 to S6); where a native interpreter is installed, the denied forms are run for real to
// prove they would have changed the protected checkout.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { guardShellCommand, protectCheckout } from "../../src/runtime/protected-checkout.js"
import { MESSAGES } from "../../src/runtime/git-guard-policy.js"
import { inspectionBudget, INSPECTION_STEPS, mergedValue, namesGit, UNKNOWN, UNKNOWN_GIT, WORKTREE_COMMAND } from "../../src/runtime/guard-unknowns.js"
import { inspectPowerShell, POWERSHELL_GIT_FORMS } from "../../src/runtime/powershell-commands.js"
import { expandBraces, inspectShell, shellScript } from "../../src/runtime/shell-commands.js"

const plugin = fileURLToPath(new URL("../../../", import.meta.url))
const hook = path.join(plugin, "hooks", "protected-checkout.cjs")
const q = (text) => `'${text.replaceAll("'", "'\\''")}'`
const psq = (text) => `'${text.replaceAll("'", "''")}'`
const pwsh = !spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).error

// A bare origin, a protected clone on main (state branch main) with a local branch `topic`, an ordinary clone, and a
// protected linked worktree of the ordinary clone holding an unsaved file.
async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-guard-allowlist-")))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const home = path.join(root, "home")
  mkdirSync(home)
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n")
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS|GLOBAL))/u.test(key)) delete env[key]
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const origin = path.join(root, "origin.git"), prot = path.join(root, "prot"), own = path.join(root, "own"), pwt = path.join(root, "pwt")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env })
  execFileSync("git", ["init", "-q", "-b", "main", prot], { env })
  writeFileSync(path.join(prot, "file.txt"), "base\n")
  git(prot, "add", "file.txt"); git(prot, "commit", "-qm", "first")
  git(prot, "branch", "topic")
  git(prot, "remote", "add", "origin", origin)
  git(prot, "push", "-q", "-u", "origin", "main", "topic")
  execFileSync("git", ["clone", "-q", origin, own], { env })
  git(own, "worktree", "add", "-q", "--detach", pwt, "HEAD")
  const saved = process.env.HOME
  process.env.HOME = home
  try {
    await protectCheckout({ root: prot, stateBranch: "main" })
    await protectCheckout({ root: pwt })
  } finally { process.env.HOME = saved }
  writeFileSync(path.join(pwt, "unsaved.txt"), "unsaved\n")
  return {
    root, env, git, origin, prot, own, pwt,
    guard: (command, { cwd = prot, powershell = true, ...extra } = {}) => guardShellCommand({ command, cwd, env, powershell, ...extra }),
  }
}

function real(f, shell, command, cwd) {
  const args = shell === "pwsh" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : ["--noprofile", "--norc", "-c", command]
  return spawnSync(shell, args, { cwd, env: f.env, encoding: "utf8", timeout: 60000 })
}

test("round 4: PowerShell Git runs only as git <args>, $name = git <args> or git <args> piped to a read-only cmdlet", async (t) => {
  const f = await fixture(t)
  const allow = [
    "git status", "git.exe status", "/usr/bin/git status --short", "git status --porcelain 2>&1", "git log -1 > $null",
    "$s = git status --porcelain; if ($s) { Write-Output 'dirty' }",
    "$x = git status", "$x=git status", "$x =git status", "$x= git status", "$null = git fetch -q",
    "git log -1 --format=%H | Out-String", "$h = git log -1 --format=%H | Out-String", "git log --oneline | Select-Object -First 3",
    "git status --porcelain | Where-Object { $_ -match '^ M' } | ForEach-Object { $_.Substring(3) }", "git log | Select-String fix",
    "git diff --name-only | Measure-Object", "git branch | Sort-Object", "git fetch -q | Out-Null", "git status | Write-Output", "git log | % { $_ } | ? { $_ }",
    "git add -A; git commit -q -m 'x'; git pull -q --rebase origin main; git push -q origin main",
    "git add -A\ngit commit -q -m x\ngit push -q origin main", "git tag v2 && git push -q origin v2", "git fetch -q || Write-Output offline",
    "$m = 'note'; git commit -q --allow-empty -m $m", 'git commit -q --allow-empty -m "note ${m}: $env:HOME"', "git log -1 --format='%h %s'",
    "$b = git branch --show-current; git push -q origin $b", "git -C $unknownRepo status", "git log --format=%h,%s", "git log user@host",
    "$wt = Join-Path $env:TMPDIR 'x'; Write-Output $wt",
  ]
  for (const command of allow) {
    const result = await f.guard(command)
    assert.equal(result.deny, false, `${command}: ${result.reason}`)
  }
  const forms = [
    "& git status", ". git status", "(git status)", "$(git status)", "@(git status)", "{ git status }", "$a = @('status'); git @a",
    "git status | bash", "git diff | Out-File patch.diff", "git log | ForEach-Object { git show $_ }", "git status | ForEach-Object { 'git' }",
    "if ($x) { git status }", "foreach ($f in 1) { git status }", "while ($false) { git status }", "try { git status } catch { }",
    "switch (1) { 1 { git status } }", "function g { git status }", "$b = { git status }", "Invoke-Command { git status }",
    "Start-Process git -ArgumentList 'status'", "Invoke-Expression 'git status'", "iex 'git status'", "[scriptblock]::Create('git status')",
    "'git status' | pwsh -NoProfile -Command -", "$env:X = git status", "[string]$x = git status", "$script:x = git status", "${x} = git status",
    "$x.y = git status", "$x += git status", "$a, $b = git status", 'git commit -m "wip $(Get-Date)"', "git log '%h'x", "git --% status",
    "git push origin 'main'--force", "Write-Host 'git'", "git status &", "| git status", "git status |", "gIt status | Out-File x", "pwsh -c git status",
    "git -C (Get-Location) status", "git -C $pwd.Path status", "git status $x[0]", "git show HEAD@{1}", "git log `$(x)",
  ]
  for (const command of forms) assert.equal((await f.guard(command)).reason, POWERSHELL_GIT_FORMS, command)
  // Narrowed 2026-09-27: an unprotected checkout never gets the allowlist denial, unless the text could reach another checkout.
  assert.equal((await f.guard("(git status)", { cwd: f.own })).deny, false)
  assert.equal((await f.guard(`(git -C ${psq(f.prot)} status)`, { cwd: f.own })).reason, POWERSHELL_GIT_FORMS)
  assert.equal((await f.guard("(git --git-dir x status)", { cwd: f.own })).reason, POWERSHELL_GIT_FORMS)
  assert.equal(namesGit("Write-Output 'g`it'"), true)
  assert.equal(namesGit("Get-Content .git/config; cd github"), false)
})

test("round 4 S1: @( ) arguments and attribute script blocks cannot carry Git past the guard", async (t) => {
  const f = await fixture(t)
  const rows = [
    [`git -C @(Join-Path ${psq(f.root)} 'prot') stash`, f.own],
    [`git worktree remove --force @(${psq(f.pwt)})`, f.own],
    [`git worktree remove --force @(Join-Path ${psq(f.root)} 'pwt')`, f.own],
    [`git worktree remove --force @(Join-Path ${psq(f.root)} 'pwt')`, f.prot],
    ["[ValidateScript({ $true })][string]$x = git stash", f.prot],
    [`$script:a = @('stash'); git @script:a`, f.prot],
  ]
  for (const [command, cwd] of rows) assert.equal((await f.guard(command, { cwd })).reason, POWERSHELL_GIT_FORMS, command)
  // Outside Git, @( ) is one unknown value (PowerShell itself rejects an array as a location).
  assert.match((await f.guard(`Set-Location @(${psq(f.prot)}); git stash`, { cwd: f.own })).reason, /could not resolve which checkout/u)
  // A non-Git statement's attribute script block still runs its location change.
  assert.equal((await f.guard(`[ValidateScript({ Set-Location ${psq(f.prot)}; $true })][string]$x = 'a'; git stash`, { cwd: f.own })).deny, true)
  assert.equal((await f.guard("[ValidateScript({ $true })][string]$x = 'a'; git status")).deny, false)
  // An assignment whose leading words cannot be balanced is unparseable, and denied only because it names a Git
  // operation a rule could deny.
  assert.equal((await f.guard("[a(]$x = 1)")).deny, false)
  assert.equal((await f.guard("[a(]$x = 1); git status")).deny, false)
  assert.match((await f.guard("[a(]$x = 1); git stash")).reason, /could not inspect this shell command \(unresolved PowerShell expression\)/u)
  // A Windows path to git.exe counts as naming Git when the text cannot be inspected.
  assert.match((await f.guard("Set-Location -PassThru x; C:\\Tools\\Git\\cmd\\git.exe stash")).reason, /could not inspect this shell command \(unresolved PowerShell location parameter\)/u)
  if (!pwsh) { t.diagnostic("native PowerShell unavailable; decisions still checked"); return }
  writeFileSync(path.join(f.prot, "file.txt"), "another session's edit\n")
  real(f, "pwsh", rows[0][0], f.own)
  assert.notEqual(f.git(f.prot, "stash", "list"), "", "the @( ) directory reached the protected checkout")
  real(f, "pwsh", rows[1][0], f.own)
  assert.equal(existsSync(f.pwt), false, "the protected worktree and its unsaved file were removed")
})

test("round 4 S5: subexpressions, background jobs, loops, launchers and opaque setters leave what they change unknown", async (t) => {
  const f = await fixture(t)
  const deny = [
    `$null = $(Set-Location ${psq(f.prot)}); git stash`, `Write-Output "$(Set-Location ${psq(f.prot)})"; git stash`,
    `$d = ${psq(f.own)}; foreach ($d in @(${psq(f.prot)})) { Set-Location $d }; git stash`,
    `function go($d) { Set-Location $d }; go ${psq(f.prot)}; git stash`, `& { Set-Location ${psq(f.prot)} }; git stash`,
    `iex ${psq(`Set-Location ${psq(f.prot)}`)}; git stash`, `[scriptblock]::Create(${psq(`Set-Location ${psq(f.prot)}`)}).Invoke(); git stash`,
    `$r = ${psq(f.own)}; Set-Variable r ${psq(f.prot)}; git -C $r stash`, `$r = ${psq(f.own)}; Write-Output x -OutVariable r; git -C $r stash`,
    `Set-Item env:GIT_DIR ${psq(path.join(f.prot, ".git"))}; git stash`, `$r = ${psq(f.own)}; $r, $s = ${psq(f.prot)}, 1; git -C $r stash`,
    `$r = ${psq(f.own)}; [ValidateNotNull()][string]$r = (Get-Content x); git -C $r stash`, `$r = ${psq(f.own)}; $r++; git -C $r stash`,
    `Set-Alias go Set-Location; go ${psq(f.prot)}; git stash`, `$x = -join ('g', 'i', 't'); Set-Alias -Name g -Value $x; Set-Location ${psq(f.prot)}; g stash`,
  ]
  for (const command of deny) assert.equal((await f.guard(command, { cwd: f.own })).deny, true, command)
  // From the protected checkout, a location change that may not happen leaves it unknown.
  for (const command of [`Set-Location ${psq(f.own)} &; git stash`, `if ($c) { Set-Location ${psq(f.own)} }; git stash`, `external || Set-Location ${psq(f.own)}; git stash`]) {
    assert.match((await f.guard(command)).reason, /could not resolve which checkout/u, command)
  }
  for (const [command, reason] of [
    ["Start-Process $x", /could not resolve the program this command runs/u], ["[scriptblock]::Create($x)", /evaluates/u],
    ["pwsh -EncodedCommand ZQBjAGgAbwA=", /encoded script/u], ["Get-Content s.ps1 | pwsh", /reads from its input/u],
    ["Get-Content s.sh | bash", /reads from its input/u], ["Write-Output 'echo hi' | bash", /reads from its input/u],
    ['"echo $x" | bash', /reads from its input/u], ["[scriptblock]::Create('Set-' + 'Location x')", /evaluates/u],
    ["& (eval x) status", /could not resolve the program this command runs/u], ["& $p iex", /could not resolve the program this command runs/u],
  ]) assert.match((await f.guard(command)).reason, reason, command)
  // A hashtable entry's value runs, and a prefix increment changes its variable.
  assert.equal((await f.guard(`$h = @{ a = $(Set-Location ${psq(f.prot)}); b=1; c= 2 }; git stash`, { cwd: f.own })).reason, `Desk protected checkout ${f.prot}: ${MESSAGES.stash}`)
  assert.equal((await f.guard(`$r = ${psq(f.own)}; ++$r; git -C $r stash`, { cwd: f.own })).deny, true)
  for (const command of [
    "'echo hi' | bash", "Start-Process notepad", "Write-Output ok &", `Set-Location ${psq(f.own)}; git stash`, "bash -c 'echo ok'",
    "pwsh -NoProfile -File s.ps1", "pwsh", "pwsh -Command", "$n = 0; $n++; Write-Output $n", "for ($i = 0; $i -lt 3; $i++) { Write-Output $i }",
    '"echo hi" | bash', "$h = @{ a = 1; b=2; c= 3; d =4 }", "$x = $null; Write-Output $true $false \"x$null\" $pwd", "git log -1 $null",
    `git -C $pwd status; pwsh -wd ${psq(f.own)} -c 'Write-Output hi'; pwsh -wd '/definitely-missing' -c 'Write-Output hi'`, "exit | Write-Output x",
    "; Write-Output a", "function f { Write-Output x }; f",
  ]) {
    const result = await f.guard(command)
    assert.equal(result.deny, false, `${command}: ${result.reason}`)
  }
  // A literal script piped into PowerShell's -Command - is inspected as PowerShell; a working directory moves it.
  assert.equal((await guardShellCommand({ command: `pwsh -wd ${q(f.prot)} -c 'git stash'`, cwd: f.own, env: f.env })).reason, `Desk protected checkout ${f.prot}: ${MESSAGES.stash}`)
  assert.match((await guardShellCommand({ command: `pwsh -WorkingDirectory "$(pick)" -c 'git stash'`, cwd: f.own, env: f.env })).reason, /could not resolve which checkout/u)
  assert.match((await guardShellCommand({ command: "pwsh -wd /definitely-missing -c 'git stash'", cwd: f.own, env: f.env })).reason, /could not resolve which checkout/u)
  assert.equal((await guardShellCommand({ command: "pwsh -c git stash", cwd: f.prot, env: f.env })).reason, `Desk protected checkout ${f.prot}: ${MESSAGES.stash}`)
  if (!pwsh) return
  for (const command of deny.slice(0, 2)) {
    const run = await fixture(t)
    writeFileSync(path.join(run.prot, "file.txt"), "another session's edit\n")
    real(run, "pwsh", command.replaceAll(f.root, run.root), run.own)
    assert.notEqual(run.git(run.prot, "stash", "list"), "", `${command} stashes when run`)
  }
})

test("round 4: an unknown PowerShell variable argument takes its most dangerous reading", async (t) => {
  const f = await fixture(t)
  const variable = `Desk protected checkout ${f.prot}: ${MESSAGES.variable}`
  for (const command of [
    "$x = Get-Content f; git commit $x", "$x = Get-Content f; git push origin main $x", "$x = Get-Content f; git branch $x topic",
    "$x = Get-Content f; git merge --ff-only $x", 'git commit "--$x"', "git worktree list $x",
  ]) assert.equal((await f.guard(command)).reason, variable, command)
  // An unknown victim is checked against every worktree of the repository; both of these have a protected one.
  assert.equal((await f.guard("git worktree remove $wt")).reason, `Desk protected checkout ${f.prot}: ${MESSAGES.worktreeRemove}`)
  assert.equal((await f.guard("git worktree remove $wt", { cwd: f.own })).reason, `Desk protected checkout ${f.pwt}: ${MESSAGES.worktreeRemove}`)
  for (const [command, cwd] of [
    ["$x = Get-Content f; git commit $x", f.own], ["$m = Get-Content f; git commit -q --allow-empty -m $m", f.prot], ["git checkout -- $f", f.prot],
    ["git add $files", f.prot], ["$x = Get-Content f; git status $x", f.prot], ["git worktree add --detach $wt HEAD", f.own],
  ]) {
    const result = await f.guard(command, { cwd })
    assert.equal(result.deny, false, `${command}: ${result.reason}`)
  }
  // Bash keeps its earlier reading: an unknown word is one operand.
  assert.equal((await f.guard('git commit -q --allow-empty "$(cat f)"', { powershell: false })).deny, false)
})

test("round 4 S2: one step and time budget bounds all inspection, and the hook's deadline can always fire", async (t) => {
  const f = await fixture(t)
  // Re-review 3's explosion: each `if` assigning its own variable used to double the tracked states.
  const forks = (n) => Array.from({ length: n }, (_, i) => `if ($env:A${i}) { $v${i} = 1 }`).join("\n")
  for (const [command, deny] of [[`${forks(40)}\ngit status`, false], [`${forks(40)}\ngit stash`, true]]) {
    const started = Date.now()
    assert.equal((await f.guard(command)).deny, deny, command.slice(-10))
    assert.ok(Date.now() - started < 3000, `decided in ${Date.now() - started} ms`)
  }
  const bashForks = (n) => Array.from({ length: n }, (_, i) => `if [ -n "$A${i}" ]; then v${i}=1; fi`).join("\n")
  for (const [command, deny] of [[`${bashForks(40)}\ngit status`, false], [`${bashForks(40)}\ngit stash`, true], [`d=${q(f.own)}\n${bashForks(20)}\nif [ -n "$B" ]; then d=${q(f.prot)}; fi\ncd "$d" && git stash`, true]]) {
    const started = Date.now()
    assert.equal((await f.guard(command, { powershell: false, cwd: command.includes("cd ") ? f.own : f.prot })).deny, deny, command.slice(-24))
    assert.ok(Date.now() - started < 3000, `decided in ${Date.now() - started} ms`)
  }
  // Merged states keep a candidate that could be Git as could-be-Git.
  assert.equal(mergedValue("git", "ls"), UNKNOWN_GIT)
  assert.equal(mergedValue("a", undefined), UNKNOWN)
  assert.equal((await f.guard(`if [ -n "$C" ]; then g=git; else g=ls; fi\n${bashForks(20)}\n$g stash`, { powershell: false })).reason, `Desk protected checkout ${f.prot}: ${MESSAGES.stash}`)
  assert.match((await f.guard(`if [ -n "$C" ]; then cd ${q(f.own)}; fi\n${bashForks(20)}\ngit stash`, { powershell: false })).reason, /could not resolve which checkout/u)
  // Running out of steps or time denies with a reason that names the budget.
  await assert.rejects(inspectPowerShell({ command: forks(3), cwd: f.prot, env: f.env, visit() {}, budget: inspectionBudget({ steps: 5 }) }), /stopped inspecting this shell command after 5 steps/u)
  let clock = 0
  const budget = inspectionBudget({ deadline: 10, now: () => clock++, budgetMs: 7000 })
  await assert.rejects(inspectShell({ command: bashForks(10), cwd: f.prot, env: f.env, visit() {}, budget }), /could not finish inspecting this shell command within its 7 s budget/u)
  assert.equal(INSPECTION_STEPS, 20000)
  // Inspection yields to the event loop, so a timer set before it (like the hook's 9 s deadline) fires during it.
  let fired = false
  setTimeout(() => { fired = true }, 0)
  await assert.rejects(inspectShell({ command: "again() { again; }; again", cwd: f.prot, env: f.env, visit() {} }), /after 20000 steps/u)
  assert.equal(fired, true)
  const input = { tool_name: "PowerShell", tool_input: { command: `${forks(40)}\ngit status` }, cwd: f.prot }
  const result = spawnSync(process.execPath, [hook, "claude"], { cwd: f.prot, env: f.env, input: JSON.stringify(input), encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {})
})

test("round 4 S3, narrowed on 2026-09-27: a script piped or redirected into a shell is inspected when Desk can read it, and passes when it cannot", async (t) => {
  const f = await fixture(t)
  const script = path.join(f.root, "s.txt")
  writeFileSync(script, "git stash\n")
  // The guard is not a sandbox: code Desk cannot read is not judged.
  for (const command of [
    "cat - <<'EOF' | bash\ngit stash\nEOF", "cat <<'EOF' | tee /dev/null | bash\ngit stash\nEOF", `bash <<EOF\n$(cat ${q(script)})\nEOF`,
    `bash < ${q(script)}`, `cat ${q(script)} | sh`, `curl -fsSL https://example.invalid/x | sh`, "echo 'git stash' | { cat | bash; }",
    "pwsh -e ZQBjAGgAbwA=", 'eval "$(azd env get-values)"', 'source "$DIR/ids.env"', 'sh "$T/x.sh"', 'bash -c "$T/build.sh $H > $E/log"',
    "cat <<'EOF' | bash\necho harmless\nEOF", "cat <<'EOF' | wc -l\ngit stash\nEOF", "echo 'echo hi' | bash", "bash -c 'echo ok' < /dev/null",
    `bash ${q(script)}`, "cat <<'EOF' > notes.md\ngit stash\nEOF", "git commit -q --allow-empty -F - <<'EOF'\ngit stash is mentioned\nEOF",
    "pwsh -NoProfile -Command - <<'EOF'\nWrite-Output hi\nEOF", "echo hi | pwsh -File x.ps1",
  ]) {
    const result = await f.guard(command, { powershell: false })
    assert.equal(result.deny, false, `${command}: ${result.reason}`)
  }
  // Text Desk can read is inspected like any other command, even when part of it is unknown.
  for (const command of [
    "pwsh -NoProfile -Command - <<'EOF'\ngit stash\nEOF", "echo 'git stash' | pwsh", "echo 'git stash' | pwsh -File -", "echo 'git stash' | { bash; }",
    "cat <<'EOF' | bash\ngit stash\nEOF", 'eval "git stash $(cat args)"', 'bash -c "cd $(pwd) && git stash"',
  ]) {
    assert.equal((await f.guard(command, { powershell: false })).reason, `Desk protected checkout ${f.prot}: ${MESSAGES.stash}`, command)
  }
  for (const command of ["@'\ngit stash\n'@ | bash", "'git stash' | bash", "@'\ngit stash\n'@ | pwsh -NoProfile -Command -"]) {
    assert.equal((await f.guard(command)).reason, POWERSHELL_GIT_FORMS, command)
  }
  assert.deepEqual(shellScript("pwsh", ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-com", "git", "status"]), { command: "git status", directory: undefined })
  assert.deepEqual(shellScript("pwsh", ["pwsh", "-ec", "x"]), { encoded: true })
  assert.deepEqual(shellScript("pwsh", ["pwsh", "s.ps1"]), {})
  assert.deepEqual(shellScript("pwsh", ["pwsh", "-wd", "/tmp", "-OutputFormat", "Text"]), { stdin: true, directory: "/tmp" })
  assert.deepEqual(shellScript("pwsh", ["pwsh", "-wd"]), { stdin: true, directory: "" })
  assert.deepEqual(shellScript("bash", ["bash", "-o", "pipefail", "-c", "x", "a"]), { command: "x", positional: ["a"] })
})

test("round 4 S6, narrowed on 2026-09-27: a non-force push of any name passes; forcing or deleting does not", async (t) => {
  const f = await fixture(t)
  for (const command of [
    '[ -z "$(git status --porcelain)" ] && git tag v2 && git push -q origin v2', "if git tag v3; then git push -q origin v3; fi",
    'if [ -n "$NOPE" ]; then git tag v4; fi; git push -q origin v4', 'test -n "$NOPE" && git tag topic; git push -q origin topic',
    "git push -q origin topic", "git push -q origin HEAD:other", "git push -q --all", "git push -q origin refs/heads/topic:refs/heads/topic",
  ]) {
    const result = await f.guard(command, { powershell: false })
    assert.equal(result.deny, false, `${command}: ${result.reason}`)
  }
  // Deleting another branch on the remote is cleanup; `:` pushes matching branches without force.
  for (const command of ["git push -q origin :topic", "git push -q origin --delete topic", "git push -q -d origin refs/heads/topic", "git push -q origin :"]) {
    assert.equal((await f.guard(command, { powershell: false })).deny, false, command)
  }
  for (const command of ["git push -q origin +topic", "git push -q origin :main", "git push -q --delete origin main", "git push -q --force origin topic", "git push -q --prune origin"]) {
    assert.equal((await f.guard(command, { powershell: false })).reason, `Desk protected checkout ${f.prot}: ${MESSAGES.pushForce}`, command)
  }
  assert.equal((await f.guard("git tag v6; git push -q origin v6")).deny, false)
  assert.equal((await f.guard("if ($env:NOPE) { git tag v5 }; git push -q origin v5")).reason, POWERSHELL_GIT_FORMS)
})

test("round 4: unknown Git configuration from the environment fails closed for checked operations", async (t) => {
  const f = await fixture(t)
  assert.match((await f.guard('GIT_CONFIG_PARAMETERS="$(cat x)" git push -q origin main', { powershell: false })).reason, /could not resolve the Git configuration this command inherits/u)
  assert.equal((await f.guard('GIT_CONFIG_PARAMETERS="$(cat x)" git status', { powershell: false })).deny, false)
  assert.match((await f.guard(`Set-Item env:GIT_CONFIG_PARAMETERS "'remote.origin.mirror'"; git push -q origin main`)).reason, /unresolved Git location/u)
})

// Coordinator ruling (2026-09-27): on a desk checkout's state branch, the desk's ordinary writes pass, and only denials
// of a real HEAD move, a rewrite of the shared branch or discarded work send an agent to a worktree.
test("round 4: ordinary desk writes pass on the state branch, and only HEAD moves or discards name a worktree", async (t) => {
  const f = await fixture(t)
  writeFileSync(path.join(f.prot, "note.md"), "note\n")
  const writes = [
    "git status", "git add -A", "git add note.md", "git commit -q -m note", "git commit -q -m note -- note.md", "git fetch -q origin",
    "git pull -q --rebase origin main", "git pull -q --rebase", "git pull -q", "git pull -q --ff-only", "git pull -q origin main",
    "git rebase", "git rebase origin/main", "git rebase @{upstream}", "git rebase --continue", "git rebase --abort", "git merge --ff-only origin/main",
    "git merge --abort", "git push -q", "git push -q origin main", "git push -q origin HEAD:main", "git push -q -u origin main", "git push -q origin HEAD",
    "git rm -q --cached note.md", "git mv note.md note2.md", "git restore note.md", "git switch main", "git checkout main",
    "git tag v9", "git tag v9 && git push -q origin v9", "git branch -u origin/main", "git worktree add -q --detach ../wt HEAD",
  ]
  for (const command of writes) {
    for (const powershell of [false, true]) {
      // PowerShell reads an unquoted @{ } as a hashtable, so the upstream shorthand is quoted there.
      const result = await f.guard(powershell ? command.replace("@{upstream}", "'@{upstream}'") : command, { powershell })
      assert.equal(result.deny, false, `${powershell ? "PowerShell" : "Bash"} ${command}: ${result.reason}`)
    }
  }
  assert.equal((await f.guard(writes.join("; ").replace("@{upstream}", "'@{upstream}'"), { powershell: true })).deny, false)
  assert.equal((await f.guard(writes.join(" && "), { powershell: false })).deny, false)

  // Bash braces are reserved words only as whole words; a brace expansion is expanded as text, as Bash does.
  for (const [command, deny] of [
    ["git log -1 HEAD@{1}", false], ["git rebase main@{u}", false], ["{ git status; }", false], ["{ git status;}", false], ["echo a} b{", false],
    ["{ git checkout topic; }", true], ["git switch {topic,}", true], ["git checkout top{ic}", false], ["echo {1..3}", false],
    ["git add src/{a,b}.js", false], ["mkdir -p x/{a,b} && git status", false], ["wc -l src/{a,b}.js; git status", false],
    ["for i in {1..40}; do git log -1 --oneline; done", false], ["git checkout {topic,main}", false], ["git stash {push,pop}", true],
  ]) assert.equal((await f.guard(command, { powershell: false })).deny, deny, command)
  assert.deepEqual(expandBraces("a{b,{c,d}}e{1..3..2}"), ["abe1", "abe3", "ace1", "ace3", "ade1", "ade3"])
  assert.deepEqual(expandBraces("{01..03}{a..b}"), ["01a", "01b", "02a", "02b", "03a", "03b"])
  assert.deepEqual(expandBraces("{3..1}{z..y}{,x}{a}"), ["3z{a}", "3zx{a}", "3y{a}", "3yx{a}", "2z{a}", "2zx{a}", "2y{a}", "2yx{a}", "1z{a}", "1zx{a}", "1y{a}", "1yx{a}"])
  assert.throws(() => expandBraces("{1..100000}"), /too large/u)
  assert.throws(() => expandBraces("{1..70}{1..70}"), /too large/u)
  // A brace word that mixes quotes or substitutions is not expanded; the command is then judged by the Git it names.
  assert.match((await f.guard('git checkout {"$x",main}', { powershell: false })).reason, /unresolved brace expansion.*git checkout could change/u)
  assert.equal((await f.guard('echo {"$x",main}; git status', { powershell: false })).deny, false)

  // Every policy message, with a sample argument where it takes one: only these name the worktree command.
  const texts = Object.fromEntries(Object.entries(MESSAGES).map(([key, text]) => [key, typeof text === "function" ? text("remote.origin.url", "push") : text]))
  const worktree = ["leave", "discard", "rewind", "branch", "rebase", "pull"]
  assert.deepEqual(Object.keys(texts).filter((key) => texts[key].includes(WORKTREE_COMMAND)).sort(), [...worktree].sort())
  for (const key of Object.keys(texts).filter((name) => !worktree.includes(name))) assert.doesNotMatch(texts[key], /worktree add/u, key)
  // Fail-closed denials can meet an ordinary write phrased in an unusual way, so none of them names a worktree.
  const budget = inspectionBudget({ steps: 0 })
  await assert.rejects(budget.step(), (error) => !/worktree/u.test(error.reason))
  const late = inspectionBudget({ deadline: 0, now: () => 1, budgetMs: 7000 })
  await assert.rejects(late.step(), (error) => !/worktree/u.test(error.reason))
  assert.doesNotMatch(POWERSHELL_GIT_FORMS, /worktree/u)
  assert.doesNotMatch(readFileSync(hook, "utf8").match(/permissionDecisionReason: "([^"]*)/u)[1], /worktree/u)
  for (const [command, powershell] of [
    ["git push origin (git branch --show-current)", true], ["$w = Get-Random; git commit -q $w", true], ["git stash; &", true],
    ['git -C "$(pick)" stash', false], ["git stash (", true], ["git checkout 'x", false],
  ]) {
    const { deny, reason } = await f.guard(command, { powershell })
    assert.equal(deny, true, command)
    assert.doesNotMatch(reason, /worktree/u, `${command}: ${reason}`)
  }
  // Unparseable text naming no denied Git operation, and unreadable code, pass (2026-09-27).
  for (const [command, powershell] of [["git status; &", true], ["git status (", true], ['eval "$(cat x)"', false], ["git commit -m 'x", false]]) {
    assert.equal((await f.guard(command, { powershell })).deny, false, command)
  }
  // An ordinary desk write aimed at a computed checkout is safe in any checkout, so it passes (2026-09-27).
  assert.equal((await f.guard('git -C "$(pick)" push -q origin main', { powershell: false })).deny, false)
  // Real HEAD moves and discards still name it.
  for (const command of ["git checkout topic", "git reset --hard", "git switch -c other", "git rebase --onto topic main"]) {
    assert.ok((await f.guard(command, { powershell: false })).reason.endsWith(WORKTREE_COMMAND), command)
  }

  // Without an upstream of <remote>/<state branch>, pull and rebase ask for one instead of a worktree.
  f.git(f.prot, "branch", "--unset-upstream")
  for (const command of ["git pull -q --rebase origin main", "git rebase origin/main"]) {
    assert.equal((await f.guard(command, { powershell: false })).reason, `Desk protected checkout ${f.prot}: ${MESSAGES.noUpstream}`, command)
  }
  // The suggested git branch -u passes (it is among the writes above); once it has run, the pull passes.
  f.git(f.prot, "branch", "-u", "origin/main")
  assert.equal((await f.guard("git pull -q --rebase origin main", { powershell: false })).deny, false)

  // The worktree command runs as written in both shells, passes both guards and leaves the checkout on its branch.
  for (const [shell, name] of [["bash", "wt-bash"], ["pwsh", "wt-pwsh"]]) {
    const command = WORKTREE_COMMAND.replace("<new directory>", name).replace("<ref>", "HEAD")
    assert.equal((await f.guard(command, { powershell: shell === "pwsh" })).deny, false, command)
    if (shell === "pwsh" && !pwsh) continue
    const run = real(f, shell, command, f.prot)
    assert.equal(run.status, 0, run.stderr)
    assert.ok(existsSync(path.join(f.env.HOME, name, "file.txt")))
  }
  assert.equal(f.git(f.prot, "symbolic-ref", "--short", "HEAD"), "main")
})

test("round 4, 2026-09-27: the PowerShell allowlist never fires where the statement can only reach an unprotected checkout", async (t) => {
  const f = await fixture(t)
  const own = (command, extra = {}) => f.guard(command, { cwd: f.own, ...extra })
  // Every assignment form in an unmodeled statement leaves its variable unknown, and later Git use of it is judged as such.
  for (const command of ["${a} = (git status); git status", "$b += (git status); git status", "[void](++$c + (git log -1))", "[void](++${d} + (git log -1))"]) {
    assert.equal((await own(command)).deny, false, command)
  }
  assert.equal((await own("$b = (git branch --show-current); git -C $b stash")).deny, true, "the unmodeled assignment leaves $b unknown")
  // Anything that could move where Git runs keeps the allowlist denial, even from an unprotected checkout.
  for (const command of [`(git -C ${psq(f.prot)} status)`, "(git --git-dir x status)", `(git worktree list)`, `Set-Location ${psq(f.prot)}; (git status)`, "$env:GIT_DIR = 'x'; (git status)"]) {
    assert.equal((await own(command)).reason, POWERSHELL_GIT_FORMS, command)
  }
  assert.equal((await own("(git status)", { env: { ...f.env, GIT_WORK_TREE: f.prot } })).reason, POWERSHELL_GIT_FORMS)
  // A checkout whose protection cannot be read is treated as protected.
  const broken = path.join(f.root, "broken")
  execFileSync("git", ["init", "-q", broken], { env: f.env })
  writeFileSync(path.join(broken, ".git", "config"), "[core\n\tbroken = \n")
  assert.equal((await f.guard("(git status)", { cwd: broken })).deny, true)
  // A caller that does not answer the question gets the allowlist denial.
  await assert.rejects(inspectPowerShell({ command: "(git status)", cwd: f.own, env: f.env, visit() {} }), (error) => error.reason === POWERSHELL_GIT_FORMS)
})
