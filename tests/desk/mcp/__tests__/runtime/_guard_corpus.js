// Loads a guard corpus (fixtures/*-guard-corpus.json): a list of { command, expect: "allow" | "deny", why } the guard must answer
// as written, in a protected-checkout fixture. `{{PROT}}` and `{{OWN}}` stand for the protected and the ordinary clone.
// `cwd: "own"` runs the command in the ordinary clone. `known_gap: true` (only with expect "deny") marks a command the guard
// still allows today: the corpus documents it, the table test skips it, and a separate test fails when it is fixed, so
// that the entry is then promoted to a plain deny. `launcher_ok` (allowed commands only) says why a command that runs a
// launcher such as Invoke-Expression is harmless, for the differential check against PowerShell's own parser.
import { readFileSync } from "node:fs"
import { assertActionable } from "./_guard_text.js"

export function loadCorpus(name) {
  return validateCorpus(JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")), name)
}

export function validateCorpus(entries, name) {
  for (const entry of entries) {
    const label = JSON.stringify(entry.command)
    if (typeof entry.command !== "string" || entry.command === "") throw new Error(`${name}: an entry has no command`)
    if (entry.expect !== "allow" && entry.expect !== "deny") throw new Error(`${name}: ${label} must expect allow or deny`)
    if (typeof entry.why !== "string" || entry.why.length < 10) throw new Error(`${name}: ${label} needs a why`)
    if (entry.known_gap !== undefined && (entry.known_gap !== true || entry.expect !== "deny")) throw new Error(`${name}: ${label}: known_gap is true and only on a deny`)
    if (entry.launcher_ok !== undefined && entry.expect !== "allow") throw new Error(`${name}: ${label}: launcher_ok only on an allow`)
    if (entry.cwd !== undefined && entry.cwd !== "own") throw new Error(`${name}: ${label}: cwd is "own" or absent`)
  }
  return entries
}

// A command carries the checkout's path as text. On Windows the path is written with forward slashes, the way a Git Bash or PowerShell user writes
// it: an unquoted backslash path in Bash loses every backslash to the shell's escape rule, so the command would name a folder that does not exist.
const asWritten = (folder) => (process.platform === "win32" ? folder.replaceAll("\\", "/") : folder)
export const fill = (text, f) => text.replaceAll("{{PROT}}", asWritten(f.prot)).replaceAll("{{OWN}}", asWritten(f.own))

/** The guard's answer for one entry, in the fixture. */
export function answer(f, entry, powershell) {
  return f.guard(fill(entry.command, f), { cwd: entry.cwd === "own" ? f.own : f.prot, powershell })
}

/** Runs the table: every entry is a subtest; a known gap is skipped with its reason, and a denial must open with the fix. */
export async function runCorpus(t, assert, f, entries, powershell) {
  for (const entry of entries) {
    const name = `${entry.expect}${entry.known_gap ? " (known gap)" : ""}: ${entry.command.replaceAll("\n", "\\n").slice(0, 110)}`
    await t.test(name, { skip: entry.known_gap ? `known gap: ${entry.why}` : false }, async () => {
      const result = await answer(f, entry, powershell)
      assert.equal(result.deny, entry.expect === "deny", `${entry.why} -> ${result.reason ?? "allowed"}`)
      if (result.deny) assertActionable(assert, result.reason, entry.command)
    })
  }
}

/** A known gap that the guard now denies is fixed: it must leave the gap list. */
export async function assertGapsStillOpen(assert, f, entries, powershell) {
  for (const entry of entries.filter((candidate) => candidate.known_gap)) {
    const result = await answer(f, entry, powershell)
    assert.equal(result.deny, false, `${entry.command} is now denied: remove known_gap from its corpus entry and say how it was fixed`)
  }
}
