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
// `scope`): quoted values are strings, an unquoted YAML timestamp is a Date
// (so an unquoted `updated:` is never treated as a string, exactly as under
// gray-matter), integers are numbers and `true`/`false`/`null`/`~` are what
// YAML says they are. Nested values are not parsed; `matter` keeps the raw
// frontmatter text, which is where the checks look for pull request URLs.

const KEY_LINE_RE = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{1,2}:\d{2}:\d{2}(?:\.\d+)?[ \t]*(?:Z|[+-]\d{1,2}(?::\d{2})?)?)?$/
const INTEGER_RE = /^[-+]?\d+$/

function scalar(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  const plain = value.replace(/[ \t]+#.*$/, "")
  if (plain === "" || plain === "~" || plain === "null") return null
  if (plain === "true") return true
  if (plain === "false") return false
  if (INTEGER_RE.test(plain)) return Number(plain)
  if (TIMESTAMP_RE.test(plain)) return new Date(plain.replace(" ", "T"))
  return plain
}

export function parseFrontmatterLite(text) {
  const normalized = String(text).replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  if (lines[0].trim() !== "---") {
    return { data: {}, content: normalized, matter: "" }
  }

  let close = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (close === -1) close = lines.length
  const matterLines = lines.slice(1, close)
  const data = {}
  for (const line of matterLines) {
    const match = KEY_LINE_RE.exec(line)
    if (!match) continue
    data[match[1]] = scalar(match[2] ?? "")
  }

  return {
    data,
    content: lines.slice(close + 1).join("\n"),
    matter: `\n${matterLines.join("\n")}`,
  }
}
