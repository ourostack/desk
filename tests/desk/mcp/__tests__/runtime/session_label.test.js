import { test } from "node:test"
import { strict as assert } from "node:assert"
import { makeSessionLabelProposal } from "../../../../../plugins/desk/mcp/src/runtime/session-label.js"

const task = { track: "engineering", slug: "workflow-review" }
const unavailable = (code) => ({ state: "unavailable", code })

test("an authored safe label is only an automatic unknown-phase proposal", () => {
  assert.deepEqual(makeSessionLabelProposal({ task, displayLabel: "Workflow promotion review" }), {
    proposal: {
      version: 1,
      task,
      text: "Workflow promotion review",
      phase: "unknown",
      origin: "automatic",
    },
  })
})

test("omission never derives a label from task identity or a card title", () => {
  assert.deepEqual(makeSessionLabelProposal({ task, title: "Sensitive card title" }), unavailable("missing_safe_label"))
})

test("only an explicit current focus can produce a proposal", () => {
  assert.deepEqual(makeSessionLabelProposal({ task, displayLabel: "Browser qualification", focused: false }), unavailable("awaiting_focus"))
})

test("labels are trimmed and bounded in Unicode code points, not UTF-16 units", () => {
  const text = String.fromCodePoint(0x1f9ea).repeat(72)
  assert.equal(makeSessionLabelProposal({ task, displayLabel: `  ${text}  ` }).proposal.text, text)
  assert.deepEqual(makeSessionLabelProposal({ task, displayLabel: `${text}x` }), unavailable("unsafe_label"))
})

for (const displayLabel of [
  "", "   ", null, 42, {}, ["Review"],
  "Review\nbrowser", "Review\tbrowser", "Review\u0000browser",
  "Review\u202ebrowser", "Review\u200bbrowser", "Review\ud800browser",
  "/Users/example/work", "relative/task.md", "C:\\Users\\example",
  "~/work", "Review user@example.invalid", "Read https://example.invalid",
  "Visit www.example.invalid", "Open mailto:example@example.invalid",
  "Use ghp_fixture", "Use (github_pat_fixture)", "Use sk-fixture",
  "pw fixture", "password=fixture", "api_key=fixture", "Bearer fixture",
  "Host 192.0.2.1", "Value abcdef0123456789",
]) {
  test(`reject the whole unsafe label (${JSON.stringify(displayLabel)})`, () => {
    const result = makeSessionLabelProposal({ task, displayLabel })
    assert.deepEqual(result, unavailable("unsafe_label"))
    assert.equal(Object.hasOwn(result, "proposal"), false)
    assert.equal(Object.hasOwn(result, "text"), false)
  })
}

for (const displayLabel of ["Rotate API token", "Review password handling", "Fix browser boundary", "Review task.js"]) {
  test(`topic words and functional labels remain usable (${displayLabel})`, () => {
    assert.equal(makeSessionLabelProposal({ task, displayLabel }).proposal.text, displayLabel)
  })
}

for (const prefix of ["ghp_", "gho_", "ghs_", "ghu_", "ghr_", "github_pat_", "sk-"]) {
  for (const separator of ["-", ".", "_"]) {
    test(`known token prefixes remain unsafe after punctuation (${prefix}, ${separator})`, () => {
      const displayLabel = `Review prod${separator}${prefix}${"Gz".repeat(18)}`
      assert.deepEqual(makeSessionLabelProposal({ task, displayLabel }), unavailable("unsafe_label"))
    })
  }
}

test("a proposal is detached from the caller's mutable task object", () => {
  const supplied = { ...task }
  const { proposal } = makeSessionLabelProposal({ task: supplied, displayLabel: "Workflow review" })
  supplied.slug = "different-work"
  assert.deepEqual(proposal.task, task)
})

for (const invalidTask of [
  undefined, null, {}, { track: "engineering" },
  { ...task, track: null }, { ...task, track: "" }, { ...task, track: " " },
  { ...task, track: "." }, { ...task, track: ".." }, { ...task, track: "../foreign" },
  { ...task, slug: "bad\\task" }, { ...task, slug: "bad\nname" },
]) {
  test(`missing or invalid task identity cannot produce a proposal (${JSON.stringify(invalidTask)})`, () => {
    assert.deepEqual(makeSessionLabelProposal({ task: invalidTask, displayLabel: "Workflow review" }), unavailable("owner_unknown"))
  })
}

test("card status, delivery-shaped fields and supplied phase cannot assert native activity", () => {
  const result = makeSessionLabelProposal({
    task, displayLabel: "Workflow review", phase: "delivered",
    status: "processing", signoff: "accepted", nativeReceipt: { delivered: true },
  })
  assert.equal(result.proposal.phase, "unknown")
  assert.equal(result.state, undefined)
})
