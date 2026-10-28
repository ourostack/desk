import { mkTempRoot } from "../_temp_roots.js"
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

test("context-run fixtures are removed after the file finishes without removing a sibling", async () => {
  const parent = await mkTempRoot("desk-context-run-lifecycle-")
  const sibling = "desk-context-run-unowned"
  const marker = join(parent, sibling, "retained.txt")
  await mkdir(join(parent, sibling))
  await writeFile(marker, "unrelated sibling")
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    fileURLToPath(new URL("../_isolated_env.mjs", import.meta.url)),
    "--test",
    "--test-reporter=tap",
    "--test-name-pattern=^an unreadable producer identity starts no context run$",
    fileURLToPath(new URL("./context_run.test.js", import.meta.url)),
  ], {
    env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent },
    timeout: 60_000,
  })
  assert.match(stdout, /# pass 1(?:\r?\n|$)/, "the selected real fixture test must run")
  assert.equal(await readFile(marker, "utf8"), "unrelated sibling")
  assert.deepEqual((await readdir(parent)).filter((name) => name.startsWith("desk-context-run-")), [sibling])
})
