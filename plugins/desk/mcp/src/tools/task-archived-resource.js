// A disposition recorded on an archived card. A finished card's cleanup reminder has to be closable, but the card is history, so this is the only change Desk makes to it:
// one existing `## Resources` row gets its terminal cell filled. Nothing else is touched: the frontmatter stays byte for byte (no `updated`, no record, no date reformat),
// the factory report is not asked for again and no sync or evaluation is requested.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { writeFileAtomic } from "../util/fm.js"
import { applyResource, canonicalIdentity, openResources, readResources } from "../desk/resources.js"
import { recordCleanupCard } from "../desk/cleanup-index.js"

const ALLOWED = ["identity", "disposition", "details"]
// The card's frontmatter fence and everything up to it; the rest is the body.
const FRONT = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u

/**
 * Fills the terminal cell of the archived card's existing row, and returns `{ status: "updated", path, resource }`; refuses, changing nothing, for any other call.
 * `helpers` are task.js's own `{ relPath, stagingAllowed, stageAndCommitCard, schedulePush }`.
 */
export async function recordArchivedDisposition({ deskRoot, file, track, slug, values, resources, search, env, spawnGit, helpers }) {
  const refuse = (why, { code }) => { throw Object.assign(new Error(`task_update: Pass only \`resource: {identity, disposition, details}\` for an archived card: ${track}/${slug} is archived, so a call can only record a disposition on one of its existing resource rows (\`resource: {identity, disposition, details}\` and nothing else); ${why}; nothing was changed.`), { code }) }
  const extra = Object.keys(values).filter((key) => !["track", "slug", "resource", "resources"].includes(key))
  if (extra.length > 0) refuse(`Pass only \`resource: {identity, disposition, details}\`: this call also has ${extra.map((key) => `\`${key}\``).join(", ")}`, { code: "task_update_archived_extra_fields" })
  const raw = await fs.readFile(file, "utf8")
  const front = FRONT.exec(raw)?.[0] ?? ""
  const known = readResources(raw.slice(front.length)).rows ?? []
  for (const resource of resources) {
    const other = Object.keys(resource).filter((key) => !ALLOWED.includes(key))
    if (other.length > 0) refuse(`Pass only \`resource: {identity, disposition, details}\`: the resource has ${other.map((key) => `\`${key}\``).join(", ")}`, { code: "task_update_archived_resource_fields" })
    if (resource.disposition === undefined) refuse("Pass `disposition` with `details`: the resource has no `disposition`", { code: "task_update_archived_no_disposition" })
    const identity = canonicalIdentity(resource.identity)
    if (!known.some((row) => canonicalIdentity(row.identity) === identity)) refuse(`Pass an identity that is a row of the Resources table: ${JSON.stringify(resource.identity)} is not a row of its Resources table`, { code: "task_update_archived_unknown_identity" })
  }
  let body = raw.slice(front.length)
  const rows = []
  for (const resource of resources) {
    const written = applyResource(body, resource, "task_update", `${track}/${slug}`)
    body = written.body
    rows.push(written.row)
  }
  // Judged before the write, so a card another session left changed is never adopted.
  const stage = helpers.stagingAllowed(file, spawnGit)
  // Written through a temporary file and a rename, so a reader never sees the card half written; nothing else about the card changes.
  await writeFileAtomic(file, front + body)
  const commit = stage ? helpers.stageAndCommitCard(file, `task_update: ${track}/${slug}`, spawnGit, [], null, deskRoot) : undefined
  if (stage && !commit) helpers.schedulePush({ root: deskRoot })
  search?.noteChange(helpers.relPath(deskRoot, file))
  try {
    recordCleanupCard(deskRoot, helpers.relPath(deskRoot, path.dirname(file)), openResources(body).length > 0, env)
  } catch {
    // A state folder that cannot be written never fails the card write.
  }
  return { status: "updated", path: helpers.relPath(deskRoot, file), resource: rows[0], ...(rows.length > 1 ? { resources: rows } : {}), ...(commit ? { commit } : {}) }
}
