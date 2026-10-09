import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveSuperpowersContext } from "../../../../../plugins/desk/mcp/src/activation/superpowers-context.js"

const cli = fileURLToPath(new URL("../../../../../plugins/desk/mcp/src/activation/superpowers-context.js", import.meta.url))
const input = { deskRoot: "/desk", taskPath: "/desk/task", iterationPath: "/desk/task/iteration", planPath: "/desk/task/iteration/planning.md", evidenceRoot: "/evidence", step: 1, attempt: 1 }
for (const [args, expected] of [
  [["--step"], "value required for --step"],
  [["--step", "--attempt", "2"], "value required for --step"],
  [["--progress-path"], "value required for --progress-path"],
  [["--progress-path", "--plan-path", "/desk/plan.md"], "value required for --progress-path"],
  [["--progress", "/desk/progress.md"], "unknown argument --progress"],
  [["constructor", "2"], "unknown argument constructor"],
  [["__proto__", "2"], "unknown argument __proto__"],
]) {
  test(`context CLI refuses ${args.join(" ")} with its exact diagnostic`, () => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, `Superpowers context: ${expected}\n`)
  })
}
test("context rejects whitespace-only required paths", async () => {
  await assert.rejects(resolveSuperpowersContext({ ...input, evidenceRoot: " \t " }), { message: /^Superpowers context: evidenceRoot is required: pass --evidence-root <a folder outside the desk>/u })
})
for (const key of ["planPath", "progressPath"]) {
  test(`context rejects a supplied but empty ${key} without filesystem work`, async () => {
    await assert.rejects(resolveSuperpowersContext({ ...input, [key]: " \t " }), {
      message: `Superpowers context: ${key} must be a non-empty path when supplied`,
    })
  })
  test(`context rejects a non-string ${key} without filesystem work`, async () => {
    await assert.rejects(resolveSuperpowersContext({ ...input, [key]: 7 }), {
      message: `Superpowers context: ${key} must be a non-empty path when supplied`,
    })
  })
}
for (const key of ["step", "attempt"]) {
  test(`context rejects non-integer ${key} without filesystem work`, async () => {
    await assert.rejects(resolveSuperpowersContext({ ...input, [key]: 1.5 }), { message: `Superpowers context: ${key} must be a positive integer` })
  })
}
test("context preserves an unexpected canonical-file stat error", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "superpowers-stat-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const taskPath = path.join(root, "task")
  const iterationPath = path.join(taskPath, "iteration")
  await fs.mkdir(iterationPath, { recursive: true })
  await fs.writeFile(path.join(taskPath, "task.md"), "task\n")
  await fs.writeFile(path.join(iterationPath, "doing.md"), "progress\n")
  await fs.writeFile(path.join(iterationPath, "planning.md"), "plan\n")
  const failure = Object.assign(new Error("fixture canonical stat denied"), { code: "EACCES" })
  t.mock.method(fs, "stat", async () => { throw failure })
  syncBuiltinESMExports()
  try {
    await assert.rejects(resolveSuperpowersContext({ ...input, deskRoot: root, taskPath, iterationPath, planPath: path.join(iterationPath, "planning.md") }), { message: "desk-mcp: cannot read the desk root (EACCES)" })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("a missing iterationPath says exactly what to pass, with an example under the task's folder, and creates nothing", async () => {
  const { iterationPath, ...rest } = input
  await assert.rejects(resolveSuperpowersContext(rest), (error) => {
    assert.match(error.message, /^Superpowers context: iterationPath is required: pass --iteration-path <task folder>\/<repo>\/<YYYY-MM-DD>-<slug>, a folder under the task's own folder, for example .*\/<repo>\/2026-09-30-<slug>\. The mapper only reads and creates nothing, so do not mkdir it first$/u)
    assert.ok(error.message.includes(`${input.taskPath.replace(/\/+$/u, "")}/<repo>/`), "the example sits under the task folder that was passed")
    return true
  })
})

test("the hint for each missing path names its flag, with an example built from the paths already given", async () => {
  await assert.rejects(resolveSuperpowersContext({ ...input, taskPath: undefined }), /taskPath is required: pass --task-path <desk>\/<track>\/<task>/u)
  await assert.rejects(resolveSuperpowersContext({ ...input, deskRoot: undefined }), /deskRoot is required: pass --desk-root <the desk's absolute path>/u)
  await assert.rejects(resolveSuperpowersContext({ deskRoot: "/desk", taskPath: "/desk/t/x/", step: 1, attempt: 1 }), /iterationPath is required: .* for example \/desk\/t\/x\/<repo>\//u)
  await assert.rejects(resolveSuperpowersContext({ deskRoot: "/desk", taskPath: " ", step: 1, attempt: 1 }), /taskPath is required/u)
  await assert.rejects(resolveSuperpowersContext({ deskRoot: "/desk", taskPath: "/desk/t/x", iterationPath: "/desk/t/x/r/d", step: 1, attempt: 1 }), /evidenceRoot is required: pass --evidence-root <a folder outside the desk>, for example \/evidence;/u)
  await assert.rejects(resolveSuperpowersContext({ taskPath: "/desk/t/x", iterationPath: "/desk/t/x/r/d", step: 1, attempt: 1 }), /deskRoot is required/u)
})
