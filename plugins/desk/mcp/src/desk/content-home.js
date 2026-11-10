import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import * as path from "node:path"

const POLICY = ".desk/content-home.json"
const repository = /^[\w.-]+\/[\w.-]+$/u
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const sha256 = (value) => createHash("sha256").update(value).digest("hex")

function refuse(tool, code, message) {
  throw new Error(`${tool}: ${code}: ${message}. Nothing was written or committed by this call; preserve the input and existing sources.`)
}

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 })
}

function readPolicy(root, tool) {
  const top = git(root, ["rev-parse", "--show-toplevel"])
  const policyRoot = top.status === 0 ? top.stdout.trim() : root
  const upstream = git(root, ["rev-parse", "--verify", "@{upstream}^{commit}"])
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
  return { policy, commit, sha256: sha256(read.stdout) }
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

export function assertPublishedContentBase(root, admission, tool) {
  if (admission === null) return
  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"])
  if (head.status !== 0 || head.stdout.trim() !== admission.policy_commit) {
    refuse(tool, "content_home_unpublished_base", "This checkout has an unpublished or different base; do not replay held commits. Use the existing qualified published checkout or finish its already-owned publication")
  }
}

export function assertCleanContentTarget(root, relativePath, admission, tool) {
  if (admission === null) return
  const status = git(root, ["status", "--porcelain", "--untracked-files=normal", "--", relativePath])
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
