// Keeps open pull requests moving. For each open, non-draft PR from this repository, it comments once per head commit (a plain
// comment, no @mention: lanes push as one person, so a mention only lands in his inbox):
//   - conflicts with main: names the conflicting files;
//   - a required check is red: names the failing checks, and when the branch is behind main says so, because a rerun
//     reuses the old tree and only a new head can pick up a fix that already landed.
// It does not update branches itself: a push made with the workflow's own token starts no pull_request run, so the
// required checks would sit stale and hold the merge. A PR that is merely behind with nothing red is left alone.
// Usage: node pr-keep-moving.mjs [--dry-run]   (GH_TOKEN and GITHUB_REPOSITORY set; run from a full clone of the repository)

import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

export const MARKER = "<!-- pr-keep-moving"

/** What to do for one PR: "conflict", "red" or "none". `required` names the required checks; `checks` are { name, conclusion } rows. */
export function decide({ mergeable, behind, checks, required }) {
  if (mergeable === "CONFLICTING") return { action: "conflict" }
  const red = checks.filter((c) => required.includes(c.name) && ["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"].includes(c.conclusion)).map((c) => c.name)
  if (red.length === 0) return { action: "none" }
  return { action: "red", red, behind }
}

/** The comment for `kind` on the commit `sha`; the marker lets a later run see it was already sent. */
export function message({ kind, sha, files = [], red = [], behind = false }) {
  const mark = `${MARKER} ${kind} ${sha} -->`
  if (kind === "conflict") {
    return `${mark}\nThis branch conflicts with main in ${files.length > 0 ? files.map((f) => `\`${f}\``).join(", ") : "files git did not name"}. Merge main in and resolve it; auto-merge cannot proceed until you do.`
  }
  return `${mark}\nRequired check${red.length > 1 ? "s" : ""} ${red.map((n) => `\`${n}\``).join(", ")} failed on ${sha.slice(0, 9)}. Read the failing job, fix the cause (not a rerun) and push; a random failure gets its own issue first.${behind ? " This branch is behind main, so merge main in: a rerun would reuse the old tree and miss any fix that has landed." : ""}`
}

export const alreadySent = (comments, kind, sha) => comments.some((c) => (c.body ?? "").includes(`${MARKER} ${kind} ${sha} -->`))

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

function conflictingFiles(number) {
  try {
    git("fetch", "-q", "origin", "main", `pull/${number}/head:refs/pr-keep-moving/${number}`)
    git("merge-tree", "--write-tree", "--name-only", "origin/main", `refs/pr-keep-moving/${number}`)
    return []
  } catch (error) {
    // merge-tree exits 1 on conflicts: the tree id, then the conflicted file names, then a blank line and the messages.
    const lines = String(error.stdout ?? "").split("\n")
    const names = []
    for (const line of lines.slice(1)) {
      if (line === "") break
      names.push(line)
    }
    return names
  }
}

function main() {
  const dry = process.argv.includes("--dry-run")
  const repo = process.env.GITHUB_REPOSITORY
  const required = JSON.parse(gh("api", `repos/${repo}/rules/branches/main`, "-q", "[.[]|select(.type==\"required_status_checks\")|.parameters.required_status_checks[].context]"))
  const prs = JSON.parse(gh("pr", "list", "-R", repo, "--state", "open", "--json", "number,isDraft,headRefOid,mergeable,mergeStateStatus,isCrossRepository,statusCheckRollup", "-L", "100"))
  for (const pr of prs) {
    if (pr.isDraft || pr.isCrossRepository || pr.mergeable === "UNKNOWN") continue
    const checks = (pr.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context, conclusion: c.conclusion ?? c.state }))
    const decision = decide({ mergeable: pr.mergeable, behind: pr.mergeStateStatus === "BEHIND", checks, required })
    if (decision.action === "none") continue
    const sha = pr.headRefOid
    const kind = decision.action
    const comments = JSON.parse(gh("api", `repos/${repo}/issues/${pr.number}/comments`, "--paginate", "-q", "[.[]|{body}]"))
    if (alreadySent(comments, kind, sha)) continue
    const body = message({ kind, sha, files: kind === "conflict" ? conflictingFiles(pr.number) : [], red: decision.red, behind: decision.behind })
    console.log(`#${pr.number}: ${decision.action}`)
    if (dry) continue
    gh("pr", "comment", String(pr.number), "-R", repo, "--body", body)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()
