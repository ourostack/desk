import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"

const pluginRoot = new URL("../../../", import.meta.url)
const read = (relativePath) => readFileSync(new URL(relativePath, pluginRoot), "utf8")

for (const agent of ["agents/worker.md", "agents/worker.agent.md"]) {
  test(`${agent} binds long-running work to bounded process continuity`, () => {
    const source = read(agent)
    assert.match(source, /Long-lived work, bounded processes/u)
    assert.match(source, /session-resumption.*checkpoint|checkpoint.*session-resumption/u)
    assert.match(source, /process exit is not task completion/u)
    assert.match(source, /mapped.*progress.*rulings/u)
    assert.match(source, /entire writer tree.*released/u)
    assert.match(source, /delivery.*git-hygiene/u)
    assert.match(source, /cleanup_pending.*validating/u)
  })
}

test("resumption preserves actual source and unfinished work before a handoff", () => {
  const source = read("skills/session-resumption/SKILL.md")
  assert.match(source, /## Checkpoint before handoff/u)
  for (const requirement of [
    /same work-item identity/u,
    /exact repository.*revisions/u,
    /uncommitted.*untracked/u,
    /local-only commits/u,
    /pending external side effects/u,
    /hashes.*read-back/u,
    /same-host.*not.*off-host/u,
  ]) assert.match(source, requirement)
})

test("resumption binds the explicit provider map and continuous task/ledger identity", () => {
  const source = read("skills/session-resumption/SKILL.md")
  for (const requirement of [
    /mapped `progressPath`.*`rulingsPath`/u,
    /explicit provider progress.*not.*universal `doing\.md`/u,
    /--progress-path.*existing `doing\.md`.*`task\.md`/u,
    /canonical task.*work-ledger identity/u,
    /exact source and unfinished-file hashes/u,
    /step\/attempt.*findings.*active writers.*unresolved.*next expected step/u,
    /new attempt.*preserve.*earlier/u,
    /private measurement outside Git/u,
  ]) assert.match(source, requirement)
  assert.doesNotMatch(source, /same work-item identity, task card and existing doing record|canonical doing record/u)
})

test("recovery admission distinguishes owner release from stale process labels", () => {
  const source = read("skills/session-resumption/SKILL.md")
  assert.match(source, /## Fresh-process recovery/u)
  for (const requirement of [
    /process generation/u,
    /descendants/u,
    /before.*writer/u,
    /fresh process.*bounded handoff/u,
    /do not replay.*transcript/u,
    /reconcile.*external side effects/u,
    /missing, corrupt, stale/u,
  ]) assert.match(source, requirement)
})

test("session-resumption owns bounded execution without creating a second lifecycle", () => {
  const source = read("skills/session-resumption/SKILL.md")
  assert.match(source, /## Bounded execution and recovery/u)
  assert.match(source, /completed integration.*delegation/u)
  assert.match(source, /before.*unattended/u)
  assert.match(source, /compaction.*failure/u)
  assert.match(source, /outside.*worker process/u)
  assert.match(source, /two consecutive.*interruption.*recovery/u)
  assert.match(source, /session-resumption/u)
  assert.match(source, /bounded findings.*artifact pointers/u)
  assert.match(source, /Context-token usage is not JavaScript heap usage/u)
  assert.match(source, /no new go or lifecycle/u)
  assert.match(source, /T16.*host lifecycle implementation/u)
  assert.match(source, /not.*watchdog.*restart service/u)
})

test("task lifecycle uses mapped progress and retains validating until cleanup is accounted for", () => {
  const source = read("skills/task-lifecycle/SKILL.md")
  assert.match(source, /mapped `progressPath`.*`rulingsPath`/u)
  assert.doesNotMatch(source, /canonical doing record|canonical doing.*same Desk file/u)
  assert.match(source, /`cleanup_pending`.*Markdown.*canonical.*`validating`/u)
  assert.match(source, /not a ninth.*state/u)
  assert.match(source, /resources.*at creation/u)
  for (const disposition of ["removed-and-absent", "named transfer", "retained-with-trigger"]) {
    assert.ok(source.includes(disposition), `missing resource disposition: ${disposition}`)
  }
  assert.match(source, /Every resource.*before.*`done`/u)
  assert.match(source, /No delivery daemon or schema/u)
})

test("delivery uses known repository policy, not a late provider finishing menu", () => {
  const source = read("skills/git-hygiene/SKILL.md")
  assert.match(source, /recorded repository policy.*literal finishing menu/u)
  assert.match(source, /repo-handling.*PR.*host-specific skills/u)
  assert.match(source, /Production ADO.*required human approval.*agent.*merges.*cleans/u)
  assert.match(source, /alpha.*forbids plugin main merge/u)
  assert.doesNotMatch(source, /\*\*At the delivery endpoint\*\*: use `desk:superpowers-integration`/u)
})

test("cleanup is exact-owned and absence-verified, not pattern-based or merge-only", () => {
  const source = read("skills/git-hygiene/SKILL.md")
  assert.match(source, /Never.*process-name patterns/u)
  assert.match(source, /exact.*process generation.*descendants/u)
  assert.match(source, /before deleting a worktree.*ownership.*absence.*writers/iu)
  assert.match(source, /uncommitted.*untracked.*local-only commits/u)
  assert.match(source, /removed-and-absent.*readback/u)
  assert.match(source, /named transfer.*retained-with-trigger/u)
})

test("delivery gates do not reopen satisfied approval or require unauthorized publication", () => {
  const lifecycle = read("skills/task-lifecycle/SKILL.md")
  const resumption = read("skills/session-resumption/SKILL.md")
  const git = read("skills/git-hygiene/SKILL.md")
  assert.doesNotMatch(lifecycle, /resumption is operator-initiated|implementation is complete; opens PR/u)
  const humanGate = resumption.split("\n").find(line => line.startsWith("| `collaborating` |"))
  assert.match(humanGate, /already satisfied.*resume/u)
  assert.doesNotMatch(git, /If the agent changed a file, it's committed and pushed/u)
  assert.match(git, /no-push.*preserve.*exact/u)
})

test("a matching upstream diff is not independent cleanup authority", () => {
  const source = read("skills/git-hygiene/SKILL.md")
  assert.doesNotMatch(source, /Empty diff →.*safe to delete/u)
  assert.match(source, /Empty diff.*content evidence.*not deletion authority/u)
  assert.match(source, /explicitly frozen base.*do not rebase/u)
})

test("continuation does not require keeping an exhausted runtime alive", () => {
  const source = read("principles.md")
  assert.match(source, /Verified resource exhaustion is not a phantom limit/u)
  assert.match(source, /process handoff continues.*mandate/u)
  assert.match(source, /not permission to return control/u)
})
