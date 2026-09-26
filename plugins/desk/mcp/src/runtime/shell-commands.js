// Inspect shell syntax without executing it. Quoted data stays data; substitutions and
// literal shell/eval wrappers are walked as commands. Unknown program exit statuses
// fork the &&/|| paths, and subshells/pipelines cannot change their parent's cwd.
import * as path from "node:path"
import { statSync } from "node:fs"

const separators = new Set([";", "\n", "&", "&&", "||", "|", "(", ")", "{", "}"])

export function tokenizeShell(text, powershell = false) {
  const tokens = []
  let parts = [], value = "", active = false, quote = "", pendingHere = null, quoted = false
  const heredocs = []
  const part = (expand) => {
    parts.push({ text: value, expand })
    value = ""
  }
  const word = () => {
    if (!active) return
    part(quote !== "'")
    const token = { parts, quoted }
    tokens.push(token)
    if (pendingHere) {
      heredocs.push({ delimiter: parts.map((p) => p.text).join(""), expand: !parts.some((p) => !p.expand), tabs: pendingHere === "<<-" })
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
    if (c === "'" || c === '"') {
      active = true; quoted = true; part(true); quote = c
    } else if (c === "$" && next === "(") {
      active = true
      const sub = substitution(text, i + 2)
      value += text.slice(i, sub.end + 1); i = sub.end
    } else if (c === "#" && !active) {
      while (i < text.length && text[i] !== "\n") i++
      i--
    } else if (c === "\n") {
      word(); tokens.push("\n")
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
        if (here.expand) tokens.push({ heredoc: body })
      }
    } else if (/\s/u.test(c)) {
      word()
    } else if ("<>".includes(c)) {
      // Redirection paths are operands, never commands. Keep substitutions in them.
      if (active && /^\d+$/u.test(value) && parts.length === 0) { value = ""; active = false }
      word()
      let op = c
      while (text[i + 1] === c || ["&", "-"].includes(text[i + 1])) op += text[++i]
      tokens.push({ redirect: op })
      if (op === "<<" || op === "<<-") pendingHere = op
    } else if (separators.has(c)) {
      // Braces inside ${VAR} belong to the word.
      if (c === "{" && value.endsWith("$")) {
        const end = text.indexOf("}", i)
        if (end >= 0) { value += text.slice(i, end + 1); i = end; continue }
      }
      word()
      const op = (c === "&" || c === "|") && next === c ? c + text[++i] : c
      tokens.push(op)
    } else {
      active = true; value += c
    }
  }
  if (quote) throw new Error("unterminated shell quote")
  word()
  return tokens
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

function parse(tokens, powershell) {
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
    if (powershell && tokens[i] === "&") i++
    if (keyword(tokens[i]) === "!") { i++; return { kind: "not", body: command() } }
    if (keyword(tokens[i]) === "if") return conditional()
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
    while (i < tokens.length && typeof tokens[i] !== "string") {
      const token = tokens[i++]
      if (token.redirect) {
        if (tokens[i]?.parts) redirects.push(tokens[i++])
      } else if (token.heredoc !== undefined) redirects.push({ parts: [{ text: token.heredoc, expand: true }] })
      else words.push(token)
    }
    if (!words.length && !redirects.length) throw new Error(`unexpected shell operator ${tokens[i]}`)
    return { kind: "command", words, redirects }
  }
  return list()
}

function unique(states) {
  return [...new Map(states.map((s) => [JSON.stringify(s), s])).values()]
}

export async function inspectShell({ command, cwd, env, powershell = false, visit, depth = 0 }) {
  if (depth > 16) throw new Error("shell wrapper nesting exceeds 16")
  const tree = parse(tokenizeShell(command, powershell), powershell)
  let steps = 0
  async function nested(text, state) {
    return inspectShell({ command: text, cwd: state.cwd, env: state.vars, powershell, visit, depth: depth + 1 })
  }
  async function expand(word, state) {
    let result = ""
    for (const part of word.parts) {
      if (!part.expand) { result += part.text; continue }
      let text = part.text, out = ""
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "$" && text[i + 1] === "(") {
          const sub = substitution(text, i + 2)
          await nested(sub.text, state)
          out += await literalOutput(sub.text, state)
          i = sub.end
        } else out += text[i]
      }
      result += out.replace(/\$(?:\{([A-Za-z_]\w*|\d+)\}|(?:env:)?([A-Za-z_]\w*|\d))/gu, (_, braced, plain) => state.vars[braced ?? plain] ?? "")
    }
    return result
  }
  async function literalOutput(text, state) {
    const tokens = tokenizeShell(text, powershell)
    if (!tokens.every((token) => token.parts)) return "\0"
    const words = []
    for (const token of tokens) words.push(await expand(token, state))
    if (words[0] === "pwd" && words.length === 1) return state.cwd
    if (words[0] === "echo") return words.slice(1).join(" ").replace(/\n+$/u, "")
    if (words[0] === "printf" && words[1] === "%s") return words.slice(2).join("").replace(/\n+$/u, "")
    return "\0"
  }
  function positional(state, values, start) {
    const vars = Object.fromEntries(Object.entries(state.vars).filter(([key]) => !/^\d+$/u.test(key)))
    for (let i = 0; i < values.length; i++) vars[i + start] = values[i]
    return { ...state, vars }
  }
  async function run(node, state) {
    if (++steps > 1000) throw new Error("shell inspection budget exceeded")
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
        states = (await Promise.all(states.map((s) => run(node.body, { ...s, vars: { ...s.vars, [node.variable]: value } })))).flat()
      }
      return unique(states)
    }
    if (node.kind === "not") return (await run(node.body, state)).map((s) => ({ ...s, status: !s.status }))
    if (node.kind === "background") { await run(node.body, state); return [{ ...state, status: true }] }
    if (node.kind === "list") {
      let states = [state]
      for (const item of node.nodes) states = unique((await Promise.all(states.map((s) => run(item, s)))).flat())
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
      for (const item of node.nodes) await run(item, { ...state, vars: { ...state.vars } })
      return [{ ...state, status: true }, { ...state, status: false }]
    }
    for (const redirect of node.redirects) await expand(redirect, state)
    let args = []
    for (const word of node.words) args.push(await expand(word, state))
    const local = { ...state, vars: { ...state.vars } }
    while (args.length && /^[A-Za-z_]\w*=/u.test(args[0])) {
      const at = args[0].indexOf("=")
      local.vars[args[0].slice(0, at)] = args[0].slice(at + 1)
      args.shift()
    }
    if (!args.length) return [{ ...local, status: true }]
    let name = path.basename(args[0]).replace(/\.exe$/iu, "").toLowerCase()
    while (["command", "exec", "env", "builtin", "nohup", "time", "timeout", "nice", "sudo"].includes(name)) {
      const wrapper = name
      args.shift()
      while (args[0]?.startsWith("-")) {
        const flag = args.shift()
        if (flag === "-u" || flag === "--unset") delete local.vars[args.shift()]
        if (flag === "-C" || flag === "--chdir") local.cwd = path.resolve(local.cwd, args.shift())
        if (wrapper === "nice" && flag === "-n") args.shift()
      }
      if (wrapper === "timeout") args.shift()
      while (args[0] && /^[A-Za-z_]\w*=/u.test(args[0])) {
        const at = args[0].indexOf("=")
        local.vars[args[0].slice(0, at)] = args[0].slice(at + 1); args.shift()
      }
      name = path.basename(args[0] ?? "").replace(/\.exe$/iu, "").toLowerCase()
    }
    if (name === "export") {
      for (const arg of args.slice(1)) {
        const at = arg.indexOf("=")
        if (at > 0) local.vars[arg.slice(0, at)] = arg.slice(at + 1)
      }
      return [{ ...local, status: true }]
    }
    if (["cd", "chdir", "set-location"].includes(name)) {
      const operand = args.slice(1).find((arg) => !["--", "-L", "-P", "-LiteralPath", "-Path"].includes(arg))
      const target = operand === "-" ? local.vars.OLDPWD : operand ?? local.vars.HOME
      let dir = target?.replace(/^~(?=$|[/\\])/u, local.vars.HOME ?? "")
      if (dir?.includes("\0")) return [{ ...state, status: false }]
      if (dir) dir = path.resolve(local.cwd, dir)
      try {
        if (dir && statSync(dir).isDirectory()) return [{ ...local, cwd: dir, vars: { ...local.vars, OLDPWD: state.cwd, PWD: dir }, status: true }]
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error
      }
      return [{ ...state, status: false }]
    }
    if (local.functions[name]) return run(local.functions[name], positional(local, args.slice(1), 1))
    if (["sh", "bash", "zsh", "dash", "ksh", "pwsh", "powershell"].includes(name)) {
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/u.test(arg) || /^-command$/iu.test(arg))
      if (flag > 0 && args[flag + 1] !== undefined) await nested(args[flag + 1], positional(local, args.slice(flag + 2), 0))
    } else if (name === "eval") await nested(args.slice(1).join(" "), local)
    else await visit({ name, args: args.slice(1), cwd: local.cwd, env: local.vars })
    if (["true", ":", "echo", "printf"].includes(name)) return [{ ...state, status: true }]
    if (name === "false") return [{ ...state, status: false }]
    return [{ ...state, status: true }, { ...state, status: false }]
  }
  await run(tree, { cwd, vars: { ...env, PWD: cwd }, functions: {}, status: true })
}
