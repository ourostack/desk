#!/usr/bin/env node
// Turn a folder into a fresh solo desk and commit it: `node desk-init.js [--root <dir>] [--owner <display name>]`.
// The root defaults to DESK, then the working directory, so a hosted realm passes no desk path on the command line.
// Prints one JSON line. Exit 0: created. 2: refused because the folder is already a desk (nothing written). 1: error. 64: usage.
// first-run-bootstrap's fresh-create step and hosted GitHub linking both call this, so the desk layout lives here only.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
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

// Existing entries stay first and in their order; only the missing desk entries are appended.
function gitignoreText(existing) {
  const present = new Set(existing.split(/\r?\n/))
  const missing = DESK_GITIGNORE.filter((entry) => !present.has(entry))
  if (!missing.length) return null
  const base = existing && !existing.endsWith("\n") ? `${existing}\n` : existing
  return `${base}${missing.join("\n")}\n`
}

// Git's own messages can quote the folder; hand back only what is relative to the desk.
function scrub(text, root) {
  let out = String(text).trim().split("\n")[0]
  for (const spelling of new Set([realpathSync(root), root])) out = out.split(spelling).join(".")
  return out
}

/**
 * Write the solo desk template into `root` and commit exactly those paths.
 * Returns `{status:"created", commit, files}`, `{status:"refused", reason}` or `{status:"error", step, message}`; every path in it is desk-relative.
 */
export function initDesk({ root, owner, env, spawn = spawnSync }) {
  if (env.DESK_ISOLATED_HOSTED === "1") {
    try {
      isolatedDeskRoot(root, env)
    } catch (error) {
      return { status: "error", step: "git", message: error.message }
    }
  }
  if (existsSync(root) && !statSync(root).isDirectory()) return { status: "error", step: "root", message: "the desk root is not a folder" }
  if (isDeskWorkspace(root)) return { status: "refused", reason: "already_a_desk" }
  if (existsSync(path.join(root, "_meta")) || existsSync(path.join(root, "_archive"))) return { status: "refused", reason: "desk_folders_present" }

  const run = (args) => {
    const invocation = deskGitInvocation({ root, args, env })
    return spawn("git", invocation.args, { ...invocation.options, env, encoding: "utf8" })
  }
  mkdirSync(root, { recursive: true })
  const gitDir = path.join(root, ".git")
  if (!existsSync(gitDir)) {
    const init = run(["init", "-q"])
    if (init.status !== 0) return { status: "error", step: "init", message: scrub(init.stderr, root) }
  }

  const files = []
  const ignorePath = path.join(root, ".gitignore")
  const ignore = gitignoreText(existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "")
  if (ignore !== null) {
    writeFileSync(ignorePath, ignore)
    files.push(".gitignore")
  }
  if (!existsSync(path.join(root, "README.md"))) {
    writeFileSync(path.join(root, "README.md"), readme(owner))
    files.push("README.md")
  }
  for (const folder of ["_archive", "_meta"]) {
    mkdirSync(path.join(root, folder))
    writeFileSync(path.join(root, folder, ".gitkeep"), "")
    files.push(`${folder}/.gitkeep`)
  }

  const add = run(["add", "--", ...files])
  if (add.status !== 0) return { status: "error", step: "add", message: scrub(add.stderr, root) }
  // A pathspec commit takes only these paths, so anything the owner already staged stays staged and out of this commit.
  const commit = run(["commit", "-q", "-m", "Start the desk", "--", ...files])
  if (commit.status !== 0) return { status: "error", step: "commit", message: scrub(commit.stderr, root) }
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

/**
 * Run `main` when this module is the script Node was asked to run, and report whether it did.
 * A hosted realm launches built-in scripts through a loader that keeps their path off the command line (deskScriptInvocation).
 * A direct run compares real paths, because argv[1] keeps a symlinked spelling such as macOS's $TMPDIR.
 */
export async function runIfMain({ moduleUrl, argv, env, cwd, out, run = main }) {
  const builtin = env.DESK_ISOLATED_HOSTED === "1" && env.DESK_BUILTIN_SCRIPT === moduleUrl
  if (!builtin && realpathSync(argv[1] ?? ".") !== realpathSync(fileURLToPath(moduleUrl))) return false
  process.exitCode = await run({ argv: argv.slice(2), env, cwd, write: (text) => out.write(text) })
  return true
}

await runIfMain({ moduleUrl: import.meta.url, argv: process.argv, env: process.env, cwd: process.cwd(), out: process.stdout })
