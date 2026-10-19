import { isCredentialLike } from "../factory/credential.js"

const unavailable = (code) => ({ state: "unavailable", code })
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\\/@]|\b(?:https?|file|data|mailto):|\bwww\.|(?:^|\s)~|^[a-z]:/iu
const CREDENTIAL_VALUE = /\b(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+|\bbearer\s+\S+/iu
const isTaskSegment = (value) => typeof value === "string" && value.trim() !== "" &&
  value !== "." && value !== ".." && !/[/\\\p{Cc}]/u.test(value)

// A task observation proposes display text only. Native identity, freshness,
// activity and manual-name ownership must be established by its consumer.
export function makeSessionLabelProposal({ task, displayLabel, focused = true }) {
  if (focused !== true) return unavailable("awaiting_focus")
  if (!isTaskSegment(task?.track) || !isTaskSegment(task?.slug)) return unavailable("owner_unknown")
  if (displayLabel === undefined) return unavailable("missing_safe_label")
  if (typeof displayLabel !== "string") return unavailable("unsafe_label")
  const text = displayLabel.trim()
  if (text === "" || [...text].length > 72 || UNSAFE_TEXT.test(displayLabel) ||
      CREDENTIAL_VALUE.test(text) || isCredentialLike(text) ||
      [...text.matchAll(/(?:^|[^\p{L}\p{N}])/gu)]
        .some((match) => isCredentialLike(text.slice(match.index + match[0].length)))) return unavailable("unsafe_label")
  return {
    proposal: {
      version: 1,
      task: { track: task.track, slug: task.slug },
      text,
      phase: "unknown",
      origin: "automatic",
    },
  }
}
