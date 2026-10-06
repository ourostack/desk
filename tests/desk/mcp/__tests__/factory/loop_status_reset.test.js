// A damaged status file is moved aside by the reader and read as empty. That must never restart the evaluator's daily cap:
// a UTC day on which the status was reset is a spent day for the evaluator. The reader here is the real one, on a really damaged file.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { runEvaluatorStep } from "../../../../../plugins/desk/mcp/src/factory/evaluator-step.js"
import { listStatusAside, statusResetDay } from "../../../../../plugins/desk/mcp/src/factory/loop-worker-state.js"
import { factoryStateRoot, readStatus, requestEvaluation, setConsent, updateStatus, writeLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { indexJob } from "./_index_helper.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const LOCAL = JSON.parse(readFileSync(path.join(here, "fixtures", "local-golden.json"), "utf8"))
const LABELS = JSON.parse(readFileSync(path.join(here, "fixtures", "labels-golden.json"), "utf8"))
const STORE = "ourostack/factory"
const DAY = 24 * 60 * 60 * 1000
const NOW = Math.floor(Date.now() / DAY) * DAY + 12 * 60 * 60 * 1000

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-status-reset-")))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state"), PATH: path.join(base, "no-bin") }
  try {
    return await run(env, base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

async function seedJob(env, base) {
  await setConsent(env, { store: STORE, contribute: true })
  const job = `01${"ab".repeat(15)}`
  const facts = structuredClone(LOCAL)
  facts.session.id = "3b0c1f5e-8a1d-4c2e-9f3a-000000000010"
  facts.jobs = [{ ...facts.jobs[0], job }]
  await writeLocalFacts(env, STORE, facts)
  await indexJob(env, job, `claude-code-${facts.session.id}.json`)
  await requestEvaluation(env, { job, deskRoot: path.join(base, "desk") })
}

const seams = (calls, extra = {}) => ({
  pluginVersion: LABELS.evaluator.plugin_version,
  now: extra.now ?? NOW,
  deadline: Date.now() + 365 * DAY,
  runHeadless: async (call) => { calls.push(call); return { state: "ran", cost_usd: 0.25, detail: null } },
  findAgentCli: () => "claude",
  probeSignIn: async () => ({ state: "subscription" }),
  ...extra,
})

// The real reader meets a status file that does not parse: it moves the file aside and answers empty.
async function damageStatus(env) {
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "status.json"), "{ damaged")
  const read = await readStatus(env)
  assert.equal(read.evaluator, undefined, "the reader answers as if nothing was ever recorded")
  return root
}

test("after the real reader sets a damaged status aside, the evaluator runs nothing that UTC day and says budget_exhausted", () => scratch(async (env, base) => {
  await seedJob(env, base)
  await updateStatus(env, (current) => ({ ...current, evaluator: { headless: { state: "ran", day: new Date(NOW).toISOString().slice(0, 10), jobs: 6 } } }))
  const root = await damageStatus(env)
  assert.equal(listStatusAside(root).length, 1)
  // The day is the set-aside file's own, read from the file, so a run across UTC midnight cannot disagree with it.
  const aside = await fs.stat(path.join(root, listStatusAside(root)[0]))
  const markDay = new Date(Math.max(aside.mtimeMs, aside.ctimeMs)).toISOString().slice(0, 10)
  assert.equal(statusResetDay(root), markDay)
  const clock = { now: Date.parse(`${markDay}T12:00:00.000Z`) }
  const calls = []
  assert.deepEqual(await runEvaluatorStep(env, seams(calls, clock)), { ok: true, result: "budget_exhausted" })
  assert.deepEqual(calls, [], "no run starts and no money is spent")
  assert.equal((await readStatus(env)).evaluator.headless.state, "budget_exhausted")
  assert.equal((await runEvaluatorStep(env, seams(calls, clock))).result, "budget_exhausted", "the next worker the same day finds the same")
  assert.deepEqual(calls, [])
}))

test("the next UTC day starts clean, and a machine whose status was never damaged is not held", () => scratch(async (env, base) => {
  await seedJob(env, base)
  await damageStatus(env)
  const calls = []
  assert.equal((await runEvaluatorStep(env, seams(calls, { now: NOW + 3 * DAY }))).result, "ran")
  assert.equal(calls.length, 1)
}))

test("a machine with no set-aside status runs as before", () => scratch(async (env, base) => {
  await seedJob(env, base)
  const calls = []
  assert.equal((await runEvaluatorStep(env, seams(calls))).result, "ran")
  assert.equal(statusResetDay(await factoryStateRoot(env)), null)
  assert.deepEqual(listStatusAside(path.join(base, "missing")), [])
}))

test("a set-aside name that cannot be read any more is ignored", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  await fs.symlink(path.join(root, "nowhere"), path.join(root, "status.json.corrupt-json-1"))
  assert.equal(statusResetDay(root), null)
}))
