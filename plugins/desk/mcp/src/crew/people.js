// The team's roster: one Markdown file of everyone the team works with, teammates and contacts, and what is worth
// knowing about them. Where it lives is `people` in `_meta/crew.json` (by default `_shared/landscape/roster.md`); its
// shape is the team's own. Crew starts a team with the starter below, and reads only two things from any roster: the
// interview questions under `## What we ask new teammates`, and whether a member's alias or identity appears in it.
// The agent writes each entry in the file's own format; this module lands it, merging it three ways with what
// teammates changed meanwhile.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

export { DEFAULT_PEOPLE } from "../desk/crew-config.js"

export const DEFAULT_QUESTIONS = Object.freeze([
  "What name do you go by (and your full name, if different)?",
  "Your pronouns, if you'd like to share them.",
  "Your role, and what you're working on these days.",
  "What should teammates come to you for?",
  "How do you like to be reached, and what's your time zone or usual hours?",
  "Anything else the team should know?",
])

const QUESTIONS_HEADING = "What we ask new teammates"

/** Crew's starter roster, for a team that has none yet. */
export function starterRoster() {
  return [
    "# Roster",
    "",
    "Everyone this team works with, teammates and the people we work with outside the team, and what is worth knowing about them. Every teammate and every teammate's agent reads it. Crew's `crew:roster` skill keeps it.",
    "",
    "## How to write in it",
    "",
    "- Say where each fact came from and when.",
    "- A role is what we have seen someone do, not a formal charter.",
    "- Record other spellings of a name: transcripts mangle them.",
    "- Never guess pronouns: write \"not shared\" until the person tells us.",
    "- Say who to go to for what.",
    "- Keep anything private or sensitive out.",
    "",
    "Each person gets one section, `### Name (alias)`, with short labeled lines: Role, Works on, Go to them for, Pronouns, Reach them, Notes, Source. Leave out a line we know nothing about.",
    "",
    `## ${QUESTIONS_HEADING}`,
    "",
    "When someone joins, their agent asks these in one message, and any of them can be skipped. Change this list to change what we ask.",
    "",
    ...DEFAULT_QUESTIONS.map((question, index) => `${index + 1}. ${question}`),
    "",
    "## Teammates",
    "",
    "One section per teammate, newest last.",
    "",
    "## Contacts",
    "",
    "People we work with outside the team: partners, customers, other teams. One section per person.",
    "",
  ].join("\n")
}

export const toLf = (text) => String(text).replace(/\r\n/gu, "\n")

/**
 * peopleQuestions(text) -> { questions, from: "roster" | "crew" }
 *
 * The list items under the roster's `What we ask new teammates` heading (any heading level, any letter case), or
 * Crew's defaults when the file is missing, has no such heading, or lists nothing under it.
 */
export function peopleQuestions(text) {
  const lines = toLf(text ?? "").split("\n")
  const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${QUESTIONS_HEADING}\\s*#*\\s*$`, "iu").test(line.trim()))
  const questions = []
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (/^#{1,6}\s/u.test(line.trim())) break
    const item = /^\s*(?:\d+[.)]|[-*+])\s+(\S.*?)\s*$/u.exec(line)
    if (item !== null) questions.push(item[1])
  }
  return questions.length > 0 ? { questions, from: "roster" } : { questions: [...DEFAULT_QUESTIONS], from: "crew" }
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

/** Whether any of `names` appears in `text` as a whole word, ignoring case; letters, digits, `_` and `-` join words. */
export function listedIn(text, names) {
  return names
    .filter((name) => typeof name === "string" && name.trim() !== "")
    .some((name) => new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped(name.trim())}(?![\\p{L}\\p{N}_-])`, "iu").test(String(text)))
}

const MARKER = 31
const OURS = `${"<".repeat(MARKER)} ours`
const BASE = `${"|".repeat(MARKER)} base`
const SPLIT = "=".repeat(MARKER)
const THEIRS = `${">".repeat(MARKER)} theirs`
const ended = (text) => (text.endsWith("\n") || text === "" ? text : `${text}\n`)

// Each conflict in `git merge-file --diff3` output where both sides only added lines at the same place takes the
// teammate's lines first, then ours. A conflict over lines that were already there stays a conflict: null.
function unionOfAdditions(output) {
  const out = []
  let part = null
  const block = { ours: [], base: [], theirs: [] }
  for (const line of output.split("\n")) {
    if (part === null && line === OURS) part = "ours"
    else if (part === "ours" && line === BASE) part = "base"
    else if (part === "base" && line === SPLIT) part = "theirs"
    else if (part === "theirs" && line === THEIRS) {
      if (block.base.length > 0) return null
      out.push(...block.theirs, ...block.ours)
      Object.assign(block, { ours: [], base: [], theirs: [] })
      part = null
    } else if (part === null) out.push(line)
    else block[part].push(line)
  }
  return out.join("\n")
}

/**
 * mergePeople({ base, ours, theirs, spawnGit? }) -> { text } | { conflict: true } | { error }
 *
 * Git's three-way merge of the roster: `base` is the file the member's agent edited, `ours` the edited file, `theirs`
 * the file on the default branch now. All three are compared with LF line endings, each ending with a newline. Lines
 * both sides added at the same place are kept, the teammate's first; a change to the same existing lines is a conflict.
 */
export function mergePeople({ base, ours, theirs, spawnGit = spawnSync }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "crew-roster-"))
  try {
    const files = { ours, base, theirs }
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), ended(toLf(text)))
    const merged = spawnGit("git", ["merge-file", "-p", "--diff3", `--marker-size=${MARKER}`, "-L", "ours", "-L", "base", "-L", "theirs", ...Object.keys(files).map((name) => path.join(dir, name))], { windowsHide: true, encoding: "utf8" })
    const output = String(merged.stdout ?? "")
    if (merged.status === 0) return { text: output }
    if (!(merged.status > 0 && merged.status < 128)) return { error: String(merged.stderr ?? "").trim().split("\n")[0] || "git merge-file did not run" }
    const union = unionOfAdditions(output)
    return union === null ? { conflict: true } : { text: union }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** `text` with LF line endings, ending with a newline: how the roster is compared and merged. */
export const normalized = (text) => ended(toLf(text))
