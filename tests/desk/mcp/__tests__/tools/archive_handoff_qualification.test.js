// Regression qualification of the normal archive primitive in owned fixtures.
import "../_isolated_env.mjs"
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { promises as io } from "node:fs"
import path from "node:path"
import { task_archive, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { findCard } from "../../../../../plugins/desk/mcp/src/tools/task-focus.js"
import { readCleanupIndex } from "../../../../../plugins/desk/mcp/src/desk/cleanup-index.js"
import { activeTasks } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { ART, SLUG, RESOURCE, exists, digest, record, fixture, options, complete, readCard,
  openReadiness, requests, realGit, git, spawnActor, actorMessage, send, finishActor, drainActors, errorData, ownIdentity } from "./archive_handoff_qualification_child.mjs"

const reports = []
const readers = []
record("qualification-suite-start", await ownIdentity())
async function readiness(f, label) {
  const reader = await openReadiness(f, label)
  readers.push(reader)
  return reader
}
async function attempt(action) {
  try { return { result: await action(), error: null } }
  catch (error) { return { result: null, error: errorData(error) } }
}
function scenario(name, body) {
  test(name, { timeout: 35000 }, async () => {
    const report = { name, startedAt: new Date().toISOString() }
    try {
      const detail = await body()
      Object.assign(report, detail)
      report.failedCriteria = Object.entries(detail.checks).filter(([, okay]) => !okay).map(([key]) => key)
      report.verdict = report.failedCriteria.length ? "FAIL" : "PASS"
      fs.writeFileSync(path.join(ART, `${name}.json`), JSON.stringify(report, null, 2) + "\n")
      reports.push(report)
      assert.deepEqual(report.failedCriteria, [], `Desired archive criteria failed: ${report.failedCriteria.join(", ")}`)
    } catch (error) {
      if (!report.verdict) {
        report.verdict = "HARNESS_OR_UNEXPECTED_FAILURE"
        report.error = errorData(error)
        reports.push(report)
        fs.writeFileSync(path.join(ART, `${name}.json`), JSON.stringify(report, null, 2) + "\n")
      }
      throw error
    }
  })
}
after(async () => {
  const journals = await Promise.allSettled(readers.map((reader) => reader.journal.close()))
  const actors = await drainActors()
  const failures = journals.filter((item) => item.status === "rejected")
  const result = { reports: reports.map(({ name, verdict, failedCriteria, error }) => ({ name, verdict, failedCriteria, error })),
    actors, journalCloseFailures: failures.map((item) => String(item.reason)),
    retainedFixtures: true, noOperatorState: true, noNetworkPush: true, productSourceWritesByHarness: false }
  fs.writeFileSync(path.join(ART, "summary.json"), JSON.stringify(result, null, 2) + "\n")
  assert.equal(failures.length, 0)
})

async function terminalWorkflow(name, onGit) {
  const f = await fixture(name, { onGit, resource: true })
  const reader = await readiness(f, "workflow")
  let guardNegative = null
  if (onGit) {
    const original = await io.readFile(f.card)
    const head = git(f.root, "rev-parse", "HEAD")
    await io.appendFile(f.card, "\nOwned unflagged guard probe.\n")
    git(f.root, "add", "--", path.relative(f.root, f.card))
    const rejected = realGit("git", ["-C", f.root, "commit", "-m", "must refuse unflagged card edit"],
      { encoding: "utf8", env: { ...process.env, DESK_TOOL_COMMIT: "", DESK_CARD_GUARD_RUNNING: "" } })
    guardNegative = { status: rejected.status, stderr: rejected.stderr, headUnchanged: git(f.root, "rev-parse", "HEAD") === head }
    await io.writeFile(f.card, original)
    git(f.root, "add", "--", path.relative(f.root, f.card))
  }
  const updated = await complete(f, reader.readiness)
  const before = await io.readFile(f.card)
  const frontBefore = (await readCard(f.card)).data
  const trackBeforeArchive = await io.readFile(f.track, "utf8")
  const requestsBefore = await requests(f)
  const archived = await task_archive(options(f, { readiness: reader.readiness, input: { track: "t", slug: SLUG } }))
  const firstArchiveHead = onGit ? git(f.root, "rev-parse", "HEAD") : null
  const after = await io.readFile(f.archived)
  const frontAfter = (await readCard(f.archived)).data
  const found = await findCard({ deskRoot: f.root, person: null, track: "t", slug: SLUG })
  const cleanupKeys = await readCleanupIndex(f.root, f.env)
  const boot = await activeTasks(f.root, { env: f.env })
  const track = await io.readFile(f.track, "utf8")
  const link = /\[task\]\(([^)]+)\)/u.exec(track)?.[1]
  const journal = reader.journal.replay()
  const requestsAfter = await requests(f)
  const retryBefore = await requests(f)
  const retried = await task_archive(options(f, { readiness: reader.readiness, input: { track: "t", slug: SLUG } }))
  const retryAfter = await requests(f)
  const finalHead = onGit ? git(f.root, "rev-parse", "HEAD") : null
  return {
    root: f.root, updated, archived, retried, guardNegative,
    beforeFrontmatter: frontBefore, afterFrontmatter: frontAfter, beforeHash: digest(before), afterHash: digest(after),
    requestsBefore, requestsAfter, retryBefore, retryAfter, cleanupKeys, boot, track, link, journal,
    git: onGit ? { firstArchiveHead, finalHead, status: git(f.root, "status", "--short"),
      published: git(f.root, "ls-tree", "-r", "--name-only", "HEAD") } : null,
    checks: {
      actualFolderAndQuery: !exists(f.src) && found?.file === f.archived && found.archived === true,
      terminalCardByteIdentity: before.equals(after),
      oneDeliveryAndUnsignedSignoffPreserved: frontBefore.flow.deliveries === 1 &&
        JSON.stringify(frontBefore.flow) === JSON.stringify(frontAfter.flow) &&
        JSON.stringify(frontBefore.evidence) === JSON.stringify(frontAfter.evidence) &&
        frontAfter.signoff?.state === "delivered_unsigned" && archived.signoff === "delivered_unsigned",
      sameFactoryJobs: ["finalize", "evaluate-requests"].every((kind) => requestsBefore[kind].length === 1 &&
        requestsAfter[kind].length === 1 && requestsBefore[kind][0].record.job === requestsAfter[kind][0].record.job),
      trackRowStateStillTerminal: track.includes(`| \`${SLUG}\` | done |`),
      trackTaskLinkResolvesAfterArchive: Boolean(link && exists(path.resolve(path.dirname(f.track), link))),
      trackOtherCellsPreserved: track === trackBeforeArchive.replace(
        `[task](${SLUG}/task.md)`, `[task](_archive/${SLUG}/task.md)`),
      journalCoversBothMoveSubtrees: journal.changes.some((item) => item.path === `t/${SLUG}` && item.operation === "delete") &&
        journal.changes.some((item) => item.path === `t/_archive/${SLUG}` && item.operation === "write"),
      journalCoversActuallyChangedTrackRow: journal.changes.some((item) => item.path === "t/track.md"),
      cleanupLiveKeyResolvesArchivedCard: cleanupKeys.includes(`t/${SLUG}`) && boot.cleanup?.items === 1 &&
        boot.cleanup.finished.some((item) => item.due === 1),
      retryNoSecondGitCommitOrCompletion: retried.status === "already_archived" && firstArchiveHead === finalHead &&
        JSON.stringify(frontAfter) === JSON.stringify((await readCard(f.archived)).data),
      realGuardAndPublication: !onGit || (guardNegative.status !== 0 && guardNegative.headUnchanged &&
        !archived.commit && git(f.root, "ls-tree", "-r", "--name-only", "HEAD").includes(`t/_archive/${SLUG}/task.md`)),
    },
  }
}
scenario("01-nongit-terminal-update-then-normal-archive", () => terminalWorkflow("01-nongit", false))
scenario("02-git-guard-terminal-update-archive-and-retry", () => terminalWorkflow("02-git", true))

scenario("03-two-real-processes-race-the-same-folder", async () => {
  const variants = []
  for (const onGit of [false,true]) {
    const f = await fixture(`03-race-${onGit}`, { status: "done", onGit })
    const original = await io.readFile(f.card)
    const first = spawnActor("archive", f, "barrier")
    const second = spawnActor("archive", f, "barrier")
    await Promise.all([first.ready, second.ready])
    send(first, { cmd: "start" }); send(second, { cmd: "start" })
    const barriers = await Promise.all([actorMessage(first, "rename-barrier"), actorMessage(second, "rename-barrier")])
    send(first, { cmd: "go" }); send(second, { cmd: "go" })
    const outcomes = await Promise.all([actorMessage(first, "result"), actorMessage(second, "result")])
    await Promise.all([finishActor(first), finishActor(second)])
    const found = await findCard({ deskRoot: f.root, track: "t", slug: SLUG })
    const published = onGit ? git(f.root, "ls-tree", "-r", "--name-only", "HEAD") : null
    variants.push({ root:f.root,onGit,barriers,outcomes,exits:[first.exit,second.exit],found,
      oneWinner:outcomes.filter((item) => item.result?.status === "archived").length === 1 &&
        outcomes.filter((item) => item.error).length === 1,
      exactPayload:!exists(f.src) && exists(f.archived) &&
        original.equals(await io.readFile(f.archived)) && found?.file === f.archived,
      retired:first.exit.code === 0 && second.exit.code === 0,
      publication:!onGit || (git(f.root, "status", "--short") === "" &&
        published.includes(`t/_archive/${SLUG}/task.md`) && !published.includes(`t/${SLUG}/task.md`)) })
  }
  const summary = { scope:"owned two-process archive observations; criteria and product bytes unchanged",
    platform:process.platform,variants:variants.map(({root,onGit,outcomes,oneWinner,exactPayload,retired,publication}) => ({
      onGit,oneWinner,exactPayload,retired,publication,
      outcomes:outcomes.map(({result,error,renameReturned}) => ({
        status:result?.status ?? null,renameReturned,
        publication:result?.publication?.status ?? null,
        commitReason:result?.commit?.reason?.replaceAll(root,"<owned-root>") ?? null,
        error:error === null ? null : {name:error.name,code:error.code,phase:error.phase,
          message:error.message.replaceAll(root,"<owned-root>")},
      })),
    })) }
  fs.writeFileSync(new URL("../../../../../windows-archive-race-observations.json",import.meta.url),
    JSON.stringify(summary,null,2)+"\n")
  return { variants,
    checks: {
      exactlyOneArchiveAndOneHonestConflict:variants.every((row) => row.oneWinner),
      noOldPathWritesOrDuplicatePayload:variants.every((row) => row.exactPayload),
      actualProcessesRetiredNormally:variants.every((row) => row.retired),
      exactGitPublication:variants.every((row) => row.publication),
    } }
})

scenario("04-crash-after-real-rename-normal-retry-recovers-publication", async () => {
  const f = await fixture("04-crash", { onGit: true, status: "done" })
  const beforeHead = git(f.root, "rev-parse", "HEAD")
  const beforeCard = await io.readFile(f.card)
  const actor = spawnActor("archive", f, "exit-after-rename")
  await actor.ready
  send(actor, { cmd: "start" })
  const barrier = await actorMessage(actor, "rename-barrier")
  send(actor, { cmd: "go" })
  const exit = await actor.ended
  const crash = JSON.parse(await io.readFile(path.join(f.base, "crash-after-rename.json"), "utf8"))
  const headAfterCrashBeforeRetry = git(f.root, "rev-parse", "HEAD")
  const foundBeforeRetry = await findCard({ deskRoot: f.root, track: "t", slug: SLUG })
  const reader = await readiness(f, "fresh-retry")
  const retried = await attempt(() => task_archive(options(f, { readiness: reader.readiness, input: { track: "t", slug: SLUG } })))
  const published = git(f.root, "ls-tree", "-r", "--name-only", "HEAD").split("\n")
  const status = git(f.root, "status", "--short")
  const journal = reader.journal.replay()
  const repaired = published.includes(`t/_archive/${SLUG}/task.md`) && !published.includes(`t/${SLUG}/task.md`) &&
    journal.changes.some((row) => row.path === `t/${SLUG}` && row.operation === "delete") &&
    journal.changes.some((row) => row.path === `t/_archive/${SLUG}` && row.operation === "write")
  const honestPending = retried.result?.status === "archive_pending" &&
    retried.result.path === `t/_archive/${SLUG}/task.md` &&
    ["pending", "unknown"].includes(retried.result.publication?.status) &&
    typeof retried.result.next_action === "string" && retried.result.next_action.length > 0 &&
    retried.result.commit?.status === "failed"
  return { root: f.root, barrier, exit, crash, foundBeforeRetry, retried, beforeHead, headAfterCrashBeforeRetry,
    afterHead: git(f.root, "rev-parse", "HEAD"), published, status, journal, factoryRequests: await requests(f),
    checks: {
      // New required Git preflight reads are allowed; no publication/hook has begun.
      qualifiedInjectionNoGitPublicationOrHookBeforeExit: exit.code === 37 &&
        crash.gitPublicationCallsBeforeExit === 0 && headAfterCrashBeforeRetry === beforeHead,
      noInventedCompletionOrLostPayload: beforeCard.equals(await io.readFile(f.archived)),
      retryRepairsOrTruthfullyDisclosesLostPublicationAndJournal: repaired || honestPending,
    } }
})

scenario("05-parent-replacement-outside-prefix-is-refused-or-qualified", async () => {
  const f = await fixture("05-parent", { person: "alice", status: "done" })
  const original = await io.readFile(f.card)
  const outside = path.join(f.base, "owned-outside-effective-prefix")
  await io.mkdir(outside)
  const actor = spawnActor("archive", f, "barrier")
  await actor.ready; send(actor, { cmd: "start" })
  const barrier = await actorMessage(actor, "rename-barrier")
  const oldParent = path.dirname(f.dst)
  await io.rename(oldParent, path.join(f.base, "owned-parent-backup"))
  await io.symlink(outside, oldParent, process.platform === "win32" ? "junction" : "dir")
  send(actor, { cmd: "go" })
  const outcome = await actorMessage(actor, "result")
  await finishActor(actor)
  const outsideCard = path.join(outside, SLUG, "task.md")
  const escaped = exists(outsideCard)
  const refusedBeforeMove = Boolean(outcome.error) && exists(f.card) && !escaped
  const qualifiedLatePartial = Boolean(outcome.error) && outcome.error.actual_path === outsideCard &&
    outcome.error.phase === "relocated_outside_boundary" && !outcome.result
  return { root: f.root, person: f.person, barrier, outside, outsideCard, escaped, outcome,
    actualPath: escaped ? await io.realpath(outsideCard) : exists(f.card) ? f.card : null,
    checks: {
      knownReplacementRefusedOrActualPlacementQualified: refusedBeforeMove || qualifiedLatePartial,
      originalPayloadNotLost: original.equals(await io.readFile(escaped ? outsideCard : f.card)),
      noFakeSuccess: !outcome.result,
    } }
})

scenario("06-head-index-destination-occupancy-refuses-before-write", async () => {
  const variants = []
  for (const stagedDelete of [false, true]) {
    const f = await fixture(`06-destination-${stagedDelete}`, { onGit: true, status: "done" })
    await io.mkdir(f.dst)
    await io.writeFile(f.archived, "---\nschema_version: 1\nstatus: cancelled\ncreated: 2020-01-01T00:00:00.000Z\n---\nFOREIGN_ARCHIVE_PAYLOAD\n")
    git(f.root, "add", "--", path.relative(f.root, f.dst))
    git(f.root, "commit", "-q", "-m", "independent prior archive")
    const foreignBytes = await io.readFile(f.archived)
    await io.rename(f.dst, path.join(f.base, "owned-foreign-archive-backup"))
    if (stagedDelete) git(f.root, "add", "--", path.relative(f.root, f.dst))
    const head = git(f.root, "rev-parse", "HEAD")
    const index = git(f.root, "ls-files", "-s")
    const source = await io.readFile(f.card)
    const outcome = await attempt(() => task_archive(options(f, { input: { track: "t", slug: SLUG } })))
    variants.push({ stagedDelete, root: f.root, outcome, headBefore: head, headAfter: git(f.root, "rev-parse", "HEAD"),
      status: git(f.root, "status", "--short"), sourceStillPresent: exists(f.card),
      foreignBackupPreserved: foreignBytes.equals(await io.readFile(path.join(f.base, "owned-foreign-archive-backup", "task.md"))),
      refusedWithoutMutation: Boolean(outcome.error) && exists(f.card) && source.equals(await io.readFile(f.card)) &&
        git(f.root, "rev-parse", "HEAD") === head && git(f.root, "ls-files", "-s") === index })
  }
  return { variants, checks: {
    bothHeadAndStagedDeleteOccupancyRefused: variants.every((item) => item.refusedWithoutMutation),
    foreignPayloadBackupsRetained: variants.every((item) => item.foreignBackupPreserved),
  } }
})

scenario("07-dirty-and-untracked-companions-are-not-published", async () => {
  const variants = []
  for (const staged of [false, true]) {
    const f = await fixture(`07-companions-${staged}`, { onGit: true, status: "done" })
    const dirty = "FOREIGN_DIRTY_COMPANION\n"
    const untracked = "FOREIGN_UNTRACKED_COMPANION\n"
    await io.writeFile(path.join(f.src, "companion.txt"), dirty)
    if (staged) git(f.root, "add", "--", path.relative(f.root, path.join(f.src, "companion.txt")))
    await io.writeFile(path.join(f.src, "foreign.txt"), untracked)
    const head = git(f.root, "rev-parse", "HEAD")
    const index = git(f.root, "ls-files", "-s")
    const outcome = await attempt(() => task_archive(options(f, { input: { track: "t", slug: SLUG } })))
    const newPath = exists(f.src) ? f.src : f.dst
    const publishedPaths = git(f.root, "ls-tree", "-r", "--name-only", "HEAD")
    variants.push({ staged, root: f.root, outcome, publishedPaths, status: git(f.root, "status", "--short"),
      refusedUnchanged: Boolean(outcome.error) && exists(f.src) && git(f.root, "rev-parse", "HEAD") === head &&
        git(f.root, "ls-files", "-s") === index,
      publishedForeign: git(f.root, "rev-parse", "HEAD") !== head &&
        publishedPaths.includes(`t/_archive/${SLUG}/foreign.txt`),
      payloadsPreserved: await io.readFile(path.join(newPath, "companion.txt"), "utf8") === dirty &&
        await io.readFile(path.join(newPath, "foreign.txt"), "utf8") === untracked })
  }
  return { variants,
    checks: {
      dirtyOrStagedCompanionsRefusedBeforeMutation: variants.every((row) => row.refusedUnchanged),
      noAccidentalForeignPublication: variants.every((row) => !row.publishedForeign),
      bothForeignPayloadsPreserved: variants.every((row) => row.payloadsPreserved),
    } }
})

scenario("08-preflight-and-archived-resource-policy-preserve-records", async () => {
  const f = await fixture("08-policies", { person: "alice", resource: true })
  await io.mkdir(path.join(f.root, "desks", "bob"), { recursive: true })
  const original = await io.readFile(f.card)
  const wrong = await attempt(() => task_archive(options(f, { person: "bob", input: { track: "t", slug: SLUG } })))
  const badEvidence = await attempt(() => task_archive(options(f, { input: { track: "t", slug: SLUG,
    evidence: { kind: "non_code", ref: "does-not-exist.md" } } })))
  const untouched = original.equals(await io.readFile(f.card)) && !exists(f.dst)
  await complete(f)
  await task_archive(options(f, { input: { track: "t", slug: SLUG } }))
  const raw = await io.readFile(f.archived, "utf8")
  const front = raw.match(/^---[\s\S]*?\n---\n/u)?.[0]
  const requestsBefore = await requests(f)
  const mixed = await attempt(() => task_update(options(f, { input: { track: "t", slug: SLUG,
    note: "MUST_NOT_APPEND", resource: { identity: RESOURCE, disposition: "retained-with-trigger", details: "owner QA; trigger: qualification review" } } })))
  const mixedUntouched = raw === await io.readFile(f.archived, "utf8")
  const sameStatus = await attempt(() => task_update(options(f, { input: { track: "t", slug: SLUG, status: "done" } })))
  const disposition = await attempt(() => task_update(options(f, { input: { track: "t", slug: SLUG,
    resource: { identity: RESOURCE, disposition: "retained-with-trigger", details: "owner QA; trigger: qualification review" } } })))
  const after = await io.readFile(f.archived, "utf8")
  const requestsAfter = await requests(f)
  return { root: f.root, wrong, badEvidence, mixed, sameStatus, disposition, requestsBefore, requestsAfter,
    checks: {
      wrongPersonAndBadEvidenceRefuseBeforePayloadWrite: Boolean(wrong.error && badEvidence.error) && untouched,
      archivedMixedNeverReplaysAppend: Boolean(mixed.error) && mixedUntouched && !after.includes("MUST_NOT_APPEND"),
      narrowResourceDispositionWorksWithoutCompletionOrAcceptance: disposition.result?.status === "updated" &&
        after.startsWith(front) && after.includes("retained-with-trigger") &&
        (await readCard(f.archived)).data.signoff.state === "delivered_unsigned",
      resourceOnlyDoesNotRequestFactoryAgain: JSON.stringify(requestsBefore) === JSON.stringify(requestsAfter),
    } }
})
