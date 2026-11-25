// CI-only consumer probe on the released Desk 3.2.552 tree. Synthetic registered personal and Crew desks, roster member, published content-home policy.
// It drives the supported entrypoint (scripts/local-recovery.js -> bootstrap.cjs -> index.js) and prints every raw report. No live Crew, store or account.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

const repo = realpathSync(path.resolve(import.meta.dirname, "../../.."))
const script = path.join(repo, "plugins/desk/mcp/scripts/local-recovery.js")
const sandbox = realpathSync(mkdtempSync(path.join(os.tmpdir(), "consumer-")))
const home = path.join(sandbox, "home")
mkdirSync(home, { recursive: true })
const ident = { GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ident } })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}
const POLICY = { schema_version: 1, mode: "declared-purpose", repository: "sample/context", context_purposes: ["coordination", "project-plan", "metadata", "source-context", "historical-evidence", "migration-pointer"], product_purposes: ["product-contract", "product-tool", "product-run-artifact"] }
const CARD = "---\nschema_version: 1\ntitle: Work\nstatus: drafting\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Work\n\n**Next step:** Start.\n"

function desk(name, { roster = false } = {}) {
  const root = path.join(sandbox, name)
  mkdirSync(path.join(root, ".desk"), { recursive: true })
  writeFileSync(path.join(root, ".desk/content-home.json"), JSON.stringify(POLICY))
  const base = roster ? path.join(root, "desks/ari") : root
  mkdirSync(path.join(base, "t/work"), { recursive: true })
  writeFileSync(path.join(base, "t/work/task.md"), CARD)
  if (roster) {
    mkdirSync(path.join(root, "_meta"), { recursive: true })
    writeFileSync(path.join(root, "_meta/desks.md"), "| alias | identity | path |\n|---|---|---|\n| ari | ari_microsoft | desks/ari |\n")
  }
  git(root, "init", "-q", "-b", "main")
  git(root, "add", "-A")
  git(root, "commit", "-qm", "seed")
  git(root, "remote", "add", "origin", "https://github.com/sample/context.git")
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
  git(root, "config", "branch.main.remote", "origin")
  git(root, "config", "branch.main.merge", "refs/heads/main")
  return { root, card: path.join(base, "t/work/task.md"), log: path.join(base, "t/work/log.md") }
}
const personal = desk("personal")
const crew = desk("crew", { roster: true })
const registry = path.join(home, "desks.md")
writeFileSync(registry, `| desk | local path | repo |\n|---|---|---|\n| solo | ${personal.root} | sample/personal |\n\n| crew | local path | repo |\n|---|---|---|\n| team | ${crew.root} | sample/team |\n`)

function activation(root) {
  const file = path.join(sandbox, `activation-${path.basename(root)}.json`)
  writeFileSync(file, JSON.stringify({ schema_version: 1, desk: { root }, desk_runtime: { root: "workspace", write_authority: "workspace", lexical: "required", semantic: "unsupported" } }))
  return file
}
const sha = (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null)
const snap = (d) => ({ head: git(d.root, "rev-parse", "HEAD"), status: git(d.root, "status", "--porcelain"), card: sha(d.card), log: sha(d.log) })

const results = []
function run(label, rootDesk, input, { person = true, extraEnv = {} } = {}) {
  const before = { personal: snap(personal), crew: snap(crew) }
  const file = path.join(sandbox, `input-${results.length}.json`)
  writeFileSync(file, JSON.stringify(input))
  const args = [script, "--root", rootDesk.root, "--operation", "task_update", "--activation-config", activation(rootDesk.root), "--input-file", file]
  if (person) args.push("--person", "ari")
  const started = Date.now()
  const r = spawnSync(process.execPath, args, {
    cwd: rootDesk.root, encoding: "utf8", timeout: 100000,
    env: { ...process.env, ...ident, HOME: home, USERPROFILE: home, DESK_REGISTRY: registry, ...(person ? { DESK_PERSON: "ari" } : { DESK_PERSON: "ari" }), ...extraEnv, XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"), XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data") },
  })
  let report = null
  try { report = JSON.parse(r.stdout) } catch {}
  const after = { personal: snap(personal), crew: snap(crew) }
  const entry = { label, input, exit: r.status, ms: Date.now() - started, result: report?.result ?? null, effects: report?.effects ?? null, before, after }
  results.push(entry)
  console.log(`\n=== ${label} ===\nexit=${r.status} ms=${entry.ms}\n${JSON.stringify({ before, after }, null, 1)}\nstdout:\n${r.stdout}\nstderr(len ${r.stderr.length}):\n${r.stderr.slice(0, 1500)}`)
  return entry
}

console.log(`release=${git(repo, "rev-parse", "HEAD")} platform=${process.platform} node=${process.version} git=${spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim()}`)
console.log(`local-recovery.js sha256=${sha(script)}`)

const LOG = "- progress entry from the consumer probe"
const CH = { purpose: "coordination", lifecycle: "current" }
// The bound session is a solo personal desk (no --person); the card is in a registered Crew desk, written as the member this machine's sign-in resolves (DESK_PERSON stands in for the sign-in).
const viaDesk = { person: false }
run("B refusal atomicity: Crew card status change via `desk` without content_home", personal, { desk: "team", track: "t", slug: "work", status: "processing" }, viaDesk)
run("G ordinary: Crew card status change via `desk` with content_home commits as the member", personal, { desk: "team", track: "t", slug: "work", status: "processing", note: "ordinary write", content_home: CH }, viaDesk)
run("F non-member sign-in is refused before any write", personal, { desk: "team", track: "t", slug: "work", note: "x", content_home: CH }, { person: false, extraEnv: { DESK_PERSON: "", DESK_IDENTITY: "nobody" } })
run("E unregistered desk refused", personal, { desk: "nowhere", track: "t", slug: "work", log: LOG }, viaDesk)
run("A ordinary: Crew card log-only via `desk` (content_home defaulted)", personal, { desk: "team", track: "t", slug: "work", log: LOG }, viaDesk)
run("C recovery: log-only on the Crew desk itself as its member", crew, { track: "t", slug: "work", log: LOG })
run("D recovery: log + status mixed on the Crew desk (content_home still required)", crew, { track: "t", slug: "work", status: "processing", log: LOG })

console.log("\n=== SUMMARY ===")
for (const r of results) console.log(`${r.label}\n  exit=${r.exit} result=${r.result ? `${r.result.status}/${r.result.code ?? ""}` : "none"} crewHead ${r.before.crew.head.slice(0, 8)}->${r.after.crew.head.slice(0, 8)} personalHead ${r.before.personal.head.slice(0, 8)}->${r.after.personal.head.slice(0, 8)}`)
