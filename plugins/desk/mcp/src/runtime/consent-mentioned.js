// Whether an agent on this machine already told the operator that Desk can contribute to a store.
//
// The contribution question is asked once at setup (RFC section 4). The boot gives an interactive session the one sentence to say while
// the store's decision is undecided, and "say it once" was only prose: every later session got the same instruction and said it again.
// The agent that said the sentence now records it here (`factory.js consent --store <store> --mentioned yes`), and the boot of a later
// session tells its agent not to raise it. The record is made by the agent, not by the boot that gave the instruction, because a boot
// cannot know the sentence was said: a session that ends before its work is done never reaches it.
//
// One small file per store in Desk's own state folder, beside the other per-machine records. It is not a decision, so it is not in the
// factory's `consent.json`, whose every entry is read as a store this machine decided about.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { PATTERNS } from "../factory/schema.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"
import { renameWithRetry } from "../util/rename-retry.js"

export const CONSENT_MENTIONED_DIR = "factory-consent-mentioned"

const hasText = (value) => typeof value === "string" && value.trim() !== ""
const isStore = (store) => typeof store === "string" && PATTERNS.prRepo.test(store)

/** The record for one store. `store` must already be a valid `<owner/repo>`. */
export function mentionedFile(stateDir, store) {
  return path.join(stateDir, CONSENT_MENTIONED_DIR, `${store.replace("/", "__")}.json`)
}

function readRecord(stateDir, store) {
  try {
    assertNotRealStateUnderTest(stateDir)
    const parsed = JSON.parse(readFileSync(mentionedFile(stateDir, store), "utf8"))
    return parsed?.store === store && hasText(parsed.mentioned_at) ? { store, mentioned_at: parsed.mentioned_at } : null
  } catch {
    return null
  }
}

/** Whether the operator was already told about `store` on this machine. Fails open: no record, or one that cannot be read, is `false`. */
export function consentMentioned(stateDir, store) {
  return hasText(stateDir) && isStore(store) && readRecord(stateDir, store) !== null
}

/** Records that the operator was told about `store`, keeping the first time, and returns the record. Throws when it cannot be written. */
export function noteConsentMentioned(stateDir, store, { now = () => new Date().toISOString() } = {}) {
  if (!isStore(store)) throw new TypeError("store must be <owner/repo>")
  assertNotRealStateUnderTest(stateDir)
  const existing = readRecord(stateDir, store)
  if (existing !== null) return existing
  const file = mentionedFile(stateDir, store)
  const record = { store, mentioned_at: now() }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameWithRetry(temp, file)
  return record
}
