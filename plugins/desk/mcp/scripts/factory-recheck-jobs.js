#!/usr/bin/env node
// Diagnostic and correction-prep tool for one problem: a session already
// published to a factory store may carry job attributions that the current
// binding.js would no longer produce, because a fix changed which touches
// count as work on a task (for example: the bare-card exclusion, so that a
// commit or write whose only change inside a task's folder is `task.md`
// itself no longer binds it). This script never writes to the store; it
// only reads, diffs, and optionally stages a byte-exact local correction for
// a human to review and submit through the store's normal intake pull
// request flow.
//
//   GH_TOKEN=$(gh auth token) node scripts/factory-recheck-jobs.js \
//     --store ourostack/factory --desk /path/to/desk \
//     --session <session id> --transcript /path/to/<session id>.jsonl \
//     [--session <id2> --transcript <path2> ...] \
//     [--host claude-code|copilot-cli] [--person-prefix <prefix>] [--ref main] \
//     [--write-corrected <output dir>]
//
// For each --session (paired in order with the --transcript given right
// after it), this:
//
//   1. Re-derives the session's events from its transcript and re-binds them
//      with THIS CHECKOUT's binding.js against the desk's real, current Git
//      history and task cards (read-only: no writes to the desk).
//   2. Fetches that session's currently published facts from the store
//      (`facts/<host>-<session id>.json` on `--ref`, default `main`; facts
//      and labels live on `main`, not the `reports` branch the store builds).
//   3. Reports every job id the store has that the recheck does not, and the
//      reverse (which a pure exclusion fix should never produce; any such id
//      is printed as an error, and that session is skipped for
//      --write-corrected rather than guessed at).
//
// With --write-corrected <dir>, it also writes one file per session to <dir>,
// named like the published path (`<host>-<session id>.json`): the published
// facts, byte-for-byte, with only the `jobs` array narrowed to drop the
// entries this recheck could not reproduce. Nothing else about the session
// changes — not `transitions`, not `observed`, not any job this recheck
// still confirms — so the correction is exactly "remove what no longer
// binds," never a full re-derivation, which could otherwise drift on facts
// that have moved on since the session ran (a task card's status today, for
// instance).
//
// Submitting the correction is a separate, manual step this script does not
// take: open a pull request on the store adding those files as `modified`
// changes to the matching `facts/...json` paths. `pipeline/validate-pr.js`
// already allows a modified facts file whose session host and id are
// unchanged and whose `session.duration_ms` does not decrease — both true
// here, since only `jobs` shrinks. The pull request goes through the same
// `factory-validate` and `factory-merge` gates as any other contribution;
// nothing here bypasses them, and a store-build labels-ledger rebuild
// (`factory-build`) then reflects the correction as it does for any merge.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import * as path from "node:path"

import { bindSession } from "../src/factory/binding.js"
import { createDeskReaders, readDeskRemote } from "../src/factory/desk-repo.js"
import { deriveClaudeSession } from "../src/factory/derive-claude.js"
import { ghRunner } from "../src/factory/flush.js"

const HOSTS = new Set(["claude-code", "copilot-cli"])

function usage(message) {
  if (message) process.stderr.write(`factory-recheck-jobs: ${message}\n`)
  process.stderr.write("usage: factory-recheck-jobs --store <owner/repo> --desk <path> --session <id> --transcript <path> [...] [--host claude-code|copilot-cli] [--person-prefix <prefix>] [--ref main] [--write-corrected <dir>]\n")
  process.exit(1)
}

function parseArgs(argv) {
  const options = { sessions: [], host: "claude-code", personPrefix: "", ref: "main" }
  let index = 0
  while (index < argv.length) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (typeof value !== "string") usage(`${flag} needs a value`)
    switch (flag) {
      case "--store": options.store = value; break
      case "--desk": options.desk = value; break
      case "--host": options.host = value; break
      case "--person-prefix": options.personPrefix = value; break
      case "--ref": options.ref = value; break
      case "--write-corrected": options.writeCorrected = value; break
      case "--session": options.sessions.push({ id: value, transcript: null }); break
      case "--transcript": {
        const last = options.sessions.at(-1)
        if (last === undefined || last.transcript !== null) usage("--transcript must directly follow the --session it belongs to")
        last.transcript = value
        break
      }
      default: usage(`unknown flag ${flag}`)
    }
    index += 2
  }
  if (typeof options.store !== "string" || options.store === "") usage("--store is required")
  if (typeof options.desk !== "string" || options.desk === "") usage("--desk is required")
  if (!HOSTS.has(options.host)) usage(`--host must be one of ${[...HOSTS].join(", ")}`)
  if (options.sessions.length === 0) usage("at least one --session is required")
  for (const session of options.sessions) if (session.transcript === null) usage(`--session ${session.id} has no --transcript`)
  return options
}

async function fetchPublished(run, { store, host, sessionId, ref }) {
  const result = await run(["api", "-H", "Accept: application/vnd.github.raw", `repos/${store}/contents/facts/${host}-${sessionId}.json?ref=${ref}`], { token: process.env.GH_TOKEN })
  if (result.code !== 0) return { ok: false, error: (result.stderr || result.stdout || "gh api failed").trim() }
  try {
    return { ok: true, value: JSON.parse(result.stdout) }
  } catch {
    return { ok: false, error: "published facts did not parse as JSON" }
  }
}

async function recheckSession(readers, deskRemote, personPrefix, session) {
  const derived = await deriveClaudeSession({ transcriptPath: session.transcript, plugins: [], endReason: null })
  const { jobs } = bindSession({ events: derived.events, deskRoot: readers.deskRoot, deskRemote, personPrefix, ...readers })
  return jobs
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.desk)) usage(`--desk ${options.desk} does not exist`)
  const deskRoot = options.desk
  const readers = { deskRoot, ...createDeskReaders({ deskRoot, personPrefix: options.personPrefix }) }
  const deskRemote = readDeskRemote({ deskRoot })
  if (deskRemote === null) usage(`--desk ${options.desk} has no readable Git remote; pass the same desk the sessions actually ran in`)

  const run = ghRunner()
  if (options.writeCorrected !== undefined) mkdirSync(options.writeCorrected, { recursive: true })

  let anyRemoved = false
  let anyUnexpectedAdd = false

  for (const session of options.sessions) {
    process.stdout.write(`\n${session.id}\n`)
    const recomputed = await recheckSession(readers, deskRemote, options.personPrefix, session)
    const recomputedIds = new Set(recomputed.map((entry) => entry.job))

    const published = await fetchPublished(run, { store: options.store, host: options.host, sessionId: session.id, ref: options.ref })
    if (!published.ok) {
      process.stdout.write(`  could not read the published facts: ${published.error}\n`)
      continue
    }
    const publishedJobs = Array.isArray(published.value.jobs) ? published.value.jobs : []
    const publishedById = new Map(publishedJobs.map((entry) => [entry.job, entry]))

    const removed = publishedJobs.filter((entry) => !recomputedIds.has(entry.job))
    const added = [...recomputedIds].filter((id) => !publishedById.has(id))

    if (removed.length === 0 && added.length === 0) {
      process.stdout.write(`  no change: ${publishedJobs.length} published job(s) all still bind\n`)
      continue
    }
    for (const entry of removed) {
      anyRemoved = true
      process.stdout.write(`  no longer binds: ${entry.job} (was: ${(entry.basis ?? []).join("+")})\n`)
    }
    for (const id of added) {
      anyUnexpectedAdd = true
      process.stdout.write(`  UNEXPECTED new binding, not touched by this script: ${id} (investigate before correcting this session)\n`)
    }

    if (options.writeCorrected !== undefined) {
      if (added.length > 0) {
        process.stdout.write("  skipping --write-corrected for this session: an unexpected new binding needs a human's judgment first\n")
        continue
      }
      const removedIds = new Set(removed.map((entry) => entry.job))
      const corrected = { ...published.value, jobs: publishedJobs.filter((entry) => !removedIds.has(entry.job)) }
      const outFile = path.join(options.writeCorrected, `${options.host}-${session.id}.json`)
      writeFileSync(outFile, `${JSON.stringify(corrected, null, 2)}\n`)
      process.stdout.write(`  wrote corrected facts: ${outFile}\n`)
    }
  }

  if (anyUnexpectedAdd) {
    process.stdout.write("\nAt least one session bound a job this recheck did not expect. That is not what a pure exclusion fix should do; do not submit a correction for it without understanding why first.\n")
  }
  if (options.writeCorrected !== undefined && anyRemoved) {
    process.stdout.write(`\nCorrected files are staged in ${options.writeCorrected}. This script has not opened a pull request or touched the store. To submit the correction: open a pull request on ${options.store} that replaces each session's facts/<host>-<session id>.json with the matching staged file (a "modified" change; see the header comment), and let factory-validate and factory-merge run as they would for any other contribution.\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`factory-recheck-jobs: ${error?.stack ?? error}\n`)
  process.exit(1)
})
