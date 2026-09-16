import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const workflowPath = path.join(repoRoot, ".github", "workflows", "desk-mcp-tests.yml")
const require = createRequire(import.meta.url)
const ZERO_SHA = "0".repeat(40)

// The shipped step is executed here, not paraphrased: a paraphrase is exactly how the all-zero "before" SHA
// stayed unhandled while a contract test still passed.
function publishRequestStepScript() {
  const { load } = require("js-yaml")
  const workflow = load(readFileSync(workflowPath, "utf8"))
  const step = (workflow.jobs["desk-mcp-tests"].steps ?? [])
    .find((candidate) => candidate.name === "Publish the relevant-revision evaluation request")
  assert.ok(step, "the workflow must still publish a relevant-revision request")
  assert.ok(typeof step.run === "string" && step.run.length > 0, "the request step must be a shell script")
  return step.run
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

function commitFile(cwd, relativePath, body) {
  const target = path.join(cwd, relativePath)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, body, "utf8")
  git(cwd, "add", relativePath)
  git(cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", `add ${relativePath}`)
  return git(cwd, "rev-parse", "HEAD")
}

function runRequestStep({ cwd, head, base }) {
  const result = spawnSync("bash", ["-c", publishRequestStepScript()], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      REVISION_REPOSITORY: "ourostack/ouroboros-skills",
      REVISION_REF: "refs/heads/v2-alpha",
      REVISION_HEAD: head,
      REVISION_BASE: base,
      REVISION_EVENT_ID: "fixture-1",
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(readFileSync(path.join(cwd, "revision-request.json"), "utf8"))
}

test("the published revision request covers the whole pushed range, including first pushes and root commits", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "revision-request-range-"))
  try {
    git(scratch, "init", "--initial-branch=v2-alpha")
    const rootCommit = commitFile(scratch, "plugins/desk/first.md", "one\n")

    // A root commit has no parent at all; the previous fallback died on `git rev-parse HEAD^`.
    const rootRequest = runRequestStep({ cwd: scratch, head: rootCommit, base: ZERO_SHA })
    assert.deepEqual(rootRequest.changedPaths, ["plugins/desk/first.md"])
    assert.equal(rootRequest.head, rootCommit)

    const second = commitFile(scratch, "plugins/desk/second.md", "two\n")
    const third = commitFile(scratch, "plugins/desk/third.md", "three\n")

    // A multi-commit first push reports the all-zero SHA; every pushed path must be reported, not just the
    // last commit's.
    const initialPush = runRequestStep({ cwd: scratch, head: third, base: ZERO_SHA })
    assert.deepEqual([...initialPush.changedPaths].sort(), [
      "plugins/desk/first.md",
      "plugins/desk/second.md",
      "plugins/desk/third.md",
    ])

    // An ordinary push keeps its exact range.
    const ordinary = runRequestStep({ cwd: scratch, head: third, base: second })
    assert.deepEqual(ordinary.changedPaths, ["plugins/desk/third.md"])

    // A base this clone cannot resolve — a force-push past the local history — reports every path at the
    // pushed head rather than the last commit's alone, because a missing base may only widen relevance.
    const unknownBase = runRequestStep({ cwd: scratch, head: third, base: "f".repeat(40) })
    assert.deepEqual([...unknownBase.changedPaths].sort(), [
      "plugins/desk/first.md",
      "plugins/desk/second.md",
      "plugins/desk/third.md",
    ])

    for (const request of [rootRequest, initialPush, ordinary, unknownBase]) {
      assert.equal(request.kind, "relevant_revision_request")
      assert.equal(request.repository, "ourostack/ouroboros-skills")
      assert.deepEqual(request.previousHeads, [])
      assert.equal(request.events.length, 1)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
