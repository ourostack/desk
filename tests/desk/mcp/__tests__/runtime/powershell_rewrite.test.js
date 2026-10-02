// The PowerShell rewrite a denial offers: only for text it reads with certainty, only for a statement that starts with git, and
// only after the guard itself allows the rewritten command.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { fixture } from "./_guard_fixture.js"
import { REWRITE_LINES } from "./_guard_text.js"
import { guardShellCommand } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout.js"
import { rewritePowerShell, splitStatements } from "../../../../../plugins/desk/mcp/src/runtime/powershell-rewrite.js"

test("statements split at ; new lines && and ||, outside quotes and groups", () => {
  assert.deepEqual(splitStatements("a; b\nc && d || e"), [
    { separator: "", text: "a" }, { separator: ";", text: " b" }, { separator: "\n", text: "c " }, { separator: "&&", text: " d " }, { separator: "||", text: " e" },
  ])
  assert.deepEqual(splitStatements("git log 'a;b' \"c;d\" (x; y) { z; w } `; | 'it''s;'").map(({ text }) => text), ["git log 'a;b' \"c;d\" (x; y) { z; w } `; | 'it''s;'"])
  assert.deepEqual(splitStatements("echo \"a`\"; b\" ; x").map(({ text }) => text), ["echo \"a`\"; b\" ", " x"])
  assert.deepEqual(splitStatements("echo \"a\"\"; b\"; x").map(({ text }) => text), ["echo \"a\"\"; b\"", " x"])
  assert.deepEqual(splitStatements("a & b | c").map(({ text }) => text), ["a & b | c"])
  assert.deepEqual(splitStatements("").map(({ text }) => text), [""])
})

test("text the splitter cannot read with certainty is not split", () => {
  for (const text of ["a; @'\nx\n'@", '@"\nx\n"@', "a # comment", "# comment", "a; # x", "echo 'unclosed", "echo (a", "echo a)", "echo {a", "echo a]"]) assert.equal(splitStatements(text), null, text)
  assert.notEqual(splitStatements("echo a#b"), null, "a # inside a word is not a comment")
})

test("an argument PowerShell would not pass to git as written is single-quoted", () => {
  assert.equal(rewritePowerShell("git log HEAD..@{u}"), "git log 'HEAD..@{u}'")
  assert.equal(rewritePowerShell("git rev-list HEAD..@{u} --count"), "git rev-list 'HEAD..@{u}' --count")
  assert.equal(rewritePowerShell("git.exe log @{u}..HEAD"), "git.exe log '@{u}..HEAD'")
  assert.equal(rewritePowerShell("git status; git log   HEAD..@{u}"), "git status; git log 'HEAD..@{u}'", "other statements keep their text")
  assert.equal(rewritePowerShell("git log HEAD..@{u}\n"), "git log 'HEAD..@{u}'\n")
  assert.equal(rewritePowerShell("git log 'HEAD..@{u}'"), null, "already quoted")
  assert.equal(rewritePowerShell("git log \"HEAD..@{$x}\""), null, "a double-quoted word is left alone")
  assert.equal(rewritePowerShell("git log HEAD..@{$u}"), null, "a variable inside is not rewritten with certainty")
  assert.equal(rewritePowerShell("git status"), null)
})

test("git output piped into a cmdlet outside the allowlist is held in a variable first", () => {
  assert.equal(rewritePowerShell("git status | Format-Table"), "$deskGitOutput = git status; $deskGitOutput | Format-Table")
  assert.equal(rewritePowerShell("git status 2>&1 | Tee-Object x"), "$deskGitOutput = git status 2>&1; $deskGitOutput | Tee-Object x")
  assert.equal(rewritePowerShell("git log HEAD..@{u} | Format-Table"), "$deskGitOutput = git log 'HEAD..@{u}'; $deskGitOutput | Format-Table")
  assert.equal(rewritePowerShell("git log | Select-Object -First 3 | Format-Table"), "$deskGitOutput = git log; $deskGitOutput | Select-Object -First 3 | Format-Table")
  assert.equal(rewritePowerShell("git status | % { $_ }"), "$deskGitOutput = git status; $deskGitOutput | % { $_ }")
  assert.equal(rewritePowerShell("git -C 'a b' status | Out-File \"x y\""), "$deskGitOutput = git -C 'a b' status; $deskGitOutput | Out-File \"x y\"")
})

test("a statement it cannot rewrite with certainty is left alone", () => {
  for (const text of [
    "git status |", "git status | ", "git (git rev-parse HEAD) | Format-Table", "git {x} | Format-Table", "Write-Output x | Format-Table", "& git status | Format-Table",
    "git status; echo 'unterminated", "git log 'a", "git log (a", "", "echo hi", "git status # c\n git log | Format-Table",
  ]) assert.equal(rewritePowerShell(text), null, text)
  assert.equal(rewritePowerShell("git status`"), null, "a trailing backtick leaves no change to make")
})

test("a statement after && or || is not moved, because it would change when it runs", () => {
  assert.equal(rewritePowerShell("git status && git log | Format-Table"), null)
  assert.equal(rewritePowerShell("git status || git log HEAD..@{u}"), null)
  assert.equal(rewritePowerShell("git log HEAD..@{u} && git status"), "git log 'HEAD..@{u}' && git status", "the statement before it still can be")
  assert.equal(rewritePowerShell("git status | Format-Table && git fetch"), "$deskGitOutput = git status; $deskGitOutput | Format-Table && git fetch")
})

test("the guard offers a rewrite only when the guard allows it", async (t) => {
  const f = await fixture(t)
  const deny = async (command, extra = {}) => guardShellCommand({ command, cwd: f.prot, env: f.env, powershell: true, ...extra })
  // The exact command, in the first line.
  const split = await deny("git status | Format-Table")
  assert.match(split.reason, /^Run this instead: \$deskGitOutput = git status; \$deskGitOutput \| Format-Table\nRun each git command as its own plain statement/u)
  assert.equal((await deny("$deskGitOutput = git status; $deskGitOutput | Format-Table")).deny, false, "the suggestion passes")
  const quoted = await deny("git log HEAD..@{u}")
  assert.match(quoted.reason, /^Run this instead: git log 'HEAD\.\.@\{u\}'\n/u)
  assert.equal((await deny("git log 'HEAD..@{u}'")).deny, false, "the suggestion passes")
  // Where the rewrite leaves another statement the guard denies, no rewrite is offered.
  const still = await deny("git log HEAD..@{u}; git checkout topic")
  assert.equal(still.deny, true)
  assert.doesNotMatch(still.reason, /Run this instead/u)
  assert.match(still.reason, /^Run each git command as its own plain statement/u)
  // Where the rewrite is too long for the first line, the first line points to it.
  const long = await deny(`git log ${"--oneline ".repeat(12)}HEAD..@{u}`)
  assert.match(long.reason, /^Run the rewritten command below instead\.\nRewrite: git log .*'HEAD\.\.@\{u\}'\nRun each git command/u)
  // A rewrite too long to show at all is left out.
  const huge = await deny(`git log ${"--oneline ".repeat(100)}HEAD..@{u}`)
  assert.doesNotMatch(huge.reason, /Rewrite|Run this instead/u)
  // Bash gets none: the rewrite is for PowerShell text.
  const bash = await guardShellCommand({ command: "git stash", cwd: f.prot, env: f.env, powershell: false })
  assert.doesNotMatch(bash.reason, /Run this instead/u)
  // The rewritten command is judged without a further rewrite, in what is left of the budget.
  let clock = 0
  const budgeted = await deny("git status | Format-Table", { budgetMs: 25, now: () => (clock += 10) })
  assert.equal(budgeted.deny, true)
  assert.equal(REWRITE_LINES.test(budgeted.reason), false, "a rewrite the guard could not verify in time is not offered")
})
