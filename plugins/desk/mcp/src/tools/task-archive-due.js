import { TERMINAL_STATES } from "../desk/lifecycle.js"

export function archiveDueAnswer({ track, slug, status, archived = false }) {
  if (archived || !TERMINAL_STATES.includes(status)) return {}
  return {
    archive_due: { track, slug },
    archive_next_action: "If you are the owning main agent, call task_archive with archive_due before final delivery and inspect its actual result. This advice does not archive the task or grant ownership. Preserve the existing unsigned signoff packet; archive_pending or failure remains unresolved, not completed archival.",
  }
}
