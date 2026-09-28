// objectInput — the one check for a tool argument that must be an object of
// key/value pairs, such as task_update's `frontmatter`.
//
// A client that sees no input schema (or ignores one) can send an object as a
// JSON string. Spreading that string into a card writes one key per character
// ("0": "{", "1": "\"", ...), so a merge never touches a value this has not
// accepted. It accepts a plain object, parses a string that holds a JSON
// object, treats null and undefined as absent, and rejects everything else
// with a message that says what arrived without quoting it: the value can be
// anything, including a secret pasted into the wrong field.

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function describe(value) {
  if (Array.isArray(value)) return "an array"
  if (typeof value === "object") return `a ${value.constructor.name}`
  return `a ${typeof value}`
}

function describeParsed(value) {
  if (value === null) return "JSON null"
  if (Array.isArray(value)) return "a JSON array"
  return `a JSON ${typeof value}`
}

const WRITE_EFFECT = "nothing was written"
const WRITE_EXAMPLE = '{"status": "implementing"}'

/**
 * objectInput(value, { tool, field, effect?, example? }) -> object | undefined
 *
 * Throws `<tool>: \`<field>\` must be an object ...; <effect>` for anything
 * that is not an object or a JSON-string object. `effect` and `example`
 * default to a card write's; a read passes its own (desk_search's filters).
 */
export function objectInput(value, { tool, field, effect = WRITE_EFFECT, example = WRITE_EXAMPLE }) {
  if (value === undefined || value === null) return undefined
  const reject = (got) => {
    throw new TypeError(
      `${tool}: \`${field}\` must be an object of key/value pairs (got ${got}); ${effect}. ` +
        `Pass it as a JSON object, for example ${example}.`,
    )
  }
  if (typeof value === "string") {
    let parsed
    try {
      parsed = JSON.parse(value)
    } catch {
      return reject("a string that is not valid JSON")
    }
    if (!isPlainObject(parsed)) return reject(describeParsed(parsed))
    return parsed
  }
  if (!isPlainObject(value)) return reject(describe(value))
  return value
}
