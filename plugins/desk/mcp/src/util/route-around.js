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
// by one compare-and-swap against the HEAD it qualified, never touching the shared index or the working tree (R1, R3). Without a capture the route is held: it reads, stops and reports, whether or not the commit landed. Committed here and published to the remote are separate facts with separate read-backs.
//
// What a route never contains: `git stash`, a force push, `git add`, `git commit`, `git reset`, `-a`/`-A`, `--no-verify`, the
// card guard's override variable, a hard-coded remote or branch (the published read-back compares with the checkout's own
// upstream), or a step that touches another session's index lock.

import * as path from "node:path"
import { fileURLToPath } from "node:url"

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

const READS_ONLY = "It changes nothing."
const STOP = "On exit 4 (held) or 5 (unknown): stop, change nothing, and report its JSON reason together with the tool's failure; only a person can settle it."

function deskPaths(root, deskRoot, paths) {
  return paths.map((p) => path.relative(deskRoot, path.resolve(root, p)).split(path.sep).join("/"))
}

/**
 * The route for a commit Desk could not finish: exactly `paths` (relative to `root`) with `message`. `readback` is the commit's
 * read-back (`absent` or `unknown`); `capture` is the change Desk captured before dispatch (`{ before, branch, expected }`), when it
 * could; `card` names a live task card (`<track>/<slug>`) that is `paths[0]`, which the card guard lets in only through
 * task_update. `deskRoot` is the root a successful call hands `schedulePush`; the publish step uses exactly it, never a nested
 * `root`, because the push worker's lock and delivery state are keyed by it (R6), and Desk tool steps name paths relative to it.
 */
export function commitRoute({ root, paths, message, readback = "unknown", card = null, deskRoot = root, capture = null }) {
  const publish = { step: "Publish through Desk's push worker.", argv: publishArgv(deskRoot) }
  const published_when = publishedWhen(root, paths)
  if (capture) {
    const check = finishArgv(root, paths, message, capture)
    const finish = card === null
      ? [{ step: "Only if step 1 exited 3 (ready): commit exactly the captured change, once. It builds the commit from a private index, runs the repository's commit hooks through Git, and moves the branch by one compare-and-swap against the HEAD step 1 qualified, so a branch another writer moved is refused, never overwritten; the shared index and the working tree are not written. Exit 0 means it is committed; on any other exit, read back again with step 1 and stop unless it now exits 0.", argv: finishArgv(root, paths, message, capture, true) }]
      : [{
        step: `Only if step 1 exited 3 (ready): call task_update for ${card} with a one-line note saying the earlier commit did not finish. Desk commits the card itself; the card guard refuses a hand commit of a live card, and that protection stays.${paths.length > 1 ? ` Then read ${paths.slice(1).join(", ")} with \`git diff HEAD\`, and only if it shows nothing but this call's change, commit ${paths.length > 2 ? "them" : "it"} through desk_save with exactly ${paths.length > 2 ? "those paths" : "that path"}.` : ""}`,
        tool: "task_update",
        arguments: { track: card.split("/")[0], slug: card.split("/").slice(1).join("/"), note: "Committing the card change an earlier call left uncommitted." },
      }]
    return {
      summary: readback === "absent"
        ? "Desk's commit did not land. Finish exactly the change Desk captured: read where it stands, commit it once only if the read says ready, publish, then read back the remote."
        : "Desk cannot tell whether its commit landed. Never repeat it blind: read where the captured change stands first; commit it once only if the read says ready, otherwise stop and report.",
      steps: [
        { step: `Read back where the captured change stands. ${READS_ONLY} Exit 0: HEAD already holds exactly it, go straight to publishing. Exit 3 (ready): go on. ${STOP}`, argv: check },
        ...finish,
        publish,
      ],
      committed_locally_when: { argv: check, expect: "exits 0 and prints \"state\":\"committed\"" },
      published_when,
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
  return {
    status: readback === "absent" ? "failed" : "unknown",
    reason: committed.stderr,
    ...(committed.landed ? { landed: committed.landed } : {}),
    route_around: commitRoute({ root, paths, message, readback, card, deskRoot, capture: committed.capture ?? null }),
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
      { step: `Read what ${files} hold beyond HEAD (a new file shows in the second read). ${READS_ONLY}`, argv: [["git", "-C", dir, "diff", "HEAD", "--", ...names], ["git", "-C", dir, "status", "--porcelain", "--", ...names]] },
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
