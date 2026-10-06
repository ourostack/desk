// Inspect shell syntax without executing it. Quoted data stays data; substitutions and
// literal shell/eval wrappers are walked as commands. Unknown program exit statuses
// fork the &&/|| paths, and subshells/pipelines cannot change their parent's cwd.
// A value computed by a program the inspector does not model is unknown (guard-unknowns.js):
// an unknown directory is carried forward, and only an unknown program, script or Git
// target that could reach Git ends inspection with a denial.
import * as path from "node:path"
import { bashPath, mktempPath, physicalDirectory, staticGitOutput } from "./shell-paths.js"
import { inspectPowerShell } from "./powershell-commands.js"
import { inspectionBudget, mayInvokeGit, mergedValue, UNKNOWN, UNKNOWN_GIT, unknownOutput } from "./guard-unknowns.js"

const separators = new Set([";", "\n", "&", "&&", "||", "|", "(", ")", "{", "}"])

export function tokenizeShell(text, powershell = false) {
  const tokens = []
  let parts = [], value = "", active = false, quote = "", pendingHere = null, quoted = false, braced = false
  const heredocs = []
  const part = (expand) => {
    parts.push({ text: value, expand, quoted: Boolean(quote) })
    value = ""
  }
  const word = () => {
    if (!active) return
    part(quote !== "'")
    if (braced) {
      // Bash expands `{a,b}` and `{1..3}` into several words before anything else, from the text alone.
      if (parts.some((p) => p.text !== "" && (p.quoted || !p.expand)) || /\$[({]|`/u.test(parts.map((p) => p.text).join(""))) throw new Error("unresolved brace expansion")
      for (const text of expandBraces(parts.map((p) => p.text).join(""))) tokens.push({ parts: [{ text, expand: true, quoted: false }], quoted: false })
      parts = []; active = false; quoted = false; braced = false
      return
    }
    const token = { parts, quoted }
    tokens.push(token)
    if (pendingHere) {
      heredocs.push({ delimiter: parts.map((p) => p.text).join(""), expand: !parts.some((p) => !p.expand), tabs: pendingHere.redirect === "<<-", token: pendingHere })
      pendingHere = null
    }
    parts = []; active = false; quoted = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (c === (powershell ? "`" : "\\") && quote !== "'") {
      active = true
      if (next === "\n") { i++; continue }
      if (!powershell && quote === '"' && !["$", "`", '"', "\\"].includes(next)) { value += c; continue }
      part(true); parts.push({ text: next ?? "", expand: false }); i++
      continue
    }
    if (!powershell && c === "`" && quote !== "'") {
      const end = text.indexOf("`", i + 1)
      if (end < 0) throw new Error("unterminated backtick substitution")
      active = true; value += `$(${text.slice(i + 1, end)})`; i = end
      continue
    }
    if (quote) {
      if (c === quote) {
        if (powershell && quote === "'" && next === "'") { value += "'"; i++; continue }
        part(quote !== "'"); quote = ""
      } else if (quote === '"' && c === "$" && next === "(") {
        const sub = substitution(text, i + 2)
        value += text.slice(i, sub.end + 1); i = sub.end
      } else value += c
      continue
    }
    if (!powershell && c === "$" && next === "'") {
      active = true; quoted = true; part(true)
      const ansi = ansiQuoted(text, i + 2)
      parts.push({ text: ansi.text, expand: false, quoted: true })
      i = ansi.end
    } else if (c === "'" || c === '"') {
      active = true; quoted = true; part(true); quote = c
    } else if (c === "$" && next === "(") {
      active = true
      const sub = substitution(text, i + 2)
      value += text.slice(i, sub.end + 1); i = sub.end
    } else if (c === "#" && !active) {
      while (i < text.length && text[i] !== "\n") i++
      i--
    } else if (c === "\n") {
      word()
      // A here-document's body follows the line, but it belongs to the redirect that opened it: that command's stdin.
      for (const here of heredocs.splice(0)) {
        let body = ""
        while (++i < text.length) {
          const end = text.indexOf("\n", i)
          const stop = end < 0 ? text.length : end
          const line = text.slice(i, stop)
          i = stop
          if ((here.tabs ? line.replace(/^\t+/u, "") : line) === here.delimiter) break
          body += `${line}\n`
        }
        here.token.heredoc = body
        here.token.literal = !here.expand
      }
      tokens.push("\n")
    } else if (/\s/u.test(c)) {
      word()
    } else if (!powershell && "<>".includes(c) && next === "(" && !active) {
      // Process substitution runs its command and stands for a path, like $( ) stands for its output.
      active = true
      const sub = substitution(text, i + 2)
      value += `$(${sub.text})`; i = sub.end
    } else if ("<>".includes(c)) {
      // Redirection paths are operands, never commands. Keep substitutions in them.
      if (active && /^\d+$/u.test(value) && parts.length === 0) { value = ""; active = false }
      word()
      let op = c
      while (text[i + 1] === c || ["&", "-"].includes(text[i + 1])) op += text[++i]
      const redirect = { redirect: op }
      tokens.push(redirect)
      if (op === "<<" || op === "<<-") pendingHere = redirect
    } else if (separators.has(c)) {
      // Braces inside ${VAR} belong to the word.
      if (c === "{" && value.endsWith("$")) {
        const end = text.indexOf("}", i)
        if (end >= 0) { value += text.slice(i, end + 1); i = end; continue }
      }
      // Bash's { and } are reserved words only as whole words, so `@{upstream}` and `HEAD@{1}` are one word. A brace
      // expansion such as `{main,topic}` makes several words (expandBraces).
      if (!powershell && (c === "{" || c === "}") && (active || !(next === undefined || (c === "{" ? /\s/u : /[\s;&|)<>]/u).test(next)))) {
        if (c === "{" && !quote && braceEnd(text, i) > 0) braced = true
        active = true; value += c
        continue
      }
      word()
      let op = (c === "&" || c === "|") && next === c ? c + text[++i] : c
      if (c === ";" && (next === ";" || next === "&")) {
        op += text[++i]
        if (op === ";;" && text[i + 1] === "&") op += text[++i]
      }
      tokens.push(op)
    } else {
      active = true; value += c
    }
  }
  if (quote) throw new Error("unterminated shell quote")
  word()
  return tokens
}

// The index of the `}` that closes a brace expansion opened at `start` (a top-level `,` or a `x..y` sequence), or -1.
function braceEnd(text, start) {
  let depth = 0, comma = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (/[\s;&|<>()]/u.test(c)) return -1
    // A quoted piece stays inside the word (word() then refuses to expand a word that mixes quotes).
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1)
      if (close < 0) return -1
      i = close
    } else if (c === "{") depth++
    else if (c === "}" && --depth === 0) return comma || /^\{(?:-?\d+\.\.-?\d+|[A-Za-z]\.\.[A-Za-z])(?:\.\.-?\d+)?\}$/u.test(text.slice(start, i + 1)) ? i : -1
    else if (c === "," && depth === 1) comma = true
  }
  return -1
}

const BRACE_WORDS = 4096
/** Bash brace expansion of an unquoted word: `a{b,c}d`, nesting, and `{1..3}`/`{a..c}` sequences with an optional step. */
export function expandBraces(word) {
  let out = [""], i = 0
  while (i < word.length) {
    const end = word[i] === "{" ? braceEnd(word, i) : -1
    if (end < 0) { out = out.map((w) => w + word[i]); i++; continue }
    const inner = word.slice(i + 1, end)
    let items = []
    const sequence = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/u.exec(inner)
    if (sequence && /^-?\d/u.test(sequence[1]) === /^-?\d/u.test(sequence[2])) {
      const numeric = /^-?\d/u.test(sequence[1])
      const from = numeric ? Number(sequence[1]) : sequence[1].charCodeAt(0), to = numeric ? Number(sequence[2]) : sequence[2].charCodeAt(0)
      const step = Math.abs(Number(sequence[3] ?? 1)) || 1
      const width = numeric && /^-?0\d/u.test(sequence[1] + sequence[2]) ? Math.max(sequence[1].length, sequence[2].length) : 0
      if (Math.abs(to - from) / step >= BRACE_WORDS) throw new Error("brace expansion too large")
      for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) {
        items.push(numeric ? String(n).padStart(width, "0") : String.fromCharCode(n))
      }
    } else {
      let depth = 0, startItem = 0
      for (let j = 0; j <= inner.length; j++) {
        if (j === inner.length || (inner[j] === "," && depth === 0)) { items.push(...expandBraces(inner.slice(startItem, j))); startItem = j + 1 }
        else if (inner[j] === "{") depth++
        else if (inner[j] === "}") depth--
      }
    }
    out = out.flatMap((w) => items.map((item) => w + item))
    if (out.length > BRACE_WORDS) throw new Error("brace expansion too large")
    i = end + 1
  }
  return out
}

function ansiQuoted(text, start) {
  let value = ""
  const escapes = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' }
  for (let i = start; i < text.length; i++) {
    if (text[i] === "'") return { text: value, end: i }
    if (text[i] !== "\\") { value += text[i]; continue }
    const c = text[++i]
    if (c in escapes) { value += escapes[c]; continue }
    const pattern = c === "x" ? /^[0-9a-fA-F]{1,2}/u : c === "u" ? /^[0-9a-fA-F]{1,4}/u : c === "U" ? /^[0-9a-fA-F]{1,8}/u : null
    if (pattern) {
      const match = pattern.exec(text.slice(i + 1))
      if (!match) throw new Error("unresolved ANSI-C escape")
      value += String.fromCodePoint(parseInt(match[0], 16)); i += match[0].length
    } else if (/[0-7]/u.test(c)) {
      const match = /^[0-7]{1,3}/u.exec(text.slice(i))
      value += String.fromCharCode(parseInt(match[0], 8)); i += match[0].length - 1
    } else if (c === "c") {
      const control = text[++i]
      if (control === undefined) throw new Error("unresolved ANSI-C control escape")
      value += String.fromCharCode(control.toUpperCase().charCodeAt(0) & 31)
    } else value += `\\${c}`
  }
  throw new Error("unterminated ANSI-C quote")
}

function substitution(text, start) {
  let depth = 1, quote = ""
  const pending = []
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === "\\" && quote !== "'") { i++; continue }
    if (quote) { if (c === quote) quote = ""; continue }
    // A here-document's body is raw text up to its delimiter line; quotes and parentheses in it do not count.
    const here = !quote && c === "<" && /^<<(-?)[ \t]*(['"]?)([\w.-]+)\2/u.exec(text.slice(i))
    if (here && text[i + 2] !== "<") { pending.push({ delimiter: here[3], tabs: here[1] === "-" }); i += here[0].length - 1; continue }
    if (c === "\n" && pending.length) {
      for (const { delimiter, tabs } of pending.splice(0)) {
        while (i < text.length) {
          const end = text.indexOf("\n", i + 1)
          const line = text.slice(i + 1, end < 0 ? text.length : end)
          i = end < 0 ? text.length : end
          if ((tabs ? line.replace(/^\t+/u, "") : line) === delimiter) break
        }
      }
      continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === "(") depth++
    if (c === ")" && --depth === 0) return { text: text.slice(start, i), end: i }
  }
  throw new Error("unterminated command substitution")
}

function parse(tokens) {
  let i = 0
  const keyword = (token) => typeof token === "string" ? token : token?.quoted ? null : token?.parts?.map((p) => p.text).join("")
  function list(ends = []) {
    const nodes = []
    while (i < tokens.length && !ends.includes(keyword(tokens[i]))) {
      if ([";", "\n"].includes(tokens[i])) { i++; continue }
      let node = andOr()
      if (tokens[i] === "&") { i++; node = { kind: "background", body: node } }
      nodes.push(node)
    }
    return { kind: "list", nodes }
  }
  function expect(value) {
    if (keyword(tokens[i++]) !== value) throw new Error(`expected shell ${value}`)
  }
  function conditional() {
    i++
    const condition = list(["then"])
    expect("then")
    const yes = list(["else", "elif", "fi"])
    let no = { kind: "list", nodes: [] }
    if (keyword(tokens[i]) === "elif") no = conditional()
    else {
      if (keyword(tokens[i]) === "else") { i++; no = list(["fi"]) }
      expect("fi")
    }
    return { kind: "if", condition, yes, no }
  }
  function andOr() {
    let node = pipeline()
    while (tokens[i] === "&&" || tokens[i] === "||") {
      const op = tokens[i++]
      while (tokens[i] === "\n") i++
      node = { kind: op, left: node, right: pipeline() }
    }
    return node
  }
  function pipeline() {
    const nodes = [command()]
    while (tokens[i] === "|") {
      i++
      while (tokens[i] === "\n") i++
      nodes.push(command())
    }
    return nodes.length === 1 ? nodes[0] : { kind: "pipe", nodes }
  }
  function command() {
    if (keyword(tokens[i]) === "!") { i++; return { kind: "not", body: command() } }
    if (keyword(tokens[i]) === "if") return conditional()
    if (keyword(tokens[i]) === "case") {
      i++
      const value = tokens[i++]
      expect("in")
      const arms = []
      while (true) {
        while (tokens[i] === "\n") i++
        if (keyword(tokens[i]) === "esac") break
        if (tokens[i] === "(") i++
        const patterns = []
        while (tokens[i]?.parts || tokens[i] === "|") {
          if (tokens[i] !== "|") patterns.push(tokens[i])
          i++
        }
        expect(")")
        const body = list([";;", ";&", ";;&", "esac"])
        const terminator = tokens[i]
        arms.push({ patterns, body, terminator })
        if (keyword(tokens[i]) !== "esac") i++
      }
      expect("esac")
      return { kind: "case", value, arms }
    }
    if (["while", "until"].includes(keyword(tokens[i]))) {
      const until = keyword(tokens[i++]) === "until"
      const condition = list(["do"])
      expect("do")
      const body = list(["done"])
      expect("done")
      return { kind: "while", until, condition, body }
    }
    if (tokens[i]?.parts && tokens[i + 1] === "(" && tokens[i + 2] === ")") {
      const name = keyword(tokens[i])
      i += 3
      return { kind: "define", name, body: command() }
    }
    if (keyword(tokens[i]) === "for") {
      i++
      const variable = keyword(tokens[i++])
      expect("in")
      const values = []
      while (tokens[i]?.parts) values.push(tokens[i++])
      while (tokens[i] === ";" || tokens[i] === "\n") i++
      expect("do")
      const body = list(["done"])
      expect("done")
      return { kind: "for", variable, values, body }
    }
    if (tokens[i] === "(" || tokens[i] === "{") {
      const scoped = tokens[i++] === "("
      const end = scoped ? ")" : "}"
      const body = list([end])
      expect(end)
      return { kind: "group", scoped, body }
    }
    const words = [], redirects = []
    let stdin = null
    while (i < tokens.length && typeof tokens[i] !== "string") {
      const token = tokens[i++]
      if (token.redirect) {
        if (tokens[i]?.parts) {
          // A here-document's delimiter word is not a path; its body is the command's stdin.
          if (token.heredoc !== undefined) stdin = { parts: [{ text: token.heredoc, expand: !token.literal }] }
          else if (token.redirect === "<<<") stdin = tokens[i]
          // A file's contents are not read: unknown input.
          else if (token.redirect === "<") stdin = { parts: [{ text: UNKNOWN, expand: false }] }
          redirects.push(token.heredoc !== undefined ? stdin : tokens[i])
          i++
        }
      } else words.push(token)
    }
    if (!words.length && !redirects.length) throw new Error(`unexpected shell operator ${tokens[i]}`)
    return { kind: "command", words, redirects, stdin }
  }
  return list()
}

// More distinct reachable states than this are merged, so a long script's conditionals cannot multiply them: states
// that agree on status, termination, functions and input become one, and any directory or variable they disagree on
// becomes unknown (could-be-Git when any candidate could run Git).
const STATE_LIMIT = 16

function unique(states) {
  const distinct = [...new Map(states.map((s) => [JSON.stringify(s), s])).values()]
  if (distinct.length <= STATE_LIMIT) return distinct
  const merged = new Map()
  for (const s of distinct) {
    const key = JSON.stringify([s.status, s.terminated, s.functions, s.stdin])
    const other = merged.get(key)
    if (!other) { merged.set(key, s); continue }
    const vars = {}
    for (const name of new Set([...Object.keys(other.vars), ...Object.keys(s.vars)])) vars[name] = other.vars[name] === s.vars[name] ? s.vars[name] : mergedValue(other.vars[name], s.vars[name])
    const same = (field) => other[field] === s[field] ? s[field] : UNKNOWN
    merged.set(key, { ...s, vars, cwd: same("cwd"), logicalCwd: same("logicalCwd") })
  }
  return [...merged.values()]
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "pwsh", "powershell"])
const POWERSHELL_VALUES = /^(?:ex|ep|exe\w*|config\w*|cus\w*|inp\w*|if|o|of|out\w*|settings\w*|w|win\w*|encodeda\w*)$/u

/**
 * The script a shell invocation runs: { command } for -c or -Command text (PowerShell joins every later argument),
 * { stdin: true } when it reads its script from stdin, { encoded: true } for PowerShell's -EncodedCommand, and {} for
 * a script file. A PowerShell -WorkingDirectory is returned as `directory`.
 */
export function shellScript(name, args) {
  if (name !== "pwsh" && name !== "powershell") {
    const flag = args.findIndex((arg, i) => i > 0 && /^-[a-z]*c[a-z]*$/u.test(arg))
    if (flag > 0) return args[flag + 1] === undefined ? {} : { command: args[flag + 1], positional: args.slice(flag + 2) }
    // With no script operand, or with -s (the rest are positional arguments), a POSIX shell reads its script from stdin.
    return args.slice(1).every((arg) => arg.startsWith("-")) || args.slice(1).some((arg) => /^-[a-z]*s[a-z]*$/u.test(arg)) ? { stdin: true } : {}
  }
  let directory
  for (let i = 1; i < args.length; i++) {
    const option = /^-{1,2}(\w+)$/u.exec(args[i])
    if (!option) return {}
    const key = option[1].toLowerCase()
    const is = (full, shortest) => key.length >= shortest && full.startsWith(key)
    if (key === "c" || is("command", 3)) {
      const rest = args.slice(i + 1)
      return rest[0] === "-" ? { stdin: true, directory } : rest.length ? { command: rest.join(" "), directory } : {}
    }
    if (["e", "ec"].includes(key) || is("encodedcommand", 3)) return { encoded: true }
    if (is("file", 1)) return args[i + 1] === "-" ? { stdin: true, directory } : {}
    if (key === "wd" || is("workingdirectory", 3)) directory = args[++i] ?? ""
    else if (POWERSHELL_VALUES.test(key)) i++
  }
  return { stdin: true, directory }
}

function literalPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

function globPattern(text) {
  let result = ""
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "*") result += ".*"
    else if (text[i] === "?") result += "."
    else if (text[i] === "[" && text.indexOf("]", i + 1) >= 0) {
      const end = text.indexOf("]", i + 1)
      const characters = text.slice(i + 1, end)
      result += `[${characters.replace(/^!/u, "^")}]`
      i = end
    } else result += literalPattern(text[i])
  }
  return result
}

function unescapeText(text) {
  return text.replace(/\\([nt\\])/gu, (_, c) => ({ n: "\n", t: "\t", "\\": "\\" })[c])
}

function wordText(words) {
  return words.map((word) => word.parts.map((part) => part.text).join("")).join(" ")
}

// `budget` is shared by every nested inspection of one command (guard-unknowns.js).
// `via` names what the command text being inspected is the value of: `{ name, real, word, text }` when it is the body of a
// `$(...)` in the assignment word `name=...` (`real` when that assignment really sets the variable, as a prefix to a command
// or an argument of `export` or `env`; `text` is the substitution's text). Every command visited directly in that text carries
// it, so a guard can tell `GH_TOKEN=$(gh auth token) git push` from `echo $(gh auth token)`.
export async function inspectShell({ command, cwd, env, powershell = false, visit, depth = 0, budget = inspectionBudget(), via }) {
  if (powershell) return inspectPowerShell({ command, cwd, env, visit, depth, budget })
  if (depth > 16) throw new Error("shell wrapper nesting exceeds 16")
  const tree = parse(tokenizeShell(command))
  let serial = 0
  async function nested(text, state, shell = "bash", origin) {
    // An eval, -c or stdin script Desk cannot read is not judged (the guard is not a sandbox): text with no Git in
    // what is known passes, and readable Git text is inspected with its unknown parts as unknown values.
    if (text.includes(UNKNOWN) && !mayInvokeGit(text.replaceAll(UNKNOWN_GIT, "").replaceAll(UNKNOWN, " "))) return
    return inspectShell({ command: text, cwd: state.cwd, env: state.vars, powershell: shell === "powershell", visit, depth: depth + 1, budget, via: origin })
  }
  async function expand(word, state, split = false, origin) {
    const fields = [""]
    const emit = (text, canSplit = false) => {
      const ifs = state.vars.IFS ?? " \t\n"
      for (const c of text) {
        if (split && canSplit && ifs.includes(c)) {
          if (fields.at(-1) !== "") fields.push("")
        } else fields[fields.length - 1] += c
      }
    }
    for (const [index, part] of word.parts.entries()) {
      if (!part.expand) { emit(part.text); continue }
      let text = part.text
      if (index === 0 && !part.quoted) text = text.replace(/^~(?=$|\/)/u, () => bashPath.value(state.vars.HOME ?? "~"))
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "$" && text[i + 1] === "(") {
          const sub = substitution(text, i + 2)
          await nested(sub.text, state, "bash", origin && { ...origin, text: sub.text })
          emit(await literalOutput(sub.text, state), !part.quoted)
          i = sub.end
        } else if (text[i] === "$") {
          const match = /^\$(?:\{([A-Za-z_]\w*|\d+)\}|(?:env:)?([A-Za-z_]\w*|\d))/u.exec(text.slice(i))
          if (match) {
            emit(bashPath.value(state.vars[match[1] ?? match[2]] ?? ""), !part.quoted)
            i += match[0].length - 1
          } else emit(text[i])
        } else emit(text[i])
      }
    }
    return split ? fields.filter((field) => field !== "" || word.quoted).map(bashPath.word) : bashPath.word(fields.join(""))
  }
  async function literalOutput(text, state) {
    const tokens = tokenizeShell(text)
    if (!tokens.every((token) => token.parts)) return unknownOutput(text)
    return outputOf(tokens, text, state)
  }
  // The output of a literal pwd, echo, printf '%s' or mktemp, without running it; otherwise unknown.
  async function outputOf(tokens, text, state) {
    const words = []
    // The words are expanded again to read the output, so an assignment keeps the origin it has when the command runs.
    for (const token of tokens) {
      const name = token.parts && /^[A-Za-z_]\w*(?==)/u.exec(token.parts[0].text)?.[0]
      const leading = words.every((word) => /^[A-Za-z_]\w*=/u.test(word))
      words.push(await expand(token, state, false, name ? { name, real: leading || ["export", "env", "declare", "typeset", "local", "readonly"].includes(words[0]), word: token } : undefined))
    }
    if (words[0] === "pwd" && words.length === 1) return bashPath.value(state.cwd)
    // Read-only Git that names the checkout or its branch is answered from the file system.
    const answered = staticGitOutput(words, state.cwd, state.vars)
    if (answered !== null) return answered
    if (words[0] === "echo") {
      let i = 1, escapes = false
      for (; /^-[neE]+$/u.test(words[i] ?? ""); i++) escapes = /e[^E]*$/u.test(words[i])
      const output = words.slice(i).join(" ")
      return (escapes ? unescapeText(output) : output).replace(/\n+$/u, "")
    }
    if (words[0] === "printf" && words.length > 1) {
      // Only %s, %b and %% conversions are modeled; the format repeats while arguments remain.
      const format = words[1], values = words.slice(2)
      if (/%[^%sb]/u.test(format)) return unknownOutput(text)
      let output = "", k = 0
      do {
        output += format.replace(/%([%sb])/gu, (_, c) => c === "%" ? "%" : values[k++] ?? "")
      } while (k > 0 && k < values.length)
      return unescapeText(output).replace(/\n+$/u, "")
    }
    if (words[0] === "mktemp") return mktempPath(words.slice(1), state.cwd, state.vars, ++serial) ?? UNKNOWN
    return unknownOutput(text)
  }
  // An if or while condition never ends the script under `set -e`.
  async function condition(node, state) {
    return (await run(node, { ...state, errexit: false })).map((s) => ({ ...s, errexit: state.errexit }))
  }
  // A directory this command creates (mkdir, git worktree add) can be entered later in the same command.
  function created(state, operand) {
    if (operand === undefined || operand.includes(UNKNOWN) || state.logicalCwd.includes(UNKNOWN)) return state
    return { ...state, made: [...state.made ?? [], path.resolve(state.logicalCwd, operand)] }
  }
  function positional(state, values, start) {
    const vars = Object.fromEntries(Object.entries(state.vars).filter(([key]) => !/^\d+$/u.test(key)))
    for (let i = 0; i < values.length; i++) vars[i + start] = values[i]
    return { ...state, vars }
  }
  async function run(node, state) {
    await budget.step()
    if (state.terminated) return [state]
    if (node.kind === "case") {
      const value = await expand(node.value, state)
      let states = [{ ...state, status: true }], fallthrough = false
      for (const arm of node.arms) {
        let matched = fallthrough || value.includes("\0")
        for (const pattern of arm.patterns) {
          let expression = ""
          for (const part of pattern.parts) {
            const text = await expand({ parts: [part] }, state)
            if (text.includes("\0")) matched = true
            expression += part.quoted || !part.expand ? literalPattern(text) : globPattern(text)
          }
          if (new RegExp(`^${expression}$`, "u").test(value)) matched = true
        }
        if (!matched) continue
        states = (await Promise.all(states.map((s) => run(arm.body, s)))).flat()
        if (arm.terminator === ";;" && !value.includes("\0")) return states
        fallthrough = arm.terminator === ";&"
      }
      return states
    }
    if (node.kind === "define") return [{ ...state, functions: { ...state.functions, [node.name]: node.body }, status: true }]
    if (node.kind === "while") {
      const states = await condition(node.condition, state), out = []
      for (const s of states) {
        if (s.status !== node.until) out.push(...await run(node.body, s))
        else out.push({ ...s, status: true })
      }
      return unique(out)
    }
    if (node.kind === "if") {
      const states = await condition(node.condition, state)
      // An if whose condition fails and has no else branch succeeds.
      return (await Promise.all(states.map((s) => run(s.status ? node.yes : node.no, { ...s, status: true })))).flat()
    }
    if (node.kind === "for") {
      // Identical states after an iteration are merged before the next one, so a loop costs steps in
      // proportion to its length instead of doubling them per iteration.
      let states = [state]
      for (const word of node.values) {
        const value = await expand(word, state)
        states = unique((await Promise.all(states.map((s) => run(node.body, { ...s, vars: { ...s.vars, [node.variable]: value } })))).flat())
      }
      return states
    }
    if (node.kind === "not") return (await run(node.body, state)).map((s) => ({ ...s, status: !s.status, exempt: true }))
    if (node.kind === "background") { await run(node.body, state); return [{ ...state, status: true }] }
    if (node.kind === "list") {
      let states = [state]
      for (const [index, item] of node.nodes.entries()) {
        states = (await Promise.all(states.map((s) => run(item, s)))).flat()
        // Under `set -e`, a failed command ends the script, unless it failed on the left of && or || or under !.
        states = states.map(({ exempt, ...s }) => s.errexit && !s.status && !exempt ? { ...s, terminated: true } : s)
        // Only the last item's status reaches the list's caller ($? is not modeled).
        if (index < node.nodes.length - 1) states = states.map((s) => ({ ...s, status: true }))
        states = unique(states)
      }
      return states
    }
    if (node.kind === "&&" || node.kind === "||") {
      const left = await run(node.left, state), out = []
      for (const s of left) {
        if (s.status === (node.kind === "&&" ? true : false)) out.push(...await run(node.right, s))
        else out.push({ ...s, exempt: true })
      }
      return out
    }
    if (node.kind === "group") {
      const result = await run(node.body, { ...state, vars: { ...state.vars } })
      return node.scoped ? result.map((s) => ({ ...state, status: s.status })) : result
    }
    if (node.kind === "pipe") {
      // Each command reads the one before it: literal echo or printf output, `cat` of a here-document or here-string,
      // or unknown output (a shell reading it fails closed).
      let input = state.stdin
      for (const item of node.nodes) {
        await run(item, { ...state, vars: { ...state.vars }, stdin: input })
        const catBody = item.kind === "command" && wordText(item.words) === "cat" && item.stdin && item.redirects.length === 1
        input = catBody ? await expand(item.stdin, state)
          : item.kind === "command" && !item.redirects.length ? await outputOf(item.words, wordText(item.words), state) : UNKNOWN
      }
      return [{ ...state, status: true }, { ...state, status: false }]
    }
    for (const redirect of node.redirects) await expand(redirect, state)
    const local = { ...state, vars: { ...state.vars } }
    let leading = 0
    while (leading < node.words.length && /^[A-Za-z_]\w*=/u.test(node.words[leading].parts[0].text)) {
      const assignment = await expand(node.words[leading], local, false, { name: /^[A-Za-z_]\w*/u.exec(node.words[leading].parts[0].text)[0], real: true, word: node.words[leading] })
      leading++
      const at = assignment.indexOf("=")
      local.vars[assignment.slice(0, at)] = assignment.slice(at + 1)
    }
    let args = []
    for (const word of node.words.slice(leading)) {
      const assignment = /^[A-Za-z_]\w*=/u.test(word.parts[0].text)
      const split = !(assignment && args[0] === "export")
      const origin = assignment ? { name: /^[A-Za-z_]\w*/u.exec(word.parts[0].text)[0], real: ["export", "env", "declare", "typeset", "local", "readonly"].includes(args[0]), word } : undefined
      args.push(...(split ? await expand(word, state, true, origin) : [await expand(word, state, false, origin)]))
    }
    if (!args.length) return [{ ...local, status: true }]
    let name = path.basename(args[0]).replace(/\.exe$/iu, "").toLowerCase()
    while (["command", "exec", "env", "builtin", "nohup", "time", "timeout", "nice", "sudo"].includes(name)) {
      const wrapper = name
      args.shift()
      while (args[0]?.startsWith("-")) {
        const flag = args.shift()
        if (flag === "-u" || flag === "--unset") delete local.vars[args.shift()]
        if (flag === "-C" || flag === "--chdir") {
          const dir = physicalDirectory(local.cwd, args.shift())
          if (!dir) return [{ ...state, status: false }]
          local.cwd = dir
          local.logicalCwd = dir
        }
        if (wrapper === "nice" && flag === "-n") args.shift()
      }
      if (wrapper === "timeout") args.shift()
      while (args[0] && /^[A-Za-z_]\w*=/u.test(args[0])) {
        const at = args[0].indexOf("=")
        local.vars[args[0].slice(0, at)] = args[0].slice(at + 1); args.shift()
      }
      name = path.basename(args[0] ?? "").replace(/\.exe$/iu, "").toLowerCase()
    }
    const unknown = [{ ...state, status: true }, { ...state, status: false }]
    if (path.basename(args[0] ?? "").includes(UNKNOWN)) {
      // A program whose name is unknown is judged as Git when its arguments read like a checked Git command. A computed
      // directory with a known name, such as "$(npm bin)/nx", is that program.
      await visit({ name: "git", args: args.slice(1), cwd: local.cwd, env: local.vars, computed: true, via })
      return unknown
    }
    if (name === "export") {
      for (const arg of args.slice(1)) {
        const at = arg.indexOf("=")
        if (at > 0) local.vars[arg.slice(0, at)] = arg.slice(at + 1)
      }
      return [{ ...local, status: true }]
    }
    if (name === "exit") return [{ ...state, terminated: true, status: args[1] === undefined || args[1] === "0" }]
    const unknownDirectory = [{ ...local, cwd: UNKNOWN, logicalCwd: UNKNOWN, vars: { ...local.vars, OLDPWD: state.logicalCwd, PWD: UNKNOWN }, status: true }, { ...state, status: false }]
    // pushd DIR changes directory like cd; the directory stack itself is not modeled.
    if (name === "popd" || (name === "pushd" && !/^[^+-]/u.test(args[1] ?? ""))) return unknownDirectory
    if (name === "cd" || name === "pushd") {
      let physical = false, operand
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--") { operand = args[i + 1]; break }
        if (/^-[LP]+$/u.test(args[i])) { physical = args[i].endsWith("P"); continue }
        operand = args[i]; break
      }
      const target = operand === "-" ? local.vars.OLDPWD : operand ?? local.vars.HOME
      if (target?.includes(UNKNOWN) || (target && !path.isAbsolute(target) && local.cwd === UNKNOWN)) return unknownDirectory
      const prefixes = target && !path.isAbsolute(target) && !/^\.{1,2}(?:\/|$)/u.test(target) && local.vars.CDPATH
        ? [...local.vars.CDPATH.split(":"), ""] : [""]
      for (const prefix of prefixes) {
        const candidate = prefix ? `${prefix}/${target}` : target
        const logical = candidate ? path.resolve(local.logicalCwd, candidate) : null
        const dir = candidate ? physicalDirectory(local.cwd, physical ? candidate : logical) : null
        if (dir) {
          const logicalCwd = physical ? dir : logical
          return [{ ...local, cwd: dir, logicalCwd, vars: { ...local.vars, OLDPWD: state.logicalCwd, PWD: logicalCwd }, status: true }]
        }
      }
      const made = target && !target.includes(UNKNOWN) ? path.resolve(local.logicalCwd, target) : null
      if (made !== null && local.made?.includes(made)) {
        return [{ ...local, cwd: made, logicalCwd: made, vars: { ...local.vars, OLDPWD: state.logicalCwd, PWD: made }, status: true }]
      }
      return [{ ...state, status: false }]
    }
    if (name === "set") {
      const flags = args.slice(1)
      const errexit = flags.some((flag, i) => /^-[a-z]*e/u.test(flag) || (flag === "-o" && flags[i + 1] === "errexit"))
        ? true : flags.some((flag, i) => /^\+[a-z]*e/u.test(flag) || (flag === "+o" && flags[i + 1] === "errexit")) ? false : local.errexit
      return [{ ...local, errexit, status: true }]
    }
    if (name === "mkdir") {
      let made = local
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "-m" || args[i] === "--mode") i++
        else if (!args[i].startsWith("-")) made = created(made, args[i])
      }
      // `mkdir -p` succeeds when the directory already exists, so only its success is modeled.
      return args.some((arg) => /^-[a-z]*p/u.test(arg) || arg === "--parents") ? [{ ...made, status: true }] : [{ ...made, status: true }, { ...state, status: false }]
    }
    // `rm -f` succeeds when the file is missing, so only its success is modeled.
    if (name === "rm" && args.some((arg) => /^-[a-z]*f/iu.test(arg) || arg === "--force")) return [{ ...local, status: true }]
    // A sourced file is not read, known or not.
    if (local.functions[name]) return run(local.functions[name], positional(local, args.slice(1), 1))
    if (SHELLS.has(name)) {
      const shell = ["pwsh", "powershell"].includes(name) ? "powershell" : "bash"
      const script = shellScript(name, args)
      // An encoded script is not decoded: unreadable code passes.
      if (script.encoded) return unknown
      const directory = script.directory === undefined ? local.cwd : physicalDirectory(local.cwd, script.directory) ?? UNKNOWN
      if (script.command !== undefined) await nested(script.command, shell === "bash" ? positional(local, script.positional, 0) : { ...local, cwd: directory }, shell)
      else if (script.stdin) {
        // A here-document, here-string, input file or piped output is the script; one Desk cannot read passes (nested).
        const input = node.stdin ? await expand(node.stdin, local) : state.stdin
        if (input !== undefined) await nested(input, { ...local, cwd: directory }, shell)
      }
    } else if (name === "eval") await nested(args.slice(1).join(" "), local)
    else {
      await visit({ name, args: args.slice(1), cwd: local.cwd, env: local.vars, via })
      const add = name === "git" ? args.indexOf("add") : -1
      if (add > 0 && args[add - 1] === "worktree") {
        let operand
        for (let i = add + 1; i < args.length && operand === undefined; i++) {
          if (["-b", "-B", "--reason"].includes(args[i])) i++
          else if (!args[i].startsWith("-")) operand = args[i]
        }
        return [{ ...created(local, operand), status: true }, { ...state, status: false }]
      }
    }
    if (["true", ":", "echo", "printf"].includes(name)) return [{ ...state, status: true }]
    if (name === "false") return [{ ...state, status: false }]
    return unknown
  }
  const physicalCwd = physicalDirectory(cwd, ".") ?? cwd
  await run(tree, { cwd: physicalCwd, logicalCwd: cwd, vars: { ...env, PWD: cwd }, functions: {}, status: true })
}
