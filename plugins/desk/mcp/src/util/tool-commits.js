// The commits Desk's own write tools made in a desk checkout, kept as a list of ids in Desk's state folder.
//
// A desk's commits wait locally until the background push delivers them, which on a repository that merges through a
// checked pull request takes minutes. A purpose policy (`desk/content-home.js`) used to refuse every write in that
// window, because the checkout was ahead of the published base. Knowing which of the held commits Desk itself made lets
// the policy say yes to Desk's own follow-up writes and still refuse a commit made by hand.
//
// Best effort: a state folder that cannot be written only leaves a commit unrecorded, which is the old, stricter answer.

import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { lastStartRootKey, resolveDeskStateDir } from "../runtime/last-start.js"
import { assertNotRealStateUnderTest } from "../runtime/test-state-guard.js"

const FOLDER = "tool-commits"
// Older ids are long since on the remote; the newest are what a held range can name.
const KEEP = 2000
const SHA = /^[0-9a-f]{40,64}$/u

function ledgerPath(root, env) {
  return path.join(resolveDeskStateDir({ env }), FOLDER, `${lastStartRootKey(root)}.txt`)
}

/** Records the commit now at HEAD of `root` as one Desk's tools made. Never throws. */
export function recordToolCommit(root, env = process.env) {
  try {
    const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8", windowsHide: true, timeout: 5000 })
    const sha = head.status === 0 ? head.stdout.trim() : ""
    if (!SHA.test(sha)) return
    const file = ledgerPath(root, env)
    assertNotRealStateUnderTest(path.dirname(file), { env })
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${sha}\n`)
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    if (lines.length > KEEP * 2) writeFileSync(file, `${lines.slice(-KEEP).join("\n")}\n`)
  } catch {
    // The commit stays unrecorded, and a policy that asks sees it as held.
  }
}

/** The ids of the commits Desk's tools made in `root`, or an empty set. Never throws. */
export function readToolCommits(root, env = process.env) {
  try {
    return new Set(readFileSync(ledgerPath(root, env), "utf8").split("\n").filter(Boolean))
  } catch {
    return new Set()
  }
}
