// The throwaway world one host session runs in: an installed plugin set laid out the way the host installs it, a synthetic
// person's home, and a small Git desk with a local bare remote. Nothing here reads or writes the real home or desk.

import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const WINDOWS = process.platform === "win32"
export const PLUGINS = ["desk", "superpowers", "plain-language", "crew"]

/** Files a host would install from a plugin folder: what Git tracks there, or everything but node_modules outside a checkout. */
function shippedFiles(source) {
  const listed = spawnSync("git", ["ls-files", "-z", "--", "."], { cwd: source, encoding: "utf8", windowsHide: true })
  if (listed.status === 0 && listed.stdout.length > 0) return listed.stdout.split("\0").filter(Boolean)
  const files = []
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else files.push(rel)
    }
  }
  walk(source, "")
  return files
}

function copyPlugin(source, target) {
  for (const rel of shippedFiles(source)) {
    const from = path.join(source, rel)
    if (!fs.existsSync(from)) continue
    const to = path.join(target, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    if (!WINDOWS) fs.chmodSync(to, fs.statSync(from).mode)
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))

/**
 * Install the plugin set for one host under `home`, where that host keeps installed plugins:
 * Claude Code under ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>, Copilot under ~/.copilot/installed-plugins/<marketplace>/<plugin>.
 */
export function installPlugins({ host, home, pluginsSource }) {
  const roots = {}
  for (const name of PLUGINS) {
    const source = path.join(pluginsSource, name)
    const version = readJson(path.join(source, "plugin.json")).version
    const target = host === "claude"
      ? path.join(home, ".claude", "plugins", "cache", "ourostack", name, version)
      : path.join(home, ".copilot", "installed-plugins", "ourostack", name)
    copyPlugin(source, target)
    roots[name] = target
  }
  return roots
}

/** The environment a person's shell gives a host: their home, PATH with Node and Git, and on Windows the system variables. */
export function personEnv(home) {
  const nodeDir = path.dirname(process.execPath)
  const base = {
    PATH: [nodeDir, ...String(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean).join(path.delimiter),
    LANG: "en_US.UTF-8",
  }
  if (process.env.TMPDIR) base.TMPDIR = process.env.TMPDIR
  if (WINDOWS) {
    for (const name of ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "PSModulePath", "PSModuleAnalysisCachePath", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]) {
      const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
      if (key !== undefined) base[name] = process.env[key]
    }
    Object.assign(base, {
      USERPROFILE: home,
      HOMEDRIVE: path.parse(home).root.replace(/\\$/u, ""),
      HOMEPATH: home.slice(path.parse(home).root.length - 1),
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
    })
    fs.mkdirSync(base.APPDATA, { recursive: true })
    fs.mkdirSync(base.LOCALAPPDATA, { recursive: true })
  } else {
    base.HOME = home
  }
  return base
}

export function git(cwd, args, env) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim()
}

// Seed documents the tools did not write, so search, recall and the timeline have something to find.
const SEED = {
  "AGENTS.md": "# Desk Instructions\n\nThis is a synthetic desk for Desk's black-box tester.\n",
  "_meta/friction.md": "# Friction\n\n",
  "_meta/tips/README.md": "# Tips\n",
  "_archive/README.md": "# Archive\n",
}

// Notes an agent writes into a track and saves with desk_save; the corpus meaning-based search must rank.
export const NOTES = {
  "gardening.md": "# Garden notes\n\nThe tomatoes need watering every morning, and the basil grows best in full sun beside the fence.\n",
  "travel.md": "# Travel plan\n\nBook the train to Lisbon in spring; pack light and keep the passport in the blue folder.\n",
  "kitchen.md": "# Kitchen\n\nThe sourdough starter is fed twice a day with flour and water and kept on the warm shelf.\n",
}

/** A Git desk with a bare remote, seeded and pushed; returns its paths. */
export function makeDesk({ root, env }) {
  const desk = path.join(root, "desk")
  const remote = path.join(root, "remote.git")
  fs.mkdirSync(desk, { recursive: true })
  git(root, ["init", "-q", "--bare", "-b", "main", remote], env)
  git(desk, ["init", "-q", "-b", "main"], env)
  for (const [rel, text] of Object.entries(SEED)) {
    const file = path.join(desk, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  git(desk, ["add", "-A"], env)
  git(desk, ["commit", "-q", "-m", "Seed the synthetic desk"], env)
  git(desk, ["remote", "add", "origin", remote], env)
  git(desk, ["push", "-q", "-u", "origin", "main"], env)
  return { desk, remote }
}

/** A person's home: Git identity and the default branch Desk expects. */
export function makeHome(root) {
  const home = path.join(root, "home")
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Blackbox Tester\n\temail = blackbox@example.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n")
  return home
}

/** Desk's state folder for a person, the way Desk finds it with no XDG variables set. */
export function deskStateDir(home) {
  return path.join(home, ".local", "state", "ouroboros-skills", "desk")
}

export function copyTree(from, to) {
  if (!fs.existsSync(from)) return false
  fs.cpSync(from, to, { recursive: true, force: true })
  return true
}

export function makeTempRoot() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "desk-blackbox-"))
}
