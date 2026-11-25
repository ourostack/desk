// CI-only consumer probe on the released Desk 3.2.552 tree. Synthetic registered personal and Crew desks, roster member, published content-home policy.
// It drives the supported entrypoint (scripts/local-recovery.js -> bootstrap.cjs -> index.js) and prints every raw report. No live Crew, store or account.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { readdirSync, statSync } from "node:fs"

const repo = realpathSync(path.resolve(import.meta.dirname, "../../.."))
const script = path.join(repo, "plugins/desk/mcp/scripts/local-recovery.js")
const sandbox = realpathSync(mkdtempSync(path.join(os.tmpdir(), "consumer-")))
const home = path.join(sandbox, "home")
mkdirSync(home, { recursive: true })
const SEAL_KEYS = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "windir", "COMSPEC", "ComSpec", "TEMP", "TMP", "TMPDIR"]
const sealed = Object.fromEntries(SEAL_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))
const originsDir = path.join(sandbox, "origins")
mkdirSync(originsDir, { recursive: true })
const gitconfig = path.join(home, "gitconfig")
// Any https://github.com/ remote is rewritten to a file path that cannot exist, so nothing reaches the network.
writeFileSync(gitconfig, `[url "${pathToFileURL(path.join(sandbox, "blocked")).href}/"]\n\tinsteadOf = https://github.com/\n`)
const sealEnv = { ...sealed, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata"), GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"), XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data") }
const ident = { GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...sealEnv, ...ident } })
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
  mkdirSync(path.join(base, "zq9/work"), { recursive: true })
  writeFileSync(path.join(base, "zq9/work/task.md"), CARD)
  if (roster) {
    mkdirSync(path.join(root, "_meta"), { recursive: true })
    writeFileSync(path.join(root, "_meta/desks.md"), "| alias | identity | path |\n|---|---|---|\n| ari | ari_microsoft | desks/ari |\n")
  }
  git(root, "init", "-q", "-b", "main")
  git(root, "add", "-A")
  git(root, "commit", "-qm", "seed")
  const bare = path.join(originsDir, `${name}.git`)
  git(sandbox, "init", "-q", "--bare", "-b", "main", bare)
  git(root, "remote", "add", "origin", "https://github.com/sample/context.git")
  git(root, "config", `url.${pathToFileURL(bare).href}.insteadOf`, "https://github.com/sample/context.git")
  git(root, "push", "-q", "origin", "main")
  git(root, "fetch", "-q", "origin")
  git(root, "config", "branch.main.remote", "origin")
  git(root, "config", "branch.main.merge", "refs/heads/main")
  return { root, card: path.join(base, "zq9/work/task.md"), log: path.join(base, "zq9/work/log.md") }
}
let personal, crew, count = 0
const registry = path.join(home, "desks.md")
function fresh() {
  count += 1
  personal = desk(`personal-${count}`)
  crew = desk(`crew-${count}`, { roster: true })
  writeFileSync(registry, `| desk | local path | repo |\n|---|---|---|\n| solo | ${personal.root} | sample/personal |\n\n| crew | local path | repo |\n|---|---|---|\n| team | ${crew.root} | sample/team |\n`)
}

function activation(root) {
  const file = path.join(sandbox, `activation-${path.basename(root)}.json`)
  writeFileSync(file, JSON.stringify({ schema_version: 1, desk: { root }, desk_runtime: { root: "workspace", write_authority: "workspace", lexical: "required", semantic: "unsupported" } }))
  return file
}
const sha = (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null)
function treeHash(root) {
  const h = createHash("sha256")
  const walk = (dir) => {
    for (const e of readdirSync(dir).sort()) {
      if (e === ".git") continue
      const f = path.join(dir, e)
      if (statSync(f).isDirectory()) walk(f)
      else h.update(path.relative(root, f).split(path.sep).join("/") + "\0").update(readFileSync(f)).update("\0")
    }
  }
  walk(root)
  return h.digest("hex")
}
const snap = (d) => ({ head: git(d.root, "rev-parse", "HEAD"), origin: git(d.root, "rev-parse", "refs/remotes/origin/main"), status: git(d.root, "status", "--porcelain"), tree: treeHash(d.root), card: sha(d.card), log: sha(d.log) })

const failures = []
let checks = 0
function check(label, cond, detail) {
  checks += 1
  if (!cond) { failures.push(`${label}: ${detail ?? "assertion failed"}`); console.log(`ASSERT FAIL ${label}: ${detail ?? ""}`) } else console.log(`assert ok   ${label}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function run(label, which, input, { person = true, extraEnv = {} } = {}) {
  fresh()
  const rootDesk = which === "crew" ? crew : personal
  const before = { personal: snap(personal), crew: snap(crew) }
  const file = path.join(sandbox, `input-${count}.json`)
  writeFileSync(file, JSON.stringify(input))
  const args = [script, "--root", rootDesk.root, "--operation", "task_update", "--activation-config", activation(rootDesk.root), "--input-file", file]
  if (person) args.push("--person", "ari")
  const started = Date.now()
  const r = spawnSync(process.execPath, args, { cwd: rootDesk.root, encoding: "utf8", timeout: 100000, env: { ...sealEnv, ...ident, DESK_REGISTRY: registry, DESK_PERSON: "ari", ...extraEnv } })
  let report = null
  let parseError = null
  try { report = JSON.parse(r.stdout) } catch (e) { parseError = String(e) }
  const after = { personal: snap(personal), crew: snap(crew) }
  console.log(`\n=== ${label} ===\nexit=${r.status} ms=${Date.now() - started}\n${JSON.stringify({ before, after }, null, 1)}\nstdout:\n${r.stdout}\nstderr(len ${r.stderr.length}):\n${r.stderr.slice(0, 1500)}`)
  check(`${label}: stdout is one JSON report`, report !== null, parseError)
  check(`${label}: exit 2 (partial or not-ok, never 0 without observation)`, r.status === 2, `exit=${r.status}`)
  return { report: report ?? {}, before, after, stdout: r.stdout, crew, personal }
}
const refused = (label, e, code) => {
  check(`${label}: refusal code`, e.stdout.includes(code), `missing ${code}`)
  check(`${label}: both desks byte-identical (head, origin, status, tree, card, log)`, same(e.before, e.after), "desk state changed")
}

console.log(`release=${git(repo, "rev-parse", "HEAD")} platform=${process.platform} node=${process.version} git=${spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim()}`)
console.log(`local-recovery.js sha256=${sha(script)}`)
check("product bytes are the accepted 3.2.552 runtime", sha(script) === "625b9b3ac520c44a416ff4a65f8519bc56f69701705f57a8a53fd195a4229c31", sha(script))

const LOG = "- progress entry from the consumer probe"
const CH = { purpose: "coordination", lifecycle: "current" }
const viaDesk = { person: false }
const MEMBER_CARD = "desks/ari/zq9/work/task.md"
const MEMBER_LOG = "desks/ari/zq9/work/log.md"

let e = run("B refusal atomicity: Crew status change via `desk` without content_home", "personal", { desk: "team", track: "zq9", slug: "work", status: "processing" }, viaDesk)
check("B: tool_error", e.report.code === "tool_error" && e.report.result?.status === "error", e.report.code)
check("B: content_home_required and nothing written", e.stdout.includes("content_home_required") && e.stdout.includes("nothing was written"), "missing")
refused("B", e, "content_home_required")

e = run("G ordinary: Crew status change via `desk` with declared content_home commits as the member", "personal", { desk: "team", track: "zq9", slug: "work", status: "processing", note: "ordinary write", content_home: CH }, viaDesk)
check("G: tool updated, member path, commit returned", e.report.result?.status === "updated" && typeof e.report.result?.desk_commit === "string" && String(e.report.result?.path).startsWith("desks/ari/"), JSON.stringify(e.report.result?.path))
check("G: admission subjects status+note", same(Object.keys(e.report.result?.content_admission?.subjects ?? {}).sort(), ["note", "status"]), "subjects")
check("G: Crew HEAD advanced by one commit", e.after.crew.head !== e.before.crew.head && git(e.crew.root, "rev-list", "--count", `${e.before.crew.head}..HEAD`) === "1", "head")
check("G: commit touched only the member card", git(e.crew.root, "diff", "--name-only", `${e.before.crew.head}..HEAD`) === MEMBER_CARD, git(e.crew.root, "diff", "--name-only", `${e.before.crew.head}..HEAD`))
const gCard = readFileSync(e.crew.card, "utf8")
check("G: card bytes carry status and note", /^status: processing$/m.test(gCard.replace(/\r/g, "")) && gCard.includes("ordinary write"), gCard)
check("G: bound personal desk untouched", same(e.before.personal, e.after.personal), "personal changed")
check("G: receipt is conservative partial/commit_not_observed (cross-desk readback not followed)", e.report.status === "partial" && e.report.code === "commit_not_observed", `${e.report.status}/${e.report.code}`)

e = run("F non-member sign-in refused before any write", "personal", { desk: "team", track: "zq9", slug: "work", note: "x", content_home: CH }, { person: false, extraEnv: { DESK_PERSON: "", DESK_IDENTITY: "nobody" } })
refused("F", e, "card_tool_desk_not_registered")

e = run("E unregistered desk refused", "personal", { desk: "nowhere", track: "zq9", slug: "work", log: LOG }, viaDesk)
refused("E", e, "card_tool_desk_not_registered")

function logOnly(tag, e, exposesRoot) {
  check(`${tag}: tool logged, commit queued, defaulted content_home admission (log subject only)`, e.report.result?.status === "logged" && e.report.result?.commit === "queued" && same(Object.keys(e.report.result?.content_admission?.subjects ?? {}), ["log"]), JSON.stringify(e.report.result))
  const bytes = existsSync(e.crew.log) ? readFileSync(e.crew.log, "utf8") : ""
  check(`${tag}: log bytes in the member's card folder carry the entry`, bytes.includes(LOG), bytes)
  check(`${tag}: queued at exit = not yet committed (HEAD unchanged, log untracked, card unchanged)`, e.after.crew.head === e.before.crew.head && e.after.crew.status === `?? ${MEMBER_LOG}` && e.after.crew.card === e.before.crew.card, e.after.crew.status)
  check(`${tag}: bound personal desk untouched`, same(e.before.personal, e.after.personal), "personal changed")
  return bytes
}
e = run("A ordinary: Crew log-only via `desk` (content_home defaulted)", "personal", { desk: "team", track: "zq9", slug: "work", log: LOG }, viaDesk)
logOnly("A", e)
check("A: tool returned desk_root; receipt conservative partial/log_evidence_unknown", typeof e.report.result?.desk_root === "string" && e.report.status === "partial" && e.report.code === "log_evidence_unknown", `${e.report.status}/${e.report.code}`)

e = run("C recovery: log-only on the Crew desk itself as its member", "crew", { track: "zq9", slug: "work", log: LOG })
logOnly("C", e)
check("C: receipt partial/commit_queued, effects commit queued, person scope desks/ari", e.report.status === "partial" && e.report.code === "commit_queued" && e.report.effects?.commit === "queued" && e.report.preflight?.writeScope?.person === "ari" && e.report.preflight?.writeScope?.relative_path === "desks/ari", `${e.report.status}/${e.report.code}`)

e = run("D recovery: log + status mixed on the Crew desk (content_home required)", "crew", { track: "zq9", slug: "work", status: "processing", log: LOG })
refused("D", e, "content_home_required")

console.log(`\n=== SUMMARY === checks=${checks} failures=${failures.length}`)
for (const f of failures) console.log(`FAIL ${f}`)
process.exit(failures.length ? 1 : 0)
