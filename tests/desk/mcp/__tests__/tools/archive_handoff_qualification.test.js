// Regression qualification of the normal archive primitive in owned fixtures.
import "../_isolated_env.mjs"
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { promises as io } from "node:fs"
import path from "node:path"
import { EventEmitter } from "node:events"
import { task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { findCard } from "../../../../../plugins/desk/mcp/src/tools/task-focus.js"
import { readCleanupIndex } from "../../../../../plugins/desk/mcp/src/desk/cleanup-index.js"
import { activeTasks } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { ART, SLUG, RESOURCE, exists, digest, record, fixture, options, complete, readCard,
  openReadiness, requests, realGit, git, spawnActor, actorMessage, send, finishActor, drainActors, errorData, ownIdentity,
  nativeMoveObserver, nativeActorObservations, drainWithNativeObservations,
  archiveOwned, archiveCandidateObservations, archiveProductionObservations } from "./archive_handoff_qualification_child.mjs"

const reports = []
const readers = []
record("qualification-suite-start", await ownIdentity())
// Preserve the old Directory.Move observer controls as historical, not default proof.
const moveForObserverControl = () => import("./_legacy_directory_move.mjs")
function observedChild({ requestOutput, releaseOutput } = {}) {
  const child = new EventEmitter()
  child.pid = 42
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  const writes = [], ends = []
  const emit = item => child.stdout.emit("data", Buffer.from(typeof item === "string" ? item : JSON.stringify(item) + "\n"))
  const close = code => { child.emit("exit", code, null); child.emit("close", code, null) }
  child.stdin.write = function (...args) {
    writes.push({ receiverMatches: this === child.stdin, args })
    const callback = args.find(item => typeof item === "function")
    if (callback) callback()
    queueMicrotask(() => emit(requestOutput ?? { state: "ready", pid: child.pid, powershell: "5.1", runtime: "4.0",
      edition: "Desktop", api: "System.IO.Directory.Move" }))
    return false
  }
  child.stdin.end = function (...args) {
    ends.push({ receiverMatches: this === child.stdin, args })
    const callback = args.find(item => typeof item === "function")
    if (callback) callback()
    queueMicrotask(() => {
      if (args[0]) {
        for (const item of releaseOutput ?? [{ state: "result", moved: true, exception: null, hresult: null }]) emit(item)
        close(releaseOutput?.[0]?.moved === false ? 3 : 0)
      } else close(2)
    })
    return this
  }
  queueMicrotask(() => child.emit("spawn"))
  return { child, writes, ends }
}

test("passive native receipt preserves real helper outcomes, child events and pipe forwarding", async () => {
  const { moveArchive } = await moveForObserverControl()
  const source = "C:\\owned\\source", destination = "C:\\owned\\archive", fixture = { src: source, dst: destination }
  const f = observedChild()
  let spawnArguments
  const observer = nativeMoveObserver({ source, destination, fixture, spawnChild(...args) {
    spawnArguments = args
    return f.child
  } })
  const state = await moveArchive(source, destination, async () => observer.event("freshness-callback-completed"), {
    platform: "win32", env: { SystemRoot: "C:\\Windows" }, realpath: async value => value, spawn: observer.spawn,
  })
  observer.returned(state)
  assert.equal(state.movement, "confirmed")
  assert.equal(observer.receipt.executableMatches, true)
  assert.equal(observer.receipt.ready.pidMatchesChild, true)
  assert.deepEqual(observer.receipt.ack, { valid: true, moved: true, exception: null, hresult: null })
  assert.deepEqual(observer.receipt.close, { code: 0, signal: null })
  assert.deepEqual(observer.receipt.protocolIssues, [])
  assert.equal(observer.receipt.events.filter(item => item.type === "native-child-exit").length, 1)
  assert.equal(observer.receipt.events.filter(item => item.type === "native-child-close").length, 1)

  const forwarded = observedChild(), second = nativeMoveObserver({ source, destination, fixture, spawnChild(...args) {
    assert.deepEqual(args, spawnArguments)
    return forwarded.child
  } })
  const observed = second.spawn(...spawnArguments)
  let writes = 0, ends = 0
  const onWrite = () => { writes += 1 }, onEnd = () => { ends += 1 }
  assert.equal(observed, forwarded.child)
  assert.equal(observed.stdin.write("{}", "utf8", onWrite), false)
  assert.equal(observed.stdin.end("move\n", "utf8", onEnd), forwarded.child.stdin)
  assert.equal(writes, 1)
  assert.equal(ends, 1)
  assert.deepEqual(forwarded.writes, [{ receiverMatches: true, args: ["{}", "utf8", onWrite] }])
  assert.deepEqual(forwarded.ends, [{ receiverMatches: true, args: ["move\n", "utf8", onEnd] }])
})

for (const [name, options, issue] of [
  ["malformed", { requestOutput: "DO_NOT_RETAIN\n" }, "malformed_json"],
  ["unknown", { requestOutput: { state: "other", secret: "DO_NOT_RETAIN" } }, "unexpected_protocol_state"],
  ["oversized", { requestOutput: "DO_NOT_RETAIN".repeat(2000) }, "stdout_oversized"],
  ["duplicate", { releaseOutput: Array(2).fill({ state: "result", moved: true, exception: null, hresult: null }) }, "duplicate_result"],
]) {
  test(`passive native receipt keeps ${name} protocol failure explicit and private`, async () => {
    const { moveArchive } = await moveForObserverControl()
    const source = "C:\\owned\\source", destination = "C:\\owned\\archive"
    const f = observedChild(options)
    const observer = nativeMoveObserver({ source, destination, fixture: { src: source, dst: destination }, spawnChild: () => f.child })
    await assert.rejects(moveArchive(source, destination, async () => {}, {
      platform: "win32", env: { SystemRoot: "C:\\Windows" }, realpath: async value => value, spawn: observer.spawn,
    }), error => {
      observer.threw(error)
      assert.equal(observer.receipt.helper.outcome, "threw")
      assert.ok(observer.receipt.protocolIssues.includes(issue))
      assert.equal(JSON.stringify(observer.receipt).includes("DO_NOT_RETAIN"), false)
      return true
    })
  })
}

test("native receipt cleanup retains successful drain results", async () => {
  const actors = []
  let retained
  assert.equal(await drainWithNativeObservations(async () => actors, (value, error) => {
    retained = value
    assert.equal(error, undefined)
  }), actors)
  assert.equal(retained, actors)
})

test("native receipt cleanup persists partial observations before rethrowing the exact teardown failure", async () => {
  const failure = new Error("owned teardown failed")
  let retained = false
  await assert.rejects(drainWithNativeObservations(async () => { throw failure }, (value, error) => {
    assert.equal(value, undefined)
    assert.equal(error, failure)
    retained = true
  }), error => error === failure)
  assert.equal(retained, true)
})

test("native receipt cleanup does not replace teardown failure when observation persistence also fails", async t => {
  const failure = new Error("owned teardown failed")
  const logged = t.mock.method(console, "error", () => {})
  let retained = false
  await assert.rejects(drainWithNativeObservations(async () => { throw failure }, () => {
    retained = true
    throw Object.assign(new Error("private persistence detail"), { code: "EIO" })
  }), error => error === failure)
  assert.equal(retained, true)
  assert.deepEqual(logged.mock.calls[0].arguments, ["Passive native observation persistence failed:", "EIO"])
})

test("native receipt cleanup does not convert a persistence failure into success", async () => {
  const failure = new Error("owned persistence failed")
  await assert.rejects(drainWithNativeObservations(async () => [], () => { throw failure }),
    error => error === failure)
})
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
  const failures = journals.filter((item) => item.status === "rejected")
  await drainWithNativeObservations(drainActors, (actors, teardownError) => {
    const result = { reports: reports.map(({ name, verdict, failedCriteria, error }) => ({ name, verdict, failedCriteria, error })),
      actors: actors ?? null, actorTeardownFailed: teardownError !== undefined,
      journalCloseFailures: failures.map((item) => String(item.reason)),
      retainedFixtures: true, noOperatorState: true, noNetworkPush: true, productSourceWritesByHarness: false }
    try {
      const target = new URL("../../../../../windows-archive-race-observations.json", import.meta.url)
      const artifact = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) :
        { scope: "owned two-process archive observations; criteria and product bytes unchanged", platform: process.platform, variants: [] }
      artifact.actorReceipts = nativeActorObservations()
      artifact.candidateAttempts = archiveCandidateObservations()
      artifact.productionAttempts = archiveProductionObservations()
      fs.writeFileSync(target, JSON.stringify(artifact, null, 2) + "\n")
    } catch (error) { result.observationPersistenceFailure = error.code ?? "unavailable" }
    fs.writeFileSync(path.join(ART, "summary.json"), JSON.stringify(result, null, 2) + "\n")
    assert.equal(result.observationPersistenceFailure, undefined, "Passive observation persistence failed; original scenario verdicts are unchanged")
  })
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
  const updated = await complete(f, reader.search)
  const before = await io.readFile(f.card)
  const frontBefore = (await readCard(f.card)).data
  const trackBeforeArchive = await io.readFile(f.track, "utf8")
  const requestsBefore = await requests(f)
  const archived = await archiveOwned(f, { search: reader.search, input: { track: "t", slug: SLUG } })
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
  const retried = await archiveOwned(f, { search: reader.search, input: { track: "t", slug: SLUG } })
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
      journalCoversBothMoveSubtrees: journal.changes.includes(`t/${SLUG}`) && journal.changes.includes(`t/_archive/${SLUG}`),
      journalCoversActuallyChangedTrackRow: journal.changes.includes("t/track.md"),
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
      caseId:digest(root),onGit,oneWinner,exactPayload,retired,publication,
      outcomes:outcomes.map(({result,error,renameReturned,moveObservation}) => ({
        status:result?.status ?? null,renameReturned,moveObservation,
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
  const retried = await attempt(() => archiveOwned(f, { search: reader.search, input: { track: "t", slug: SLUG } }))
  const published = git(f.root, "ls-tree", "-r", "--name-only", "HEAD").split("\n")
  const status = git(f.root, "status", "--short")
  const journal = reader.journal.replay()
  const repaired = published.includes(`t/_archive/${SLUG}/task.md`) && !published.includes(`t/${SLUG}/task.md`) &&
    journal.changes.includes(`t/${SLUG}`) && journal.changes.includes(`t/_archive/${SLUG}`)
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
    const outcome = await attempt(() => archiveOwned(f, { input: { track: "t", slug: SLUG } }))
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
    const outcome = await attempt(() => archiveOwned(f, { input: { track: "t", slug: SLUG } }))
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
  const wrong = await attempt(() => archiveOwned(f, { person: "bob", input: { track: "t", slug: SLUG } }))
  const badEvidence = await attempt(() => archiveOwned(f, { input: { track: "t", slug: SLUG,
    evidence: { kind: "non_code", ref: "does-not-exist.md" } } }))
  const untouched = original.equals(await io.readFile(f.card)) && !exists(f.dst)
  await complete(f)
  await archiveOwned(f, { input: { track: "t", slug: SLUG } })
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
