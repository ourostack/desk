// The guard corpus: every probe command the protected-checkout guard has been judged against (the false positives of the
// 2026-10-01 Copilot session on Windows, the bypass set of PR #140's review, the allowlist attacks, the operator's real
// commands, and the Bash operations), each with the answer the guard must give and why. A change that makes the guard allow
// a harmful command, or deny a harmless one, fails here by name. A command the guard still allows although it should deny is
// marked `known_gap`: it is skipped, and `known gaps` fails when one is fixed so the entry gets promoted.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { fixture } from "./_guard_fixture.js"
import { assertGapsStillOpen, loadCorpus, runCorpus, validateCorpus } from "./_guard_corpus.js"

const pwsh = loadCorpus("pwsh-guard-corpus.json")
const bash = loadCorpus("bash-guard-corpus.json")

test("the corpora are well formed and cover every class the review named", () => {
  for (const [name, entries, floor] of [["pwsh", pwsh, { allow: 40, deny: 120, gap: 10 }], ["bash", bash, { allow: 30, deny: 30, gap: 0 }]]) {
    const count = { allow: entries.filter((e) => e.expect === "allow").length, deny: entries.filter((e) => e.expect === "deny" && !e.known_gap).length, gap: entries.filter((e) => e.known_gap).length }
    for (const key of Object.keys(floor)) assert.ok(count[key] >= floor[key], `${name} has ${count[key]} ${key} entries; the corpus never shrinks below ${floor[key]}`)
    assert.equal(new Set(entries.map((e) => `${e.cwd ?? "prot"}\0${e.command}`)).size, entries.length, `${name}: a command appears twice`)
  }
  const groups = new Set(pwsh.map((e) => e.group))
  for (const group of [
    "bypass (PR #140 review): a statement that names git and could run it", "allowlist attacks: script blocks and calculated properties", "allowlist attacks: interpolation in strings and here-strings",
    "allowlist attacks: redefining an allowlisted command", "allowlist attacks: chaining after an allowlisted statement", "quoted -C path", "unresolved checkout: a $roots loop", "known gap",
  ]) assert.ok(groups.has(group), group)
})

test("PowerShell corpus: the guard answers every command as written", async (t) => {
  await runCorpus(t, assert, await fixture(t), pwsh, true)
})

test("Bash corpus: the guard answers every command as written", async (t) => {
  await runCorpus(t, assert, await fixture(t), bash, false)
})

test("known gaps are still gaps (a fixed one must be promoted to a plain deny)", async (t) => {
  const f = await fixture(t)
  await assertGapsStillOpen(assert, f, pwsh, true)
  await assertGapsStillOpen(assert, f, bash, false)
})

test("the corpus loader rejects an entry that is malformed", () => {
  const good = { command: "git status", expect: "allow", why: "read-only: changes nothing" }
  assert.deepEqual(validateCorpus([good], "x"), [good])
  for (const [bad, message] of [
    [{ ...good, command: "" }, /no command/u], [{ ...good, expect: "maybe" }, /allow or deny/u], [{ ...good, why: "" }, /needs a why/u],
    [{ ...good, known_gap: true }, /only on a deny/u], [{ ...good, expect: "deny", known_gap: false }, /only on a deny/u],
    [{ ...good, expect: "deny", launcher_ok: "fine, harmless" }, /only on an allow/u], [{ ...good, cwd: "prot" }, /"own" or absent/u],
  ]) assert.throws(() => validateCorpus([bad], "x"), message)
  assert.deepEqual(validateCorpus([{ ...good, expect: "deny", known_gap: true }, { ...good, cwd: "own", launcher_ok: "harmless script" }], "x").length, 2)
})
