// Replay ruling, 2026-09-27: PowerShell Git that earlier reviews expected to pass is allowed. Git inside groups,
// subexpressions, script blocks, control statements, functions and `& git` runs as its own statement under the same
// policy; a group's value is its static answer or one unknown value; and code Desk cannot read passes unless its readable
// text names Git. The rows are written for this test, one or more per group of the replay report, and the denied rows
// show the safety contract still holds: Git that moves HEAD off the state branch, rewrites pushed history or discards
// work is denied in a protected checkout, and nothing is denied in an ordinary one.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { guardShellCommand, protectCheckout } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout.js"
import { MESSAGES } from "../../../../../plugins/desk/mcp/src/runtime/git-guard-policy.js"
import { removeFixtureAfter } from "../_process_hygiene.js"

async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-guard-pwsh-allow-")))
  removeFixtureAfter(t, root)
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "F", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "F", GIT_COMMITTER_EMAIL: "f@example.invalid" }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS|GLOBAL))/u.test(key)) delete env[key]
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env, stdio: "ignore" })
  const origin = path.join(root, "origin.git"), prot = path.join(root, "prot"), ord = path.join(root, "ord")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env })
  execFileSync("git", ["init", "-q", "-b", "main", prot], { env })
  writeFileSync(path.join(prot, "file.txt"), "base\n")
  git(prot, "add", "file.txt"); git(prot, "commit", "-qm", "first"); git(prot, "branch", "topic")
  git(prot, "remote", "add", "origin", origin); git(prot, "push", "-q", "-u", "origin", "main")
  execFileSync("git", ["clone", "-q", origin, ord], { env })
  await protectCheckout({ root: prot, stateBranch: "main" })
  return { prot, ord, guard: (command, cwd) => guardShellCommand({ command, cwd, env, powershell: true }) }
}

const ALLOWED = [
  // `& git` and a quoted program after `&` are Git.
  "& git status", "& 'git' log -1 --oneline",
  // Read-only Git nested in assignments, strings and groups.
  "$branch = git branch --show-current; Write-Output $branch", 'Write-Output "on $(git branch --show-current)"',
  "git log --oneline (git rev-parse --abbrev-ref HEAD) -1",
  // Moving to the top level Git reports keeps Desk's knowledge of the checkout.
  "$top = git rev-parse --show-toplevel; Set-Location $top; git status", "Push-Location (git rev-parse --show-toplevel); git status; Pop-Location",
  // Control flow, loops, functions and try blocks run their Git as statements.
  "if (git status --porcelain) { Write-Output dirty }", "foreach ($f in git diff --name-only) { Write-Output $f }",
  "function Show-State { git status --short }; Show-State", "try { git fetch origin } catch { Write-Output $_ }",
  // A worktree added at an unknown path creates a new checkout and moves no HEAD.
  "$wt = Join-Path $env:TEMP x; git worktree add $wt topic",
  // Git inside a quoted script, and code read from a file Desk cannot see.
  `pwsh -Command '"$(git -C /definitely-missing-pwsh-allow status)"; Write-Output "x=$?"'`,
  `pwsh -NoProfile -Command "Get-Content x.ps1 | Out-Null; [scriptblock]::Create((Get-Content -Raw x.ps1)) | Out-Null; Write-Output 'ok'"`,
]

test("replay ruling: PowerShell Git in groups, calls and control flow passes in protected and ordinary checkouts", async (t) => {
  const f = await fixture(t)
  for (const command of ALLOWED) {
    for (const cwd of [f.prot, f.ord]) assert.equal((await f.guard(command, cwd)).deny, false, `${command} in ${cwd}`)
  }
})

test("replay ruling: nested Git that moves HEAD, rewrites pushed history or discards work is still denied", async (t) => {
  const f = await fixture(t)
  for (const [command, message] of [
    ["& git checkout topic", /this would move HEAD off/u], ["Invoke-Command { git checkout topic }", /this would move HEAD off/u],
    ['iex "git checkout topic"', /this would move HEAD off/u], ["function Go { git checkout topic }; Go", /this would move HEAD off/u],
    ["$null = $(git checkout topic)", /this would move HEAD off/u], ["try { git stash } finally { Write-Output done }", MESSAGES.stash],
    ["if ($true) { git push --force origin main }", /force, mirror and prune pushes/u],
    // A group used as a Git operand takes its most dangerous reading.
    ["git switch (Get-Content b.txt)", MESSAGES.variable], ["git reset --hard (Get-Content c.txt)", MESSAGES.variable],
    ["git branch -D (Get-Content b.txt)", MESSAGES.variable], ["git worktree remove (Get-Content w.txt)", /git worktree remove/u],
  ]) {
    const decision = await f.guard(command, f.prot)
    assert.equal(decision.deny, true, command)
    if (typeof message === "string") assert.equal(decision.reason, `Desk protected checkout ${f.prot}: ${message}`, command)
    else assert.match(decision.reason, message, command)
    assert.equal((await f.guard(command, f.ord)).deny, false, `${command} in the ordinary checkout`)
  }
})

test("replay ruling: edge forms of groups, subexpressions and piped scripts", async (t) => {
  const f = await fixture(t)
  for (const [command, deny] of [
    // Text that does not parse falls back to the operation it names (a read passes, a HEAD move does not).
    ['git log "a$(b"', false], ["git log (git rev-parse HEAD", false], ['git checkout "$(a"', true],
    // A subexpression the tokenizer closes but PowerShell does not (an escaped `)`) keeps its `$`, so it is code.
    ['git log "$(a`)"', true],
    // Text PowerShell cannot parse runs nothing; its statements fall back to the operation it names.
    ["git log ({)", false], ["git log (git status }", false], ['git log "$(})"', false], ['git checkout "$(})"', true],
    // Member access on a group is not a plain argument.
    ["git log (Get-Item x).Name", true], ["git log @(Get-Item x)[0]", true],
    // A group whose statements do not parse, or that are not one plain Git command, yields one unknown value.
    ["git log --format (&) -1", false], ["git log --format (git status; git log) -1", false],
    // A string with more parts, or an unquoted word, piped into a shell is not a literal script Desk reads.
    ["'git stash'x | bash", false], ["hello | bash", false],
    // A computed program or file with readable text that runs code is denied; without it, it passes.
    ["Start-Process $x -ArgumentList iex", true], [". $x eval", true], ["Start-Process $x -ArgumentList notepad", false],
  ]) {
    const decision = await f.guard(command, f.prot)
    assert.equal(decision.deny, deny, `${command}: ${decision.reason}`)
  }
})
