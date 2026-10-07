// Finds `git … commit` and `git … add` invocations in one shell command, says
// which directory each ran in and which paths it names, and lists the files
// the command writes with `>`, `>>` and `tee`. Binding (M3-4) matches a desk commit to the
// session's own `git commit` calls by time, because agents commit with
// `git commit -q`, which prints no hash.
//
// Privacy. The command is read in memory only. `gitCommitCwds` returns
// directories and nothing else; `shellEffects` returns directories and
// absolute paths: never the command, the commit message, an option or any
// other argument. Callers keep the directories in binding
// events, which never leave the machine and never reach facts.
//
// What it understands. It splits the command into simple commands on
// unquoted `&&`, `||`, `;`, `|`, `&`, parentheses and newlines, unquoting
// words like the shell would (single and double quotes, backslash escapes in
// POSIX shells, backtick escapes and doubled single quotes in PowerShell),
// and skips comments and heredoc bodies. In each simple command it skips
// `NAME=value` assignments and the wrappers `env`, `command`, `builtin`,
// `time`, `nohup` and `exec`, then:
//   - `cd` (PowerShell also `Set-Location`, `sl`, `chdir`) moves the
//     directory for the rest of the command;
//   - `git` with its global options (`-C <dir>` applied in order, and the
//     value-taking `-c`, `--namespace`, `--super-prefix`, `--config-env`
//     skipped) followed by the subcommand `commit` is a commit in the
//     resulting directory.
// Some things are not modeled, and make the directory unknown instead:
//   - `pushd` and `popd` (PowerShell `Push-Location`, `Pop-Location`), and a
//     subshell's `(` or `)`: from there on the directory is unknown until an
//     absolute `cd`;
//   - `--git-dir` or `--work-tree` on the commit, or `GIT_DIR` or
//     `GIT_WORK_TREE` set for it (a `NAME=value` prefix, `env`), set bare or
//     exported earlier in the command (PowerShell `$env:GIT_DIR`): Git then
//     commits somewhere the directory does not say, so that commit and every
//     later one in the command are unknown.
// A command run through another program (`bash -c "…"`, an alias, a script)
// or inside a command substitution (`$(…)`, backticks) is not seen, and a
// background `&` is read as a plain separator.
//
// Directories. A directory word resolves against the current one. `~` and
// `$HOME` (PowerShell also `$env:HOME`, `$env:USERPROFILE`) expand to `home`.
// `$DESK` (PowerShell `$env:DESK`) becomes `DESK_MARKER`, a placeholder the
// binder replaces with the desk root, since `$DESK` is by definition the
// desk checkout. Any other variable, command substitution, `cd -`, a
// relative word with no known current directory, or a bare `cd` in
// PowerShell makes the directory unknown: that commit is reported with a
// `null` directory rather than a guess.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import * as path from "node:path"

/** The placeholder for `$DESK` in a returned directory; `DESK_MARKER + "/rest"` below it. */
export const DESK_MARKER = "$DESK"

const WRAPPERS = new Set(["env", "command", "builtin", "time", "nohup", "exec"])
const POSIX_CD = new Set(["cd"])
const POWERSHELL_CD = new Set(["cd", "sl", "chdir", "set-location"])
const POSIX_STACK = new Set(["pushd", "popd"])
const POWERSHELL_STACK = new Set(["pushd", "popd", "push-location", "pop-location"])
const GIT_OPTIONS_WITH_VALUE = new Set(["-c", "--namespace", "--super-prefix", "--config-env"])
const GIT_ELSEWHERE_OPTION = /^--(?:git-dir|work-tree)(?:=|$)/u
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u
const EXPORTS = new Set(["export", "declare", "typeset", "readonly"])
const PATH_SUBCOMMANDS = new Set(["commit", "add"])
const WRITE_OPERATORS = new Set([">", ">>", ">|"])
// Per subcommand: flags that mean "the whole tree", and options whose value is
// the next word (and so is not a path).
const WHOLE_TREE_SHORT = { commit: new Set(["a"]), add: new Set(["A", "u"]) }
const WHOLE_TREE_LONG = { commit: new Set(["all"]), add: new Set(["all", "update"]) }
const VALUE_SHORT = { commit: new Set(["m", "F", "C", "c", "t"]), add: new Set() }
const VALUE_LONG = {
  commit: new Set(["message", "file", "author", "date", "reuse-message", "reedit-message", "template", "cleanup", "trailer", "fixup", "squash", "pathspec-from-file"]),
  add: new Set(["pathspec-from-file"]),
}

const DIALECTS = {
  posix: {
    path: path,
    escape: "\\",
    separators: new Set([";", "|", "&", "\n"]),
    cd: POSIX_CD,
    stack: POSIX_STACK,
    gitEnv: /^GIT_(?:DIR|WORK_TREE)=/u,
    desk: /^\$(?:DESK|\{DESK\})(?=[/\\]|$)/u,
    home: /^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/u,
    bareCdGoesHome: true,
  },
  powershell: {
    path: path.win32,
    escape: "`",
    separators: new Set([";", "|", "&", "\n"]),
    cd: POWERSHELL_CD,
    stack: POWERSHELL_STACK,
    gitEnv: /^\$env:GIT_(?:DIR|WORK_TREE)(?:=|$)/iu,
    desk: /^\$env:DESK(?=[/\\]|$)/iu,
    home: /^(?:~|\$HOME|\$env:HOME|\$env:USERPROFILE)(?=[/\\]|$)/iu,
    bareCdGoesHome: false,
  },
}

// ---------------------------------------------------------------------------
// Tokenizing: a list of simple commands, each a list of words. A word is
// `{ text, dynamic, op }`: `text` is the unquoted value, `dynamic` is true
// when an unescaped `$` or backtick (command substitution) outside single
// quotes means the shell would expand it, and `op` marks a redirection
// operator, whose target word is dropped before a command is read.
// ---------------------------------------------------------------------------

function tokenize(command, dialect) {
  const { escape, separators } = dialect
  const commands = [[]]
  let word = null
  let quote = null
  let pendingHeredocs = []
  let index = 0

  const current = () => {
    if (word === null) word = { text: "", dynamic: false, op: false }
    return word
  }
  const endWord = () => {
    if (word !== null) commands[commands.length - 1].push(word)
    word = null
  }
  const endCommand = () => {
    endWord()
    if (commands[commands.length - 1].length > 0) commands.push([])
  }
  // Skips heredoc bodies that start after the newline at `index`.
  const skipHeredocs = () => {
    for (const { delimiter, stripTabs } of pendingHeredocs) {
      for (;;) {
        if (index >= command.length) return
        const lineEnd = command.indexOf("\n", index)
        const end = lineEnd === -1 ? command.length : lineEnd
        const line = command.slice(index, end)
        index = end + 1
        if ((stripTabs ? line.replace(/^\t+/u, "") : line) === delimiter) break
      }
    }
  }
  // Reads the heredoc delimiter word after `<<` / `<<-`; with none, the
  // operator is ignored.
  const readHeredocDelimiter = () => {
    let stripTabs = false
    if (command[index] === "-") {
      stripTabs = true
      index += 1
    }
    while (command[index] === " " || command[index] === "\t") index += 1
    let delimiter = ""
    while (index < command.length && !/[\s;&|()<>]/u.test(command[index])) {
      const char = command[index]
      if (char !== "'" && char !== "\"" && char !== "\\") delimiter += char
      index += 1
    }
    if (delimiter === "") return
    pendingHeredocs.push({ delimiter, stripTabs })
  }

  while (index < command.length) {
    const char = command[index]
    if (quote === "'") {
      if (char === "'") {
        if (dialect === DIALECTS.powershell && command[index + 1] === "'") {
          current().text += "'"
          index += 2
          continue
        }
        quote = null
      } else {
        current().text += char
      }
      index += 1
      continue
    }
    if (quote === "\"") {
      if (char === "\"") {
        quote = null
      } else if (char === escape && index + 1 < command.length) {
        const next = command[index + 1]
        if (escape === "`" || "\"\\$`".includes(next)) current().text += next
        else if (next !== "\n") current().text += char + next
        index += 1
      } else {
        if (char === "$" || (char === "`" && escape !== "`")) current().dynamic = true
        current().text += char
      }
      index += 1
      continue
    }
    if (char === " " || char === "\t" || char === "\r") {
      endWord()
      index += 1
      continue
    }
    if (char === "#" && word === null) {
      while (index < command.length && command[index] !== "\n") index += 1
      continue
    }
    if (char === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
      endWord()
      index += 2
      readHeredocDelimiter()
      continue
    }
    if (char === "<" || char === ">") {
      endWord()
      let op = ""
      while (index < command.length && "<>&|".includes(command[index])) {
        op += command[index]
        index += 1
      }
      commands[commands.length - 1].push({ text: op, dynamic: false, op: true })
      continue
    }
    if (char === "(" || char === ")") {
      // A subshell boundary: its own marker command.
      endCommand()
      commands[commands.length - 1].push({ text: char, dynamic: false, op: false, scope: true })
      endCommand()
      index += 1
      continue
    }
    if (separators.has(char)) {
      endCommand()
      index += 1
      if (char === "\n" && pendingHeredocs.length > 0) {
        skipHeredocs()
        pendingHeredocs = []
      }
      continue
    }
    if (char === escape) {
      if (index + 1 < command.length && command[index + 1] !== "\n") current().text += command[index + 1]
      index += 2
      continue
    }
    if (char === "'" || char === "\"") {
      current()
      quote = char
      index += 1
      continue
    }
    if (char === "$" && command[index + 1] === "(") {
      // A command substitution is one dynamic word; its inside is never read as commands.
      const substitution = current()
      substitution.dynamic = true
      substitution.text += "$"
      index += 1
      let depth = 0
      do {
        const inner = command[index]
        if (inner === "(") depth += 1
        else if (inner === ")") depth -= 1
        substitution.text += inner
        index += 1
      } while (index < command.length && depth > 0)
      continue
    }
    if (char === "`" && escape !== "`") {
      const close = command.indexOf("`", index + 1)
      const end = close === -1 ? command.length : close + 1
      current().dynamic = true
      current().text += command.slice(index, end)
      index = end
      continue
    }
    if (char === "$") current().dynamic = true
    current().text += char
    index += 1
  }
  endCommand()
  return commands.filter((words) => words.length > 0)
}

// Drops each redirection operator and the word it redirects to.
function withoutRedirections(words) {
  const kept = []
  for (let index = 0; index < words.length; index += 1) {
    if (words[index].op) index += 1
    else kept.push(words[index])
  }
  return kept
}

// ---------------------------------------------------------------------------
// Directories.
// ---------------------------------------------------------------------------

function isDeskMarked(directory) {
  return directory === DESK_MARKER || directory.startsWith(`${DESK_MARKER}/`)
}

// Joins a relative word onto the desk marker, keeping `/` separators.
function underDeskMarker(base, relative) {
  const joined = path.posix.join(base, relative.replaceAll("\\", "/"))
  return isDeskMarked(joined) ? joined : null
}

/** Moves `current` (a directory, the desk marker form, or null) by one directory word. */
function applyStep(current, word, { dialect, home }) {
  const { text } = word
  const deskMatch = dialect.desk.exec(text)
  if (deskMatch) return underDeskMarker(DESK_MARKER, `.${text.slice(deskMatch[0].length)}`)
  const homeMatch = dialect.home.exec(text)
  if (homeMatch) {
    if (typeof home !== "string") return null
    return dialect.path.join(home, text.slice(homeMatch[0].length))
  }
  if (word.dynamic) return null
  if (dialect.path.isAbsolute(text)) return dialect.path.normalize(text)
  if (typeof current !== "string") return null
  if (isDeskMarked(current)) return underDeskMarker(current, text)
  return dialect.path.resolve(current, text)
}

function commandName(text, dialect) {
  const base = text.split(/[/\\]/u).pop()
  return dialect === DIALECTS.powershell ? base.toLowerCase().replace(/\.exe$/u, "") : base
}

// The index of the command word, after assignments and wrapper words.
function commandStart(words) {
  let index = 0
  while (index < words.length && (ASSIGNMENT.test(words[index].text) || WRAPPERS.has(words[index].text))) index += 1
  return index
}

// The `git … commit` or `git … add` invocation in `words` (starting after
// `git`): its subcommand, the `-C` steps, whether `--git-dir`/`--work-tree`
// points Git elsewhere, and the words after the subcommand. `undefined` when
// it is neither.
function gitInvocation(words, start) {
  const steps = []
  let elsewhere = false
  let index = start
  while (index < words.length) {
    const text = words[index].text
    if (text === "-C") {
      steps.push(words[index + 1])
      index += 2
    } else if (GIT_ELSEWHERE_OPTION.test(text)) {
      elsewhere = true
      index += text.includes("=") ? 1 : 2
    } else if (GIT_OPTIONS_WITH_VALUE.has(text)) {
      index += 2
    } else if (text.startsWith("-")) {
      index += 1
    } else {
      break
    }
  }
  if (index >= words.length || !PATH_SUBCOMMANDS.has(words[index].text)) return undefined
  return { subcommand: words[index].text, steps, elsewhere, operands: words.slice(index + 1) }
}

// The absolute paths a `git add` or `git commit` names, resolved against
// `directory`. Option words and the values of options that take one are
// skipped; `--` ends the options and is not itself a path. A whole-tree
// flag (`-A`, `--all`, `-u`, `-a`, `-am`) or the operand `.` names no
// specific path, so the list is empty then.
function gitNamedPaths(subcommand, operands, directory, options) {
  const wholeShort = WHOLE_TREE_SHORT[subcommand]
  const wholeLong = WHOLE_TREE_LONG[subcommand]
  const valueShort = VALUE_SHORT[subcommand]
  const valueLong = VALUE_LONG[subcommand]
  const named = []
  let wholeTree = false
  let optionsDone = false
  for (let index = 0; index < operands.length; index += 1) {
    const { text } = operands[index]
    if (!optionsDone && text === "--") {
      optionsDone = true
    } else if (!optionsDone && text.startsWith("--")) {
      const [name, ...attached] = text.slice(2).split("=")
      if (wholeLong.has(name)) wholeTree = true
      else if (attached.length === 0 && valueLong.has(name)) index += 1
    } else if (!optionsDone && text.startsWith("-") && text.length > 1) {
      for (let at = 1; at < text.length; at += 1) {
        if (wholeShort.has(text[at])) {
          wholeTree = true
        } else if (valueShort.has(text[at])) {
          if (at === text.length - 1) index += 1
          break
        }
      }
    } else if (text !== "" && text !== ".") {
      named.push(operands[index])
    }
  }
  if (wholeTree) return []
  const paths = []
  for (const word of named) {
    const resolved = applyStep(directory, word, options)
    if (resolved !== null && !paths.includes(resolved)) paths.push(resolved)
  }
  return paths
}

// Resolves the file a redirection or `tee` writes, or `null` when it is not a
// literal path (`/dev/...`, a variable, a command substitution).
function writeTarget(current, word, options) {
  if (word === undefined || word.op || word.scope) return null
  // `/dev/null` as written, before it is resolved: Git Bash on Windows turns it into `D:\dev\null`, which no longer starts with `/dev/`.
  if (word.text.startsWith("/dev/")) return null
  const resolved = applyStep(current, word, options)
  if (resolved === null || resolved.startsWith("/dev/")) return null
  return resolved
}

function changeDirectory(args, current, options) {
  const targets = args.filter((word) => word.text === "-" || !word.text.startsWith("-"))
  if (targets.length === 0) {
    if (!options.dialect.bareCdGoesHome) return null
    return typeof options.home === "string" ? options.home : null
  }
  if (targets[0].text === "-") return null
  return applyStep(current, targets[0], options)
}

/**
 * `shellEffects({ command, cwd, home, dialect }) -> { commits, adds, writes }`:
 * what one shell command does that the factory binds a session by, in order.
 * `commits` and `adds` hold one `{ cwd, paths }` per `git … commit` and
 * `git … add`: `cwd` as in `gitCommitCwds` (`null` when unknown) and `paths`
 * the absolute files the command names (`[]` for `-A`, `.`, `-a`, `-am`).
 * `writes` lists the absolute files that `>`, `>>` and `tee` write. It never
 * throws: a command it cannot read gives empty lists.
 */
export function shellEffects({ command, cwd, home, dialect = "bash" }) {
  const effects = { commits: [], adds: [], writes: [] }
  // Most shell calls never touch any of these; they are not tokenized at all.
  if (typeof command !== "string" || !/commit|add|tee|>/u.test(command)) return effects
  const options = { dialect: DIALECTS[dialect] ?? DIALECTS.posix, home }
  const { dialect: shell } = options
  let current = typeof cwd === "string" ? cwd : null
  // Once GIT_DIR or GIT_WORK_TREE is set for the rest of the command.
  let elsewhere = false
  const note = (target) => {
    if (target !== null && !effects.writes.includes(target)) effects.writes.push(target)
  }
  for (const raw of tokenize(command, shell)) {
    if (raw[0].scope) {
      current = null
      continue
    }
    raw.forEach((word, index) => {
      if (word.op && WRITE_OPERATORS.has(word.text)) note(writeTarget(current, raw[index + 1], options))
    })
    const words = withoutRedirections(raw)
    const start = commandStart(words)
    const prefixSetsGitEnv = words.slice(0, start).some((word) => shell.gitEnv.test(word.text))
    if (start >= words.length) {
      if (prefixSetsGitEnv) elsewhere = true
      continue
    }
    const name = commandName(words[start].text, shell)
    if (shell === DIALECTS.powershell && words.some((word) => shell.gitEnv.test(word.text))) elsewhere = true
    if (EXPORTS.has(name) && words.slice(start + 1).some((word) => shell.gitEnv.test(word.text))) elsewhere = true
    if (shell.cd.has(name)) {
      current = changeDirectory(words.slice(start + 1), current, options)
    } else if (shell.stack.has(name)) {
      current = null
    } else if (name === "tee") {
      let optionsDone = false
      for (const word of words.slice(start + 1)) {
        if (!optionsDone && word.text === "--") optionsDone = true
        else if (optionsDone || !word.text.startsWith("-")) note(writeTarget(current, word, options))
      }
    } else if (name === "git") {
      const invocation = gitInvocation(words, start + 1)
      if (invocation === undefined) continue
      const directory =
        invocation.elsewhere || elsewhere || prefixSetsGitEnv
          ? null
          : invocation.steps.reduce((where, step) => applyStep(where, step, options), current)
      const paths = gitNamedPaths(invocation.subcommand, invocation.operands, directory, options)
      effects[invocation.subcommand === "commit" ? "commits" : "adds"].push({ cwd: directory, paths })
    }
  }
  return effects
}

/**
 * `gitCommitCwds({ command, cwd, home, dialect }) -> Array<string | null>`:
 * the directory of each `git … commit` in `command`, in order and without
 * repeats; `null` for one whose directory can't be known. `cwd` is the
 * directory the command started in, `home` the user's home folder, and
 * `dialect` is `"posix"` (default) or `"powershell"`. Nothing else from the
 * command is ever returned.
 */
export function gitCommitCwds({ command, cwd, home, dialect = "posix" }) {
  const found = []
  for (const { cwd: directory } of shellEffects({ command, cwd, home, dialect }).commits) {
    if (!found.includes(directory)) found.push(directory)
  }
  return found
}
