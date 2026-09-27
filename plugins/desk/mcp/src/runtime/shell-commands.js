// Inspect shell syntax without executing it. Quoted data stays data; substitutions and
// literal shell/eval wrappers are walked as commands. Unknown program exit statuses
// fork the &&/|| paths, and subshells/pipelines cannot change their parent's cwd.
// A value computed by a program the inspector does not model is unknown (guard-unknowns.js):
// an unknown directory is carried forward, and only an unknown program, script or Git
// target that could reach Git ends inspection with a denial.
import * as path from "node:path"
import { gitToplevel, mktempPath, physicalDirectory } from "./shell-paths.js"
import { inspectPowerShell } from "./powershell-commands.js"
import { mayInvokeGit, UNKNOWN, UNKNOWN_GIT, unknownOutput, unresolved } from "./guard-unknowns.js"

const separators = new Set([";", "\n", "&", "&&", "||", "|", "(", ")", "{", "}"])

export function tokenizeShell(text, powershell = false) {
  const tokens = []
  let parts = [], value = "", active = false, quote = "", pendingHere = null, quoted = false
  const heredocs = []
  const part = (expand) => {
    parts.push({ text: value, expand, quoted: Boolean(quote) })
    value = ""
  }
  const word = () => {
    if (!active) return
    part(quote !== "'")
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
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === "\\" && quote !== "'") { i++; continue }
    if (quote) { if (c === quote) quote = ""; continue }
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
      node = { kind: op, left: node, right: pipeline() }
    }
    return node
  }
  function pipeline() {
    const nodes = [command()]
    while (tokens[i] === "|") { i++; nodes.push(command()) }
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

function unique(states) {
  return [...new Map(states.map((s) => [JSON.stringify(s), s])).values()]
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

export async function inspectShell({ command, cwd, env, powershell = false, visit, depth = 0 }) {
  if (powershell) return inspectPowerShell({ command, cwd, env, visit, depth })
  if (depth > 16) throw new Error("shell wrapper nesting exceeds 16")
  const tree = parse(tokenizeShell(command))
  let steps = 0, serial = 0
  async function nested(text, state, shell = "bash", partial = false) {
    // An eval or -c script must be known; a here-document or piped literal may hold unknown words, judged in place.
    if (!partial && text.includes(UNKNOWN)) throw unresolved("a script this command evaluates")
    return inspectShell({ command: text, cwd: state.cwd, env: state.vars, powershell: shell === "powershell", visit, depth: depth + 1 })
  }
  async function expand(word, state, split = false) {
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
      if (index === 0 && !part.quoted) text = text.replace(/^~(?=$|\/)/u, state.vars.HOME ?? "~")
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "$" && text[i + 1] === "(") {
          const sub = substitution(text, i + 2)
          await nested(sub.text, state)
          emit(await literalOutput(sub.text, state), !part.quoted)
          i = sub.end
        } else if (text[i] === "$") {
          const match = /^\$(?:\{([A-Za-z_]\w*|\d+)\}|(?:env:)?([A-Za-z_]\w*|\d))/u.exec(text.slice(i))
          if (match) {
            emit(state.vars[match[1] ?? match[2]] ?? "", !part.quoted)
            i += match[0].length - 1
          } else emit(text[i])
        } else emit(text[i])
      }
    }
    return split ? fields.filter((field) => field !== "" || word.quoted) : fields.join("")
  }
  async function literalOutput(text, state) {
    const tokens = tokenizeShell(text)
    if (!tokens.every((token) => token.parts)) return unknownOutput(text)
    return outputOf(tokens, text, state)
  }
  // The output of a literal pwd, echo, printf '%s' or mktemp, without running it; otherwise unknown.
  async function outputOf(tokens, text, state) {
    const words = []
    for (const token of tokens) words.push(await expand(token, state))
    if (words[0] === "pwd" && words.length === 1) return state.cwd
    // `git rev-parse --show-toplevel` is read-only and names the checkout that contains the directory.
    if (words.join(" ") === "git rev-parse --show-toplevel" && state.vars.GIT_DIR === undefined && state.vars.GIT_WORK_TREE === undefined) return gitToplevel(state.cwd)
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
  function positional(state, values, start) {
    const vars = Object.fromEntries(Object.entries(state.vars).filter(([key]) => !/^\d+$/u.test(key)))
    for (let i = 0; i < values.length; i++) vars[i + start] = values[i]
    return { ...state, vars }
  }
  async function run(node, state) {
    if (++steps > 5000) throw new Error("shell inspection budget exceeded")
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
      const states = await run(node.condition, state), out = []
      for (const s of states) {
        if (s.status !== node.until) out.push(...await run(node.body, s))
        else out.push(s)
      }
      return out
    }
    if (node.kind === "if") {
      const states = await run(node.condition, state)
      return (await Promise.all(states.map((s) => run(s.status ? node.yes : node.no, s)))).flat()
    }
    if (node.kind === "for") {
      let states = [state]
      for (const word of node.values) {
        const value = await expand(word, state)
        states = unique((await Promise.all(states.map((s) => run(node.body, { ...s, vars: { ...s.vars, [node.variable]: value } })))).flat())
      }
      return states
    }
    if (node.kind === "not") return (await run(node.body, state)).map((s) => ({ ...s, status: !s.status }))
    if (node.kind === "background") { await run(node.body, state); return [{ ...state, status: true }] }
    if (node.kind === "list") {
      let states = [state]
      for (const [index, item] of node.nodes.entries()) {
        states = (await Promise.all(states.map((s) => run(item, s)))).flat()
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
        else out.push(s)
      }
      return out
    }
    if (node.kind === "group") {
      const result = await run(node.body, { ...state, vars: { ...state.vars } })
      return node.scoped ? result.map((s) => ({ ...state, status: s.status })) : result
    }
    if (node.kind === "pipe") {
      // A literal echo or printf piped into a shell is that shell's script.
      let input = null
      for (const item of node.nodes) {
        await run(item, { ...state, vars: { ...state.vars }, stdin: input })
        const output = item.kind === "command" && !item.redirects.length ? await outputOf(item.words, wordText(item.words), state) : UNKNOWN
        // Wholly computed input, such as `cat script | bash`, is a script file: outside the boundary like `bash script`,
        // unless the command that produces it names Git.
        input = output === UNKNOWN ? null : output
      }
      return [{ ...state, status: true }, { ...state, status: false }]
    }
    for (const redirect of node.redirects) await expand(redirect, state)
    const local = { ...state, vars: { ...state.vars } }
    let leading = 0
    while (leading < node.words.length && /^[A-Za-z_]\w*=/u.test(node.words[leading].parts[0].text)) {
      const assignment = await expand(node.words[leading++], local)
      const at = assignment.indexOf("=")
      local.vars[assignment.slice(0, at)] = assignment.slice(at + 1)
    }
    let args = []
    for (const word of node.words.slice(leading)) {
      const assignment = /^[A-Za-z_]\w*=/u.test(word.parts[0].text)
      const split = !(assignment && args[0] === "export")
      args.push(...(split ? await expand(word, state, true) : [await expand(word, state)]))
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
      // A program whose name is unknown fails closed when its text, or the text that computed it, names Git or runs
      // code; otherwise it is judged as Git if its arguments read like a checked Git command. A computed directory
      // with a known name, such as "$(npm bin)/nx", is that program.
      if (args.some((arg) => arg.includes(UNKNOWN_GIT)) || mayInvokeGit(wordText(node.words))) throw unresolved("the program this command runs")
      await visit({ name: "git", args: args.slice(1), cwd: local.cwd, env: local.vars, computed: true })
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
      return [{ ...state, status: false }]
    }
    if ((name === "source" || name === ".") && args.some((arg) => arg.includes(UNKNOWN))) throw unresolved("the file this command sources")
    if (local.functions[name]) return run(local.functions[name], positional(local, args.slice(1), 1))
    if (["sh", "bash", "zsh", "dash", "ksh", "pwsh", "powershell"].includes(name)) {
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/u.test(arg) || /^-command$/iu.test(arg))
      if (flag > 0 && args[flag + 1] !== undefined) await nested(args[flag + 1], positional(local, args.slice(flag + 2), 0), ["pwsh", "powershell"].includes(name) ? "powershell" : "bash")
      else if (!["pwsh", "powershell"].includes(name) && args.slice(1).every((arg) => arg.startsWith("-"))) {
        // With no script operand, a POSIX shell reads its script from stdin: a here-document or a piped literal.
        const script = node.stdin ? await expand(node.stdin, local) : state.stdin
        if (script !== null && script !== undefined) await nested(script, local, "bash", true)
      }
    } else if (name === "eval") await nested(args.slice(1).join(" "), local)
    else await visit({ name, args: args.slice(1), cwd: local.cwd, env: local.vars })
    if (["true", ":", "echo", "printf"].includes(name)) return [{ ...state, status: true }]
    if (name === "false") return [{ ...state, status: false }]
    return unknown
  }
  const physicalCwd = physicalDirectory(cwd, ".") ?? cwd
  await run(tree, { cwd: physicalCwd, logicalCwd: cwd, vars: { ...env, PWD: cwd }, functions: {}, status: true })
}
