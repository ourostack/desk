// parseFrontmatterLite — a dependency-free reader for the few card fields the
// organization checks use.
//
// The Desk MCP runs with its npm dependencies restored, so the doctor parses
// cards with gray-matter. The one-time tidy migration's Detect runs the same
// organization checks straight from the installed plugin, where no npm
// dependency is installed, so `organization.js` falls back to this reader.
//
// It returns gray-matter's shape (`{ data, content, matter }`) and mirrors
// js-yaml for the top-level scalars the checks read (`status`, `updated`,
// `scope`): quoted values are strings (a comment after the closing quote is
// dropped), an unquoted YAML timestamp is a Date (so an unquoted `updated:`
// is never treated as a string, exactly as under gray-matter), integers are
// numbers, `true`/`false`/`null`/`~` are what YAML says they are, and a `|`
// or `>` block scalar is read as YAML folds or keeps it. `operating_files`
// also reads scalar lists. Other nested values are not parsed; `matter`
// keeps the raw frontmatter text, which is where the
// checks look for pull request URLs.
//
// Like gray-matter, it throws on a block it cannot trust — a duplicate key,
// an unclosed quote, text after a closing quote or an unbalanced flow
// collection — and the caller treats that card as unreadable; and, like
// gray-matter, a block with no closing `---` runs to the end of the file.
// Remaining divergence: other invalid YAML that js-yaml rejects (for example
// a plain value that itself contains ": ") is read here rather than rejected.

const KEY_LINE_RE = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/
const TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)[ \t]*(Z|[+-]\d{1,2}(?::\d{2})?)?)?$/
const INTEGER_RE = /^[-+]?\d+$/
const BLOCK_SCALAR_RE = /^([|>])([+-]?)(?:[ \t]+#.*)?$/

function malformed(what) {
  return new Error(`frontmatter: ${what}`)
}

function timestamp(match) {
  const [, day, time, zone] = match
  if (time === undefined) return new Date(`${day}T00:00:00Z`)
  let offset = "Z"
  if (zone !== undefined && zone !== "Z") {
    const [, sign, hours, minutes = "00"] = /^([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone)
    offset = `${sign}${hours.padStart(2, "0")}:${minutes}`
  }
  return new Date(`${day}T${time.replace(/^(\d):/, "0$1:")}${offset}`)
}

function quoted(value, quote) {
  let index = 1
  let text = ""
  while (index < value.length) {
    const char = value[index]
    if (quote === '"' && char === "\\" && index + 1 < value.length) {
      text += value[index + 1]
      index += 2
      continue
    }
    if (char === quote) {
      if (quote === "'" && value[index + 1] === "'") {
        text += "'"
        index += 2
        continue
      }
      const rest = value.slice(index + 1)
      if (rest.trim() !== "" && !/^[ \t]+#/.test(rest)) throw malformed("text after a closing quote")
      return text
    }
    text += char
    index += 1
  }
  throw malformed("an unclosed quote")
}

function plainScalar(raw) {
  const plain = raw.replace(/(^|[ \t]+)#.*$/, "").trim()
  if (plain === "" || plain === "~" || plain === "null") return null
  if (plain === "true") return true
  if (plain === "false") return false
  if (INTEGER_RE.test(plain)) return Number(plain)
  const stamp = TIMESTAMP_RE.exec(plain)
  if (stamp) return timestamp(stamp)
  return plain
}

// How far `[`/`{` nesting is open after `text`, ignoring quoted runs.
function flowDepth(text, depth = 0) {
  let quote = null
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === "[" || char === "{") {
      depth += 1
    } else if (char === "]" || char === "}") {
      depth -= 1
    }
  }
  return depth
}

function isContinuation(line) {
  return line.trim() === "" || /^[ \t]/.test(line)
}

function blockScalar(style, chomp, lines) {
  const content = lines.filter((line) => line.trim() !== "")
  const indent = Math.min(...content.map((line) => /^[ \t]*/.exec(line)[0].length))
  const body = lines.map((line) => line.slice(indent)).join("\n").replace(/\n+$/, "")
  const text = style === "|" ? body : body.replace(/([^\n])\n(?=[^\n])/g, "$1 ").replace(/\n\n/g, "\n")
  if (text === "") return ""
  return chomp === "-" ? text : `${text}\n`
}

function scalar(value) {
  const text = value.trim()
  if (text.startsWith('"')) {
    try { return JSON.parse(withoutFlowComments(text)) }
    catch { return null }
  }
  if (text.startsWith("'")) return quoted(text, "'")
  const plain = plainScalar(text)
  if (typeof plain !== "string") return plain
  const numeric = plain.replaceAll("_", "")
  if (/^(?:null|true|false|[-+]?\.inf|\.nan)$/iu.test(plain) ||
      numeric !== "" && !Number.isNaN(Number(numeric)) ||
      /^[-+]?\d+(?::[0-5]?\d)+(?:\.\d+)?$/u.test(numeric)) return null
  return plain
}

function withoutFlowComments(value) {
  let text = "", quote = null, comment = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (comment) {
      if (char === "\n") { comment = false; text += char }
    } else if (quote) {
      text += char
      if (quote === '"' && char === "\\") text += value[++index] ?? ""
      else if (char === quote) {
        if (quote === "'" && value[index + 1] === "'") text += value[++index]
        else quote = null
      }
    } else if (char === "#" && (index === 0 || /\s/u.test(value[index - 1]))) comment = true
    else {
      text += char
      if (char === '"' || char === "'") quote = char
    }
  }
  return text
}

function operatingFlowList(value) {
  const list = /^\[([\s\S]*)\][ \t]*$/u.exec(withoutFlowComments(value))
  if (!list) return value
  let rest = list[1].trim()
  const items = []
  while (rest) {
    const item = /^(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,[\]{}"']+?)(?=\s*(?:,|$))/u.exec(rest)
    if (!item) return value
    items.push(scalar(item[0]))
    rest = rest.slice(item[0].length).trimStart()
    if (rest.startsWith(",")) rest = rest.slice(1).trimStart()
  }
  return items
}

export function parseFrontmatterLite(text) {
  const normalized = String(text).replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  if (lines[0].trim() !== "---") {
    return { data: {}, content: normalized, matter: "" }
  }

  // Like gray-matter, a block with no closing `---` runs to the end of the file.
  let close = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (close === -1) close = lines.length
  const matterLines = lines.slice(1, close)
  const data = {}
  for (let index = 0; index < matterLines.length; index += 1) {
    const match = KEY_LINE_RE.exec(matterLines[index])
    if (!match) continue
    const [, key, raw = ""] = match
    if (Object.hasOwn(data, key)) throw malformed("a duplicate key")
    const value = raw.trim()

    const block = BLOCK_SCALAR_RE.exec(value)
    if (key === "operating_files" && (value === "" || value.startsWith("#"))) {
      const body = []
      while (index + 1 < matterLines.length &&
          (isContinuation(matterLines[index + 1]) || /^-(?:[ \t]|$)/u.test(matterLines[index + 1]))) {
        body.push(matterLines[++index])
      }
      const rows = body.filter(line => line.trim() && !line.trimStart().startsWith("#"))
      const items = rows.map(line => /^([ \t]*)-[ \t]+(.+)$/u.exec(line))
      data[key] = rows.length && items.every(item => item && item[1] === items[0][1])
        ? items.map(item => scalar(item[2])) : null
    } else if (block) {
      const body = []
      while (index + 1 < matterLines.length && isContinuation(matterLines[index + 1])) {
        body.push(matterLines[index + 1])
        index += 1
      }
      data[key] = blockScalar(block[1], block[2], body)
    } else if (value.startsWith('"') || value.startsWith("'")) {
      data[key] = quoted(value, value[0])
    } else if (value.startsWith("[") || value.startsWith("{")) {
      let depth = flowDepth(value)
      let collection = value
      while (depth > 0 && index + 1 < matterLines.length && isContinuation(matterLines[index + 1])) {
        index += 1
        depth = flowDepth(matterLines[index], depth)
        collection += `\n${matterLines[index]}`
      }
      if (depth !== 0) throw malformed("an unbalanced flow collection")
      data[key] = key === "operating_files" ? operatingFlowList(collection) : value
    } else {
      data[key] = plainScalar(value)
    }
  }

  return {
    data,
    content: lines.slice(close + 1).join("\n"),
    matter: `\n${matterLines.join("\n")}`,
  }
}
