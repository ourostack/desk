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
// the file sits next to it. The names never leave this folder, which the script
// refuses to place inside a Git work tree or the factory's own state folder.
// Everything is fetched before anything is written, and the folder is replaced
// in one rename. Refuses, naming the reason, whenever a job ID cannot be derived
// exactly as the factory does. Then serves the folder on 127.0.0.1 only (a page
// opened from a file path cannot fetch its data), prints the URL and serves
// until Ctrl-C (an agent runs it in the background). Crew desks (`desks/<alias>`) are not mapped.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
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
// The files the store deploys: ourostack/factory `.github/workflows/pages.yml` (the `cp` of site/src and the built data.json), plus health.json.
export const SITE_FILES = ["index.html", "styles.css", "app.js", "format.js", "data.json", "health.json"]
const FETCH_TIMEOUT_MS = 30000
const TYPES = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8" }

const folders = (dir) => readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)

/** The folder the private view lives in, under the state home. */
export function viewDir(env) {
  const home = env.HOME?.trim() || os.homedir()
  const state = env.XDG_STATE_HOME?.trim() ? path.resolve(env.XDG_STATE_HOME) : path.join(home, ".local", "state")
  return path.join(state, "desk-private-view", "factory")
}

// `target` with the real path of its nearest existing ancestor, so a symlinked parent cannot hide where it lands.
function resolved(target) {
  const rest = []
  let current = target
  while (!existsSync(current)) {
    rest.unshift(path.basename(current))
    current = path.dirname(current)
  }
  return path.join(realpathSync(current), ...rest)
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep)

/** Refuses a folder that is a symlink, inside a Git work tree, or inside the factory's state folder. */
export function checkViewDir(dir, env) {
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`private-view: ${dir} is a symbolic link; remove it and run again`)
  const real = resolved(dir)
  if (inside(real, resolved(factoryStateDir(env)))) throw new Error(`private-view: ${dir} is inside the factory's state folder`)
  for (let up = real; up !== path.dirname(up); up = path.dirname(up)) {
    if (existsSync(path.join(up, ".git"))) throw new Error(`private-view: ${dir} is inside the Git work tree ${up}`)
  }
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
  for (const track of folders(root).filter((name) => !name.startsWith("_") && !name.startsWith(".") && name !== "desks")) {
    const trackDir = path.join(root, track)
    const archive = existsSync(path.join(trackDir, "_archive")) ? folders(path.join(trackDir, "_archive")).map((name) => ["_archive", name]) : []
    for (const [sub, slug] of [...folders(trackDir).map((name) => ["", name]), ...archive]) {
      if (slug.startsWith("_") || slug.startsWith(".")) continue
      const card = path.join(trackDir, sub, slug, "task.md")
      if (!existsSync(card)) continue
      let plain
      try {
        const birth = resolveJobIdentity({ deskRoot: root, track, slug })
        plain = jobId({ deskRemote, personPrefix: "", track: birth.track, slug: birth.slug })
      } catch (error) {
        throw new Error(`private-view: the job ID of ${track}/${slug} cannot be derived (${error.message})`)
      }
      const title = parseFrontmatterLite(readFileSync(card, "utf8")).data.title
      jobs[known ? plain : keyedJobId(plain, secret)] = { title: typeof title === "string" && title !== "" ? title : slug, track, task: slug }
    }
  }
  return jobs
}

const fetchText = (url) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${url}: ${res.status}`))))

/** Serves `dir` on 127.0.0.1 at a free port: GET of the site files and `local-names.json` only. Resolves `{ server, url }`. */
export function serve(dir) {
  const known = new Set([...SITE_FILES, "local-names.json"])
  const server = createServer((req, res) => {
    const name = req.url === "/" ? "index.html" : req.url.slice(1)
    // Only the loopback names answer, so a page that rebinds a DNS name to this port cannot read the names.
    const port = server.address().port
    let body = null
    if (req.method === "GET" && known.has(name) && [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
      try {
        body = readFileSync(path.join(dir, name))
      } catch {
        body = null
      }
    }
    if (body === null) res.writeHead(404).end("not found")
    else res.writeHead(200, { "content-type": TYPES[name.split(".").pop()], "cache-control": "no-store" }).end(body)
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })))
}

/** Builds the view, then serves it. Resolves `{ server, url }`. */
export async function main({ env, fetchFile = fetchText, log }) {
  const { root, error } = resolveHookDeskRoot({ env })
  if (root === null) throw new Error(`private-view: no desk is bound on this machine (${error})`)
  const real = realpathSync(root)
  const dir = viewDir(env)
  checkViewDir(dir, env)
  const jobs = await taskNames({ root: real, env })
  if (existsSync(path.join(real, "desks"))) log("private-view: crew desks (desks/) are not mapped")
  const files = await Promise.all(SITE_FILES.map(async (name) => [name, await fetchFile(SITE + name)]))
  files.push(["local-names.json", `${JSON.stringify({ version: 1, jobs })}\n`])
  mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 })
  for (const leftover of readdirSync(path.dirname(dir))) {
    if (leftover.startsWith(`${path.basename(dir)}.tmp-`)) rmSync(path.join(path.dirname(dir), leftover), { recursive: true, force: true })
  }
  const temporary = mkdtempSync(`${dir}.tmp-`)
  try {
    for (const [name, text] of files) writeFileSync(path.join(temporary, name), text, { mode: 0o600 })
    rmSync(dir, { recursive: true, force: true })
    renameSync(temporary, dir)
  } catch (failure) {
    rmSync(temporary, { recursive: true, force: true })
    throw failure
  }
  return serve(dir)
}

/** Runs `main` when this module is the entry point; the server keeps the process alive until Ctrl-C. */
export async function runIfMain(importMetaUrl, argv1, run = main) {
  if (typeof argv1 !== "string" || importMetaUrl !== pathToFileURL(argv1).href) return false
  try {
    process.stdout.write(`${(await run({ env: process.env, log: (line) => process.stdout.write(`${line}\n`) })).url}\n`)
    process.stdout.write("Serving until Ctrl-C: an agent should run this command in the background and read the URL above.\n")
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
  return true
}

await runIfMain(import.meta.url, process.argv[1])
