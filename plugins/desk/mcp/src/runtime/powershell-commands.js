// Inspect PowerShell without executing it (A3b fix round 4, controller ruling). Git is allowed only in a closed set
// of plain forms: every top-level statement that names `git` must be one of them, or the command is denied with an
// instruction to split it. Statements without Git are walked for what they do to the location, variables and
// environment those Git calls use. One state is kept: whatever may or may not happen (a script block, a control
// statement, the right side of `&&`/`||` after an unknown status) leaves every value it could change unknown.
import { physicalDirectory, staticGitOutput } from "./shell-paths.js"
import { inspectShell, shellScript, tokenizeShell } from "./shell-commands.js"
import { GuardDenial, inspectionBudget, mayInvokeGit, mergedValue, namesGit, UNKNOWN, UNKNOWN_GIT, unknownOutput, unresolved } from "./guard-unknowns.js"

export const POWERSHELL_GIT_FORMS = `Desk allows Git in PowerShell only as a plain command in its own statement: git <arguments>, $name = git <arguments>, or git <arguments> piped to Out-String, Select-String, Select-Object, Where-Object, ForEach-Object, Measure-Object, Sort-Object, Out-Null or Write-Output, where every argument is literal text or a plain $variable. Rewrite this command as separate plain git commands joined by ; (for example $b = git branch --show-current; git push origin $b)`

const GIT_PROGRAM = /^(?:.*[\\/])?git(?:\.exe)?$/iu
const READ_ONLY = new Set(["out-string", "select-string", "sls", "select-object", "select", "where-object", "where", "?", "foreach-object", "foreach", "%", "measure-object", "measure", "sort-object", "sort", "out-null", "write-output", "write", "echo"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "pwsh", "powershell"])
const CONTROL = new Set(["if", "elseif", "else", "switch", "foreach", "for", "while", "do", "until", "try", "catch", "finally", "trap", "function", "filter", "begin", "process", "end", "class"])
const SEPARATORS = new Set([";", "\n", "&&", "||"])
const GROUPING = new Set(["(", ")", "{", "}"])

// A plain variable reference: $name, ${name} or $env:NAME.
const SIMPLE_VARIABLE = /^\$(?:\{([A-Za-z_]\w*)\}|((?:env:)?[A-Za-z_]\w*))$/iu
// In a double-quoted Git argument every $ must start a plain variable, never a subexpression.
const DOUBLE_QUOTED_CODE = /\$(?!\{(?:env:)?[A-Za-z_]\w*\}|(?:env:)?[A-Za-z_])/iu
// Assignment targets: optional casts and attributes, $name, ${name} or $scope:name, member and index access, comma-separated.
const CAST = String.raw`(?:\[(?:[^\[\]]|\[[^\]]*\])*\]\s*)*`
const NAME = String.raw`\$(?:\{[^}]+\}|(?:[A-Za-z]\w*:)?[A-Za-z_?][\w?]*)`
const TARGET = `${CAST}${NAME}(?:\\.\\w+|\\[[^\\]]*\\])*`
const ASSIGNMENT = new RegExp(`^(${TARGET}(?:\\s*,\\s*${TARGET})*)\\s*(\\?\\?|[-+*/%])?=(?!=)\\s*`, "u")
const SIMPLE_TARGET = new RegExp(`^${CAST}\\$(?:\\{([^}]+)\\}|((?:[A-Za-z]\\w*:)?[A-Za-z_?][\\w?]*))$`, "u")
const NAMES = /\$(?:\{([^}]+)\}|((?:[A-Za-z]\w*:)?[A-Za-z_?][\w?]*))/gu
// Every variable a statement could assign, increment or decrement, however it is spelled.
const ASSIGNED = /\$(?:\{([^}]+)\}|((?:[A-Za-z]\w*:)?[A-Za-z_?][\w?]*))(?:\.\w+|\[[^\]]*\])*\s*(?:(?:[-+*/%]|\?\?)?=(?!=)|\+\+|--)|(?:\+\+|--)\s*\$(?:\{([^}]+)\}|((?:[A-Za-z]\w*:)?[A-Za-z_?][\w?]*))/gu
// Variables or environment set in ways the walker does not model make every variable, or Git's environment, unknown.
const VARIABLE_SETTERS = /(?<![\w-])(?:(?:set|new|clear|remove)-variable|sv|nv|clv|rv)(?![\w-])|(?<![\w-])-(?:outvariable|ov|errorvariable|ev|warningvariable|wv|informationvariable|iv|pipelinevariable|pv)(?![\w-])|\[ref\]|variable:|psvariable/iu
const ENVIRONMENT_SETTERS = /(?<!\$\{?)env:|setenvironmentvariable/iu

const wordText = (word) => word.parts?.map((part) => part.text).join("") ?? word
const tokensText = (tokens) => tokens.map(wordText).join(" ")

function variable(map, name) {
  const key = Object.keys(map).find((key) => key.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : map[key]
}

function assign(map, name, value) {
  const key = Object.keys(map).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name
  map[key] = value
}

// A token list's statements, split only at `;`, new lines, `&&` and `||` outside ( ) and { } groups.
function statements(tokens) {
  const list = []
  let depth = 0, current = { words: [], previous: null }
  for (const token of tokens) {
    if (token === "(" || token === "{") depth++
    else if ((token === ")" || token === "}") && --depth < 0) throw new Error("unresolved PowerShell expression")
    if (depth === 0 && SEPARATORS.has(token)) {
      if (current.words.length) list.push(current)
      else if (token === "\n") continue
      current = { words: [], previous: token }
    } else current.words.push(token)
  }
  if (depth !== 0) throw new Error("unresolved PowerShell expression")
  if (current.words.length) list.push(current)
  return list
}

// A statement's pipeline elements, split at `|` outside groups, each with its redirect targets.
function pipeline(words) {
  const elements = [{ words: [], redirects: [] }]
  let depth = 0
  for (let i = 0; i < words.length; i++) {
    const token = words[i], element = elements.at(-1)
    if (token === "(" || token === "{") depth++
    if (token === ")" || token === "}") depth--
    if (depth === 0 && token === "|") elements.push({ words: [], redirects: [] })
    else if (depth === 0 && token.redirect) {
      if (!words[i + 1]?.parts) throw new Error("unresolved PowerShell redirection")
      element.redirects.push(words[++i])
    } else element.words.push(token)
  }
  return elements
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

// `targets op value` when the statement is an assignment; the leading words may hold attribute arguments.
function assignment(words) {
  const lead = []
  for (const word of words) { if (!word.parts && !GROUPING.has(word)) break; lead.push(word) }
  const match = ASSIGNMENT.exec(lead.map(wordText).join(" "))
  if (!match) return null
  let start = 0, index = 0
  while (index < lead.length && match[0].length >= start + wordText(lead[index]).length) start += wordText(lead[index++]).length + 1
  const value = index < lead.length && match[0].length > start ? [dropCharacters(lead[index], match[0].length - start), ...words.slice(index + 1)] : words.slice(index)
  return { targets: match[1].trim(), compound: match[2] !== undefined, value, lead: words.slice(0, index) }
}

// A hashtable entry `key = value`: the value, or null when the statement is not an entry.
function entryValue(words) {
  if (words[1]?.parts && wordText(words[1]) === "=") return words.slice(2)
  const at = words[0]?.parts ? wordText(words[0]).indexOf("=") : -1
  if (at <= 0) return null
  const rest = dropCharacters(words[0], at + 1)
  return rest.parts.length ? [rest, ...words.slice(1)] : words.slice(1)
}

// A Git argument Desk can read: literal text, or a plain variable, possibly inside a double-quoted string.
function plainArgument(word) {
  if (!word.parts) return false
  if (!word.quoted && SIMPLE_VARIABLE.test(wordText(word))) return true
  const parts = word.parts.filter((part) => part.text !== "")
  // A token that starts with a quote ends at its closing quote: PowerShell passes what follows as another argument.
  if (parts[0]?.quoted && parts.length > 1) return false
  if (wordText(word) === "--%") return false
  return parts.every((part, index) => !part.expand
    || (part.quoted ? !DOUBLE_QUOTED_CODE.test(part.text) : !part.text.includes("$") && !(index === 0 && part.text.startsWith("@"))))
}

// One of the allowed Git forms, or null: `git <args>`, `$name = git <args>`, then only read-only cmdlets without Git.
function gitForm(words) {
  const [first, ...rest] = pipeline(words)
  let call = first.words, target = null
  const lead = call[0]?.parts && !call[0].quoted ? wordText(call[0]) : ""
  const named = /^\$([A-Za-z_]\w*)(\s*=\s*)?(.*)$/su.exec(lead)
  if (named) {
    target = named[1]
    if (named[2] && named[3]) call = [dropCharacters(call[0], lead.length - named[3].length), ...call.slice(1)]
    else if (named[2]) call = call.slice(1)
    else if (!named[3] && call[1]?.parts && !call[1].quoted && wordText(call[1]).startsWith("=")) {
      call = wordText(call[1]) === "=" ? call.slice(2) : [dropCharacters(call[1], 1), ...call.slice(2)]
    } else return null
  }
  const [program, ...args] = call
  if (!program?.parts || program.quoted || !GIT_PROGRAM.test(wordText(program)) || wordText(program).includes("$")) return null
  if (![...args, ...first.redirects].every(plainArgument)) return null
  const readOnly = (element) => element.words[0]?.parts && !element.words[0].quoted && READ_ONLY.has(wordText(element.words[0]).toLowerCase())
  if (!rest.every((element) => readOnly(element) && !namesGit(tokensText([...element.words, ...element.redirects])))) return null
  return { target, args, rest }
}

// A single literal string piped into a shell is its script; anything else is input Desk cannot read.
function literalInput(element) {
  const [word] = element.words
  if (element.words.length !== 1 || element.redirects.length || !word.parts) return null
  const parts = word.parts.filter((part) => part.text !== "")
  return parts.length === 1 && parts[0].quoted && (!parts[0].expand || !parts[0].text.includes("$")) ? parts[0].text : null
}

export async function inspectPowerShell({ command, cwd, env, visit, depth = 0, budget = inspectionBudget() }) {
  if (depth > 16) throw new Error("PowerShell wrapper nesting exceeds 16")
  const tokens = tokenizeShell(command, true)
  const text = tokensText(tokens)
  const opaqueVariables = VARIABLE_SETTERS.test(text), opaqueEnvironment = ENVIRONMENT_SETTERS.test(text)
  const variables = { home: env.HOME ?? env.USERPROFILE }
  const environment = { ...env }
  let directory = physicalDirectory(cwd, ".") ?? cwd
  let status = true, terminated = false
  const aliases = new Set()

  // A variable's value; null for $null, which PowerShell passes to a program as no argument at all.
  function lookup(name) {
    const scoped = name.replace(/^(?:global|local|private|script|using):/iu, "")
    if (/^env:/iu.test(scoped)) return variable(environment, scoped.slice(4)) ?? UNKNOWN
    const lower = scoped.toLowerCase()
    if (lower === "null") return null
    if (lower === "true" || lower === "false") return lower === "true" ? "True" : "False"
    if (lower === "pwd") return directory
    // Unset here, the value may come from the session or an automatic variable.
    return opaqueVariables ? UNKNOWN : variables[lower] ?? UNKNOWN
  }

  function set(name, value) {
    const scoped = name.replace(/^(?:global|local|private|script|using):/iu, "")
    if (/^env:/iu.test(scoped)) assign(environment, scoped.slice(4), value)
    else variables[scoped.toLowerCase()] = value
  }

  const snapshot = () => ({ variables: { ...variables }, environment: { ...environment }, directory, terminated })

  // What may or may not have happened since `before`: every value that differs becomes unknown.
  function join(before) {
    for (const [map, old] of [[variables, before.variables], [environment, before.environment]]) {
      for (const key of new Set([...Object.keys(map), ...Object.keys(old)])) {
        if (map[key] !== old[key]) map[key] = mergedValue(map[key], old[key])
      }
    }
    if (directory !== before.directory) directory = UNKNOWN
    terminated = before.terminated
    status = null
  }

  async function maybe(body) {
    const before = snapshot()
    await body()
    join(before)
  }

  // A script block or control statement may run any number of times: repeat it until joining changes nothing.
  async function loop(body) {
    for (;;) {
      const before = snapshot()
      await body()
      join(before)
      if (JSON.stringify(before) === JSON.stringify(snapshot())) return
    }
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
          const inner = part.text.slice(i + 2, end)
          // A subexpression runs in the caller's scope: its location and variable changes stay.
          await sequence(tokenizeShell(inner, true))
          result += /^(?:get-location|pwd)$/iu.test(inner.trim()) ? directory : unknownOutput(inner)
          i = end
        } else {
          const match = /^\$(?:\{((?:\w+:)?[A-Za-z_]\w*)\}|((?:\w+:)?[A-Za-z_]\w*))/iu.exec(part.text.slice(i))
          if (match) {
            result += lookup(match[1] ?? match[2]) ?? ""
            i += match[0].length - 1
          } else result += part.text[i]
        }
      }
    }
    return result
  }

  // Run each top-level group of `words` and return `words` with each replaced by one argument standing for its
  // value: ( ), @( ) and $( ) run once, @{ } runs its entries' values, and a { } script block may run any number of times.
  async function groups(words) {
    const result = []
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== "(" && words[i] !== "{") { result.push(words[i]); continue }
      let nesting = 1, end = i + 1
      for (; nesting; end++) {
        if (end === words.length) throw new Error("unresolved PowerShell expression")
        if (words[end] === "(" || words[end] === "{") nesting++
        if (words[end] === ")" || words[end] === "}") nesting--
      }
      const inner = words.slice(i + 1, end - 1)
      const previous = result.at(-1)
      const prefixed = Boolean(previous?.parts) && !previous.quoted && wordText(previous).endsWith("@")
      if (prefixed && wordText(previous) === "@") result.pop()
      if (words[i] === "(") await sequence(inner)
      else if (!prefixed) await loop(() => sequence(inner))
      else {
        for (const statement of statements(inner)) {
          const value = entryValue(statement.words)
          if (value) await assignedValue(value)
          else await statementOf(statement.words)
        }
      }
      result.push({ parts: [{ text: unknownOutput(tokensText(inner)), expand: false, quoted: false }], quoted: false })
      i = end - 1
    }
    return result
  }

  // An assigned value: a plain variable, a wholly quoted string or an integer is data; anything else runs.
  async function assignedValue(words) {
    const [word] = words
    if (words.length === 1 && word.parts) {
      const simple = !word.quoted && SIMPLE_VARIABLE.exec(wordText(word))
      if (simple) return lookup(simple[1] ?? simple[2]) ?? ""
      if (word.quoted && word.parts.every((part) => part.quoted || part.text === "")) return expand(word)
      if (/^[-+]?\d+$/u.test(wordText(word))) return wordText(word)
    }
    await run(words, [], null)
    return unknownOutput(tokensText(words))
  }

  async function gitCall({ target, args: words, rest }) {
    const args = []
    for (const word of words) {
      const simple = !word.quoted && SIMPLE_VARIABLE.exec(wordText(word))
      const value = simple ? lookup(simple[1] ?? simple[2]) : await expand(word)
      if (value !== null) args.push(value)
    }
    // An environment changed in ways Desk does not model leaves Git's location unknown.
    const gitEnv = opaqueEnvironment ? { ...environment, GIT_DIR: UNKNOWN } : environment
    await visit({ name: "git", args, cwd: directory, env: gitEnv, powershell: true })
    status = null
    if (target) set(target, rest.length ? UNKNOWN_GIT : staticGitOutput(["git", ...args], directory, gitEnv) ?? UNKNOWN_GIT)
    for (const element of rest) await run(element.words, element.redirects, null)
  }

  async function statementOf(words) {
    const text = tokensText(words)
    if (namesGit(text)) {
      const form = gitForm(words)
      if (form) return gitCall(form)
      // The allowlist protects protected checkouts only: `visit.unmodeled` answers whether this statement can reach
      // one. When it cannot, the statement runs unchecked, and what it may assign becomes unknown.
      if (!await visit.unmodeled?.({ text, cwd: directory, env: environment })) throw new GuardDenial(POWERSHELL_GIT_FORMS)
      for (const match of text.matchAll(ASSIGNED)) set(match[1] ?? match[2] ?? match[3] ?? match[4], UNKNOWN)
      status = null
      return
    }
    const elements = pipeline(words)
    for (const [index, element] of elements.entries()) await run(element.words, element.redirects, index ? elements[index - 1] : null)
    if (elements.length > 1) status = null
  }

  async function sequence(list) {
    for (const { words, previous } of statements(list)) {
      if (terminated) return
      await budget.step()
      if (previous === "&&" || previous === "||") {
        // `a && b` runs b only after success and `a || b` only after failure; an unknown status may go either way.
        if (status === (previous === "||")) continue
        if (status === null) { await maybe(() => statementOf(words)); continue }
      }
      await statementOf(words)
    }
  }

  // A program whose name is unknown fails closed when its text names Git or runs code, and is judged as
  // Git when its arguments read like a checked Git command.
  async function unknownProgram(text, args) {
    if (args.some((arg) => arg.includes(UNKNOWN_GIT)) || mayInvokeGit(text)) throw unresolved("the program this command runs")
    await visit({ name: "git", args: args.slice(1), cwd: directory, env: environment, computed: true, powershell: true })
  }

  // One pipeline element without Git. `input` is the element before it, for a shell reading its script from stdin.
  async function run(words, redirects, input) {
    await budget.step()
    for (const match of tokensText(words).matchAll(ASSIGNED)) set(match[1] ?? match[2] ?? match[3] ?? match[4], UNKNOWN)
    // A background job runs elsewhere, perhaps not at all.
    if (words.at(-1) === "&") return maybe(() => run(words.slice(0, -1), redirects, input))
    let call = false
    if (words[0] === "&") { call = true; words = words.slice(1) }
    if (!words.length) throw new Error("unresolved PowerShell call")
    const assigned = call ? null : assignment(words)
    if (assigned) {
      if (!assigned.lead.every((word) => word.parts)) await groups(assigned.lead)
      const value = await assignedValue(assigned.value)
      const simple = SIMPLE_TARGET.exec(assigned.targets)
      if (simple && !assigned.compound) set(simple[1] ?? simple[2], value)
      else for (const match of assigned.targets.matchAll(NAMES)) set(match[1] ?? match[2], UNKNOWN)
      status = true
      return
    }
    const keyword = wordText(words[0]).toString().toLowerCase()
    // Loop variables and parameters take values Desk does not know.
    if (["foreach", "function", "filter", "param"].includes(keyword)) {
      const header = words.indexOf("(")
      if (header >= 0) for (const match of tokensText(words.slice(header, words.indexOf(")", header))).matchAll(NAMES)) set(match[1] ?? match[2], UNKNOWN)
    }
    if (!call && CONTROL.has(keyword)) {
      await loop(() => groups(words))
      status = null
      return
    }
    // [scriptblock]::Create('…') builds code from a literal, or from text Desk cannot read.
    if (/^\[scriptblock\]::create$/iu.test(keyword)) {
      const literal = words[1] === "(" && words[3] === ")" && words[2].parts ? literalInput({ words: [words[2]], redirects: [] }) : null
      if (literal === null) throw unresolved("a script this command evaluates")
      await loop(() => sequence(tokenizeShell(literal, true)))
    }
    if (!words.every((word) => word.parts)) {
      // A statement that starts with a group is an expression; `& (…)` or `& { … }` calls what it yields.
      const expression = !words[0].parts
      words = await groups(words)
      if (expression && !call) { status = null; return }
    }
    for (const redirect of redirects) await expand(redirect)
    const args = []
    for (const word of words) args.push(await expand(word))
    const text = tokensText(words)
    // A string, variable or type expression is data, though its interpolation has run.
    if (!call && (words[0].quoted || /^[$[]/u.test(wordText(words[0])))) { status = true; return }
    const program = args[0].split(/[\\/]/u).at(-1)
    const name = program.replace(/\.exe$/iu, "").toLowerCase()
    if (program.includes(UNKNOWN) || args[0] === "") {
      await unknownProgram(text, args)
      status = null
      return
    }
    if (["set-alias", "new-alias", "sal", "nal"].includes(name)) {
      for (const arg of args.slice(1)) if (!arg.startsWith("-")) aliases.add(arg.toLowerCase())
      status = true
      return
    }
    if (aliases.has(name)) {
      // An alias this command defines may name a location command or a program Desk cannot see.
      directory = UNKNOWN
      await unknownProgram(text, [UNKNOWN, ...args.slice(1)])
      status = null
      return
    }
    if (name === "exit") { terminated = true; return }
    if (["popd", "pop-location"].includes(name)) { directory = UNKNOWN; status = null; return }
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
      directory = dir
      status = dir === UNKNOWN ? null : true
      return
    }
    if (["iex", "invoke-expression"].includes(name)) {
      if (args.slice(1).some((arg) => arg.includes(UNKNOWN))) throw unresolved("a script this command evaluates")
      // Invoke-Expression runs in the caller's scope.
      await sequence(tokenizeShell(args.slice(1).join(" "), true))
      status = null
      return
    }
    if (name === "." && args.slice(1).some((arg) => arg.includes(UNKNOWN))) throw unresolved("the file this command dot-sources")
    if (["start-process", "saps", "start"].includes(name) && args.slice(1).some((arg) => arg.includes(UNKNOWN))) throw unresolved("the program this command runs")
    if (SHELLS.has(name)) {
      const script = shellScript(name, args)
      if (script.encoded) throw unresolved("an encoded script this command runs")
      const piped = script.stdin && input ? literalInput(input) ?? UNKNOWN : undefined
      const source = script.command ?? piped
      if (source !== undefined) {
        if (source.includes(UNKNOWN)) throw unresolved(script.command === undefined ? "the script this shell reads from its input" : "a script this command evaluates")
        const where = script.directory === undefined ? directory : physicalDirectory(directory, script.directory) ?? UNKNOWN
        await inspectShell({ command: source, cwd: where, env: environment, visit, depth: depth + 1, budget, powershell: name === "pwsh" || name === "powershell" })
      }
    }
    status = ["echo", "write-host", "write-output"].includes(name) ? true : null
  }

  await sequence(tokens)
}
