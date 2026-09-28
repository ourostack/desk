// Admission protects only a real desk: a folder with the desk layout (`_meta/` plus `_archive/` or `desks/`), or the root a saved desk binding names. On 2026-09-27 six code worktrees of this repository carried desk.protected because a test bound $DESK to the checkout running the suite; with this rule, such a binding is served but never marked.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { createDeskSession } from "../../../../../plugins/desk/mcp/src/runtime/desk-session.js"
import { guardShellCommand } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout.js"

async function admit(root, source) {
  const calls = []
  const session = createDeskSession({
    args: {}, deskStateDir: path.join(path.dirname(root), `state-${path.basename(root)}`), stderr: { write() {} },
    protect: async (request) => { calls.push(request); return { protected: true } },
    resolveInputs: async () => ({ root: { root, source }, activation: { stateBranch: "main" }, activationError: { message: "fixture activation fails" } }),
  })
  try { await session.admission.refresh({ force: true, waitMs: 60000 }) } finally { await session.dispose() }
  return calls
}

test("admission marks a desk-layout root or a saved binding, and never a code checkout bound by $DESK, --root or a host root", async (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-admission-marks-")))
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }))
  const code = path.join(base, "code"), solo = path.join(base, "solo"), crew = path.join(base, "crew"), metaOnly = path.join(base, "meta-only")
  for (const dir of [code, solo, crew, metaOnly]) { mkdirSync(dir); execFileSync("git", ["init", "-q", dir]) }
  for (const child of ["_meta", "_archive"]) mkdirSync(path.join(solo, child))
  for (const child of ["_meta", "desks"]) mkdirSync(path.join(crew, child))
  mkdirSync(path.join(metaOnly, "_meta"))
  for (const source of ["env:DESK", "explicit-root", "host-session-root", undefined]) {
    assert.deepEqual(await admit(code, source), [], `a code checkout bound by ${source} is not marked`)
    assert.deepEqual(await admit(metaOnly, source), [], `_meta alone is not a desk (${source})`)
    assert.deepEqual(await admit(solo, source), [{ root: solo, stateBranch: "main" }], `a solo desk is marked (${source})`)
    assert.deepEqual(await admit(crew, source), [{ root: crew, stateBranch: "main" }], `a crew desk is marked (${source})`)
  }
  assert.deepEqual(await admit(code, "activation-config"), [{ root: code, stateBranch: "main" }], "a saved binding names a desk")
})

test("with the real marker, a code checkout that admission bound stays unprotected", async (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-admission-real-")))
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }))
  const code = path.join(base, "code")
  mkdirSync(code)
  execFileSync("git", ["init", "-q", code])
  const session = createDeskSession({
    args: {}, deskStateDir: path.join(base, "state"), stderr: { write() {} },
    resolveInputs: async () => ({ root: { root: code, source: "env:DESK" }, activationError: { message: "fixture activation fails" } }),
  })
  try { await session.admission.refresh({ force: true, waitMs: 60000 }) } finally { await session.dispose() }
  assert.throws(() => execFileSync("git", ["-C", code, "config", "--includes", "--get", "desk.protected"], { stdio: "pipe" }))
  assert.equal((await guardShellCommand({ command: "git stash", cwd: code, env: process.env })).deny, false)
})
