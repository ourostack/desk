// Shared initiatives in a Crew workspace, one deterministic step each: `new` makes `_shared/tracks/<slug>/README.md` from
// the card template, `adopt` moves an existing document or folder into its own `_shared/tracks/<slug>/` with a card, and
// `check` reports whatever under `_shared/tracks/` is not laid out that way, leading with the command that fixes it.
//
// These write the working tree only. Publishing is the shared-path protocol's job (branch, pull request, merge), so
// nothing is committed here and a caller in any worktree gets the same result.

import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { crewWorkspace } from "../desk/crew-roster.js"

export const TRACKS = "_shared/tracks"
// A card is the file a folder's reader opens first. README.md is the layout; the older names are accepted because an
// existing initiative is reused as it is, never given a second card.
const CARD_NAMES = ["readme.md", "track.md", "index.md"]
const SLUG_MAX = 64
const EVIDENCE_LIMIT = 20

// Keep in step with plugins/crew/skills/shared-initiative/template.md; a test compares them.
export const CARD_TEMPLATE = `# <Initiative name>

## Outcome and scope

<Desired outcome, boundaries and request source.>

## Current focus

<Date>: <focus, blockers and next action; name the source or live check.>

## Contributors and work

| Person | Contribution and work link | Commitment and source |
|---|---|---|
| <Name, or unknown> | <Link to existing task/artifact; no task copy> | <Confirmed, proposed or unknown; source> |

## Open questions

- <Question; who can answer if known, source.>

## Proposals and perspectives

- <Author, date, source>: <view and uncertainty; label agent synthesis.>

## Decisions

No decision recorded.

## Evidence

- <Primary source link and what it supports.>
`

const NOT_CREW = "This repository is not a Crew workspace, so there are no shared initiatives to make. Start a crew in it with crew:start-crew first."
const notGit = (repo) => `${repo} is not inside a Git clone. Run this from the workspace clone or pass --repo <clone>.`
const posix = (value) => value.split(path.sep).join("/")

export function slugify(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/u, "")
}

function titleOf(slug) {
  const words = slug.split("-").filter(Boolean).join(" ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function toplevel(repo) {
  const result = spawnSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" })
  return result.status === 0 ? path.resolve(result.stdout.trim()) : null
}

function kindOf(file) {
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) return "link"
    return stat.isDirectory() ? "dir" : "file"
  } catch {
    return null
  }
}

function cardIn(dir) {
  return readdirSync(dir).find((name) => CARD_NAMES.includes(name.toLowerCase()) && kindOf(path.join(dir, name)) === "file") ?? null
}

function command(crewScript, args) {
  const script = /\s/u.test(crewScript) ? `"${crewScript}"` : crewScript
  return `node ${script} initiative ${args}`
}

function quote(value) {
  return /\s/u.test(value) ? `"${value}"` : value
}

/** The first Markdown heading of a document, used to title its card. */
function headingOf(file) {
  if (!/\.(md|markdown)$/iu.test(file)) return null
  const match = readFileSync(file, "utf8").match(/^#\s+(.+?)\s*#*\s*$/mu)
  return match ? match[1].trim() : null
}

function renderCard({ title, date, evidence, note }) {
  const lines = evidence.map((entry) => `- [${entry}](${encodeURI(entry)}): ${note}`)
  return CARD_TEMPLATE
    .replace("# <Initiative name>", `# ${title}`)
    .replace(/^<Date>: .*$/mu, `${date}: Card created; outcome, focus and next action are not filled in yet.`)
    .replace(/^- <Primary source link and what it supports\.>$/mu, lines.length > 0 ? lines.join("\n") : "- <Primary source link and what it supports.>")
}

const placeholders = (text) => [...text.matchAll(/<[A-Z][^<>\n]*>/gu)].length

function context(repo, now) {
  const top = toplevel(repo)
  if (top === null) return { result: { state: "not_git", repo, message: notGit(repo) } }
  if (!crewWorkspace(top).crew) return { result: { state: "not_crew", repo: top, message: NOT_CREW } }
  return { top, date: new Date(now()).toISOString().slice(0, 10) }
}

function done(top, slug, parts) {
  const card = `${TRACKS}/${slug}/README.md`
  return { state: parts.state, repo: top, slug, card, ...parts.extra, message: parts.message }
}

const NEXT = "Next: fill in the <…> placeholders in the card (outcome, focus, contributors), link it from the workspace's front door if it has one, then publish it through the shared-path protocol: branch, pull request, merge. Nothing is committed yet."

/** Makes `_shared/tracks/<slug>/README.md` from the card template. */
export function newInitiative({ repo, slug: requested, title, now = Date.now }) {
  const base = context(repo, now)
  if (base.result) return base.result
  const slug = slugify(requested)
  if (slug === "") return { state: "refused", repo: base.top, message: "Give the initiative a short name, for example `initiative new reliability-checks`." }
  const dir = path.join(base.top, TRACKS, slug)
  if (kindOf(dir) !== null) {
    const card = kindOf(dir) === "dir" ? cardIn(dir) : null
    return { state: "exists", repo: base.top, slug, message: `${TRACKS}/${slug}/ already exists${card ? `; its card is ${TRACKS}/${slug}/${card}. Read it and contribute there, or pick another name` : ". Pick another name"}. Nothing changed.` }
  }
  mkdirSync(dir, { recursive: true })
  const text = renderCard({ title: title ?? titleOf(slug), date: base.date, evidence: [], note: "" })
  writeFileSync(path.join(dir, "README.md"), text)
  return done(base.top, slug, {
    state: "created",
    extra: { slug_changed: slug !== requested, placeholders: placeholders(text) },
    message: `Created ${TRACKS}/${slug}/README.md from the card template. ${NEXT}`,
  })
}

// Git sees a rename at commit time, so a move needs no `git mv`.
function moveInto(source, target, insideRepo) {
  mkdirSync(path.dirname(target), { recursive: true })
  if (!insideRepo) {
    cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
    return "copied"
  }
  renameSync(source, target)
  return "moved"
}

function listEvidence(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && !CARD_NAMES.includes(name.toLowerCase()))
    .sort()
    .slice(0, EVIDENCE_LIMIT)
}

function resolveSource(top, given) {
  const candidates = path.isAbsolute(given) ? [given] : [path.resolve(given), path.resolve(top, given)]
  return candidates.find((candidate) => kindOf(candidate) !== null) ?? null
}

/**
 * Brings an existing document or folder under `_shared/tracks/<slug>/` with a card, and keeps the original file beside it.
 * A source inside the workspace moves (with `git mv` when it is tracked); one outside it is copied and left in place.
 */
export function adoptInitiative({ repo, source: given, slug: requested, title, now = Date.now }) {
  const base = context(repo, now)
  if (base.result) return base.result
  const { top } = base
  if (typeof given !== "string" || given === "") return { state: "refused", repo: top, message: "Name the file or folder to adopt, for example `initiative adopt _shared/tracks/my-plan.md`." }
  const found = resolveSource(top, given)
  if (found === null) return { state: "refused", repo: top, message: `${given} does not exist. Check the path; nothing changed.` }
  if (kindOf(found) === "link") return { state: "refused", repo: top, message: `${given} is a symbolic link. Adopt the file it points to instead; nothing changed.` }
  const source = realpathSync(found)
  const tracks = path.join(top, TRACKS)
  const relative = path.relative(tracks, source)
  const insideTracks = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  const inGit = path.relative(top, source).split(path.sep).includes(".git")
  if (inGit || source === top || !path.relative(source, tracks).startsWith("..")) {
    return { state: "refused", repo: top, message: `${given} holds the whole of ${TRACKS}/ (or the repository). Name one file or folder to adopt; nothing changed.` }
  }
  const kind = kindOf(source)
  const [first, ...rest] = insideTracks ? posix(relative).split("/") : []
  if (insideTracks && rest.length > 0) {
    return { state: "refused", repo: top, message: `${given} is already inside ${TRACKS}/${first}/. Adopt that folder (\`${TRACKS}/${first}\`) or move this file by hand; nothing changed.` }
  }
  if (insideTracks && kind === "file" && first.toLowerCase() === "readme.md") {
    return { state: "refused", repo: top, message: `${TRACKS}/${first} is the index of all initiatives, not one of them; nothing changed.` }
  }

  const ownFolder = insideTracks && kind === "dir"
  const name = path.basename(source)
  const slug = ownFolder ? first : slugify(requested ?? (kind === "dir" ? name : path.basename(name, path.extname(name))))
  if (slug === "") return { state: "refused", repo: top, message: "Pass --slug <short-name>; the name could not be made into one." }
  const dir = path.join(top, TRACKS, slug)
  const moved = []
  let pointer = null

  if (!ownFolder) {
    const insideRepo = !path.relative(top, source).startsWith("..")
    if (kind === "dir") {
      if (kindOf(dir) !== null) return { state: "refused", repo: top, slug, message: `${TRACKS}/${slug}/ already exists. Pass --slug <another-name>, or adopt into it by hand; nothing changed.` }
      moved.push({ from: path.relative(top, source), to: `${TRACKS}/${slug}`, how: moveInto(source, dir, insideRepo) })
    } else {
      const target = path.join(dir, name)
      if (kindOf(target) !== null) return { state: "refused", repo: top, slug, message: `${TRACKS}/${slug}/${name} already exists. Pass --slug <another-name>; nothing changed.` }
      const existing = kindOf(dir)
      if (existing !== null && existing !== "dir") return { state: "refused", repo: top, slug, message: `${TRACKS}/${slug} is a file, not a folder. Pass --slug <another-name>; nothing changed.` }
      const from = insideRepo ? path.relative(top, source) : source
      const how = moveInto(source, target, insideRepo)
      moved.push({ from: posix(from), to: `${TRACKS}/${slug}/${name}`, how })
      if (how === "moved" && !insideTracks && /\.md$/iu.test(name)) {
        const link = posix(path.relative(path.dirname(source), target))
        writeFileSync(source, `Moved to [${slug}](${encodeURI(link)}), a shared initiative.\n`)
        pointer = posix(path.relative(top, source))
      }
    }
  }

  const card = cardIn(dir)
  const out = { moved: moved.map((entry) => ({ ...entry, from: posix(entry.from) })), ...(pointer === null ? {} : { pointer }) }
  if (card !== null) {
    return done(top, slug, {
      state: moved.length > 0 ? "adopted" : "exists",
      extra: { ...out, card: `${TRACKS}/${slug}/${card}` },
      message: `${moved.length > 0 ? `Moved ${posix(path.relative(top, source))} into ${TRACKS}/${slug}/. ` : ""}${TRACKS}/${slug}/${card} is already its card, so no card was added${moved.length > 0 ? "; add a link to the moved document there" : ". Nothing changed"}.`,
    })
  }
  const evidence = ownFolder || kind === "dir" ? listEvidence(dir) : [name]
  const heading = kind === "file" ? headingOf(path.join(dir, name)) : null
  const text = renderCard({ title: title ?? heading ?? titleOf(slug), date: base.date, evidence, note: "the original document, kept beside the card." })
  writeFileSync(path.join(dir, "README.md"), text)
  const movedText = moved.length > 0 ? `${moved[0].how === "copied" ? "Copied" : "Moved"} ${moved[0].from} into ${moved[0].to}${moved[0].how === "copied" ? " (the original is left where it was)" : ""}. ` : ""
  return done(top, slug, {
    state: "adopted",
    extra: { ...out, placeholders: placeholders(text) },
    message: `${movedText}Added ${TRACKS}/${slug}/README.md as its card, with the document linked under Evidence. ${NEXT}`,
  })
}

/** What under `_shared/tracks/` is not laid out as `<slug>/README.md`, each with its fix. */
export function checkTracks({ repo, crewScript = "crew.js", only = null }) {
  const top = toplevel(repo)
  if (top === null) return { state: "not_git", repo, message: notGit(repo) }
  const tracks = path.join(top, TRACKS)
  if (kindOf(tracks) !== "dir") return { state: "ok", repo: top, problems: [], message: `No ${TRACKS}/ folder, so there is nothing to check.` }
  const problems = []
  for (const name of readdirSync(tracks).sort()) {
    if (name.startsWith(".")) continue
    if (only !== null && !only.has(name)) continue
    const file = path.join(tracks, name)
    const kind = kindOf(file)
    if (kind !== "dir") {
      if (kind === "file" && name.toLowerCase() === "readme.md") continue
      problems.push({ kind: "flat_file", path: `${TRACKS}/${name}`, fix: command(crewScript, `adopt ${quote(`${TRACKS}/${name}`)}`), why: "an initiative is a folder with a README.md card, not a loose file" })
    } else if (cardIn(file) === null) {
      problems.push({ kind: "folder_without_card", path: `${TRACKS}/${name}/`, fix: command(crewScript, `adopt ${quote(`${TRACKS}/${name}`)}`), why: "an initiative folder needs a README.md card" })
    }
  }
  if (problems.length === 0) return { state: "ok", repo: top, problems, message: `${TRACKS}/ is laid out correctly.` }
  const lead = problems.length === 1 ? `Run \`${problems[0].fix}\`` : `Run the fix for each of ${problems.length} entries, for example \`${problems[0].fix}\``
  const lines = problems.map((problem) => `- ${problem.path}: ${problem.why}. Fix: \`${problem.fix}\``)
  return { state: "problems", repo: top, problems, message: `${lead} to lay out ${TRACKS}/ as <slug>/README.md.\n${lines.join("\n")}` }
}
