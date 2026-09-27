// Redaction for text Desk shows at session start: the `Desk startup:` and
// `Desk boot:` lines both startup hooks inject, and the active-task listing
// desk:session-start renders. A folder name can carry a secret's value (a
// task folder named after a prompt that held a password, for example), and
// these surfaces reach the transcript and the chat without anyone choosing to
// show them.
//
// The rule is the factory's `isCredentialLike` (src/factory/credential.js):
// Desk's name rule (a password value, a 16+ character secret run, an
// IPv4-looking run) plus the known token prefixes. It is dependency-free, so
// the hooks can load it before the runtime pack is restored. A topic word such
// as "token" or "password" on its own is not a value and is not redacted (the
// M4-1 ruling): "rotate-api-token" stays readable.

import { realpathSync } from "node:fs"
import * as os from "node:os"
import { isCredentialLike } from "../factory/credential.js"

export const REDACTED_SEGMENT = "<redacted segment>"
export const REDACTED_TITLE = "<redacted title>"

// Path separators, whitespace and the punctuation that frames a path or a
// value in a sentence. A `.`, `-` or `_` stays inside a token, so
// "set-pw.hunter2" and "ghp_..." are judged whole.
const SEPARATORS = /([\s/\\;:,()[\]{}<>"'`=|]+)/u

// The folders of this machine's home and temporary directories are the
// machine's, not names anyone chose: macOS puts a 30-character per-user ID in
// every temporary path (/var/folders/nh/<id>/T), which reads like a secret
// run but is not one. Only the exact segments of those paths are exempt.
function machineSegments({ homedir = os.homedir, tmpdir = os.tmpdir, realpath = realpathSync } = {}) {
  const segments = new Set()
  for (const dir of [homedir(), tmpdir()]) {
    for (const spelling of [dir, safeRealpath(dir, realpath)]) {
      for (const segment of spelling.split(/[\\/]+/u)) segments.add(segment)
    }
  }
  return segments
}

function safeRealpath(dir, realpath) {
  try {
    return realpath(dir)
  } catch {
    return dir
  }
}

export const __redactInternalsForTests = { machineSegments }

const MACHINE_SEGMENTS = machineSegments()

/** One name (a folder, a branch): the redaction marker when it carries a secret's value, else the name. */
export function redactName(name) {
  return isCredentialLike(name) && !MACHINE_SEGMENTS.has(name) ? REDACTED_SEGMENT : name
}

/** Free text such as a title, judged whole: any secret-like run hides all of it. */
export function redactTitle(title) {
  return isCredentialLike(title) ? REDACTED_TITLE : title
}

/** A line of text: each path segment or word that carries a secret's value becomes the redaction marker. */
export function redactCredentialLikeText(text) {
  return String(text)
    .split(SEPARATORS)
    .map((part, index) => (index % 2 === 1 ? part : redactName(part)))
    .join("")
}
