import { createHash } from "node:crypto"

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const signed = (value) => ({ ...value, digest: hash(value) })

export function dispositionRecord(receipt, state, branchRemoved = false) {
  const value = {
    id: hash([receipt.repository, receipt.worktree, receipt.branch, receipt.head, receipt.owner]),
    path: receipt.worktree, branch: receipt.branch, owner: receipt.owner, receipt, state, branchRemoved,
  }
  return signed(value)
}

// Resources are an outbox for canonical accounting, not a last-run cache.
// Even an interrupted removal keeps its write-ahead receipt until acknowledged.
export function mergeTidyEvidence(previous = {}, current = {}, update = null) {
  const resources = new Map((previous.resources ?? []).map((entry) => [entry.id, entry]))
  const observe = (observation, state) => {
    const entry = signed({ id: hash(["observation", observation.path]), path: observation.path, state, observation })
    resources.set(entry.id, entry)
  }
  if (!previous.resources) {
    for (const entry of previous.removed ?? []) observe(entry, "legacy_removed")
    for (const entry of previous.left ?? []) observe(entry, "reported")
  }
  if (update) {
    resources.delete(hash(["observation", update.path]))
    resources.set(update.id, update)
  }
  for (const entry of current.left ?? []) {
    const owned = [...resources.values()].find((item) => item.receipt &&
      (item.path === entry.path || `${item.receipt.repository}:${item.branch}` === entry.path))
    if (!owned) observe(entry, "reported")
  }
  const entries = [...resources.values()]
  const left = []
  const removed = []
  for (const entry of entries) {
    if (entry.state === "reported") left.push(entry.observation)
    else if (entry.state === "legacy_removed") removed.push(entry.observation)
    else if (entry.state === "cleanup_pending") left.push({ path: entry.path, reason: "cleanup pending; reconcile persisted resource evidence" })
    else {
      removed.push(entry)
      if (!entry.branchRemoved) left.push({ path: `${entry.receipt.repository}:${entry.branch}`, reason: "branch retained; owner must reconcile" })
    }
  }
  return {
    resources: entries,
    acknowledgements: previous.acknowledgements ?? [],
    removed,
    left: [...new Map(left.map((entry) => [entry.path, entry])).values()],
    issues: current.issues ?? [],
  }
}

export function acknowledgeTidyEvidence(previous, { id, digest, canonicalEvidence }) {
  if (typeof canonicalEvidence !== "string" || !canonicalEvidence.trim()) throw new Error("canonical accounting evidence is required")
  const resource = previous.resources?.find((entry) => entry.id === id)
  if (!resource || resource.digest !== digest) throw new Error("resource evidence changed or is missing; acknowledgement refused")
  const acknowledgements = [...(previous.acknowledgements ?? []), { id, digest, canonicalEvidence }]
  return mergeTidyEvidence({ ...previous, resources: previous.resources.filter((entry) => entry.id !== id), acknowledgements })
}
