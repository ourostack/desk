import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { deskFailure } from "../runtime/desk-failure.js"
import { commandArgument } from "../runtime/pr-publication.js"
import { catchUpBehind } from "../runtime/deliver.js"
import { readSyncStatus } from "../runtime/sync-worker.js"
import { readToolCommits } from "../util/tool-commits.js"

const POLICY = ".desk/content-home.json"
const repository = /^[\w.-]+\/[\w.-]+$/u
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const sha256 = (value) => createHash("sha256").update(value).digest("hex")

function refuse(tool, code, message) {
  throw new Error(`${tool}: ${code}: ${message}. Nothing was written or committed by this call; preserve the input and existing sources.`)
}

/** The Git runner this module uses; a test swaps `spawn` to cut a call off the way a slow machine does. */
export const gitSeam = { spawn: spawnSync }

const GIT_TIMEOUT_MS = 10_000

// A call cut off by the clock is asked again with three times the room before anything concludes from it: a loaded
// machine's slow answer is not the same fact as an answer of "no".
function git(root, args) {
  const run = (timeout) => gitSeam.spawn("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, timeout })
  const first = run(GIT_TIMEOUT_MS)
  return first.status === null && (first.error || first.signal) ? run(GIT_TIMEOUT_MS * 3) : first
}

// The commit the checkout's upstream names, as a Git result: `@{upstream}`, else the tracking ref the branch's own
// settings name when `@{upstream}` cannot say (a fetch rule that does not map the branch to one).
function upstreamCommit(root) {
  const direct = git(root, ["rev-parse", "--verify", "@{upstream}^{commit}"])
  if (direct.status === 0) return direct
  const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout?.trim()
  const remote = branch ? git(root, ["config", `branch.${branch}.remote`]).stdout?.trim() : ""
  const merge = branch ? git(root, ["config", `branch.${branch}.merge`]).stdout?.trim() : ""
  if (!remote || remote === "." || !merge?.startsWith("refs/heads/")) return direct
  const named = git(root, ["rev-parse", "--verify", `refs/remotes/${remote}/${merge.slice("refs/heads/".length)}^{commit}`])
  return named.status === 0 ? named : direct
}

// A published policy never changes under its commit, so what was read at a commit (a policy, or its absence) is read once per process.
const publishedPolicies = new Map()

function readPolicy(root, tool) {
  const upstream = upstreamCommit(root)
  const known = upstream.status === 0 ? publishedPolicies.get(`${root}\0${upstream.stdout.trim()}`) : undefined
  if (known !== undefined) {
    if (known.published === null && existsSync(path.join(known.policyRoot, POLICY))) refuse(tool, "content_home_policy_unpublished", `Publish ${POLICY} through the repository's checked source route before relying on it`)
    return known.published
  }
  const top = git(root, ["rev-parse", "--show-toplevel"])
  const policyRoot = top.status === 0 ? top.stdout.trim() : root
  if (upstream.status !== 0) {
    const tracked = git(root, ["ls-tree", "--full-tree", "--name-only", "HEAD", "--", POLICY])
    if (existsSync(path.join(policyRoot, POLICY)) || tracked.stdout?.trim()) {
      refuse(tool, "content_home_policy_unpublished", `A purpose policy exists, but its published upstream cannot be resolved; restore the configured upstream and verify its policy before saving`)
    }
    return null
  }
  const commit = upstream.stdout.trim()
  const listed = git(root, ["ls-tree", "--full-tree", "--name-only", commit, "--", POLICY])
  if (listed.status !== 0) refuse(tool, "content_home_policy_invalid", `Cannot inspect the published ${POLICY}`)
  if (listed.stdout.trim() === "") {
    if (existsSync(path.join(policyRoot, POLICY))) refuse(tool, "content_home_policy_unpublished", `Publish ${POLICY} through the repository's checked source route before relying on it`)
    publishedPolicies.set(`${root}\0${commit}`, { published: null, policyRoot })
    return null
  }
  const read = git(root, ["show", `${commit}:${POLICY}`])
  if (read.status !== 0) refuse(tool, "content_home_policy_invalid", `Cannot read the published ${POLICY}`)
  let policy
  try { policy = JSON.parse(read.stdout) } catch {
    refuse(tool, "content_home_policy_invalid", `Published ${POLICY} is not valid JSON`)
  }
  const names = (value) => Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === "string" && name.trim() !== "" && !["mixed", "unknown"].includes(name))
  if (!plainObject(policy) || policy.schema_version !== 1 || policy.mode !== "declared-purpose" ||
      typeof policy.repository !== "string" || !repository.test(policy.repository) ||
      !names(policy.context_purposes) || !names(policy.product_purposes) ||
      policy.context_purposes.some((name) => policy.product_purposes.includes(name))) {
    refuse(tool, "content_home_policy_invalid", `Published ${POLICY} needs schema_version 1, mode declared-purpose, its repository, and disjoint nonempty context_purposes and product_purposes`)
  }
  const published = { policy, commit, sha256: sha256(read.stdout) }
  publishedPolicies.set(`${root}\0${commit}`, { published, policyRoot })
  return published
}

function classify(declaration, policy, tool) {
  if (!plainObject(declaration) || !["current", "historical"].includes(declaration.lifecycle)) {
    refuse(tool, "content_home_unresolved", "Declare the content's purpose and current or historical lifecycle; do not infer them from its filename or embedded commands")
  }
  if (policy.context_purposes.includes(declaration.purpose)) return
  if (!policy.product_purposes.includes(declaration.purpose)) {
    refuse(tool, "content_home_unresolved", "Classify the unresolved material by purpose using the published policy; split mixed content into classified sections rather than rejecting or deleting a whole historical file")
  }
  if (declaration.lifecycle !== "current") {
    refuse(tool, "content_home_unresolved", "A historical source is not a new product execution lease; classify preserved originals as source context or historical evidence, keeping their provenance and restrictions")
  }
  if (typeof declaration.product_repository !== "string" || !repository.test(declaration.product_repository)) {
    refuse(tool, "content_home_unresolved", "Identify the canonical product repository for current authoritative product material")
  }
  if (declaration.product_repository.toLowerCase() !== policy.repository.toLowerCase()) {
    refuse(tool, "content_home_wrong_repository", "Current authoritative product contracts, tools, and run artifacts belong in their declared product repository; keep project planning, owners, status, rationale, source context, and links here. This refusal grants no migration, public-copy, or deletion permission")
  }
}

// HEAD may stand ahead of the published base by commits Desk's own write tools made and are still waiting for their
// publication, which on a checked-pull-request repository takes minutes. It may not hold a merge, another policy file or
// a commit made any other way: those are the unpublished bytes this guard exists to keep out of a mutation.
function holdsOnlyDeskWrites(root, head, admission) {
  if (typeof admission.policy_sha256 !== "string") return false
  let policySha = headPolicies.get(`${root}\0${head}`)
  if (policySha === undefined) {
    const policy = git(root, ["show", `${head}:${POLICY}`])
    if (policy.status !== 0) return false
    policySha = sha256(policy.stdout)
    headPolicies.set(`${root}\0${head}`, policySha)
  }
  if (policySha !== admission.policy_sha256) return false
  const listed = git(root, ["rev-list", "--right-only", "--cherry-pick", "--parents", `${admission.policy_commit}...HEAD`])
  if (listed.status !== 0) return false
  const delivered = new Set(readSyncStatus({ root, env: process.env })?.delivered ?? [])
  const made = readToolCommits(root)
  return listed.stdout.split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/u)).every(([sha, ...parents]) => delivered.has(sha) || (parents.length === 1 && made.has(sha)))
}

// The policy file's digest at a commit never changes.
const headPolicies = new Map()

export function assertPublishedContentBase(root, admission, tool) {
  if (admission === null) return
  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"])
  if (head.status !== 0) {
    throw new Error(deskFailure({
      code: "content_home_unpublished_base",
      thing: `${tool}: content_home_unpublished_base`,
      probably: "this checkout's HEAD could not be read",
      look: `call desk_doctor, or run \`git -C ${commandArgument(root)} status\``,
      keepWorking: "your input and the existing sources are untouched and nothing was written or committed, so keep working in the published checkout",
      fix: "use the existing qualified published checkout",
    }))
  }
  const tip = head.stdout.trim()
  if (tip === admission.policy_commit) return
  // A checkout that is only behind holds nothing unpublished: it is brought up to the base it is behind, as far as local changes let it, and the write goes ahead.
  if (git(root, ["merge-base", "--is-ancestor", tip, admission.policy_commit]).status === 0) {
    catchUpBehind({ root, spawnGit: gitSeam.spawn })
    return
  }
  if (holdsOnlyDeskWrites(root, tip, admission)) return
  throw new Error(deskFailure({
    code: "content_home_unpublished_base",
    thing: `${tool}: content_home_unpublished_base`,
    probably: "this checkout's HEAD is not the commit the published purpose policy came from, and it holds commits Desk's tools did not make, a merge, or a changed policy, probably because it holds commits that were never published or sits on a different base",
    look: `call desk_doctor, or run \`git -C ${commandArgument(root)} log --oneline @{upstream}..HEAD\` to list the commits held here`,
    keepWorking: "your input and the existing sources are untouched and nothing was written or committed, so keep working in the published checkout and never replay the held commits",
    fix: "use the existing qualified published checkout, or finish the publication it already owns",
  }))
}

// `ownedDigest` is the digest of bytes Desk itself wrote to the target and has not committed yet (the append lane's): a target holding exactly those is Desk's own work in flight, not a held draft.
export function assertCleanContentTarget(root, relativePath, admission, tool, ownedDigest = null) {
  if (admission === null) return
  const status = git(root, ["status", "--porcelain", "--untracked-files=normal", "--", relativePath])
  if (status.status === 0 && status.stdout !== "" && ownedDigest !== null) {
    try {
      if (sha256(readFileSync(path.join(root, relativePath))) === ownedDigest) return
    } catch {
      // Unreadable bytes are not Desk's own.
    }
  }
  if (status.status !== 0 || status.stdout !== "") {
    refuse(tool, "content_home_dirty_target", "The target already holds staged or working changes outside this supplied payload; preserve them rather than adopting or overwriting them")
  }
}

// Subjects are the actual new tool arguments or exact file bytes, never the existing card's historical body.
export function admitContent({ deskRoot, tool, declaration, subjects }) {
  const published = readPolicy(deskRoot, tool)
  if (published === null) {
    if (declaration !== undefined) refuse(tool, "content_home_policy_unpublished", "No published purpose policy is available for this declaration")
    return null
  }
  if (declaration === undefined) {
    refuse(tool, "content_home_required", `This repository's published ${POLICY} requires content_home with purpose and lifecycle before this mutation`)
  }
  if (!plainObject(declaration)) refuse(tool, "content_home_unresolved", "content_home must be an object")
  const fields = ["purpose", "lifecycle", "product_repository", "source_reference", "sections"]
  if (Object.keys(declaration).some((key) => !fields.includes(key)) ||
      (declaration.purpose !== "mixed" && declaration.sections !== undefined)) {
    refuse(tool, "content_home_unresolved", "Unknown content_home field or sections without purpose mixed; correct the declaration rather than silently classifying a whole payload")
  }
  const { policy, commit } = published
  const receipt = { policy_commit: commit, policy_sha256: published.sha256, subjects: {} }
  subjects = typeof subjects === "function" ? subjects() : subjects
  if (declaration.purpose === "mixed") {
    if (!Array.isArray(declaration.sections) || declaration.sections.length === 0) {
      refuse(tool, "content_home_unresolved", "Mixed content needs classified sections covering every subject's exact UTF-8 bytes")
    }
    const known = new Set(subjects.map(({ id }) => id))
    if (declaration.sections.some((section) => !plainObject(section) || !known.has(section.subject))) {
      refuse(tool, "content_home_unresolved", "A section names an absent or invalid subject")
    }
    if (declaration.sections.some((section) => Object.keys(section).some((key) => !["subject", "start", "end", ...fields.filter((field) => field !== "sections")].includes(key)))) {
      refuse(tool, "content_home_unresolved", "A section has an unknown classification field")
    }
    for (const { id, content } of subjects) {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")
      const sections = declaration.sections.filter((section) => section.subject === id)
      let end = 0
      if (sections.length === 0) refuse(tool, "content_home_unresolved", "A mutation subject has no classified sections")
      for (const section of sections) {
        const from = section.start ?? (sections.length === 1 ? 0 : undefined)
        const to = section.end ?? (sections.length === 1 ? bytes.length : undefined)
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from !== end || to < from || to > bytes.length || (to === from && bytes.length !== 0)) {
          refuse(tool, "content_home_unresolved", "Sections must cover each subject once, in order, without gaps or overlaps; start and end are UTF-8 byte offsets")
        }
        classify(section, policy, tool)
        end = to
      }
      if (end !== bytes.length) refuse(tool, "content_home_unresolved", "Sections leave unclassified bytes at the end of a subject")
      receipt.subjects[id] = { sha256: sha256(bytes), bytes: bytes.length }
    }
  } else {
    classify(declaration, policy, tool)
    for (const { id, content } of subjects) {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")
      receipt.subjects[id] = { sha256: sha256(bytes), bytes: bytes.length }
    }
  }
  assertPublishedContentBase(deskRoot, receipt, tool)
  return receipt
}
