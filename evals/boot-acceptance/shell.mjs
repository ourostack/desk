// A small shell reader for the harness checks: it turns a Bash command into words and operators the way a shell would,
// so a check can tell a real `git push` from the text "push" inside a commit message, and can find the paths a command
// writes. It is not a full shell: no expansion beyond `~`, `$HOME` and `${HOME}`, and nothing is run.

import * as path from "node:path"

const OPERATOR_CHARS = new Set([";", "|", "&", "<", ">", "(", ")", "\n"])
const SEPARATORS = new Set([";", "|", "||", "&&", "&", "(", ")", "\n"])

// One word starting at `at`: quotes removed, a backslash keeps the next character, an unquoted operator ends it.
function readWord(text, at) {
  let word = ""
  let index = at
  while (index < text.length) {
    const char = text[index]
    if (char === "\\") {
      word += text[index + 1] ?? ""
      index += 2
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1)
      const end = close === -1 ? text.length : close
      word += text.slice(index + 1, end)
      index = end + 1
    } else if (char === '"') {
      index += 1
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && index + 1 < text.length) index += 1
        word += text[index]
        index += 1
      }
      index += 1
    } else if (char === " " || char === "\t" || OPERATOR_CHARS.has(char)) {
      break
    } else {
      word += char
      index += 1
    }
  }
  return [word, index]
}

// Skips heredoc bodies that start after the newline at `at`: each body runs to a line holding only its delimiter.
function skipHeredocBodies(text, at, delimiters) {
  let index = at
  for (const delimiter of delimiters) {
    while (index < text.length) {
      const end = text.indexOf("\n", index)
      const line = text.slice(index, end === -1 ? text.length : end)
      index = end === -1 ? text.length : end + 1
      if (line.trim() === delimiter) break
    }
  }
  return index
}

/**
 * The command as `{ kind: "word" | "op" | "redir", value, target? }` tokens: operators (`&&`, `||`, `;`, `|`, `&`,
 * parentheses, line breaks), redirections with their target (`>`, `>>`, `<`; a `>&2` style duplication is dropped) and
 * words. Heredoc bodies are skipped.
 */
export function tokenize(command) {
  const text = String(command ?? "")
  const tokens = []
  const heredocs = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === " " || char === "\t") {
      index += 1
    } else if (char === "\n") {
      tokens.push({ kind: "op", value: "\n" })
      index = skipHeredocBodies(text, index + 1, heredocs.splice(0))
    } else if (char === "<" && text.startsWith("<<", index) && text[index + 2] !== "<") {
      index += 2
      if (text[index] === "-") index += 1
      while (text[index] === " " || text[index] === "\t") index += 1
      const [delimiter, next] = readWord(text, index)
      heredocs.push(delimiter)
      index = next
    } else if (char === ">" || char === "<") {
      // `2>file`: the file descriptor was read as a word of digits just before; drop it.
      if (tokens.at(-1)?.kind === "word" && /^\d+$/u.test(tokens.at(-1).value) && text[index - 1] !== " " && text[index - 1] !== "\t") tokens.pop()
      const op = text.startsWith(">>", index) ? ">>" : char
      index += op.length
      if (text[index] === "&") {
        index += 1
        while (/[\d-]/u.test(text[index] ?? "")) index += 1
        continue
      }
      while (text[index] === " " || text[index] === "\t") index += 1
      const [target, next] = readWord(text, index)
      tokens.push({ kind: "redir", value: op, target })
      index = next
    } else if (OPERATOR_CHARS.has(char)) {
      const two = text.slice(index, index + 2)
      const op = two === "&&" || two === "||" ? two : char
      tokens.push({ kind: "op", value: op })
      index += op.length
    } else {
      const [word, next] = readWord(text, index)
      tokens.push({ kind: "word", value: word })
      index = next
    }
  }
  return tokens
}

const WRAPPERS = new Set(["env", "time", "sudo", "command", "exec", "nohup"])

/** The simple commands of `command` in order, as `{ words, redirects }`, with leading `VAR=value` words and wrappers such as `env` or `time` dropped. */
export function simpleCommands(command) {
  const out = []
  let current = { words: [], redirects: [] }
  const finish = () => {
    while (current.words.length > 0 && (/^[A-Za-z_]\w*=/u.test(current.words[0]) || WRAPPERS.has(current.words[0]))) current.words.shift()
    if (current.words.length > 0 || current.redirects.length > 0) out.push(current)
    current = { words: [], redirects: [] }
  }
  for (const token of tokenize(command)) {
    if (token.kind === "op" && SEPARATORS.has(token.value)) finish()
    else if (token.kind === "redir") current.redirects.push({ op: token.value, target: token.target })
    else current.words.push(token.value)
  }
  finish()
  return out
}

// Git's own options that take the next word as their value (the `--opt=value` spelling takes none).
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"])

/**
 * A `git` command's parts: `{ subcommand, args, directory }`, or null when `words` is not a git command. Global options
 * come before the subcommand and are skipped (`-C <dir>`, `-c k=v`, `--git-dir <dir>`, `--no-pager` ...); the first word
 * that is not an option is the subcommand. `directory` is the last `-C` value, if any.
 */
export function gitParts(words) {
  if (words[0] !== "git") return null
  let index = 1
  let directory
  while (index < words.length && words[index].startsWith("-")) {
    const option = words[index]
    if (option === "-C") directory = words[index + 1]
    index += GIT_VALUE_OPTIONS.has(option) ? 2 : 1
  }
  return { subcommand: words[index], args: words.slice(index + 1), directory }
}

/** Every git command in `command` with the folder it runs in: `{ subcommand, args, directory }`, where `directory` follows `cd` and `git -C` (relative paths resolved from `cwd`). */
export function gitCommands(command, { cwd } = {}) {
  const found = []
  let directory = cwd
  for (const { words } of simpleCommands(command)) {
    if (words[0] === "cd" && words[1] !== undefined) {
      directory = directory === undefined || words[1].startsWith("~") ? words[1] : path.posix.resolve(directory, words[1])
      continue
    }
    const git = gitParts(words)
    if (git === null || git.subcommand === undefined) continue
    const dir = git.directory === undefined ? directory : git.directory.startsWith("~") || directory === undefined ? git.directory : path.posix.resolve(directory, git.directory)
    found.push({ subcommand: git.subcommand, args: git.args, directory: dir })
  }
  return found
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const positional = (args) => args.filter((arg) => !arg.startsWith("-"))

/** A path with `~`, `$HOME` and `${HOME}` expanded and relative paths made absolute from `cwd`; null when it uses another variable or has no base. */
export function resolveShellPath(value, { cwd, home }) {
  let text = String(value)
  if (home !== undefined) text = text.replace(/^~(?=\/|$)/u, home).replace(/^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/u, home)
  if (/\$|`/u.test(text) || text.startsWith("~")) return null
  if (text.startsWith("/")) return path.posix.normalize(text)
  return cwd === undefined ? null : path.posix.resolve(cwd, text)
}

/**
 * The paths a shell command writes or creates, as `{ path, via }`: redirections, `mkdir`, `touch`, `tee`, the target of
 * `cp`, `mv`, `ln` and `install`, `git clone`, `git init` and `git worktree add`. `cwd` is where the command starts
 * and `cd` moves it; `home` expands `~`. A path that cannot be resolved is left out.
 */
export function shellWrites(command, { cwd, home }) {
  const found = []
  let directory = cwd
  const note = (value, via) => {
    const resolved = resolveShellPath(value, { cwd: directory, home })
    if (resolved !== null) found.push({ path: resolved, via })
  }
  for (const { words, redirects } of simpleCommands(command)) {
    for (const redirect of redirects) if (redirect.op !== "<" && redirect.target !== "") note(redirect.target, `a shell redirection (${redirect.op})`)
    const [name, ...rest] = words
    if (name === "cd" && rest[0] !== undefined) {
      directory = resolveShellPath(rest[0], { cwd: directory, home }) ?? directory
    } else if (name === "mkdir" || name === "touch" || name === "tee") {
      const skipValue = name === "mkdir" ? new Set(["-m", "--mode"]) : new Set()
      const args = rest.filter((arg, index) => !skipValue.has(rest[index - 1]))
      for (const arg of positional(args)) note(arg, name)
    } else if (name === "cp" || name === "mv" || name === "ln" || name === "install") {
      const args = positional(rest)
      if (args.length >= 2) note(args.at(-1), name)
    } else if (name === "git") {
      const git = gitParts(words)
      if (git === null) continue
      const args = positional(git.args)
      if (git.subcommand === "clone" && args.length > 0) note(args[1] ?? path.posix.basename(args[0]).replace(/\.git$/u, ""), "git clone")
      else if (git.subcommand === "init" && args.length > 0) note(args[0], "git init")
      else if (git.subcommand === "worktree" && args[0] === "add" && args[1] !== undefined) note(args[1], "git worktree add")
    }
  }
  return found
}
