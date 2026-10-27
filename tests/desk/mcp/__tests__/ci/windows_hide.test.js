// Every child process Desk and Crew start passes `windowsHide: true`. Without it, a Git or gh call made from a process
// with no console (the tool server, the background sync worker, a hook) opens a blank console window on Windows, which
// a member saw flash up on every write during the first Crew join on Windows.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..")
const ROOTS = ["plugins/desk", "plugins/crew"]
// Calls that are not a child process start, or that forward options a caller already built with `windowsHide`.
const NOT_A_START = new Set([
  "plugins/desk/mcp/src/runtime/boot.js spawnGit(...args)", // a test stand-in's forwarder; the real path is fetchAsync
  "plugins/desk/mcp/src/runtime/sync-worker.js spawnWorker({ root, env, debounceMs })", // Desk's own function
])
// Names that match the pattern but never start a process.
const NOT_A_START_NAME = /^(?:failedToSpawn)$/u
// macOS-only permission helpers (`/bin/ls`, `/bin/chmod`); never run on Windows.
const SKIPPED_FILES = new Set(["plugins/desk/mcp/src/factory/os-protect.js"])

function sources(dir, out = []) {
  for (const entry of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) sources(rel, out)
    else if (/\.(?:c|m)?js$/u.test(entry.name)) out.push(rel)
  }
  return out
}

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " ")).replace(/(^|\s)\/\/.*$/gmu, "$1")

// The argument text of each call that is not its own definition to a name that starts or ends with spawn, execFile,
// execSync or fork, in any letter case (so an alias such as `nodeSpawnSync` counts), or to `exec` itself or through
// a child-process module object (`childProcess.exec`). A method call such as `pattern.exec(text)` is a RegExp's.
function starts(text) {
  const found = []
  for (const match of text.matchAll(/(?<![\w$])((?:[\w$]+)\.)?([\w$]*(?:spawn|execfile|execsync|fork)(?:sync)?|(?:spawn|execfile|execsync|fork)[\w$]*|exec)\s*\(/giu)) {
    const method = match[1] !== undefined || text[match.index - 1] === "."
    if (/^exec$/iu.test(match[2]) && method && !/^(?:child_?process|cp)\.$/iu.test(match[1] ?? "")) continue
    if (/^forEach$/iu.test(match[2]) || /^fork[a-z]/u.test(match[2])) continue
    if (/function\s*\*?\s*$/u.test(text.slice(Math.max(0, match.index - 20), match.index))) continue
    let end = match.index + match[0].length
    for (let depth = 1; end < text.length && depth > 0; end++) {
      if (text[end] === "(") depth++
      else if (text[end] === ")") depth--
    }
    if (/^\s*\{/u.test(text.slice(end, end + 4))) continue
    found.push({ call: `${match[2]}(${text.slice(match.index + match[0].length, end - 1).replace(/\s+/gu, " ").trim()})`, line: text.slice(0, match.index).split("\n").length })
  }
  return found
}

test("every child process start in Desk and Crew hides its console window on Windows", () => {
  const files = ROOTS.flatMap((root) => sources(root)).filter((file) => !SKIPPED_FILES.has(file))
  assert.ok(files.length > 100, `scanned ${files.length} files`)
  const missing = []
  let checked = 0
  for (const file of files) {
    for (const { call, line } of starts(withoutComments(readFileSync(path.join(REPO, file), "utf8")))) {
      if (NOT_A_START.has(`${file} ${call}`) || NOT_A_START_NAME.test(call.slice(0, call.indexOf("(")))) continue
      checked++
      if (!/windowsHide:\s*true/u.test(call)) missing.push(`${file}:${line} ${call.slice(0, 120)}`)
    }
  }
  assert.ok(checked > 50, `checked ${checked} calls`)
  assert.deepEqual(missing, [], "add windowsHide: true to these calls")
})

test("the scan finds a start without windowsHide and ignores comments and definitions", () => {
  const text = withoutComments("// spawn(a, b)\nfunction spawnGit(a) {}\nspawnSync(git, ['x'], { encoding: 'utf8' })\nexecFile(git, [], { windowsHide: true })\n")
  assert.deepEqual(starts(text).map(({ call, line }) => [line, /windowsHide/u.test(call)]), [[3, false], [4, true]])
})

test("the scan finds aliases in any letter case and exec, but not a RegExp's exec", () => {
  const text = "nodeSpawn(a)\nnodeSpawnSync(a)\nexec('ls')\nchildProcess.exec('ls')\n/x/u.exec(s)\npattern.exec(s)\nitems.forEach(f)\nNodeExecFile(a)\n"
  assert.deepEqual(starts(text).map(({ call, line }) => [line, call.slice(0, call.indexOf("("))]), [[1, "nodeSpawn"], [2, "nodeSpawnSync"], [3, "exec"], [4, "exec"], [8, "NodeExecFile"]])
})
