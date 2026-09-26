import * as path from "node:path"
import { physicalDirectory } from "./shell-paths.js"
import { inspectShell, tokenizeShell } from "./shell-commands.js"

function variable(map, name) {
  const key = Object.keys(map).find((key) => key.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : map[key]
}

function assign(map, name, value) {
  const key = Object.keys(map).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name
  map[key] = value
}

// PowerShell has case-insensitive variables and location commands, no POSIX field
// splitting, and "$name = value" assignments rather than shell environment prefixes.
export async function inspectPowerShell({ command, cwd, env, visit, depth = 0, locals = {} }) {
  if (depth > 16) throw new Error("PowerShell wrapper nesting exceeds 16")
  const tokens = tokenizeShell(command, true)
  let variables = { home: env.HOME ?? env.USERPROFILE, pwd: cwd, ...locals }
  let environment = { ...env }
  let directory = physicalDirectory(cwd, ".") ?? cwd
  let statement = [], redirects = [], previous = null, status = null, terminated = false
  let states = [snapshot()]

  function snapshot() {
    return { variables: { ...variables }, environment: { ...environment }, directory, status, terminated }
  }

  async function advance() {
    const reachable = []
    for (const state of states) {
      variables = { ...state.variables }
      environment = { ...state.environment }
      directory = state.directory
      status = state.status
      terminated = state.terminated
      if (statement.length && !terminated && status === null && (previous === "&&" || previous === "||")) {
        // Keep the skipped branch before the executed branch changes its cwd or variables.
        reachable.push({ ...snapshot(), status: previous === "||" })
        status = previous === "&&"
      }
      await run(statement)
      const next = snapshot()
      reachable.push(next)
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
          await inspectPowerShell({ command: text, cwd: directory, env: environment, visit, depth: depth + 1, locals: variables })
          result += /^(?:get-location|pwd)$/iu.test(text.trim()) ? directory : "\0"
          i = end
        } else {
          const match = /^\$(?:\{((?:env:)?[A-Za-z_]\w*)\}|((?:env:)?[A-Za-z_]\w*))/iu.exec(part.text.slice(i))
          if (match) {
            const name = match[1] ?? match[2]
            result += /^env:/iu.test(name) ? variable(environment, name.slice(4)) ?? "" : variable(variables, name) ?? ""
            i += match[0].length - 1
          } else result += part.text[i]
        }
      }
    }
    return result
  }

  async function run(words) {
    if (!words.length || terminated) return
    const execute = previous !== "&&" || status !== false
    const skip = previous === "||" && status === true
    if (!execute || skip) return
    let callOperator = false
    if (words[0] === "&") { callOperator = true; words = words.slice(1) }
    if (!words.length) throw new Error("unresolved PowerShell call")
    const first = words[0].parts?.[0]?.text ?? ""
    const assignment = /^\$((?:env:)?[A-Za-z_]\w*)\s*=/iu.exec(first)
    const separate = /^\$((?:env:)?[A-Za-z_]\w*)$/iu.exec(first)
    if (assignment || (separate && words[1]?.parts?.[0]?.text === "=")) {
      const name = (assignment ?? separate)[1]
      const valueWords = assignment
        ? [{ ...words[0], parts: words[0].parts.map((p, i) => i === 0 ? { ...p, text: p.text.slice(assignment[0].length) } : p) }, ...words.slice(1)]
        : words.slice(2)
      const value = valueWords.length === 1 && valueWords[0].parts ? await expand(valueWords[0]) : "\0"
      if (/^env:/iu.test(name)) assign(environment, name.slice(4), value)
      else assign(variables, name, value)
      status = true
      return
    }
    if (!words.every((word) => word.parts)) throw new Error("unresolved PowerShell expression")
    for (const redirect of redirects) await expand(redirect)
    const args = []
    for (const word of words) args.push(await expand(word))
    // The resulting string is data, but interpolation has already executed.
    if (words[0].quoted && !callOperator) { status = true; return }
    if (args[0].includes("\0")) throw new Error("unresolved PowerShell command")
    const name = path.basename(args[0]).replace(/\.exe$/iu, "").toLowerCase()
    if (name === "exit") { terminated = true; return }
    if (["cd", "chdir", "sl", "set-location"].includes(name)) {
      const positional = []
      for (let i = 1; i < args.length; i++) {
        const arg = args[i]
        if (/^-(?:literalpath|path)$/iu.test(arg)) { positional.push(args[++i]); continue }
        if (arg.startsWith("-")) throw new Error("unresolved PowerShell location parameter")
        positional.push(arg)
      }
      const target = positional[0] ?? variables.home
      if (target?.includes("\0")) throw new Error("unresolved PowerShell directory")
      if (!target) { status = false; return }
      const dir = physicalDirectory(directory, target.replace(/^~(?=$|[/\\])/u, variables.home ?? "~"))
      if (!dir) { status = false; return }
      directory = dir; variables.pwd = dir; status = true
      return
    }
    if (["pwsh", "powershell", "bash", "sh"].includes(name)) {
      const at = args.findIndex((arg) => /^-(?:command|c)$/iu.test(arg))
      if (at > 0 && args[at + 1] !== undefined) await inspectShell({ command: args[at + 1], cwd: directory, env: environment, visit, depth: depth + 1, powershell: name === "pwsh" || name === "powershell" })
    } else await visit({ name, args: args.slice(1), cwd: directory, env: environment })
    status = ["echo", "write-host", "write-output"].includes(name) ? true : null
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if ([";", "\n", "&&", "||", "|"].includes(token)) {
      if (token === "\n" && statement.length === 0) continue
      await advance(); statement = []; redirects = []; previous = token
    } else if (token.redirect) {
      if (!tokens[i + 1]?.parts) throw new Error("unresolved PowerShell redirection")
      redirects.push(tokens[++i])
    } else statement.push(token)
  }
  await advance()
}
