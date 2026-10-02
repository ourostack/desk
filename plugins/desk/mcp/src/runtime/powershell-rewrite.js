// A denied PowerShell command rewritten into the plain forms Desk's protected-checkout guard reads, so the denial can
// name the exact command to run instead of describing it. The rewrite is text-only and conservative: it touches only
// a top-level statement that starts with `git` and either (1) has an argument PowerShell would not pass to Git as
// written (`HEAD..@{u}` is `HEAD..@` followed by a script block `{u}`), which it single-quotes, or (2) pipes Git's
// output into something outside the guard's pipeline allowlist, which it splits into `$__deskGitOut = git ...` and
// `$__deskGitOut | ...`. `guardShellCommand` offers a rewrite only after the guard itself allows it, so a suggestion
// is never one the guard would deny. It returns null whenever it cannot read the text with certainty.

const PLAIN_GIT = /^git(?:\.exe)?$/iu
const NEEDS_QUOTES = /^[^\s'"`$]*@[{(][^\s'"`$]*$/u
const GROUPING = /[(){}]/u
const OUTPUT_VARIABLE = "$__deskGitOut"
const QUOTED = /'(?:[^']|'')*'|"(?:[^"`]|`.|"")*"/gu
const REDIRECTION = /[<>]/u
// The PowerShell commands that read a pipe as the text lines Git's output becomes in a variable. A native program
// (tar, sh, xargs, more) reads raw bytes instead, so a pipe into anything else is never split.
const TEXT_COMMANDS = /^(?:out-string|out-null|out-host|out-file|select-string|select-object|where-object|foreach-object|measure-object|sort-object|group-object|tee-object|set-content|add-content|write-output|write-host|convertto-json|convertfrom-json|select|where|foreach|sort|measure|group|tee|\?|%|format-[a-z]+|ft|fl|fw)$/iu

/** `text` cut at the top-level statement separators (`;`, new lines, `&&`, `||`), or null for text it cannot read with certainty. */
export function splitStatements(text) {
  const parts = []
  let start = 0, separator = "", depth = 0, quote = ""
  const cut = (end, next, following) => {
    parts.push({ separator, text: text.slice(start, end) })
    separator = following
    start = next
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === "`" && quote === '"') i++
      else if (c === quote) { if (text[i + 1] === quote) i++; else quote = "" }
      continue
    }
    if (c === "`") i++
    else if (c === "'" || c === '"') {
      // A here-string (@' or @") spans lines and holds anything.
      if (text[i - 1] === "@") return null
      quote = c
    } else if (c === "#" && (i === 0 || /[\s;]/u.test(text[i - 1]))) return null
    else if ("([{".includes(c)) depth++
    else if (")]}".includes(c)) { if (--depth < 0) return null }
    else if (depth === 0 && (c === ";" || c === "\n")) cut(i, i + 1, c)
    else if (depth === 0 && (c === "&" || c === "|") && text[i + 1] === c) { cut(i, i + 2, c + c); i++ }
  }
  if (quote || depth !== 0) return null
  cut(text.length, text.length, "")
  return parts
}

/** The words of one statement, split at white space outside quotes and groups. A statement is a slice `splitStatements` already read, so its quotes and groups are closed. */
function splitWords(text) {
  const words = []
  let start = -1, depth = 0, quote = ""
  for (let i = 0; i <= text.length; i++) {
    const c = text[i]
    if (c !== undefined && start < 0 && !/\s/u.test(c)) start = i
    if (quote) {
      if (c === "`" && quote === '"') i++
      else if (c === quote) { if (text[i + 1] === quote) i++; else quote = "" }
      continue
    }
    if (c === "`") i++
    else if (c === "'" || c === '"') quote = c
    else if (c !== undefined && "([{".includes(c)) depth++
    else if (c !== undefined && ")]}".includes(c)) depth--
    else if (depth === 0 && (c === undefined || /\s/u.test(c)) && start >= 0) {
      words.push(text.slice(start, i))
      start = -1
    }
  }
  // A trailing backtick skips the end of the text, so the last word is still open.
  if (start >= 0) words.push(text.slice(start))
  return words
}

/** The words cut at each `|` into the stages of the rest of a pipeline. */
function splitStages(words) {
  const stages = [[]]
  for (const word of words) word === "|" ? stages.push([]) : stages.at(-1).push(word)
  return stages
}

const singleQuoted = (word) => `'${word.replaceAll("'", "''")}'`

/** One statement's rewrite, or null when it needs none or cannot be rewritten with certainty. */
function rewriteStatement(core) {
  const words = splitWords(core)
  if (!PLAIN_GIT.test(words[0] ?? "")) return null
  const bar = words.indexOf("|")
  const head = (bar < 0 ? words : words.slice(0, bar)).map((word, index) => (index > 0 && NEEDS_QUOTES.test(word) ? singleQuoted(word) : word))
  const tail = bar < 0 ? [] : words.slice(bar + 1)
  const changed = head.join(" ") !== words.slice(0, head.length).join(" ")
  if (bar < 0) return changed ? head.join(" ") : null
  const unquoted = head.join(" ").replace(QUOTED, "")
  if (tail.length === 0 || GROUPING.test(unquoted) || REDIRECTION.test(unquoted)) return null
  // Every stage after the first pipe must be a known PowerShell command, or the split would change what it reads.
  if (!splitStages(tail).every((stage) => TEXT_COMMANDS.test(stage[0] ?? ""))) return null
  return `${OUTPUT_VARIABLE} = ${head.join(" ")}; ${OUTPUT_VARIABLE} | ${tail.join(" ")}`
}

/**
 * The command with every statement that can be rewritten rewritten, or null when none can. A statement that follows
 * `&&` or `||` stays as it is, because moving it would change when it runs.
 */
export function rewritePowerShell(command) {
  const statements = splitStatements(command)
  if (statements === null) return null
  let changed = false
  const rebuilt = statements.map(({ separator, text }) => {
    const core = text.trim()
    const rewritten = separator === "&&" || separator === "||" ? null : rewriteStatement(core)
    if (rewritten === null) return separator + text
    changed = true
    return separator + text.replace(core, () => rewritten)
  })
  return changed ? rebuilt.join("") : null
}
