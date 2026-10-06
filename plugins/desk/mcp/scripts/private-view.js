#!/usr/bin/env node
// A private, local copy of the factory site that shows this desk's real task names.
//
//   node scripts/private-view.js
//
// Copies the published site (https://ourostack.github.io/factory/) into
// `<state home>/desk-private-view/factory/` (folder 0700), then writes
// `local-names.json` beside it (0600): for every task on the bound desk, the
// job ID the factory publishes it under (`binding.js` `jobId`, with the same
// renamed-card and visibility rules as `factory.js job-link --this-machine`)
// mapped to the task's title, track and slug. The page shows those names when
// the file sits next to it. The names never leave this folder, which is outside
// every Git checkout and outside the factory's own state folder. Refuses, naming
// the reason, whenever a job ID cannot be derived exactly as the factory does.
// Prints the path of the page.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, chmodSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { jobId } from "../src/factory/binding.js"
import { factoryStateDir } from "../src/factory/boot-check.js"
import { readDeskRemote, resolveJobIdentity } from "../src/factory/desk-repo.js"
import { publishedJobId } from "../src/factory/local-status.js"
import { readMachineSecret } from "../src/factory/outbox.js"
import { keyedJobId } from "../src/factory/publish.js"
import { parseFrontmatterLite } from "../src/desk/frontmatter-lite.js"
import { resolveHookDeskRoot } from "./resolve-desk-root.js"

export const SITE = "https://ourostack.github.io/factory/"
const SITE_FILES = ["index.html", "styles.css", "app.js", "format.js", "data.json"]

const folders = (dir) => readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)

/** The folder the private view lives in, under the state home and outside the factory's state folder. */
export function viewDir(env) {
  const home = env.HOME?.trim() || os.homedir()
  const state = env.XDG_STATE_HOME?.trim() ? path.resolve(env.XDG_STATE_HOME) : path.join(home, ".local", "state")
  return path.join(state, "desk-private-view", "factory")
}

/** `{ <job ID>: { title, track, task } }` for every task folder, current and archived, of the desk at `root`. */
export async function taskNames({ root, env }) {
  const deskRemote = readDeskRemote({ deskRoot: root }) || `local:${root}`
  const published = publishedJobId({ env, deskRemote, job: "0".repeat(32) })
  if (published.reason === "visibility_not_known") throw new Error("private-view: this desk's visibility is not known yet, so its job IDs cannot be derived; run a factory flush first")
  const known = published.job !== null
  const secretFile = path.join(factoryStateDir(env), "machine-secret")
  if (!known && !existsSync(secretFile)) throw new Error("private-view: this desk's job IDs are keyed with this machine's secret, which does not exist yet; run a factory flush first")
  const secret = known ? null : await readMachineSecret(env)
  const jobs = {}
  for (const track of folders(root).filter((name) => !name.startsWith("_") && !name.startsWith("."))) {
    const trackDir = path.join(root, track)
    const archive = existsSync(path.join(trackDir, "_archive")) ? folders(path.join(trackDir, "_archive")).map((name) => ["_archive", name]) : []
    for (const [sub, slug] of [...folders(trackDir).map((name) => ["", name]), ...archive]) {
      if (slug.startsWith("_") || slug.startsWith(".")) continue
      const card = path.join(trackDir, sub, slug, "task.md")
      if (!existsSync(card)) continue
      const birth = resolveJobIdentity({ deskRoot: root, track, slug })
      const plain = jobId({ deskRemote, personPrefix: "", track: birth.track, slug: birth.slug })
      const title = parseFrontmatterLite(readFileSync(card, "utf8")).data.title
      jobs[known ? plain : keyedJobId(plain, secret)] = { title: typeof title === "string" && title !== "" ? title : slug, track, task: slug }
    }
  }
  return jobs
}

/** Builds the view and returns the path of its page. */
export async function main({ env = process.env, fetchFile = (url) => fetch(url).then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${url}: ${res.status}`)))), write = (text) => process.stdout.write(text) } = {}) {
  const { root, error } = resolveHookDeskRoot({ env })
  if (root === null) throw new Error(`private-view: no desk is bound on this machine (${error})`)
  const dir = viewDir(env)
  const jobs = await taskNames({ root: realpathSync(root), env })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  for (const name of SITE_FILES) writeFileSync(path.join(dir, name), await fetchFile(SITE + name), { mode: 0o600 })
  const names = path.join(dir, "local-names.json")
  writeFileSync(names, `${JSON.stringify({ version: 1, jobs })}\n`, { mode: 0o600 })
  chmodSync(names, 0o600)
  write(`${path.join(dir, "index.html")}\n`)
  return 0
}

/** Runs `main` when this module is the entry point. */
export async function runIfMain(importMetaUrl, argv1, run = main) {
  if (typeof argv1 !== "string" || importMetaUrl !== pathToFileURL(argv1).href) return false
  try {
    process.exitCode = await run()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
  return true
}

await runIfMain(import.meta.url, process.argv[1])
