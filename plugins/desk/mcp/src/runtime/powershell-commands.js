import * as path from "node:path"
import { physicalDirectory, staticGitOutput } from "./shell-paths.js"
import { inspectShell, tokenizeShell } from "./shell-commands.js"
import { mayInvokeGit, UNKNOWN, UNKNOWN_GIT, unknownOutput, unresolved } from "./guard-unknowns.js"

function variable(map, name) {
  const key = Object.keys(map).find((key) => key.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : map[key]
}

function assign(map, name, value) {
  const key = Object.keys(map).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name
  map[key] = value
}

// Assignment targets: optional casts, $name, ${name} or $scope:name, member and index access, comma-separated.
const CAST = String.raw`(?:\[(?:[^\[\]]|\[[^\]]*\])*\]\s*)*`
const NAME = String.raw`\$(?:\{[^}]+\}|(?:[A-Za-z]\w*:)?[A-Za-z_?][\w?]*)`
const TARGET = `${CAST}${NAME}(?:\\.\\w+|\\[[^\\]]*\\])*`
const ASSIGNMENT = new RegExp(`^(${TARGET}(?:\\s*,\\s*${TARGET})*)\\s*(\\?\\?|[-+*/%])?=(?!=)\\s*`, "u")
const SIMPLE_TARGET = new RegExp(`^${CAST}\\$(?:\\{([^}]+)\\}|((?:[A-Za-z]\\w*:)?[A-Za-z_?][\\w?]*))$`, "u")
const CONTROL = new Set(["if", "elseif", "else", "switch", "foreach", "for", "while", "do", "until", "try", "catch", "finally", "trap", "function", "filter", "begin", "process", "end"])
const SEPARATORS = new Set([";", "\n", "&&", "||", "|"])

const wordText = (word) => word.parts?.map((part) => part.text).join("") ?? word
const tokensText = (tokens) => tokens.map(wordText).join(" ")

// A token list's statements, split only at separators outside ( ) and { } groups.
function statements(tokens) {
  const list = []
  let depth = 0, current = { words: [], redirects: [], previous: null }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "(" || token === "{") depth++
    else if ((token === ")" || token === "}") && --depth < 0) throw new Error("unresolved PowerShell expression")
    if (depth === 0 && SEPARATORS.has(token)) {
      if (token === "\n" && current.words.length === 0) continue
      list.push(current)
      current = { words: [], redirects: [], previous: token }
    } else if (depth === 0 && token.redirect) {
      if (!tokens[i + 1]?.parts) throw new Error("unresolved PowerShell redirection")
      current.redirects.push(tokens[++i])
    } else current.words.push(token)
  }
  if (depth !== 0) throw new Error("unresolved PowerShell expression")
  list.push(current)
  return list
}

// Remove the first `count` characters of a word, across its parts.
function dropCharacters(word, count) {
  const parts = []
  for (const part of word.parts) {
    if (count >= part.text.length) { count -= part.text.length; continue }
    parts.push({ ...part, text: part.text.slice(count) })
    count = 0
  }
  return { ...word, parts, quoted: parts.some((part) => part.quoted) }
}

// `targets op value` when the statement is an assignment: the operator may touch either side.
function assignment(words) {
  // Attribute arguments such as [ValidateNotNull()] put parentheses inside the leading casts.
  const lead = []
  for (const word of words) { if (!word.parts && word !== "(" && word !== ")") break; lead.push(word) }
  const match = ASSIGNMENT.exec(lead.map(wordText).join(" "))
  if (!match) return null
  let start = 0, index = 0
  while (index < lead.length && match[0].length >= start + wordText(lead[index]).length) start += wordText(lead[index++]).length + 1
  const value = index < lead.length && match[0].length > start ? [dropCharacters(lead[index], match[0].length - start), ...words.slice(index + 1)] : words.slice(index)
  return { targets: match[1].trim(), compound: match[2] !== undefined, value }
}

// A hashtable entry `key = value`: the value, or null when the statement is not an entry.
function entryValue(words) {
  if (words[1]?.parts && wordText(words[1]) === "=") return words.slice(2)
  const at = words[0]?.parts ? wordText(words[0]).indexOf("=") : -1
  if (at <= 0) return null
  const rest = dropCharacters(words[0], at + 1)
  return rest.parts.length ? [rest, ...words.slice(1)] : words.slice(1)
}

const SPLAT = /^@[A-Za-z_]\w*$/u
// PowerShell has case-insensitive variables and location commands, no POSIX field
// splitting, and "$name = value" assignments rather than shell environment prefixes. A
// statement that starts with a variable is an expression, never a call; `&` calls.
export async function inspectPowerShell({ command, cwd, env, visit, depth = 0, locals = {}, certain = true }) {
  if (depth > 16) throw new Error("PowerShell wrapper nesting exceeds 16")
  const tokens = tokenizeShell(command, true)
  let variables = { home: env.HOME ?? env.USERPROFILE, pwd: cwd, ...locals }
  let environment = { ...env }
  let directory = physicalDirectory(cwd, ".") ?? cwd
  // Commands inside groups, blocks and subexpressions, or after `||`, are not reached unconditionally.
  let status = null, terminated = false, forks = [], conditional = certain ? 0 : 1
  let states = [snapshot()]

  function snapshot() {
    return { variables: { ...variables }, environment: { ...environment }, directory, status, terminated }
  }

  async function advance({ words, redirects, previous }) {
    const reachable = []
    for (const state of states) {
      variables = { ...state.variables }
      environment = { ...state.environment }
      directory = state.directory
      status = state.status
      terminated = state.terminated
      forks = []
      if (words.length && !terminated && status === null && (previous === "&&" || previous === "||")) {
        // Keep the skipped branch before the executed branch changes its cwd or variables.
        reachable.push({ ...snapshot(), status: previous === "||" })
        status = previous === "&&"
      }
      await run(words, redirects, previous)
      reachable.push(...forks, snapshot())
    }
    states = [...new Map(reachable.map((state) => [JSON.stringify(state), state])).values()]
  }

  async function expand(word) {
    let result = ""
    for (const part of word.parts) {
      if (!part.expand) { result += part.text; continue }
      for (let i = 0; i < part.text.length; i++) {
        if (part.text.startsWith("$(", i)) {
          let end = i + 2, nesting = 1, quote = ""
          for (; end < part.text.length; end++) {
            const c = part.text[end]
            if (c === "`") { end++; continue }
            if (quote) { if (c === quote) quote = ""; continue }
            if (c === "'" || c === '"') { quote = c; continue }
            if (c === "(") nesting++
            if (c === ")" && --nesting === 0) break
          }
          if (nesting) throw new Error("unresolved PowerShell subexpression")
          const text = part.text.slice(i + 2, end)
          await inspectPowerShell({ command: text, cwd: directory, env: environment, visit, depth: depth + 1, locals: variables, certain: false })
          result += /^(?:get-location|pwd)$/iu.test(text.trim()) ? directory : staticGitOutput(text.trim().split(/\s+/u), directory, environment) ?? unknownOutput(text)
          i = end
        } else {
          const match = /^\$(?:\{((?:\w+:)?[A-Za-z_]\w*)\}|((?:\w+:)?[A-Za-z_]\w*))/iu.exec(part.text.slice(i))
          if (match) {
            const name = match[1] ?? match[2]
            result += /^env:/iu.test(name) ? variable(environment, name.slice(4)) ?? "" : variable(variables, name.replace(/^\w+:/u, "")) ?? ""
            i += match[0].length - 1
          } else result += part.text[i]
        }
      }
    }
    return result
  }

  // Run each top-level ( ) or { } group of `words` as its own statements, and return `words` with each
  // group replaced by one argument standing for its value. A hashtable's entries run their values, and a
  // foreach header runs the pipeline after `in`.
  async function groups(words, header = null) {
    const result = []
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== "(" && words[i] !== "{") { result.push(words[i]); continue }
      let nesting = 1, end = i + 1
      for (; nesting; end++) {
        if (words[end] === "(" || words[end] === "{") nesting++
        if (words[end] === ")" || words[end] === "}") nesting--
      }
      const inner = words.slice(i + 1, end - 1)
      const hashtable = words[i] === "{" && Boolean(words[i - 1]?.parts) && wordText(words[i - 1]).endsWith("@")
      const inHeader = header === "foreach" && words[i] === "(" && !result.some((word) => word.group)
      conditional++
      for (const statement of statements(inner)) {
        const keyword = statement.words.findIndex((word) => word.parts && wordText(word).toLowerCase() === "in")
        if (hashtable && entryValue(statement.words)) await assignedValue(entryValue(statement.words))
        else if (inHeader && keyword > 0) await assignedValue(statement.words.slice(keyword + 1))
        else await run(statement.words, statement.redirects, statement.previous)
      }
      conditional--
      const answered = inner.every((word) => word.parts) ? staticGitOutput(inner.map(wordText), directory, environment) : null
      result.push({ parts: [{ text: answered ?? unknownOutput(tokensText(inner)), expand: false, quoted: false }], quoted: false, group: true })
      i = end - 1
    }
    return result
  }

  // The value of an assignment: a literal, a variable or a string is data; anything else is a
  // command, group or control statement whose output is assigned, so it runs as a statement.
  async function assignedValue(words) {
    const data = words.length === 1 && words[0].parts && (words[0].quoted || /^(?:\$|[-+]?\d)/u.test(words[0].parts[0].text))
    if (data) return expand(words[0])
    await run(words, [], null)
    const answered = words.every((word) => word.parts) ? staticGitOutput(words.map(wordText), directory, environment) : null
    return answered ?? unknownOutput(tokensText(words))
  }

  // A program whose name is unknown fails closed when its text names Git or runs code, and is judged as
  // Git when its arguments read like a checked Git command.
  async function unknownProgram(text, args) {
    if (args.some((arg) => arg.includes(UNKNOWN_GIT)) || mayInvokeGit(text)) throw unresolved("the program this command runs")
    await visit({ name: "git", args: args.slice(1), cwd: directory, env: environment, computed: true, certain: false })
  }

  async function run(words, redirects, previous) {
    if (!words.length || terminated) return
    const execute = previous !== "&&" || status !== false
    const skip = previous === "||" && status === true
    if (!execute || skip) return
    let callOperator = false
    if (words[0] === "&") { callOperator = true; words = words.slice(1) }
    if (!words.length) throw new Error("unresolved PowerShell call")
    const assigned = callOperator ? null : assignment(words)
    if (assigned) {
      const value = await assignedValue(assigned.value)
      const simple = SIMPLE_TARGET.exec(assigned.targets)
      if (simple) {
        const name = simple[1] ?? simple[2]
        const result = assigned.compound ? unknownOutput(tokensText(assigned.value)) : value
        if (/^env:/iu.test(name)) assign(environment, name.slice(4), result)
        else assign(variables, name.replace(/^\w+:/u, ""), result)
      }
      status = true
      return
    }
    const keyword = String(wordText(words[0])).toLowerCase()
    if (CONTROL.has(keyword)) {
      // Either branch may run: keep the state from before the blocks as well.
      forks.push(snapshot())
      await groups(words, keyword === "foreach" ? "foreach" : null)
      status = null
      return
    }
    if (!words.every((word) => word.parts)) {
      // A statement that starts with a group is an expression; `& (expression)` calls what it yields.
      const expression = !words[0].parts
      words = await groups(words)
      if (expression && !callOperator) { status = null; return }
    }
    for (const redirect of redirects) await expand(redirect)
    const args = []
    for (const word of words) args.push(await expand(word))
    const text = tokensText(words)
    // The resulting string is data, but interpolation has already executed; so is a variable expression.
    if (!callOperator && (words[0].quoted || wordText(words[0]).startsWith("$"))) { status = true; return }
    const name = path.basename(args[0]).replace(/\.exe$/iu, "").toLowerCase()
    const unknown = path.basename(args[0]).includes(UNKNOWN) || args[0] === ""
    // Splatting passes arguments Desk does not track, so a Git call with one cannot be judged.
    if ((unknown || name === "git") && words.slice(1).some((word) => SPLAT.test(wordText(word)))) throw new Error("unresolved PowerShell splatting")
    if (unknown) {
      await unknownProgram(text, args)
      status = null
      return
    }
    if (name === "exit") { terminated = true; return }
    if (["popd", "pop-location"].includes(name)) { directory = UNKNOWN; variables.pwd = UNKNOWN; status = null; return }
    if (["cd", "chdir", "sl", "set-location", "pushd", "push-location"].includes(name)) {
      const positional = []
      for (let i = 1; i < args.length; i++) {
        const arg = args[i]
        if (/^-(?:literalpath|path)$/iu.test(arg)) { positional.push(args[++i]); continue }
        if (arg.startsWith("-")) throw new Error("unresolved PowerShell location parameter")
        positional.push(arg)
      }
      const target = positional[0] ?? variables.home
      if (!target) { status = false; return }
      const dir = physicalDirectory(directory, target.replace(/^~(?=$|[/\\])/u, variables.home ?? "~"))
      if (!dir) { status = false; return }
      directory = dir; variables.pwd = dir; status = dir === UNKNOWN ? null : true
      return
    }
    if (["iex", "invoke-expression", "."].includes(name) && args.slice(1).some((arg) => arg.includes(UNKNOWN))) {
      throw unresolved(name === "." ? "the file this command dot-sources" : "a script this command evaluates")
    }
    if (["pwsh", "powershell", "bash", "sh"].includes(name)) {
      const at = args.findIndex((arg) => /^-(?:command|c)$/iu.test(arg))
      if (at > 0 && args[at + 1] !== undefined) {
        if (args[at + 1].includes(UNKNOWN)) throw unresolved("a script this command evaluates")
        await inspectShell({ command: args[at + 1], cwd: directory, env: environment, visit, depth: depth + 1, powershell: name === "pwsh" || name === "powershell" })
      }
    } else if (name === "iex" || name === "invoke-expression") {
      await inspectPowerShell({ command: args.slice(1).join(" "), cwd: directory, env: environment, visit, depth: depth + 1, locals: variables })
    } else await visit({ name, args: args.slice(1), cwd: directory, env: environment, certain: conditional === 0 && previous !== "||" })
    status = ["echo", "write-host", "write-output"].includes(name) ? true : null
  }

  for (const statement of statements(tokens)) await advance(statement)
}
