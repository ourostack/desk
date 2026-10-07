// The task card's iteration history names other documents by a desk-relative path or by a path relative to the task folder, in the spelling its platform uses.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { computeRefs } from "../../../../../plugins/desk/mcp/src/indexer/refs.js"

const doc = (path, kind, extra = {}) => ({ path, kind, track: "t", task_slug: "s", frontmatter: {}, ...extra })

test("iteration history entries become edges to the task, whichever way their path is spelled", () => {
  const task = doc("t/s/task.md", "task", {
    frontmatter: {
      iterations: {
        history: [
          { path: "t/s/_iterations/a.md", kind: "doing" },
          { path: "_iterations/b.md" },
          { path: "_iterations/c.md", kind: "" },
          { path: "missing.md", kind: "doing" },
          { path: "" },
          { path: 7 },
          null,
          "text",
        ],
      },
    },
  })
  const docs = [task, doc("t/s/_iterations/a.md", "other"), doc("t/s/_iterations/b.md", "other"), doc("t/s/_iterations/c.md", "other")]
  assert.deepEqual(computeRefs(docs), [
    { from: "t/s/_iterations/a.md", to: "t/s/task.md", ref_kind: "doing_of" },
    { from: "t/s/_iterations/b.md", to: "t/s/task.md", ref_kind: "iteration_of" },
    { from: "t/s/_iterations/c.md", to: "t/s/task.md", ref_kind: "iteration_of" },
  ])
})

test("a task whose history is not a list has no iteration edges", () => {
  assert.deepEqual(computeRefs([doc("t/s/task.md", "task", { frontmatter: { iterations: { history: "none" } } })]), [])
})

test("a planning, doing or feedback document is linked to its task card only when the card exists, and a repeated edge is kept once", () => {
  const task = doc("t/s/task.md", "task")
  const planning = doc("t/s/planning.md", "planning")
  const edges = computeRefs([task, planning, planning, doc("t/s/doing.md", "doing"), doc("t/s/feedback.md", "feedback")])
  assert.deepEqual(edges, [
    { from: "t/s/planning.md", to: "t/s/task.md", ref_kind: "planning_of" },
    { from: "t/s/doing.md", to: "t/s/task.md", ref_kind: "doing_of" },
    { from: "t/s/feedback.md", to: "t/s/task.md", ref_kind: "feedback_of" },
  ])
  assert.deepEqual(computeRefs([planning, doc("t/s/doing.md", "doing"), doc("t/s/feedback.md", "feedback")]), [])
})
