// Name and scope validation shared by the runtime CRUD tools.
//
// Enforced only at creation and renaming (M4-1 ruling: "Existing names are
// never rejected on read; only creation and renaming validate."). Reads of
// pre-existing tracks/tasks — however they were named — never go through
// these functions.
//
// Rules are carried in verbatim from the controller ruling (2026-09-25),
// milestone-4 plan, task M4-1, as revised by the fix-round-1 ruling
// (2026-09-25): no rejection message ever quotes the candidate name, and
// credential_like narrows to a secret's *value* (a password prefix word
// followed by another word, a 16+ char hex/base64-ish run, or an
// IPv4-looking run) rather than its topic — ordinary engineering names like
// "api-key-rotation" or "token-budget-report" are not credential_like.

import { existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as path from "node:path"

// `^[a-z0-9]+(-[a-z0-9]+){1,5}$` — lowercase kebab-case, 2-6 words.
const SHAPE_RE = /^[a-z0-9]+(-[a-z0-9]+){1,5}$/
const MAX_NAME_LENGTH = 48
const MAX_SCOPE_LENGTH = 240

// A first word drawn from a greeting or a request reads as prompt text
// copied verbatim, not an outcome.
const FIRST_WORD_BLOCKLIST = new Set([
  "hi",
  "hello",
  "hey",
  "please",
  "can",
  "could",
  "would",
  "lets",
  "help",
  "i",
  "we",
])

// credential_like means a secret's *value*, not its topic — a name that
// talks about passwords, tokens, keys or users is normal engineering
// vocabulary. Only "pw"/"pwd"/"passwd" immediately followed by another word
// (a qualifier ahead of whose password it is, e.g. "setup-user-root-pw-
// alpine") reads as someone about to paste a value in.
const PASSWORD_PREFIX_WORDS = new Set(["pw", "pwd", "passwd"])

const CATCH_ALL_NAMES = new Set([
  "misc",
  "general",
  "other",
  "stuff",
  "inbox",
  "todo",
  "notes",
  "random",
  "scratch",
])

function words(name) {
  return name.split("-")
}

// "let-s" is what "let's" becomes once an apostrophe is stripped and turned
// into a hyphen — it splits into the two words "let" and "s". "hello-world"
// is the universal starter-example name, not a greeting copied from a
// prompt, so it's exempted even though "hello" is otherwise blocked.
function startsWithGreetingOrRequest(nameWords) {
  const [first, second] = nameWords
  if (first === "hello" && second === "world") return false
  if (FIRST_WORD_BLOCKLIST.has(first)) return true
  if (first === "let" && second === "s") return true
  return false
}

// Four consecutive numeric words, each a plausible octet — reads like an
// address copied out of a terminal, not an outcome.
function hasIpv4LookingRun(nameWords) {
  for (let i = 0; i + 4 <= nameWords.length; i += 1) {
    const run = nameWords.slice(i, i + 4)
    if (run.every((word) => /^\d{1,3}$/.test(word) && Number(word) <= 255)) {
      return true
    }
  }
  return false
}

// A single kebab word that is itself 16+ characters and looks encoded: pure
// hex, or an alphanumeric mix (letters + digits) long enough to be a token
// or hash rather than a long English word.
function looksLikeHexOrBase64(word) {
  if (word.length < 16) return false
  if (/^[0-9a-f]+$/.test(word)) return true
  return /[0-9]/.test(word) && /[a-z]/.test(word)
}

function hasCredentialLikeWord(nameWords) {
  for (const word of nameWords) {
    if (looksLikeHexOrBase64(word)) return true
  }
  for (let i = 0; i + 1 < nameWords.length; i += 1) {
    // "pw"/"pwd"/"passwd" *followed by another word* — a bare trailing one
    // (e.g. "rotate-pw" on its own) reads as an ordinary noun, not a value.
    if (PASSWORD_PREFIX_WORDS.has(nameWords[i])) return true
  }
  return false
}

// A trailing file extension (`.txt`, `.md`) is not part of the name's words.
const EXTENSION_RE = /\.[A-Za-z0-9]{1,10}$/

/**
 * isCredentialLike(name) -> boolean
 *
 * Whether a name carries a secret's value, judged on its own terms (M4-5
 * fix-round ruling): the name is split on every non-alphanumeric character
 * after its extension is stripped, case-folded, and checked against the
 * password-prefix rule ("pw"/"pwd"/"passwd" followed by another word), the
 * secret-run rule (a 16+ character hex or letter-and-digit run) and the IPv4
 * rule — whatever other rule the name also fails, and whatever its shape.
 * `validateName` and the doctor's path redaction both use it, so a
 * prompt-like, over-long or extension-bearing name that carries a password
 * is still treated as credential-like.
 */
export function isCredentialLike(name) {
  if (typeof name !== "string") return false
  const nameWords = name
    .replace(EXTENSION_RE, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
  return hasIpv4LookingRun(nameWords) || hasCredentialLikeWord(nameWords)
}

// No hint below ever includes the candidate — a rejection message must
// describe the problem, never quote the name that triggered it, because a
// rejected name may itself carry a secret's value.
const NAME_HINT = "name the outcome instead, like `oauth-login-fix`"

function shapeResult() {
  return {
    ok: false,
    code: "shape",
    hint: "the name must be 2–6 lowercase kebab-case words, like `oauth-login-fix`",
  }
}

/**
 * validateName(name) -> { ok, code?, hint? }
 *
 * codes: "shape" | "too_long" | "prompt_like" | "credential_like"
 *
 * No returned hint ever quotes or otherwise includes the candidate name.
 */
export function validateName(name) {
  if (typeof name !== "string" || name.trim() === "") return shapeResult()
  const candidate = name.trim()

  // Checked first: a secret's value decides the finding, whatever else the
  // name also gets wrong, so every caller treats it as a secret.
  if (isCredentialLike(candidate)) {
    return {
      ok: false,
      code: "credential_like",
      hint: `the name looks like it contains a secret's value — ${NAME_HINT}`,
    }
  }

  if (!SHAPE_RE.test(candidate)) return shapeResult()
  if (candidate.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      code: "too_long",
      hint: `the name must be at most ${MAX_NAME_LENGTH} characters — ${NAME_HINT}`,
    }
  }

  const nameWords = words(candidate)

  if (startsWithGreetingOrRequest(nameWords)) {
    return {
      ok: false,
      code: "prompt_like",
      hint: `the name starts like a prompt, not an outcome — ${NAME_HINT}`,
    }
  }

  return { ok: true }
}

/**
 * validateTrackName(name, { operatorNames }) -> { ok, code?, hint? }
 *
 * Same rules as validateName, plus a track may not be named after a person
 * (the operator's alias, GitHub login, or any alias/identity in
 * `_meta/desks.md`) and may not be a catch-all name.
 *
 * codes: adds "person" | "catch_all" ahead of the base checks, because a
 * one-word catch-all or person name (e.g. "misc", "arimendelow") would
 * otherwise fail shape first and report the wrong reason.
 */
export function validateTrackName(name, { operatorNames = [] } = {}) {
  if (typeof name === "string" && name.trim() !== "") {
    const folded = name.trim().toLowerCase()

    if (CATCH_ALL_NAMES.has(folded)) {
      return {
        ok: false,
        code: "catch_all",
        hint: `the name is a catch-all, not an outcome — ${NAME_HINT}`,
      }
    }

    const operatorNameSet = new Set(
      (operatorNames ?? []).map((entry) => String(entry).toLowerCase()),
    )
    if (operatorNameSet.has(folded)) {
      return {
        ok: false,
        code: "person",
        hint: `a track can't be named after a person — ${NAME_HINT}`,
      }
    }
  }

  return validateName(name)
}

/**
 * validateScope(scope) -> { ok, code? }
 *
 * codes: "missing" | "multiline" | "too_long"
 */
export function validateScope(scope) {
  if (typeof scope !== "string" || scope.trim() === "") {
    return {
      ok: false,
      code: "missing",
      hint:
        'write a one-line scope in the form "<what belongs>; not <what doesn\'t>"',
    }
  }
  if (scope.includes("\n")) {
    return {
      ok: false,
      code: "multiline",
      hint: "scope must be a single line, in the form \"<what belongs>; not <what doesn't>\"",
    }
  }
  if (scope.length > MAX_SCOPE_LENGTH) {
    return {
      ok: false,
      code: "too_long",
      hint: `keep scope to at most ${MAX_SCOPE_LENGTH} characters`,
    }
  }
  return { ok: true }
}

/**
 * describeNameRejection(result) -> string
 *
 * Builds the part of a tool error message that explains a rejected name.
 * Every `hint` a validator returns is already candidate-free by
 * construction, so this never echoes the rejected name back — whatever the
 * code, the name that triggered a rejection may itself carry a secret, or
 * may simply not be something a tool should ever repeat verbatim.
 */
export function describeNameRejection(result) {
  return result.hint
}

function kebabCase(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// Parse the `alias` and `identity` columns out of `_meta/desks.md`'s table
// (schema documented in `desk:session-start` Step 2.6). Tolerant of a
// missing file/table — a solo desk simply has no registry.
function parseDesksRegistry(raw) {
  const names = []
  const lines = raw.split("\n")
  let headerCols = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) continue
    const cells = trimmed
      .slice(1, trimmed.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim())
    if (headerCols === null) {
      headerCols = cells.map((cell) => cell.toLowerCase())
      continue
    }
    // Skip the `|---|---|` separator row.
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue

    const aliasIdx = headerCols.indexOf("alias")
    const identityIdx = headerCols.indexOf("identity")
    if (aliasIdx !== -1 && cells[aliasIdx]) names.push(cells[aliasIdx])
    if (identityIdx !== -1 && cells[identityIdx]) names.push(cells[identityIdx])
  }
  return names
}

function readDesksRegistryNames(deskRoot) {
  const registryPath = path.join(deskRoot, "_meta", "desks.md")
  if (!existsSync(registryPath)) return []
  let raw
  try {
    raw = readFileSync(registryPath, "utf8")
  } catch {
    return []
  }
  return parseDesksRegistry(raw)
}

function readGitUserName(deskRoot, spawnGitConfig) {
  let result
  try {
    result = spawnGitConfig("git", ["-C", deskRoot, "config", "user.name"], {
      encoding: "utf8",
    })
  } catch {
    return null
  }
  if (!result || result.status !== 0) return null
  const name = result.stdout?.trim()
  return name ? name : null
}

/**
 * operatorNames(deskRoot, { spawnGitConfig? }) -> string[]
 *
 * Lowercase, kebab-cased names the operator is known by on this desk:
 * every `alias` and `identity` in `_meta/desks.md` (when present), plus the
 * desk's own `git config user.name`. `spawnGitConfig` is an injectable seam
 * over `node:child_process`'s `spawnSync`, for tests only — real callers
 * never pass it.
 *
 * Desk's activation data does not currently record a GitHub login anywhere
 * (checked `src/activation/schema.js` and friends) — there is no field to
 * read, so none is included here. If activation ever gains one, it belongs
 * in this list.
 */
export function operatorNames(deskRoot, { spawnGitConfig = spawnSync } = {}) {
  const names = [...readDesksRegistryNames(deskRoot)]
  const gitUserName = readGitUserName(deskRoot, spawnGitConfig)
  if (gitUserName) names.push(gitUserName)
  return [...new Set(names.map(kebabCase).filter((name) => name !== ""))]
}
