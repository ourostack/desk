#!/usr/bin/env node
// Turn a folder into a fresh solo desk and commit it: `node desk-init.js [--root <dir>] [--owner <display name>]`.
// The root defaults to DESK, then the working directory, so a hosted realm passes no desk path on the command line.
// Prints one JSON line. Exit 0: created. 2: refused because the folder is already a desk (nothing written). 1: error. 64: usage.
// first-run-bootstrap's fresh-create step and hosted GitHub linking both call this, so the desk layout lives here only.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deskGitInvocation, isolatedDeskRoot } from "../src/runtime/desk-git-context.js"
import { isDeskWorkspace } from "../src/util/paths.js"

// Root and one-level-down anchors keep a real deliverable deeper in a task folder from being silently ignored.
// `~$*` is Office's lock file; `undefined/` is what an unexported shell variable's path produces; `_cache/` is the Desk-problem quarantine.
export const DESK_GITIGNORE = Object.freeze([
  ".state/", ".machine-local.yml", "~$*",
  "/*.txt", "/*/*.txt", "/*.png", "/*/*.png", "/*.jpg", "/*/*.jpg", "/*.log", "/*/*.log",
  "undefined/", "_cache/",
])

const USAGE = "Usage: desk-init.js [--root <dir>] [--owner <display name>]\n"
const OWNER_MAX = 100

export function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === "--help") return { help: true }
    if (flag !== "--root" && flag !== "--owner") return { usage: `unknown argument ${JSON.stringify(flag)}` }
    const value = argv[i + 1]
    if (typeof value !== "string" || !value.trim()) return { usage: `${flag} needs a value` }
    if (flag === "--owner" && (value.length > OWNER_MAX || /[\u0000-\u001f\u007f]/.test(value))) {
      return { usage: `--owner must be one line of at most ${OWNER_MAX} characters` }
    }
    options[flag.slice(2)] = value
    i += 1
  }
  return options
}

function readme(owner) {
  const title = owner ? `${owner}'s desk` : "Desk"
  return `# ${title}\n\nThis is a [Desk](https://github.com/ourostack/desk) workspace: tracks of tasks, friction and lessons that agents keep between sessions. Desk's tools write here; edit cards through them rather than by hand.\n`
}

// Existing entries stay first and in their order, and keep the file's own line ending; only the missing desk entries are appended.
function gitignoreText(existing) {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n"
  const present = new Set(existing.split(/\r?\n/))
  const missing = DESK_GITIGNORE.filter((entry) => !present.has(entry))
  if (!missing.length) return null
  const base = existing && !existing.endsWith("\n") ? `${existing}${eol}` : existing
  return `${base}${missing.join(eol)}${eol}`
}

// Every spelling Git or Node may use for the root, longest first, including Git for Windows' forward slashes.
export function spellingsOf(...roots) {
  return [...new Set(roots.flatMap((root) => [root, root.replaceAll("\\", "/")]))].sort((x, y) => y.length - x.length)
}

// Git and Node messages can quote the folder; hand back only what is relative to the desk.
function scrub(text, spellings) {
  let out = String(text).trim().split("\n")[0]
  for (const spelling of spellings) out = out.split(spelling).join(".")
  return out
}

const NODE_FS = { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync }

/**
 * Write the solo desk template into `root` and commit exactly those paths.
 * Returns `{status:"created", commit, files}`, `{status:"refused", reason}` or `{status:"error", step, message}`; every path in it is desk-relative.
 * A hosted root must already exist inside the realm desk (a cloned repository). Every failure after the checks puts the folder and the index back as they were, so a rerun starts clean.
 */
export function initDesk({ root, owner, env, spawn = spawnSync, fs = NODE_FS }) {
  let spellings = spellingsOf(root)
  const error = (step, message) => ({ status: "error", step, message: scrub(message, spellings) })
  if (env.DESK_ISOLATED_HOSTED === "1") {
    try {
      isolatedDeskRoot(root, env)
    } catch (refusal) {
      return error("root", refusal.message)
    }
  }
  try {
    if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) return error("root", "the desk root is not a folder")
    if (isDeskWorkspace(root)) return { status: "refused", reason: "already_a_desk" }
    if (fs.existsSync(path.join(root, "_meta")) || fs.existsSync(path.join(root, "_archive"))) return { status: "refused", reason: "desk_folders_present" }
    fs.mkdirSync(root, { recursive: true })
    spellings = spellingsOf(root, fs.realpathSync(root))
  } catch (failure) {
    return error("root", failure.message)
  }

  const run = (args) => {
    const invocation = deskGitInvocation({ root, args, env })
    return spawn("git", invocation.args, { ...invocation.options, env, encoding: "utf8" })
  }
  // A commit needs an identity; checking first means a missing one never leaves a half-made desk behind.
  for (const ident of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const check = run(["var", ident])
    if (check.status !== 0) return error("identity", check.stderr)
  }
  if (!fs.existsSync(path.join(root, ".git"))) {
    const init = run(["init", "-q"])
    if (init.status !== 0) return error("init", init.stderr)
  }
  if (run(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status === 0) return error("merge", "a merge is in progress; finish or abort it first")
  // A pathspec commit takes a file's whole working copy, so the owner's own uncommitted .gitignore edits would ride along.
  const ignoreState = run(["status", "--porcelain", "--", ".gitignore"]).stdout
  if (ignoreState && !ignoreState.startsWith("??")) return error("gitignore", ".gitignore has uncommitted changes; commit or stash them first")

  const files = []
  const undo = []
  const rollBack = () => {
    for (const step of undo.reverse()) step()
  }
  try {
    const ignorePath = path.join(root, ".gitignore")
    const before = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : null
    const ignore = gitignoreText(before ?? "")
    if (ignore !== null) {
      fs.writeFileSync(ignorePath, ignore)
      undo.push(() => (before === null ? fs.rmSync(ignorePath) : fs.writeFileSync(ignorePath, before)))
      files.push(".gitignore")
    }
    if (!fs.readdirSync(root).some((name) => /^readme(\..*)?$/i.test(name))) {
      const readmePath = path.join(root, "README.md")
      fs.writeFileSync(readmePath, readme(owner))
      undo.push(() => fs.rmSync(readmePath))
      files.push("README.md")
    }
    for (const folder of ["_archive", "_meta"]) {
      const dir = path.join(root, folder)
      fs.mkdirSync(dir)
      undo.push(() => fs.rmSync(dir, { recursive: true }))
      fs.writeFileSync(path.join(dir, ".gitkeep"), "")
      files.push(`${folder}/.gitkeep`)
    }
  } catch (failure) {
    rollBack()
    return error("write", failure.message)
  }

  // Forced, so an owner's ignore rule such as `_*` cannot drop the files that give the desk its shape.
  const add = run(["add", "-f", "--", ...files])
  // A pathspec commit takes only these paths, so anything the owner already staged stays staged and out of this commit.
  const commit = add.status === 0 ? run(["commit", "-q", "-m", "Start the desk", "--", ...files]) : add
  if (commit.status !== 0) {
    // A reset unstages what this run added: a path in HEAD gets its committed entry back, and a new path (even on an unborn branch) leaves the index.
    run(["reset", "-q", "--", ...files])
    rollBack()
    return error(add.status === 0 ? "commit" : "add", commit.stderr)
  }
  const head = run(["rev-parse", "HEAD"])
  return { status: "created", commit: head.stdout.trim(), files }
}

const EXIT = { created: 0, refused: 2, error: 1 }

export async function main({ argv, env, cwd, write }) {
  const options = parseArgs(argv)
  if (options.help) {
    write(USAGE)
    return 0
  }
  if (options.usage) {
    write(`${JSON.stringify({ status: "usage", message: options.usage })}\n`)
    return 64
  }
  const root = path.resolve(cwd, options.root ?? env.DESK ?? cwd)
  const result = initDesk({ root, owner: options.owner, env })
  write(`${JSON.stringify(result)}\n`)
  return EXIT[result.status]
}

// argv[1] can be absent, or a label such as the hosted loader's "desk-builtin", which is never this file.
function isThisScript(argv1, moduleUrl) {
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

/**
 * Run `main` when this module is the script Node was asked to run, and report whether it did.
 * A hosted realm launches built-in scripts through a loader that keeps their path off the command line (deskScriptInvocation).
 * A direct run compares real paths, because argv[1] keeps a symlinked spelling such as macOS's $TMPDIR.
 */
export async function runIfMain({ moduleUrl, argv, env, cwd, out, run = main }) {
  const builtin = env.DESK_ISOLATED_HOSTED === "1" && env.DESK_BUILTIN_SCRIPT === moduleUrl
  if (!builtin && !isThisScript(argv[1], moduleUrl)) return false
  process.exitCode = await run({ argv: argv.slice(2), env, cwd, write: (text) => out.write(text) })
  return true
}

await runIfMain({ moduleUrl: import.meta.url, argv: process.argv, env: process.env, cwd: process.cwd(), out: process.stdout })
