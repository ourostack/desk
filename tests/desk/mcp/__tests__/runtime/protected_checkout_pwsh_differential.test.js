// A differential check of the guard's hand-written PowerShell tokenizer against PowerShell's own parser. For each corpus command
// the guard allows, the real parser lists every command it would run (CommandAst) and every .NET member call. The guard may allow
// a command only if (1) it runs no launcher (Start-Process, Invoke-Expression, cmd, bash, ...) or dynamic invocation (`& $x`), unless the
// corpus entry says why that is harmless (`launcher_ok`), and (2) every command the real parser names git was also seen by the guard's
// own walk, which is what the guard judges. The same check runs over each corpus bypass wrapped in a construct that could hide it
// (an if, a try, a loop, a function, a call-operator block), so a wrapper the tokenizer cannot read shows up here as an allowed
// command whose real parse still runs git. It skips cleanly where PowerShell is absent. Named "native" so the Windows job runs it.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { fixture } from "./_guard_fixture.js"
import { answer, fill, loadCorpus } from "./_guard_corpus.js"
import { parseCommands, pwshPath } from "./_pwsh_parse.js"
import { inspectShell } from "../../../../../plugins/desk/mcp/src/runtime/shell-commands.js"

const LAUNCHERS = new Set([
  "start-process", "saps", "start", "invoke-expression", "iex", "invoke-command", "icm", "cmd", "bash", "sh", "zsh", "pwsh", "powershell", "wsl", "env", "ssh", "docker", "docker-compose",
  "invoke-cimmethod", "invoke-wmimethod", "start-job", "start-threadjob", "new-object", "set-alias", "new-alias", "sal", "nal",
])
const GIT = /^(?:.*[\\/])?git(?:\.exe)?$/iu
const program = (name) => name.split(/[\\/]/u).at(-1).replace(/\.exe$/iu, "").toLowerCase()

// Wrappers that run the same text while changing how it is nested.
const WRAPPERS = [
  (c) => `if ($true) { ${c} }`, (c) => `try { ${c} } catch { }`, (c) => `foreach ($i in 1) { ${c} }`, (c) => `function Go { ${c} }; Go`,
  (c) => `& { ${c} }`, (c) => `Write-Output 1; ${c}`, (c) => `${c}; Write-Output 1`, (c) => `$null = $(${c})`, (c) => `$y = ${c}`, (c) => `${c} | Out-Null`,
  (c) => `Write-Output ("x" + $(${c}))`, (c) => `[void]$(${c})`, (c) => `switch (1) { 1 { ${c} } }`, (c) => `while ($true) { ${c}; break }`,
  (c) => `do { ${c} } while ($false)`, (c) => `@(${c})`, (c) => `$h = @{ a = $(${c}) }`, (c) => `Invoke-Command -ScriptBlock { ${c} }`, (c) => `${c} 2>&1`,
  (c) => `cd .; ${c}`, (c) => `$env:X = 1; ${c}`, (c) => `if ($false) { 1 } else { ${c} }`,
]

/** How many git commands the guard's own walk saw in `command` (what it judges), or null when the walk stops (it denies or cannot read the text). */
async function visitedGit(f, command, cwd) {
  const seen = []
  try {
    await inspectShell({ command, cwd, env: f.env, powershell: true, visit: async (call) => { if (call.name === "git") seen.push(call) } })
  } catch {
    return null
  }
  return seen.length
}

function findings(parsed, entry, visited) {
  const found = []
  if (parsed.errors > 0) return found
  for (const { name, operator, text } of parsed.commands) {
    if (name === null) { if (!entry.launcher_ok) found.push(`a dynamic invocation (${operator}): ${text}`); continue }
    if (LAUNCHERS.has(program(name)) && !entry.launcher_ok) found.push(`a launcher (${name}): ${text}`)
  }
  if (parsed.members.includes("Start") && !entry.launcher_ok) found.push("a member call Start()")
  const git = parsed.commands.filter(({ name }) => name !== null && GIT.test(name))
  if (git.length > 0 && visited !== null && visited < git.length) found.push(`${git.length} git commands for the parser, ${visited} for the guard: ${git.map(({ text }) => text).join(" | ")}`)
  return found
}

const shell = pwshPath()
const skip = shell === null ? "PowerShell (pwsh) is not installed here" : false

test("native pwsh differential: an allowed corpus command runs no git or launcher the guard did not judge", { skip }, async (t) => {
  const f = await fixture(t)
  const entries = loadCorpus("pwsh-guard-corpus.json")
  const allowed = []
  for (const entry of entries) if (entry.expect === "allow" && !entry.known_gap && !(await answer(f, entry, true)).deny) allowed.push(entry)
  assert.ok(allowed.length >= 40, "the corpus has allowed commands to check")
  const parsed = parseCommands(shell, allowed.map((entry) => fill(entry.command, f)))
  const problems = []
  for (const [index, entry] of allowed.entries()) {
    const command = fill(entry.command, f)
    const visited = entry.cwd === "own" ? null : await visitedGit(f, command, f.prot)
    for (const finding of findings(parsed[index], entry, visited)) problems.push(`${entry.command}: ${finding}`)
  }
  assert.deepEqual(problems, [], "an allowed command the real parser reads as running git or a launcher")
})

test("native pwsh differential: a corpus bypass the guard allows, in any wrapper, runs no git or launcher", { skip }, async (t) => {
  const f = await fixture(t)
  const corpus = loadCorpus("pwsh-guard-corpus.json")
  const entries = corpus.filter((entry) => entry.expect === "deny" && !entry.known_gap && entry.cwd === undefined)
  // A wrapper can spell a known gap (`$y = ` before a bypass that is already listed), which the corpus already documents.
  const documented = new Set(corpus.filter((entry) => entry.known_gap).map((entry) => entry.command))
  const wrapped = []
  for (const entry of entries) {
    for (const [index, wrap] of WRAPPERS.entries()) {
      const candidate = { ...entry, command: wrap(entry.command), expect: "deny", why: `${entry.why} (wrapper ${index})` }
      if (!documented.has(candidate.command) && !(await answer(f, candidate, true)).deny) wrapped.push(candidate)
    }
  }
  const parsed = wrapped.length === 0 ? [] : parseCommands(shell, wrapped.map((entry) => fill(entry.command, f)))
  const problems = []
  for (const [index, entry] of wrapped.entries()) {
    const visited = await visitedGit(f, fill(entry.command, f), f.prot)
    for (const finding of findings(parsed[index], entry, visited)) problems.push(`${entry.command.replaceAll("\n", "\\n")}: ${finding}`)
  }
  t.diagnostic(`${wrapped.length} wrapped bypasses were allowed by the guard; ${problems.length} of them run git or a launcher`)
  assert.deepEqual(problems, [], "a wrapped bypass the guard allows but PowerShell runs")
})

test("native pwsh differential: the parser flags what the guard's known gaps run", { skip }, async (t) => {
  const f = await fixture(t)
  const gaps = loadCorpus("pwsh-guard-corpus.json").filter((entry) => entry.known_gap)
  const parsed = parseCommands(shell, gaps.map((entry) => fill(entry.command, f)))
  const flagged = gaps.filter((entry, index) => findings(parsed[index], entry, null).length > 0)
  t.diagnostic(`the real parser flags ${flagged.length} of ${gaps.length} known gaps: ${flagged.map((entry) => entry.command).join(" || ")}`)
  assert.ok(flagged.length > 0, "the differential is able to see a bypass the tokenizer misses")
})
