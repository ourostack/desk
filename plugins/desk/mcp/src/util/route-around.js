// What a Desk result that did not finish its commit gives the agent instead (#561, #623): the steps to finish the same
// commit by hand, in order, and the read-backs that prove it worked. Desk tools only help: a tool's failure is never a
// reason to stop, and the route keeps every protection the tool had.
//
// Each step is an argv (run it as given, from any folder; no shell is needed, so nothing here depends on POSIX quoting)
// or, for a live task card, the Desk tool that commits it. Step 1 is always a read-back, because a failed or timed-out
// commit can still have landed: nothing is committed again until the read-back says it is needed. Committed here and
// published to the remote are separate facts with separate read-backs.
//
// What a route never contains: `git stash`, a force push, `git add -f`, `-a`/`-A`, `--no-verify`, the card guard's override variable,
// a hard-coded remote or branch (the published read-back compares with the checkout's own upstream), or a step that
// touches another session's index lock.

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const SYNC_PUSH_SCRIPT = fileURLToPath(new URL("../../scripts/sync-push.js", import.meta.url))

/** The argv that hands `root` to Desk's own push worker, which never forces, takes its turn behind a push already running and replays in a private worktree. */
function publishArgv(root) {
  return [process.execPath, SYNC_PUSH_SCRIPT, "--root", root, "--debounce-ms", "0"]
}

function readbacks(root, paths) {
  return {
    committed_locally_when: { argv: ["git", "-C", root, "status", "--porcelain", "--", ...paths], expect: "prints nothing" },
    published_when: {
      argv: [["git", "-C", root, "fetch", "--quiet"], ["git", "-C", root, "diff", "--exit-code", "HEAD", "@{u}", "--", ...paths]],
      expect: "both exit 0 and the second prints nothing; a desk with no remote has nothing to publish, and committed_locally_when is the whole proof",
    },
  }
}

// `git add` takes only the paths on disk (a new file has to be added before it can be committed); `git commit -- <paths>`
// then records every listed path as it is on disk, a deleted or moved-away one included.
function handCommit(root, paths, message, which) {
  const present = paths.filter((p) => existsSync(path.resolve(root, p)))
  return {
    step: `Only if step 1 listed any of ${which}: stage and commit exactly them, with this message. Never -a, -A, add -f, --no-verify, a stash or a way past the card guard.`,
    argv: [...(present.length > 0 ? [["git", "-C", root, "add", "--", ...present]] : []), ["git", "-C", root, "commit", "-m", message, "--", ...paths]],
  }
}

/**
 * The route for a commit Desk could not finish: exactly `paths` (relative to `root`) with `message`. `readback` is the
 * commit's read-back (`absent` or `unknown`); `card` names a live task card (`<track>/<slug>`) that is `paths[0]`, which
 * the card guard lets in only through task_update, so the route commits it there instead of by hand (any other paths are
 * committed by hand after it, never together with it). `deskRoot` is the root a successful call hands `schedulePush`; the
 * publish step uses exactly it, never a nested `root`, because the push worker's lock and delivery state are keyed by it (R6).
 */
export function commitRoute({ root, paths, message, readback = "unknown", card = null, deskRoot = root }) {
  const { committed_locally_when: local, published_when: published } = readbacks(root, paths)
  const commit = card === null
    ? [handCommit(root, paths, message, "these paths")]
    : [
      {
        step: `Only if step 1 listed ${paths[0]}: call task_update for ${card} with a one-line note saying the earlier commit did not finish. Desk commits the card with what it already holds; the card guard refuses a hand commit of a live card, and that protection stays.`,
        tool: "task_update",
        arguments: { track: card.split("/")[0], slug: card.split("/").slice(1).join("/"), note: "Committing the card change an earlier call left uncommitted." },
      },
      ...(paths.length > 1 ? [handCommit(root, paths.slice(1), message, "the other paths")] : []),
    ]
  return {
    summary: readback === "absent"
      ? "Desk's commit did not land. Finish it another way: read back, commit exactly these paths, publish, then read back the remote."
      : "Desk cannot tell whether its commit landed. Never repeat the commit blind: read back first, commit only what is still uncommitted, publish, then read back the remote.",
    steps: [
      { step: "Read back first. No output means these paths are already committed here: go straight to publishing.", argv: local.argv },
      ...commit,
      { step: "Publish through Desk's push worker.", argv: publishArgv(deskRoot) },
    ],
    committed_locally_when: local,
    published_when: published,
  }
}

/** The failure object a commit step returns: `failed` when the commit did not land, `unknown` when Desk cannot tell, always with its route. */
export function commitFailure({ root, paths, message, committed, card = null, deskRoot = root }) {
  const readback = committed.readback === "absent" ? "absent" : "unknown"
  return {
    status: readback === "absent" ? "failed" : "unknown",
    reason: committed.stderr,
    ...(committed.landed ? { landed: committed.landed } : {}),
    route_around: commitRoute({ root, paths, message, readback, card, deskRoot }),
  }
}

/**
 * The route for a change Desk wrote but deliberately left uncommitted because a file already held another session's
 * uncommitted edit: committing the file would publish that edit as this call's. The same change is committed from a
 * temporary worktree at HEAD that checks out only these files, the branch is moved to that commit only if it has not
 * moved, and the index entries for the files are reset to the new HEAD, so the other session's edit stays in the
 * working tree, uncommitted and untouched.
 * `dir` is the folder the files are in, `prefix` that folder relative to the repository's top (Git's `--show-prefix`),
 * `names` the file names, `branch` the checked-out branch, `head` HEAD's full hash, `worktree` an unused folder for the
 * temporary worktree, and `change` says in words what to make the same in the worktree's copies.
 */
function heldFileRoute({ dir, prefix, names, message, branch, head, change, worktree, deskRoot }) {
  const tempBranch = `desk-route/${path.basename(worktree)}`
  const inWorktree = path.join(worktree, ...prefix.split("/").filter(Boolean))
  const files = names.join(" and ")
  return {
    summary: `${files} already held another session's uncommitted edit, so Desk did not commit. Commit only this change from a temporary worktree, leaving that edit where it is, then publish and read back the remote.`,
    steps: [
      { step: "Make a temporary worktree at HEAD on a temporary branch, with only these files checked out (any unused folder you own will do for the worktree).", argv: [
        ["git", "-C", dir, "worktree", "add", "--no-checkout", "-b", tempBranch, worktree, head],
        ["git", "-C", worktree, "reset", "-q"],
        ["git", "-C", worktree, "checkout", head, "--", ...names.map((name) => [prefix, name].filter(Boolean).join(""))],
      ] },
      { step: `In ${inWorktree}, ${change}. Change nothing else.` },
      { step: "Commit exactly those files there.", argv: [["git", "-C", inWorktree, "add", "--", ...names], ["git", "-C", inWorktree, "commit", "-m", message, "--", ...names]] },
      { step: `Move ${branch} to that commit only if it still points where it did; this fails safely if anything moved, and then you start again from step 1 at the new HEAD.`, argv: ["git", "-C", dir, "update-ref", `refs/heads/${branch}`, tempBranch, head] },
      { step: "Point the index entries for these files at the new HEAD. The working tree keeps the other session's edit, still uncommitted.", argv: ["git", "-C", dir, "reset", "-q", "--", ...names] },
      { step: `Delete the folder ${worktree} (the temporary worktree from step 1, and nothing else), then let Git forget it and drop the temporary branch.`, argv: [["git", "-C", dir, "worktree", "prune"], ["git", "-C", dir, "branch", "-d", tempBranch]] },
      { step: "Publish through Desk's push worker.", argv: publishArgv(deskRoot) },
    ],
    committed_locally_when: { argv: ["git", "-C", dir, "diff", "HEAD", "--", ...names], expect: "shows only the other session's edit, never this change" },
    published_when: readbacks(dir, names).published_when,
    never: `Never commit ${files} whole: that publishes the other session's edit as this change.`,
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

function gitLine(spawnGit, dir, args) {
  const answer = spawnGit("git", ["-C", dir, ...args], { windowsHide: true, encoding: "utf8", timeout: 10_000 })
  return answer.status === 0 && typeof answer.stdout === "string" ? answer.stdout.replace(/\r?\n$/u, "") : null
}

/**
 * heldFileRoute for the files `names` in `dir`, reading the branch, HEAD and the folder's place in the repository from Git.
 * The temporary worktree goes beside the repository, in a folder named for this call. When Git cannot say (a detached or
 * unborn HEAD), the route says what to do in words and still never commits the held files whole.
 */
export function heldFileRouteFor({ dir, names, message, change, spawnGit, deskRoot = dir }) {
  const top = gitLine(spawnGit, dir, ["rev-parse", "--show-toplevel"])
  const prefix = gitLine(spawnGit, dir, ["rev-parse", "--show-prefix"])
  const branch = gitLine(spawnGit, dir, ["symbolic-ref", "--short", "-q", "HEAD"])
  const head = gitLine(spawnGit, dir, ["rev-parse", "--verify", "-q", "HEAD"])
  if (top && prefix !== null && branch && head) {
    const worktree = `${path.resolve(top)}.desk-route-${randomBytes(4).toString("hex")}`
    return heldFileRoute({ dir, prefix, names, message, branch, head, change, worktree, deskRoot })
  }
  const files = names.join(" and ")
  return {
    summary: `${files} already held another session's uncommitted edit, so Desk did not commit, and Git could not name the branch and HEAD to build the exact commands.`,
    steps: [
      { step: "Read back what the files hold that is not committed.", argv: ["git", "-C", dir, "diff", "HEAD", "--", ...names] },
      { step: `Make a temporary worktree at the commit the checkout's branch points to, ${change} in its copies and nothing else, commit exactly those files with the message "${message}", move the branch to that commit only if it has not moved (git update-ref with the old value), then reset the index entries for the files here.` },
      { step: "Publish through Desk's push worker.", argv: publishArgv(deskRoot) },
    ],
    committed_locally_when: { argv: ["git", "-C", dir, "diff", "HEAD", "--", ...names], expect: "shows only the other session's edit, never this change" },
    never: `Never commit ${files} whole: that publishes the other session's edit as this change.`,
  }
}
