// Desk failures speak Ouro AX's problem shape, and the one call that reports one records its evidence.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { checkFailureCopyAllow, vagueFailuresIn } from "../../../../../plugins/desk/mcp/lib/ouro/ax/precise-copy.ts"
import { friction_add } from "../../../../../plugins/desk/mcp/src/tools/friction.js"
import { doctorRuntime } from "../../../../../plugins/desk/mcp/src/tools/doctor.js"
import { deskFailure } from "../../../../../plugins/desk/mcp/src/runtime/desk-failure.js"
import { updateSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { factoryStateRoot } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { mkTempDeskRoot } from "../tools/_helpers.js"
import { osEnv } from "../_os_env.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, "../../../../../plugins/desk/mcp/src")

// The allow-list holds the failure texts not yet in the problem shape. It can only shrink: delete an entry when its text is converted, and lower this number with it.
const ALLOWED_AT_MOST = 57

const failure = () => deskFailure({
  code: "desk_demo_failure",
  thing: "demo",
  probably: "the demo service refused the call, probably because its sign-in expired",
  look: "call desk_doctor",
  keepWorking: "your work is safe and Desk retries with every write",
  fix: "gh auth login",
})

test("a Desk failure says what probably happened, how to look further, the one call that files it and how to keep working", () => {
  const line = failure()
  assert.equal(line, 'desk: demo: the demo service refused the call, probably because its sign-in expired; to look further, call desk_doctor; to file a bug with its evidence, call friction_add with {"error_code":"desk_demo_failure"}; your work is safe and Desk retries with every write. Fix: gh auth login.')
  assert.deepEqual(vagueFailuresIn(line), [])
})

test("friction_add with an error_code records the failure's evidence on the desk, credentials redacted, and desk_doctor lists the failure", async () => {
  const deskRoot = await mkTempDeskRoot()
  const base = await mkTempDeskRoot()
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  await factoryStateRoot(env)
  const line = failure()
  updateSyncStatus(deskRoot, env, { blocked: true, reason: "auth_failed", error: "Authentication failed for https://user:ghp_0123456789abcdefghijklmnopqrstuvwxyz@github.com/o/r.git" })
  const result = await friction_add({ deskRoot, input: { error_code: "desk_demo_failure" }, env })
  assert.equal(result.status, "added")
  assert.equal(result.kaizen, "candidate")
  const entry = await fs.readFile(path.join(deskRoot, "_meta", "friction.md"), "utf8")
  for (const part of ["Desk error `desk_demo_failure`", `Message: ${line}`, "Stack:\nError: desk_demo_failure\n    at ", "Desk version: ", "Host: ", `Desk path: ${deskRoot}`, '"blocked":true', '"reason":"auth_failed"']) {
    assert.ok(entry.includes(part), `the entry holds ${part}`)
  }
  assert.doesNotMatch(entry, /ghp_0123456789/u)
  assert.match(doctorRuntime({ input: {}, deskRoot }).summary, /Recent Desk failures\n {2}desk_demo_failure at /u)
})

test("friction_add says so when this process holds no record of the code, and refuses a malformed one", async () => {
  const deskRoot = await mkTempDeskRoot()
  const base = await mkTempDeskRoot()
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state"), DESK_PLUGIN_ROOT: path.join(base, "no-plugin") })
  await factoryStateRoot(env)
  await friction_add({ deskRoot, input: { error_code: "desk_from_another_process", body: "The agent's own words." }, env })
  const entry = await fs.readFile(path.join(deskRoot, "_meta", "friction.md"), "utf8")
  assert.match(entry, /^The agent's own words\.\n\nDesk error `desk_from_another_process`: this process holds no record of it/u)
  assert.match(entry, /Desk version: unknown\n.*\nDesk path: .*\nRecent sync status: none recorded/u)
  await assert.rejects(friction_add({ deskRoot, input: { error_code: "desk_from_another_process", body: 7 }, env }), /`body` must be a string/u)
  await assert.rejects(friction_add({ deskRoot, input: { error_code: "Not A Code" }, env }), /`error_code` must be the code a Desk failure line gave/u)
})

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu
const FAILURE_LINE = /(?:Error|refuse|throw|fail\w*|message|fix|problem|tell|summary|hint|reason|note|detail)\w*\s*[(:=]/iu

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) return name === "node_modules" ? [] : sourceFiles(file)
    return /\.(?:js|cjs|mjs)$/u.test(name) ? [file] : []
  })
}

// The text of every string in Desk's source that sits on a line speaking a failure, a message or a fix.
function failureTexts() {
  const texts = []
  for (const file of sourceFiles(srcRoot)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*(?:\/\/|\*|\/\*)/u.test(line) || !FAILURE_LINE.test(line)) continue
      for (const [literal] of line.matchAll(LITERAL)) texts.push(literal.slice(1, -1))
    }
  }
  return texts
}

test("every failure text in Desk's source is precise or on the shrinking allow-list", (t) => {
  const allow = checkFailureCopyAllow(JSON.parse(readFileSync(path.join(here, "failure-copy-allow.json"), "utf8")))
  const texts = failureTexts()
  const vague = vagueFailuresIn(texts, { allow })
  assert.deepEqual(vague.filter((finding) => finding.allowed === null).map((finding) => finding.text), [], "a failure text is vague: say what probably happened and precisely why, then the next step (see ax-precise-copy)")
  assert.deepEqual(allow.filter((entry) => !texts.some((text) => text.includes(entry.match))).map((entry) => entry.match), [], "an allow-list entry no text matches any more: delete it from failure-copy-allow.json and lower ALLOWED_AT_MOST")
  assert.ok(allow.length <= ALLOWED_AT_MOST, `the allow-list holds ${allow.length}; it can only shrink, to at most ${ALLOWED_AT_MOST}`)
  t.diagnostic(`allow-list: ${allow.length} failure texts not yet in the Ouro AX problem shape`)
})
