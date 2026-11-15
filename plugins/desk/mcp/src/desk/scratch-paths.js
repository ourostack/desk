// Paths that die with a session: the host's session folder, a harness's per-project history, and the temp folders.
//
// Desk keeps what a successor would miss on the desk or in the product repository. A path into one of these places in a
// card or a saved file is a pointer to something that is gone once the session is archived or the machine cleans up, and
// that no other session or machine can read. Desk flags such a path and says what to do instead; it never refuses the
// write, because the text may be quoting the path on purpose.

// The path must start where a path starts: not after a word character, a slash, a dot, a colon or a hyphen, which is how a URL or a longer path reads.
const START = String.raw`(?<![\w/.:~\\-])`
const BODY = String.raw`[^\s"'` + "`" + String.raw`)\]>,;|]*`
const PLACES = [
  String.raw`(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|[A-Za-z]:[\\/]Users[\\/][^\s\\/]+|/(?:Users|home)/[^\s/]+)[\\/]\.copilot[\\/]session-state(?:[\\/]|(?![\w-]))`,
  String.raw`(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|[A-Za-z]:[\\/]Users[\\/][^\s\\/]+|/(?:Users|home)/[^\s/]+)[\\/]\.claude[\\/]projects(?:[\\/]|(?![\w-]))`,
  String.raw`(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|[A-Za-z]:[\\/]Users[\\/][^\s\\/]+|/(?:Users|home)/[^\s/]+)[\\/]\.codex[\\/]sessions(?:[\\/]|(?![\w-]))`,
  String.raw`/(?:private/)?(?:var/)?tmp(?:/|(?![\w-]))`,
  String.raw`/(?:private/)?var/folders/`,
]
const SCRATCH = new RegExp(`${START}(?:${PLACES.join("|")})${BODY}`, "gu")

/** The scratch paths named in `text`, each once, in the order they first appear. */
function scratchPaths(text) {
  if (typeof text !== "string" || text === "") return []
  return [...new Set((text.match(SCRATCH) ?? []).map((found) => found.replace(/[.:]+$/u, "")))]
}

/** How many scratch paths `text` names. */
export const scratchPathCount = (text) => scratchPaths(text).length

const SHOWN = 3

/**
 * The warning a write tool adds to its answer, or undefined when `texts` name no scratch path. It leads with what to do.
 * `where` names what was written ("this card", "this file").
 */
export function scratchPathWarning(texts, where = "what you wrote") {
  const found = [...new Set((Array.isArray(texts) ? texts : [texts]).flatMap(scratchPaths))]
  if (found.length === 0) return undefined
  const shown = found.slice(0, SHOWN).map((path) => `\`${path}\``).join(", ")
  const more = found.length > SHOWN ? ` and ${found.length - SHOWN} more` : ""
  return `Copy the file into the task's folder with desk_save (\`files\`) and refer to that desk path or its repository URL instead; for a short record, put the text on the card or in task_update's \`log\`. ${where} names ${shown}${more}, which dies with the session and that no other session or machine can read. Desk saved it as written.`
}
