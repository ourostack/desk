import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

const repoRoot = new URL("../../../../../", import.meta.url)
const read = (file) => readFileSync(new URL(file, repoRoot), "utf8")
const evaluation = () => read("plugins/desk/skills/online-evaluation/SKILL.md")
const integration = () => read("plugins/desk/skills/superpowers-integration/SKILL.md")

test("the evaluation skill states its own agreed-horizon or request trigger, not a second copy on the retired integration seam", () => {
  assert.match(evaluation(), /at an agreed evaluation endpoint or observation horizon, or for a requested work-item evaluation or retrospective/iu)
  assert.doesNotMatch(integration(), /agreed evaluation endpoint or observation horizon/iu)
})

test("the evaluation trigger preserves absent-skill, disabled-recording and collection-authority boundaries on its own owning skill", () => {
  const text = evaluation()
  assert.match(text, /report evaluation unavailable/iu)
  assert.match(text, /invocation grants no collection consent/iu)
  assert.match(text, /this is a trigger, not another engine, store or lifecycle/iu)
})

test("the evaluation reads the factory's job report and never the retired manual ledger", () => {
  const text = evaluation()
  assert.match(text, /Accounting is automatic: the factory captures each session when it ends and reports each finished job/u)
  assert.match(text, /`factory_report:`/u)
  assert.match(text, /desk:factory-evaluator/u)
  assert.match(text, /mark flow and consumption unavailable with that reason/u)
  assert.doesNotMatch(text, /desk_work_ledger|work-measurement-ledger|ledger/iu)
})

test("the retired integration seam no longer carries executable review/accounting instructions", () => {
  const text = integration()
  assert.doesNotMatch(text, /^## Review and accounting$/mu)
  assert.doesNotMatch(text, /invocation grants no collection consent/iu)
})

test("the packaged evaluation skill is the exact parent-approved body", () => {
  const body = readFileSync(new URL("plugins/desk/skills/online-evaluation/SKILL.md", repoRoot))
  assert.equal(createHash("sha256").update(body).digest("hex"), "b061134c9ac570382f2bf166087e9e9231fedf3e93b179aac161507c06356507")
})
