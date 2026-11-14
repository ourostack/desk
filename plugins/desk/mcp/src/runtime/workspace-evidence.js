import { createHash } from "node:crypto"

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const signed = (value) => ({ ...value, digest: hash(value) })
export const TIDY_REPORT_MAX_BYTES = 1_048_576
const REPORT_FORMAT = "workspace-tidy-compact-v1"

function requireReportCapacity(bytes) {
  if (Buffer.byteLength(bytes) > TIDY_REPORT_MAX_BYTES) {
    throw Object.assign(new Error("Check the retained resources and acknowledge them before cleanup: workspace-tidy evidence capacity exhausted; acknowledge retained resources before cleanup"), { code: "workspace_evidence_check_the_retained_resources_and" })
  }
}

function requireReportShape(report) {
  if (!Array.isArray(report.resources) || !Array.isArray(report.issues)) throw Object.assign(new Error("Run the tidy again to rebuild the compact report: invalid compact workspace-tidy report"), { code: "workspace_evidence_run_the_tidy_again_to" })
}

export function encodeTidyReport(report) {
  requireReportShape(report)
  const bytes = `${JSON.stringify({
    format: REPORT_FORMAT,
    resources: report.resources,
    issues: report.issues,
    root: report.root,
    updated: report.updated,
    line: report.line,
  })}\n`
  requireReportCapacity(bytes)
  return bytes
}

export function decodeTidyReport(bytes) {
  requireReportCapacity(bytes)
  const report = JSON.parse(bytes)
  if (report?.format !== REPORT_FORMAT) return report
  requireReportShape(report)
  return { ...report, ...mergeTidyEvidence(report, { issues: report.issues }) }
}

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
  if (typeof canonicalEvidence !== "string" || !canonicalEvidence.trim()) throw Object.assign(new Error("Pass the canonical accounting evidence: canonical accounting evidence is required"), { code: "workspace_evidence_pass_the_canonical_accounting_evidence" })
  const resource = previous.resources?.find((entry) => entry.id === id)
  if (!resource || resource.digest !== digest) throw Object.assign(new Error("Run it again: resource evidence changed or is missing; acknowledgement refused"), { code: "workspace_evidence_run_it_again_resource_evidence" })
  const acknowledgements = [...(previous.acknowledgements ?? []), { id, digest, canonicalEvidence }]
  return mergeTidyEvidence({ ...previous, resources: previous.resources.filter((entry) => entry.id !== id), acknowledgements })
}
