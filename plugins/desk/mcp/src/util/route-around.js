// What a Desk result that did not finish its commit gives the agent instead (#561, #623): the steps to finish the same
// commit another way, in order, and the read-backs that prove it worked. Desk tools only help: a tool's failure is never a
// reason to stop, and the route keeps every protection the tool had.
//
// Each step is an argv (run it as given, from any folder; no shell is needed, so nothing here depends on POSIX quoting)
// or a Desk tool call. Step 1 always only reads, because a failed or timed-out commit can still have landed.
//
// A route never commits whatever the paths hold now (R2, 0972 on #625): later bytes there may be another session's. When the
// failure carries the change Desk captured before it dispatched (`capture`: the entries with their modes, the HEAD and the
// branch), the route finishes exactly that change with `scripts/finish-commit.js`, which reads first, refuses on anything it
// cannot qualify, builds the commit from a private index with the repository's hooks run through Git, and moves the branch
// by one compare-and-swap against the HEAD it qualified, never touching the shared index or the working tree (R1, R3). After the publish, a read-only last step says whether those paths hold edits newer than the committed change; those are not delivered, and the route never folds them in. A live task card's captured change is held instead: only task_update
// commits a card, and a new task_update is a new write, never the captured change (0972 #2). A live card's change is finished only from Desk's own record of it, named by an id (capture-record.js), so a card whose record cannot be written is held. Without a capture the route is held: it reads, stops and reports, whether or not the commit landed. Committed here and published to the remote are separate facts with separate read-backs.
//
// What a route never contains: `git stash`, a force push, `git add`, `git commit`, `git reset`, `-a`/`-A`, `--no-verify`, the
// card guard's override variable, a hard-coded remote or branch (the published read-back compares with the checkout's own
// upstream), or a step that touches another session's index lock.

import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { writeCaptureRecord } from "./capture-record.js"
import { resolveDeskStateDir } from "../runtime/last-start.js"

const SYNC_PUSH_SCRIPT = fileURLToPath(new URL("../../scripts/sync-push.js", import.meta.url))
const FINISH_SCRIPT = fileURLToPath(new URL("../../scripts/finish-commit.js", import.meta.url))

/** The argv that hands `root` to Desk's own push worker, which never forces, takes its turn behind a push already running and replays in a private worktree. */
function publishArgv(root) {
  return [process.execPath, SYNC_PUSH_SCRIPT, "--root", root, "--debounce-ms", "0"]
}

function publishedWhen(root, paths) {
  return {
    argv: [["git", "-C", root, "fetch", "--quiet"], ["git", "-C", root, "diff", "--exit-code", "HEAD", "@{u}", "--", ...paths]],
    expect: "both exit 0 and the second prints nothing; a desk with no remote has nothing to publish, and committed_locally_when is the whole proof",
  }
}

/** The finish-commit argv for a captured change; `commit` adds the one dispatch. */
function finishArgv(root, paths, message, capture, commit = false) {
  return [
    process.execPath, FINISH_SCRIPT, "--root", root, "--branch", capture.branch, "--before", capture.before, "--message", message,
    ...paths.flatMap((p) => ["--path", p]), ...capture.expected.flatMap((line) => ["--entry", line]), ...(commit ? ["--commit"] : []),
  ]
}

/** The finish-commit argv for a change Desk recorded under `captureId`: the id names the change, and the paths and message are checked against it. */
function recordedArgv(root, paths, message, captureId, commit = false) {
  return [
    process.execPath, FINISH_SCRIPT, "--root", root, "--capture-id", captureId, "--message", message,
    ...paths.flatMap((p) => ["--path", p]), ...(commit ? ["--commit"] : []),
  ]
}

const READS_ONLY = "It changes nothing."
const STOP = "On exit 4 (held) or 5 (unknown): stop, change nothing, and report its JSON reason together with the tool's failure; only a person can settle it."

function deskPaths(root, deskRoot, paths) {
  return paths.map((p) => path.relative(deskRoot, path.resolve(root, p)).split(path.sep).join("/"))
}

/**
 * The route for a live task card's captured change (0972 #2 on ae1395e4). The card guard refuses a hand commit of a live card, so
 * only task_update commits one, and a new task_update appends a new note and takes along whatever the card and its track.md hold
 * by then: a new write, never this captured change. So the route reads where the captured change stands and stops; it calls no
 * tool, commits nothing and publishes nothing.
 */
function cardRoute({ root, paths, message, readback, card, capture }) {
  const check = finishArgv(root, paths, message, capture)
  return {
    summary: readback === "absent"
      ? `Desk's commit of the card ${card} did not land, and no step here can commit a live card safely. Read where the captured change stands, change nothing, and report.`
      : `Desk cannot tell whether its commit of the card ${card} landed, and no step here can commit a live card safely. Read where the captured change stands, change nothing, and report.`,
    steps: [
      { step: `Read back where the captured change stands. ${READS_ONLY} Exit 0: HEAD already holds exactly it, committed here, and Desk's next push of this desk carries it. Exit 3 (ready), 4 (held) or 5 (unknown): it is not committed, or Desk cannot tell.`, argv: check },
      { step: `Stop here: change nothing, and report step 1's JSON together with the tool's failure. Desk does not finish a live card by hand: the card guard refuses a hand commit, and that protection stays. A new task_update for ${card} appends a new note and commits whatever the card${paths.length > 1 ? ` and ${paths.slice(1).join(", ")}` : ""} hold by then, which may include another session's edit: that is a new write, not this captured change, so a person decides whether to make it.` },
    ],
    committed_locally_when: { argv: check, expect: "exits 0 and prints \"state\":\"committed\"; any other answer means this captured change is not proven committed, and nothing here commits it" },
    held: true,
  }
}

/**
 * The route for a live task card whose captured change Desk recorded (`captureId`, see capture-record.js): the read-back, finish,
 * publish and newer-bytes steps of any captured change. The finish names the record, so the card guard lets through only the
 * change Desk recorded; a hand commit of a card is still refused, and a finish with no record is not offered.
 */
function recordedCardRoute({ root, paths, message, readback, card, captureId, deskRoot }) {
  const check = recordedArgv(root, paths, message, captureId)
  const finish = recordedArgv(root, paths, message, captureId, true)
  const newer = [["git", "-C", root, "diff", "--quiet", "HEAD", "--", ...paths]]
  const publish = { step: "Publish through Desk's push worker.", argv: publishArgv(deskRoot) }
  const published_when = publishedWhen(root, paths)
  return {
    summary: readback === "absent"
      ? `Desk's commit of the card ${card} did not land. Finish exactly the change Desk recorded for it: read where it stands, commit it once only if the read says ready, publish, then read back the remote.`
      : `Desk cannot tell whether its commit of the card ${card} landed. Never repeat it blind: read where the recorded change stands first; commit it once only if the read says ready, otherwise stop and report.`,
    steps: [
      { step: `Read back where the recorded change stands. ${READS_ONLY} Exit 0: HEAD already holds exactly it, go straight to publishing. Exit 3 (ready): go on. ${STOP}`, argv: check },
      { step: `Only if step 1 exited 3 (ready): commit exactly the recorded change, once. The change comes from Desk's record named by ${captureId}; the command line only names that record and repeats its paths and message, which the command checks. The repository's commit hooks run through Git with Desk's own commit marker, so the card guard lets this one commit through; a hand commit of a card is still refused. The branch moves by one compare-and-swap against the HEAD step 1 qualified. Exit 0 means it is committed; on any other exit, read back again with step 1 and stop unless it now exits 0.`, argv: finish },
      publish,
      { step: `Read whether these paths hold anything newer than the change just committed. ${READS_ONLY} Exit 0: nothing newer, and the save is complete. Exit 1: the working tree holds later bytes this route did not commit; they are not delivered. If they are this session's own edits, save them with a Desk write of the same paths (task_update for the card, desk_save for other files). If they may be another session's, leave them and report them. Never fold them into this recorded change.`, argv: newer },
    ],
    committed_locally_when: { argv: [["git", "-C", root, "diff", "--exit-code", "HEAD", "--", ...paths], ["git", "-C", root, "log", "-1", "--format=%s", "--", ...paths]], expect: `the first exits 0 (nothing at these paths differs from HEAD) and the second prints "${message}"` },
    published_when,
    newer_unsaved_when: { argv: newer, expect: "exits 0 when nothing is newer; exits 1 means the working tree holds edits newer than the committed change, which are not delivered" },
  }
}

/**
 * The route for a commit Desk could not finish: exactly `paths` (relative to `root`) with `message`. `readback` is the commit's
 * read-back (`absent` or `unknown`); `capture` is the change Desk captured before dispatch (`{ before, branch, expected }`), when it
 * could; `card` names a live task card (`<track>/<slug>`) that is `paths[0]`, which the card guard lets in only through
 * task_update. Its route is finished from Desk's record of the change when `captureId` names one (see capture-record.js), and
 * held otherwise. `deskRoot` is the root a successful call hands `schedulePush`; the publish step uses exactly
 * it, never a nested `root`, because the push worker's lock and delivery state are keyed by it (R6), and Desk tool steps name
 * paths relative to it.
 */
export function commitRoute({ root, paths, message, readback = "unknown", card = null, deskRoot = root, capture = null, captureId = null }) {
  const publish = { step: "Publish through Desk's push worker.", argv: publishArgv(deskRoot) }
  const published_when = publishedWhen(root, paths)
  if (capture && card !== null) return captureId === null ? cardRoute({ root, paths, message, readback, card, capture }) : recordedCardRoute({ root, paths, message, readback, card, captureId, deskRoot })
  if (capture) {
    const check = finishArgv(root, paths, message, capture)
    const newer = [["git", "-C", root, "diff", "--quiet", "HEAD", "--", ...paths]]
    const finish = [{ step: "Only if step 1 exited 3 (ready): commit exactly the captured change, once. It builds the commit from a private index, runs the repository's commit hooks through Git, and moves the branch by one compare-and-swap against the HEAD step 1 qualified, so a branch another writer moved is refused, never overwritten; the shared index and the working tree are not written. Exit 0 means it is committed; on any other exit, read back again with step 1 and stop unless it now exits 0.", argv: finishArgv(root, paths, message, capture, true) }]
    return {
      summary: readback === "absent"
        ? "Desk's commit did not land. Finish exactly the change Desk captured: read where it stands, commit it once only if the read says ready, publish, then read back the remote."
        : "Desk cannot tell whether its commit landed. Never repeat it blind: read where the captured change stands first; commit it once only if the read says ready, otherwise stop and report.",
      steps: [
        { step: `Read back where the captured change stands. ${READS_ONLY} Exit 0: HEAD already holds exactly it, go straight to publishing. Exit 3 (ready): go on. ${STOP}`, argv: check },
        ...finish,
        publish,
        { step: `Read whether these paths hold anything newer than the change just committed. ${READS_ONLY} Exit 0: nothing newer, and the save is complete. Exit 1: the working tree holds later bytes this route did not commit; they are not delivered. If they are this session's own edits, save them with a new desk_save of the same paths; if they may be another session's, leave them and report them. Never fold them into this captured change.`, argv: newer },
      ],
      committed_locally_when: { argv: check, expect: "exits 0 and prints \"state\":\"committed\"" },
      published_when,
      newer_unsaved_when: { argv: newer, expect: "exits 0 when nothing is newer; exits 1 means the working tree holds edits newer than the committed change, which are not delivered" },
    }
  }
  // Without a capture nothing says which bytes at these paths are this call's (R2): a diff, a log line or a clean status is no
  // proof, and later bytes may be another session's. The route reads, stops and says so; it never commits, saves, updates a
  // card or publishes. The next write of the same thing commits it through the tool, with every protection the tool has.
  const look = { step: `Read what these paths hold beyond HEAD, and the last commit that touched them. ${READS_ONLY}`, argv: [["git", "-C", root, "diff", "HEAD", "--", ...paths], ["git", "-C", root, "log", "-1", "--format=%H %s", "--", ...paths]] }
  const what = card === null ? "the same write" : `a task_update for ${card}`
  return {
    summary: readback === "absent"
      ? "Desk's commit did not happen, and Desk could not capture the exact change, so no step here can commit it safely. Read where the paths stand, change nothing, and report."
      : "Desk cannot tell whether its commit landed, and it could not capture the exact change before dispatching it, so no step here can commit it safely. Read where the paths stand, change nothing, and report.",
    steps: [look, { step: `Stop here: change nothing, and report what step 1 showed together with the tool's failure. Whatever it shows is not proof that this call's change is or is not committed, and it may be another session's work. Once the tool's failure is fixed, ${what} commits the change through Desk, with every protection the tool has.` }],
    committed_locally_when: { argv: [["git", "-C", root, "diff", "HEAD", "--", ...paths], ["git", "-C", root, "log", "-1", "--format=%H %s", "--", ...paths]], expect: "no read here proves this call's commit: Desk did not capture the change, so report what these show and let a person or the next write settle it" },
    held: true,
  }
}

/** The failure object a commit step returns: `failed` when the commit did not land, `unknown` when Desk cannot tell, always with its route. */
export function commitFailure({ root, paths, message, committed, card = null, deskRoot = root }) {
  const readback = committed.readback === "absent" ? "absent" : "unknown"
  const capture = committed.capture ?? null
  const captureId = card !== null && capture !== null ? recordCapture({ root, paths, message, capture }) : null
  return {
    status: readback === "absent" ? "failed" : "unknown",
    reason: committed.stderr,
    ...(committed.landed ? { landed: committed.landed } : {}),
    route_around: commitRoute({ root, paths, message, readback, card, deskRoot, capture, captureId }),
  }
}

/**
 * Where an unfinished change is, which sets the first sentence of its `next` (#623): a commit's, a pull request's, or a lesson
 * whose improvement card is not written. The caller passes it, because the route's own shape does not say which it is.
 */
export const UNFINISHED = Object.freeze({ COMMIT: "commit", PULL_REQUEST: "pull_request", UNOPENED_CARD: "unopened_card", UNPUBLISHED: "unpublished" })

// `where` names the route's field in the result, so the sentence points at it.
export function unfinishedNext(route, where, kind = UNFINISHED.COMMIT) {
  if (kind === UNFINISHED.PULL_REQUEST) return `The change is on a pull request that has not merged: run ${where}.steps now, in order, then read back that it merged.`
  if (kind === UNFINISHED.UNOPENED_CARD) return `The lesson is recorded but its improvement card isn't written yet: run ${where}.steps now, in order, then read back that the card is open.`
  if (kind === UNFINISHED.UNPUBLISHED) return `The change was not published: no pull request for it has opened. Run ${where}.steps now, in order, then read back that it landed.`
  if (route.held) return `The change is on disk but not committed, and Desk will not finish it from here: read back with ${where}.steps step 1 (it only reads), then report its JSON together with the tool's failure.`
  return `The change is on disk but not committed or on the remote yet: run ${where}.steps now, in order, then read back the remote.`
}

/**
 * The answer with its `next` sentence as its first key, when the answer carries a route: its own `route_around`, else its
 * `commit`'s (#623). `kind` is what the answer's own `route_around` is; a commit's route is always a commit.
 */
export function withNext(answer, kind = UNFINISHED.COMMIT) {
  if (answer.route_around) return { next: unfinishedNext(answer.route_around, "route_around", kind), ...answer }
  if (answer.commit?.route_around) return { next: unfinishedNext(answer.commit.route_around, "commit.route_around"), ...answer }
  return answer
}

/** Desk's record of a card change it could not finish, or null when the state folder cannot be written (the route is then held). */
function recordCapture({ root, paths, message, capture }) {
  try {
    return writeCaptureRecord({ stateDir: resolveDeskStateDir(), root, paths, message, capture })
  } catch {
    return null
  }
}

/**
 * The route for a pull request Desk opened that has not merged (note_leave, lesson_add's team write, both through
 * shared-write.js): merge it by hand, then read it back. A queued pull request is read again later; any other state is reported.
 */
export function pullRequestRoute(pr) {
  return {
    summary: `Pull request ${pr} is open and has not merged, so the change is not on the default branch yet. Merge it by hand, then read it back.`,
    steps: [
      { step: `Read the pull request's state. ${READS_ONLY} OPEN and MERGEABLE: go on. QUEUED (a merge queue holds it): change nothing and read again later. Any other answer: stop and report it with the tool's result.`, argv: ["gh", "pr", "view", pr, "--json", "state,mergeable,mergeStateStatus"] },
      { step: `Only if step 1 showed OPEN and MERGEABLE: merge it once, by hand, as the GitHub account the tool's result names (\`account\`), with the same squash merge Desk runs.`, argv: ["gh", "pr", "merge", pr, "--squash"] },
    ],
    landed_when: { argv: ["gh", "pr", "view", pr, "--json", "state", "--jq", ".state"], expect: "prints MERGED" },
  }
}

/**
 * The route for a shared-repository write that stopped before its pull request merged (note_leave, lesson_add's team write):
 * read whether the change is already on the default branch, and if not, call the same tool again. The tool builds the change
 * from that branch again with every protection it has, so the route never writes to the repository by hand. `landed` is the
 * read-back (`argv` and what `expect` says it proves).
 */
export function retryRoute({ summary, landed, tool, arguments: args }) {
  return {
    summary,
    steps: [
      { step: `Read whether the change is already on the default branch. ${READS_ONLY} If it ${landed.expect}, it landed: stop.`, argv: landed.argv },
      { step: `Only if step 1 did not show it: fix the reason the tool gave, then call ${tool} again with the same arguments.`, tool, arguments: args },
    ],
    landed_when: landed,
  }
}

/**
 * The route for a change Desk wrote but deliberately left uncommitted because a file already held another session's
 * uncommitted edit (R1, R7). It only reads: committing the file whole would publish that edit as this call's, and no step
 * here resets an index entry or moves a branch, so another session's staged and unstaged work stays exactly as it is.
 * The change is committed through Desk's own desk_save once a read shows the files hold nothing else, a new file included.
 * `dir` is the folder the files are in, `names` the changed file names, `change` says in words what this call changed.
 */
export function heldFileRouteFor({ dir, names, message, change, deskRoot = dir }) {
  const files = names.join(" and ")
  return {
    summary: `${files} already held another session's uncommitted edit, so Desk did not commit. Nothing here changes that edit: read what the files hold, and commit this change through desk_save only once they hold nothing else; otherwise stop and report.`,
    steps: [
      { step: `Read what ${files} hold beyond HEAD. ${READS_ONLY} A file the second read marks \`??\` is new: neither read shows its content, so read it whole at ${names.map((name) => path.join(dir, name)).join(" or ")}.`, argv: [["git", "-C", dir, "diff", "HEAD", "--", ...names], ["git", "-C", dir, "status", "--porcelain", "--", ...names]] },
      { step: `Only once step 1 shows nothing but this call's change (${change}): commit exactly these files through desk_save. While anything else is there, stop, change nothing, and report it with the tool's failure.`, tool: "desk_save", arguments: { paths: deskPaths(dir, deskRoot, names), message } },
      { step: "Publish through Desk's push worker.", argv: publishArgv(deskRoot) },
    ],
    committed_locally_when: { argv: [["git", "-C", dir, "diff", "--exit-code", "HEAD", "--", ...names], ["git", "-C", dir, "log", "-1", "--format=%s", "--", ...names]], expect: `the first exits 0 and the second prints "${message}"` },
    published_when: publishedWhen(dir, names),
    never: `Never commit ${files} whole while they hold anything else: that publishes the other session's edit as this change. Never reset their index entries or move the branch by hand.`,
  }
}

/** How a reply says why a commit step left the change uncommitted: a commit that did not land is not one Desk cannot read back. */
export function commitFailureWords(commit) {
  if (commit.status === "unknown" && commit.landed)
    return `Desk's commit ${commit.landed.commit.slice(0, 12)} landed (${commit.reason}), but HEAD ${commit.landed.head.slice(0, 12)} no longer holds it, so Desk cannot tell whether it is in effect; route_around reads it back and changes nothing on its own`
  return commit.status === "unknown"
    ? `Desk cannot tell whether the commit landed (${commit.reason}); route_around reads it back before anything is committed again`
    : `the commit failed: ${commit.reason}; route_around finishes it`
}
