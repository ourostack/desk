// False denials seen in a real Copilot session on Windows (2026-10-01), and the protections that must stay. Git is a
// command only where it is the command name; a bare `git` word in another cmdlet's arguments runs nothing. A quoted
// -C path is literal text. With a checkout Desk cannot resolve, read-only Git (and a fetch into remote-tracking refs)
// passes, and anything that could move HEAD, stash, rewrite or discard is still denied. Denial messages put the fix first.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { unresolved } from "../../../../../plugins/desk/mcp/src/runtime/guard-unknowns.js"
import { fixture, psq } from "./_guard_fixture.js"
import { firstSentence } from "./_guard_text.js"
import { POWERSHELL_GIT_FORMS } from "../../../../../plugins/desk/mcp/src/runtime/powershell-commands.js"

test("Get-Command and Write-* statements that only name git run nothing and are allowed", async (t) => {
  const f = await fixture(t)
  const real = 'Get-Command git,node,yarn,python,agency,az -ErrorAction SilentlyContinue | Select-Object Name,Source; Write-Output "HOST $env:COMPUTERNAME"; Write-Output "SELECTED yes"'
  for (const command of [
    real, "Get-Command git", "gcm git.exe", "Get-Command -Name git -All", "Get-Command git -ErrorAction:Ignore -Syntax", "Get-Command git -CommandType Application | Format-List", "gcm git | Where-Object Source | Out-String",
    "Write-Output git", "Write-Host 'git'", "echo 'git is here'", "Write-Output 'git checkout topic' | Out-String", "Write-Host 'git checkout topic' | Out-Null",
    "Get-Command git; git -C " + psq(f.prot) + " status",
  ]) {
    const result = await f.guard(command)
    assert.equal(result.deny, false, `${command} -> ${result.reason}`)
  }
})

// Every bypass the independent review found, plus the near forms. All run in a protected checkout with a branch `topic`.
test("a statement that names git and could run it stays denied", async (t) => {
  const f = await fixture(t)
  const bypasses = [
    "'git checkout topic' | iex", '"git checkout topic" | Invoke-Expression', "Write-Output 'git checkout topic' | iex", "Write-Output 'git checkout topic' | Invoke-Expression",
    "'git checkout topic' | cmd", "'git checkout topic' | bash", "'git checkout topic' | sh", "Write-Output 'git checkout topic' | cmd", "Write-Output 'git checkout topic' | bash",
    "Write-Output 'git checkout topic' | sh", "Write-Output 'git checkout topic' | pwsh", "Write-Host 'git checkout topic' | powershell", "Write-Host 'git checkout topic' | wsl", "echo 'git checkout topic' | unknown-tool",
    "[Diagnostics.Process]::Start('git','checkout topic')", "[System.Diagnostics.Process]::Start((New-Object System.Diagnostics.ProcessStartInfo('git','checkout topic')))",
    "& (Get-Command git).Source checkout topic", "& (gcm git).Source checkout topic", "(Get-Command git).Source", "$g = (Get-Command git).Source; & $g checkout topic",
    "Set-Item alias:gg git; gg checkout topic", "Set-Content alias:gg git; gg checkout topic", "New-Item -Path alias:gg -Value git; gg checkout topic", "Set-Item -Path alias:gg -Value git; gg checkout topic",
    "Set-Content function:gg 'git checkout topic'; gg", "Start-Process (Get-Command git) -Arg checkout,topic", 'Invoke-Expression "$((Get-Command git).Source) checkout topic"',
    "Set-Content x.ps1 'git checkout topic'; .\\x.ps1", "Start-Process git -ArgumentList 'checkout','topic'", "saps git checkout", "cmd /c git checkout topic", "wsl git checkout topic", "env git checkout topic",
    "Invoke-Command { git checkout topic }", "docker-compose run app git checkout topic", "'git checkout topic'", "Get-Command git | ForEach-Object { & $_.Source checkout topic }",
    "Get-Command git | & { git checkout topic }", "Get-Command git > x.ps1", "Write-Output 'git checkout topic' > x.ps1", "Get-Command (git checkout topic)", "Get-Command git -Name", "Get-Command -Foo git", "Get-Command git -ErrorAction (git checkout topic)", "Get-Command git/x", "Write-Output 'git' |", "Get-Command git |", "Get-Command git | Out-File x", "| Write-Output 'git'", "Get-Command $x git", "Write-Output \"git $x\"",
    ". git checkout topic", "Write-Output x | git checkout topic", "Get-Command git; git checkout topic", "Write-Output git; & git checkout topic",
  ]
  for (const command of bypasses) {
    const result = await f.guard(command)
    assert.equal(result.deny, true, command)
  }
})

test("a single-quoted or double-quoted literal -C path is plain, like an unquoted one", async (t) => {
  const f = await fixture(t)
  for (const quote of [(p) => psq(p), (p) => `"${p}"`, (p) => p]) {
    const where = quote(f.prot)
    const command = `git -C ${where} status --short; git -C ${where} branch --show-current; git -C ${where} fetch --quiet origin`
    const result = await f.guard(command)
    assert.equal(result.deny, false, `${command} -> ${result.reason}`)
  }
  // The same from a checkout that is not the protected one, with a path that only exists as text (a Windows path).
  const windows = "C:\\Users\\arimendelow\\ms-desk"
  assert.equal((await f.guard(`git -C ${psq(windows)} status --short; git -C ${psq(windows)} branch --show-current; git -C ${psq(windows)} fetch --quiet origin`, { cwd: f.own })).deny, false)
  // Quoting does not hide a real move of the protected checkout.
  for (const command of [`git -C ${psq(f.prot)} checkout topic`, `git -C "${f.prot}" checkout topic`, `git -C ${f.prot} checkout topic`]) {
    assert.match((await f.guard(command)).reason ?? "", /move HEAD off/u, command)
  }
})

test("an unresolved checkout passes read-only Git and fails closed on anything that could change HEAD or the work tree", async (t) => {
  const f = await fixture(t)
  const loop = (body) => `$roots = @(${psq(f.prot)}, ${psq(f.own)}); foreach ($r in $roots) { ${body} }`
  const allow = [
    "git -C $r status --short; git -C $r branch --show-current; git -C $r fetch --quiet origin",
    "git -C $r log --oneline -5; git -C $r show HEAD --stat; git -C $r diff --stat; git -C $r rev-parse HEAD; git -C $r remote -v",
    "git -C $r config --get remote.origin.url; git -C $r ls-files; git -C $r describe --tags --always; git -C $r branch; git -C $r branch --list",
    "git -C $r fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*'", "git -C $r fetch --all --prune --tags", "git -C $r stash list", "git -C $r worktree list",
    'Write-Output "== $r"; git -C $r status --short 2>&1 | Out-String',
  ]
  for (const body of allow) {
    for (const command of [loop(body), body.replaceAll("$r", "$unknownRepo")]) {
      const result = await f.guard(command)
      assert.equal(result.deny, false, `${command} -> ${result.reason}`)
    }
  }
  const deny = [
    "git -C $r checkout main", "git -C $r checkout topic", "git -C $r switch topic", "git -C $r stash", "git -C $r stash push -m x", "git -C $r reset --hard",
    "git -C $r push --force origin main", "git -C $r restore .", "git -C $r clean -fd", "git -C $r fetch origin main:main", "git -C $r fetch --update-head-ok origin",
    "git -C $r branch -D topic", "git -C $r status --short; git -C $r checkout main",
  ]
  for (const body of deny) assert.equal((await f.guard(loop(body))).deny, true, body)
  // A fetch into a branch that is not the protected one passes where the checkout is known.
  assert.equal((await f.guard(`git -C ${psq(f.prot)} fetch origin topic:topic`)).deny, false)
  assert.equal((await f.guard(`git -C ${psq(f.prot)} fetch origin main:main`)).deny, true)
  // Bash reads the same rule.
  assert.equal((await f.guard('for r in $(pick-repos); do git -C "$r" status --short; git -C "$r" fetch --quiet origin; done', { powershell: false })).deny, false)
  assert.equal((await f.guard('for r in $(pick-repos); do git -C "$r" checkout main; done', { powershell: false })).deny, true)
})

test("the protections that define the guard still deny", async (t) => {
  const f = await fixture(t)
  const p = psq(f.prot)
  const cases = [
    [`git -C ${p} checkout topic`, /move HEAD off/u], [`git -C ${p} switch topic`, /move HEAD off/u], [`git -C ${p} stash`, /git stash/u],
    [`git -C ${p} reset --hard`, /discard/u], [`git -C ${p} push --force origin main`, /force/u],
    ["git checkout topic", /move HEAD off/u], ["& git checkout topic", /move HEAD off/u], ["git.exe checkout topic", /move HEAD off/u],
    ["& 'C:\\Program Files\\Git\\cmd\\git.exe' checkout topic", /move HEAD off/u], [`& git -C ${p} checkout topic`, /move HEAD off/u],
    ["git stash", /git stash/u], ["git reset --hard", /discard/u], ["git push --force", /force/u], ["$x = git checkout topic", /move HEAD off/u],
    ["Write-Output x; & git stash", /git stash/u],
  ]
  for (const [command, reason] of cases) {
    const result = await f.guard(command)
    assert.equal(result.deny, true, command)
    assert.match(result.reason, reason, command)
  }
})

test("denial messages put the fix in the first line", () => {
  assert.match(POWERSHELL_GIT_FORMS, /^Run each git command as its own plain statement, for example git -C <path> status; git -C <path> fetch\./u)
  assert.ok(firstSentence(POWERSHELL_GIT_FORMS).length <= 120, POWERSHELL_GIT_FORMS)
  const reason = unresolved("which checkout this Git command runs in", "Write the checkout path literally: git -C <path> status. Or cd there in a separate command first.").reason
  assert.match(reason, /^Write the checkout path literally: git -C <path> status/u)
  assert.ok(firstSentence(reason).length <= 120, reason)
})
