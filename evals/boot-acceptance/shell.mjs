// A small shell reader for the harness checks: it turns a Bash command into words and operators the way a shell would,
// so a check can tell a real `git push` from the text "push" inside a commit message, and can find the paths a command
// writes. It is not a full shell: no expansion beyond `~`, `$HOME` and `${HOME}`, and nothing is run.

import * as path from "node:path"

const OPERATOR_CHARS = new Set([";", "|", "&", "<", ">", "(", ")", "\n"])
const SEPARATORS = new Set([";", "|", "||", "&&", "&", "(", ")", "\n"])

// How many characters a backslash line continuation takes at `index` (`\\` then LF, or CRLF), or 0 when there is none.
function continuation(text, index) {
  if (text[index] !== "\\") return 0
  if (text[index + 1] === "\n") return 2
  return text[index + 1] === "\r" && text[index + 2] === "\n" ? 3 : 0
}

// One word starting at `at`: quotes removed, a backslash keeps the next character, an unquoted operator ends it.
function readWord(text, at) {
  let word = ""
  let index = at
  while (index < text.length) {
    const char = text[index]
    if (continuation(text, index) > 0) {
      // A backslash before a line break continues the line: it is no character of the word.
      index += continuation(text, index)
    } else if (char === "\\") {
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
        // As in bash, a backslash before a line break inside double quotes joins the lines; before another character it escapes it.
        if (continuation(text, index) > 0) {
          index += continuation(text, index)
          continue
        }
        if (text[index] === "\\" && index + 1 < text.length) index += 1
        word += text[index]
        index += 1
      }
      index += 1
    } else if (char === "$" && text.startsWith("$((", index)) {
      // Arithmetic: a `>` inside is a comparison, never a redirection.
      const close = text.indexOf("))", index + 3)
      const end = close === -1 ? text.length : close + 2
      word += text.slice(index, end)
      index = end
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
    if (char === " " || char === "\t" || continuation(text, index) > 0) {
      index += char === "\\" ? continuation(text, index) : 1
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
      // `>|` forces the write past `noclobber`; it is a redirection, not a pipe.
      const forced = op === ">" && text[index] === "|"
      if (forced) index += 1
      if (text[index] === "&") {
        index += 1
        while (/[\d-]/u.test(text[index] ?? "")) index += 1
        continue
      }
      while (text[index] === " " || text[index] === "\t") index += 1
      const [target, next] = readWord(text, index)
      tokens.push({ kind: "redir", value: op, target, forced })
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

// Words that run the rest of the command: shell keywords, `env`, `time`, `sudo`, `nohup`, `command`, `exec`, `nice`.
const WRAPPERS = new Set(["env", "time", "sudo", "command", "exec", "nohup", "nice", "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
// `xargs` and `ssh` options that take the next word as their value.
const XARGS_VALUE = new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"])
const SSH_VALUE = new Set(["-p", "-i", "-o", "-l", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-e", "-S", "-W"])
const basename = (word) => String(word).replace(/^.*\//u, "")

// The simple commands of one command text, before wrappers are looked through.
function rawCommands(command) {
  const out = []
  let current = { words: [], redirects: [] }
  const finish = () => {
    if (current.words.length > 0 || current.redirects.length > 0) out.push(current)
    current = { words: [], redirects: [] }
  }
  for (const token of tokenize(command)) {
    if (token.kind === "op" && SEPARATORS.has(token.value)) finish()
    else if (token.kind === "redir") current.redirects.push({ op: token.value, target: token.target, forced: token.forced })
    else current.words.push(token.value)
  }
  finish()
  return out
}

// The text inside every `$(...)` (balanced) and backtick pair of `text`.
function substitutions(text) {
  const found = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "$" && text[index + 1] === "(" && text[index + 2] !== "(") {
      let depth = 1
      let end = index + 2
      while (end < text.length && depth > 0) {
        if (text[end] === "(") depth += 1
        else if (text[end] === ")") depth -= 1
        end += 1
      }
      found.push(text.slice(index + 2, depth === 0 ? end - 1 : end))
    } else if (text[index] === "`") {
      const end = text.indexOf("`", index + 1)
      if (end === -1) break
      found.push(text.slice(index + 1, end))
      index = end
    }
  }
  return found
}

// Looks through wrappers to the command they run: `VAR=x`, `env`, `time`, `sudo`, `nohup`, `then`, `timeout 5`, `xargs -n1`, `ssh host`.
function unwrap(words) {
  let rest = [...words]
  for (let guard = 0; guard < 32 && rest.length > 0; guard += 1) {
    const first = rest[0]
    if (/^[A-Za-z_]\w*=/u.test(first) || WRAPPERS.has(first)) {
      rest = rest.slice(1)
    } else if (basename(first) === "timeout") {
      rest = rest.slice(1)
      while (rest[0]?.startsWith("-")) rest = rest.slice(["-k", "-s", "--kill-after", "--signal"].includes(rest[0]) ? 2 : 1)
      rest = rest.slice(1)
    } else if (basename(first) === "xargs") {
      rest = rest.slice(1)
      while (rest[0]?.startsWith("-")) rest = rest.slice(XARGS_VALUE.has(rest[0]) ? 2 : 1)
    } else if (basename(first) === "ssh") {
      rest = rest.slice(1)
      while (rest[0]?.startsWith("-")) rest = rest.slice(SSH_VALUE.has(rest[0]) ? 2 : 1)
      rest = rest.slice(1)
    } else {
      break
    }
  }
  return rest
}

/**
 * Every simple command in `command`, as `{ words, redirects }`, looking through what runs other commands: wrappers
 * (`env`, `time`, `sudo`, `nohup`, `timeout`, `xargs`, `then`/`do`/`else`, `ssh host`), `sh|bash|zsh -c '<script>'`
 * strings, and `$(...)` and backtick substitutions. A git path is reduced to `git`. Nested commands follow their parent.
 */
export function simpleCommands(command, depth = 0) {
  const text = String(command ?? "")
  const out = []
  for (const raw of rawCommands(text)) {
    const words = unwrap(raw.words)
    if (words.length === 0 && raw.redirects.length === 0) continue
    if (words.length > 0 && basename(words[0]) === "git") words[0] = "git"
    out.push({ words, redirects: raw.redirects })
    if (depth < 4 && words.length > 0 && SHELLS.has(basename(words[0]))) {
      const flag = words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/u.test(word))
      if (flag !== -1 && words[flag + 1] !== undefined) out.push(...simpleCommands(words[flag + 1], depth + 1))
    }
  }
  if (depth < 4) for (const inner of substitutions(text)) out.push(...simpleCommands(inner, depth + 1))
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
  const aliases = new Map()
  while (index < words.length && words[index].startsWith("-")) {
    const option = words[index]
    if (option === "-C") directory = words[index + 1]
    // `git -c alias.p=push p`: the alias names git's own subcommand.
    const alias = option === "-c" ? /^alias\.([^=]+)=!?(?:git\s+)?(\S+)/u.exec(words[index + 1] ?? "") : null
    if (alias !== null) aliases.set(alias[1], alias[2])
    index += GIT_VALUE_OPTIONS.has(option) ? 2 : 1
  }
  const subcommand = aliases.get(words[index]) ?? words[index]
  return { subcommand, args: words.slice(index + 1), directory }
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

/**
 * A `gh` command's group, verb and the words after them, skipping gh's global options (`-R a/b`, `--repo a/b`, `--repo=a/b`, `--hostname h`), or null when
 * `words` is not a gh command. `gh -R a/b repo clone` and `gh repo clone` both read as `repo clone`.
 */
export function ghParts(words) {
  if (words[0] !== "gh") return null
  let index = 1
  while (index < words.length && words[index].startsWith("-")) index += ["-R", "--repo", "--hostname"].includes(words[index]) ? 2 : 1
  return { group: words[index], verb: words[index + 1], args: words.slice(index + 2) }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// The words of `args` that are not options, skipping the value of each option in `valueOptions` (`-b main`, `--depth 1`).
function positional(args, valueOptions = []) {
  const takesValue = new Set(valueOptions)
  const out = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("-")) {
      if (takesValue.has(args[index])) index += 1
    } else {
      out.push(args[index])
    }
  }
  return out
}

const CLONE_VALUE_OPTIONS = ["-b", "--branch", "--depth", "-o", "--origin", "--reference", "--reference-if-able", "--separate-git-dir", "-c", "--config", "--filter", "-j", "--jobs", "--template", "-u", "--upload-pack", "--server-option", "--shallow-since", "--shallow-exclude", "--bundle-uri"]
const INIT_VALUE_OPTIONS = ["-b", "--initial-branch", "--template", "--separate-git-dir", "--object-format", "--shared"]
const COMMIT_VALUE_OPTIONS = ["-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message", "--author", "--date", "-t", "--template", "--cleanup", "--fixup", "--squash"]
const WORKTREE_VALUE_OPTIONS = ["-b", "-B", "--reason"]

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
      // `-t DIR` and `--target-directory DIR` name the destination, whatever the other words are.
      const flagged = rest.findIndex((arg) => arg === "-t" || arg === "--target-directory" || arg.startsWith("--target-directory="))
      if (flagged !== -1) {
        const target = rest[flagged].includes("=") ? rest[flagged].slice(rest[flagged].indexOf("=") + 1) : rest[flagged + 1]
        if (target !== undefined && target !== "") note(target, name)
      }
      else if (positional(rest).length >= 2) note(positional(rest).at(-1), name)
    } else if (name === "gh" && ghParts(words)?.group === "repo" && ghParts(words).verb === "clone") {
      // Words after a bare `--` are git's own flags, not the repository or the folder.
      const { args } = ghParts(words)
      const dashes = args.indexOf("--")
      const named = positional(dashes === -1 ? args : args.slice(0, dashes), ["-u", "--upstream-remote-name"])
      if (named.length > 0) note(named[1] ?? path.posix.basename(named[0]), "gh repo clone")
    } else if (name === "git") {
      const git = gitParts(words)
      if (git === null) continue
      if (git.subcommand === "clone") {
        const args = positional(git.args, CLONE_VALUE_OPTIONS)
        if (args.length > 0) note(args[1] ?? path.posix.basename(args[0]).replace(/\.git$/u, ""), "git clone")
      } else if (git.subcommand === "init") {
        const args = positional(git.args, INIT_VALUE_OPTIONS)
        if (args.length > 0) note(args[0], "git init")
      } else if (git.subcommand === "worktree") {
        const args = positional(git.args, WORKTREE_VALUE_OPTIONS)
        if (args[0] === "add" && args[1] !== undefined) note(args[1], "git worktree add")
      }
    }
  }
  return [...new Map(found.map((write) => [`${write.via}\0${write.path}`, write])).values()]
}

// ---------------------------------------------------------------------------
// Network fetches
// ---------------------------------------------------------------------------

// A URL or scp-style address that reaches another machine: any scheme URL whose host is not this one, and `user@host:path`.
// A bare path and `file://` are local, so the fixture desk's own bare `origin` never matches.
const REAL_REMOTE = /^(?:(?:https?|git|ssh|ftps?):\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$))|[\w.-]+@[\w.-]+:)/iu
const FETCHING_SUBCOMMANDS = new Set(["clone", "fetch", "pull", "ls-remote"])

/**
 * The network fetches a shell command makes from a real host, as `{ via, target, dest }`: `git clone|fetch|pull|ls-remote` with a URL that is
 * not local (`https://github.com/...`, `git@github.com:...`), `git remote add|set-url` with one (it points a remote at a real host; the fetch
 * that follows names the remote, not the URL, so this is where the host shows), and `gh repo clone` (also `gh -R a/b repo clone`), which always
 * reaches GitHub. A bare path or `file://` URL (the fixture's own origin) is not one. `dest` is where the clone lands, or the folder a fetch or
 * remote change runs in (following `cd` and `git -C`, `~` expanded from `home`, relative paths from `cwd`), or null when it cannot be resolved.
 */
export function remoteFetches(command, { cwd, home } = {}) {
  const found = []
  let directory = cwd
  const resolve = (value, from = directory) => resolveShellPath(value, { cwd: from, home })
  for (const { words } of simpleCommands(command)) {
    if (words[0] === "cd" && words[1] !== undefined) {
      directory = resolve(words[1]) ?? directory
      continue
    }
    const git = gitParts(words)
    if (git !== null) {
      const where = git.directory === undefined ? directory : resolve(git.directory)
      if (git.subcommand === "remote") {
        const target = ["add", "set-url"].includes(git.args[0]) ? git.args.slice(1).find((arg) => REAL_REMOTE.test(arg)) : undefined
        if (target !== undefined) found.push({ via: `git ${git.subcommand}`, target, dest: where ?? null })
      } else if (FETCHING_SUBCOMMANDS.has(git.subcommand)) {
        const target = git.args.find((arg) => REAL_REMOTE.test(arg))
        if (target === undefined) continue
        if (git.subcommand === "clone") {
          const named = positional(git.args, CLONE_VALUE_OPTIONS)
          const folder = named[1] ?? path.posix.basename(named[0] ?? target).replace(/\.git$/u, "")
          found.push({ via: "git clone", target, dest: resolve(folder, where) })
        } else {
          found.push({ via: `git ${git.subcommand}`, target, dest: where ?? null })
        }
      }
    } else if (ghParts(words)?.group === "repo" && ghParts(words).verb === "clone") {
      // `gh -R a/b repo clone` names the repository as the global option's value, so the clone's own argument may be absent.
      const { args } = ghParts(words)
      const dashes = args.indexOf("--")
      const named = positional(dashes === -1 ? args : args.slice(0, dashes), ["-u", "--upstream-remote-name"])
      const globalRepo = words.slice(1, words.indexOf("repo")).find((word, index, list) => list[index - 1] === "-R" || list[index - 1] === "--repo" || word.startsWith("--repo="))
      // With a global repository the clone's own first argument is the folder; without one it is the repository.
      const target = globalRepo === undefined ? named[0] ?? "" : globalRepo.replace(/^--repo=/u, "")
      const folder = globalRepo === undefined ? named[1] : named[0]
      found.push({ via: "gh repo clone", target, dest: resolve(folder ?? path.posix.basename(target).replace(/\.git$/u, "")) })
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Task card writes (round 12)
// ---------------------------------------------------------------------------

// The script write forms of the plugin's own Bash guard (`plugins/desk/mcp/src/runtime/shell-card-writes.js`, `SCRIPT_WRITE_PATTERNS`); round12.test.mjs
// checks the two lists are the same, so the harness and the guard read the same forms.
export const SCRIPT_WRITE_PATTERNS = [
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|renameSync|truncateSync)\s*\(/u,
  /\bfs\s*\.\s*(?:promises\s*\.\s*)?(?:rename|writeFile|appendFile|copyFile|truncate)\s*\(/u,
  /\b(?:open|openSync)\s*\([^)]*,\s*(?:mode\s*=\s*)?["'][^"']*[wax+][^"']*["']/u,
  /\.\s*(?:write_text|write_bytes)\s*\(/u,
  /\b(?:shutil\s*\.\s*(?:move|copy|copy2|copyfile)|os\s*\.\s*(?:replace|rename))\s*\(/u,
  /\b(?:File|IO)\s*\.\s*(?:write|binwrite)\s*\(/u,
  /\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Move-Item|Copy-Item)\b/iu,
  /\bFile\s*\]\s*::\s*(?:WriteAll\w+|AppendAll\w+|Copy|Move|Replace)\s*\(/iu,
]

const CARD_WORD = /[^\s"'`=:<>|;&(),{}]*task\.md(?![\w.-])/giu
const READ_CALL_BEFORE = /\b(?:readFileSync|readFile|createReadStream|statSync|existsSync|read_text|read_bytes)\s*\(\s*["']?$/u
const IN_PLACE_COMMANDS = new Set(["sed", "gsed", "perl", "ruby", "yq", "awk"])
const comparable = (value) => path.posix.normalize(String(value)).replace(/^\/private(?=\/(?:var|tmp|etc)\b)/u, "")

/**
 * Whether `target` (an absolute path) is a live task card of the desk at `deskRoot`: `<track>/<slug>/task.md`, or the same under `desks/<alias>/`, with a
 * track that is not a `_` or `.` folder. Judged from the path alone, case-insensitively; the card need not exist.
 */
export function isLiveCardFile(target, deskRoot) {
  const root = comparable(deskRoot).replace(/\/+$/u, "")
  const file = comparable(target)
  if (!file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return false
  const parts = file.slice(root.length + 1).toLowerCase().split("/").filter((part) => part !== "")
  if (parts.at(-1) !== "task.md") return false
  const inner = parts[0] === "desks" ? parts.slice(2) : parts
  return inner.length === 3 && !inner[0].startsWith("_") && !inner[0].startsWith(".")
}

// Every simple command with the folder it runs in (following `cd`), for the checks below.
function inFolders(command, { cwd, home }) {
  const out = []
  let directory = cwd
  for (const { words } of simpleCommands(command)) {
    if (words[0] === "cd" && words[1] !== undefined) {
      directory = resolveShellPath(words[1], { cwd: directory, home }) ?? directory
      continue
    }
    out.push({ words, directory })
  }
  return out
}

/**
 * The live task cards of the desk at `deskRoot` that `command` writes, as `{ path, via }`: a redirect, `tee`, `cp`, `mv`, `install` or `ln` onto one
 * (what `shellWrites` reads), `sed -i` and the other in-place editors, `git checkout` or `git restore` of one, and a script that writes files
 * (`SCRIPT_WRITE_PATTERNS`) in a command that names one. A script's path is any word ending in `task.md` that resolves to a card from the working
 * folder or the desk (the round E command built it with `path.join(process.cwd(), 'track/slug/task.md')`); a word that is the argument of a read call is a read.
 */
export function cardShellWrites(command, { cwd, home, deskRoot }) {
  const found = []
  const note = (target, via) => {
    if (target !== null && isLiveCardFile(target, deskRoot)) found.push({ path: comparable(target), via })
  }
  for (const write of shellWrites(command, { cwd, home })) note(write.path, write.via)
  for (const { words, directory } of inFolders(command, { cwd, home })) {
    const name = path.posix.basename(words[0] ?? "")
    if (IN_PLACE_COMMANDS.has(name) && words.some((word) => /^-[A-Za-z]*i/u.test(word) || word.startsWith("--in-place"))) {
      for (const word of words.slice(1)) if (!word.startsWith("-")) note(resolveShellPath(word, { cwd: directory, home }), `${name} -i`)
    }
    const git = gitParts(words)
    if (git !== null && (git.subcommand === "checkout" || git.subcommand === "restore")) {
      const unstageOnly = git.args.some((arg) => arg === "--staged" || arg === "-S") && !git.args.some((arg) => arg === "--worktree" || arg === "-W")
      if (!unstageOnly) for (const arg of git.args) if (!arg.startsWith("-")) note(resolveShellPath(arg, { cwd: git.directory ?? directory, home }), `git ${git.subcommand}`)
    }
  }
  const text = String(command ?? "")
  if (SCRIPT_WRITE_PATTERNS.some((pattern) => pattern.test(text))) {
    for (const match of text.matchAll(CARD_WORD)) {
      if (READ_CALL_BEFORE.test(text.slice(Math.max(0, match.index - 40), match.index))) continue
      for (const base of [cwd, deskRoot]) note(resolveShellPath(match[0], { cwd: base, home }), "a script that writes files")
    }
  }
  return [...new Map(found.map((write) => [write.path, write])).values()]
}

/**
 * The hand commits in `command` that include a task card: `git commit` naming a card path, or `git add` of a card followed by a `git commit` in the same
 * command (`{ via }`), looking through `cd` and `git -C`.
 */
export function cardCommits(command, { cwd, home, deskRoot }) {
  const found = []
  let staged = false
  for (const { words, directory } of inFolders(command, { cwd, home })) {
    const git = gitParts(words)
    if (git === null) continue
    const where = git.directory === undefined ? directory : resolveShellPath(git.directory, { cwd: directory, home })
    const isCard = (arg) => isLiveCardFile(resolveShellPath(arg, { cwd: where, home }) ?? "", deskRoot)
    if (git.subcommand === "add" && git.args.filter((arg) => !arg.startsWith("-")).some(isCard)) staged = true
    if (git.subcommand === "commit") {
      // Explicit pathspecs (after `--`, or a bare word that is not an option's value) commit only those paths, so a staged card is left out of the commit.
      const dashes = git.args.indexOf("--")
      const pathspecs = dashes === -1 ? positional(git.args, COMMIT_VALUE_OPTIONS) : [...positional(git.args.slice(0, dashes), COMMIT_VALUE_OPTIONS), ...git.args.slice(dashes + 1)]
      const names = pathspecs.some(isCard)
      const limited = pathspecs.length > 0
      if (names || (staged && !limited)) found.push({ via: names ? "git commit naming a card" : "git add of a card, then git commit" })
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Clones and stand-in remotes (round 12)
// ---------------------------------------------------------------------------

/** Every `git clone` in `command`, as `{ source, dest, bare }`: the source as written, the folder it lands in (resolved, or null) and whether it is a bare or mirror clone. */
export function gitClones(command, { cwd, home }) {
  const found = []
  for (const { words, directory } of inFolders(command, { cwd, home })) {
    if (words[0] === "gh" && words[1] === "repo" && words[2] === "clone") {
      // `gh repo clone <repo> [<directory>] [-- <git clone flags>]`
      const dashes = words.indexOf("--")
      const ghArgs = words.slice(3, dashes === -1 ? undefined : dashes).filter((word) => !word.startsWith("-"))
      if (ghArgs.length === 0) continue
      const folder = ghArgs[1] ?? path.posix.basename(ghArgs[0]).replace(/\.git$/u, "")
      const gitFlags = dashes === -1 ? [] : words.slice(dashes + 1)
      found.push({ source: ghArgs[0], dest: resolveShellPath(folder, { cwd: directory, home }), bare: gitFlags.includes("--bare") || gitFlags.includes("--mirror") })
      continue
    }
    const git = gitParts(words)
    if (git === null || git.subcommand !== "clone") continue
    const where = git.directory === undefined ? directory : resolveShellPath(git.directory, { cwd: directory, home })
    const named = positional(git.args, CLONE_VALUE_OPTIONS)
    if (named.length === 0) continue
    const folder = named[1] ?? path.posix.basename(named[0]).replace(/\.git$/u, "")
    found.push({ source: named[0], dest: resolveShellPath(folder, { cwd: where ?? undefined, home }), bare: git.args.includes("--bare") || git.args.includes("--mirror") })
  }
  return found
}

const LOCAL_REMOTE = /^(?:\/|\.{1,2}\/|~|file:)/u

/**
 * What in `command` makes a stand-in for a remote: `git init --bare`, `git clone --bare|--mirror`, and `git remote add|set-url <name> <local path>` for any
 * remote that is not `origin` (a fork or an upstream that points at a folder), and `git remote set-url origin <local path>` that is not the fixture's `origin.git`. Each as `{ via, target }`.
 */
export function simulatedRemotes(command) {
  const found = []
  for (const { subcommand, args } of gitCommands(command)) {
    if (subcommand === "init" && args.includes("--bare")) found.push({ via: "git init --bare", target: positional(args, INIT_VALUE_OPTIONS)[0] ?? "." })
    else if (subcommand === "clone" && (args.includes("--bare") || args.includes("--mirror"))) found.push({ via: "git clone --bare", target: positional(args, CLONE_VALUE_OPTIONS)[0] ?? "" })
    else if (subcommand === "remote" && (args[0] === "add" || args[0] === "set-url")) {
      const [name, target] = positional(args.slice(1), ["-t", "-m", "--tags", "--no-tags"])
      if (name === undefined || target === undefined || !LOCAL_REMOTE.test(target)) continue
      // `add origin <path>` is how a fixture sets up its own origin; `set-url` of any remote, origin included, to a folder repoints it at a stand-in, except back to the fixture's `origin.git`.
      const standIn = name !== "origin" || (args[0] === "set-url" && !/(?:^|\/)origin\.git\/?$/u.test(target))
      if (standIn) found.push({ via: `git remote ${args[0]} ${name}`, target })
    }
  }
  return found
}
