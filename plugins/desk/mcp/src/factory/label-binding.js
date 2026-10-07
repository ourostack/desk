// A delivered waste label stays valid only while its session's facts still bind the job it labels. A session can be bound to a job by an older
// binder and dropped from it by a later derivation; the label file then stays in the store for a task that no longer lists the session (the
// site's `labels_mismatch`). This module decides, from the local facts alone, whether a delivered label is certainly unbound, and keeps the
// bookkeeping of the withdrawal. The delete itself is the flush's ordinary retraction (`flush.js`), so consent, routing and the store's own
// checks apply to it exactly as they do to a label that is published.
//
// Fail closed: "unbound" needs a facts file for the session in this store's outbox that reads and validates and whose `jobs` do not name the job.
// A missing, unreadable, linked or newer-format facts file is "unknown", and unknown is never withdrawn. Only `jobs` bind a session; an outcome
// the session only signed off does not (the site's session list is built from `jobs`).

import { promises as fsp } from "node:fs"
import * as path from "node:path"

import { factoryStateRoot, quarantine, readDelivered, readLocalFacts, undeliver } from "./outbox.js"
import { ENUMS } from "./schema.js"

/** The quarantine reason of a label withdrawn because its session no longer binds its job. */
export const UNBOUND_REASON = "job_unbound"

const KEY = /^labels\/([0-9a-f]{32})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u
const slugOf = (store) => store.replace("/", "__")

async function present(file) {
  try {
    return await fsp.lstat(file)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

/**
 * `labelBinding(env, store, key) -> "bound" | "unbound" | "unknown"`: whether the facts of the session in the labels key
 * `labels/<job>/<session>.json` bind that job, read from this store's outbox. Any doubt is "unknown".
 */
export async function labelBinding(env, store, key) {
  const parts = KEY.exec(key)
  if (parts === null) return "unknown"
  const [, job, session] = parts
  try {
    const root = await factoryStateRoot(env, { create: false })
    if (root === null) return "unknown"
    let seen = 0
    for (const host of ENUMS.host) {
      const name = `${host}-${session}.json`
      const stat = await present(path.join(root, "outbox", slugOf(store), name))
      if (stat === null) continue
      seen += 1
      const facts = stat.isFile() ? await readLocalFacts(env, store, name) : null
      if (facts === null) return "unknown"
      if (facts.jobs.some((binding) => binding.job === job)) return "bound"
    }
    return seen > 0 ? "unbound" : "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * `withdrawLabels(env, store, keys)`: the store no longer holds these labels. Each is quarantined as `job_unbound` first, so it is never
 * published again, and its delivered record goes second, so a crash between the two leaves a quarantined label that is still delivered, which
 * the next flush withdraws again. The local label files stay.
 */
export async function withdrawLabels(env, store, keys) {
  if (keys.length === 0) return
  for (const key of keys) await quarantine(env, store, key, UNBOUND_REASON)
  await undeliver(env, store, keys)
}

/**
 * `releaseReboundLabels(env, store) -> string[]`: lifts the `job_unbound` quarantine of each label whose session's facts bind its job again,
 * so the label publishes again, and returns the keys lifted. Any other quarantine record stays.
 */
export async function releaseReboundLabels(env, store) {
  const root = await factoryStateRoot(env)
  const lifted = []
  for (const key of [...(await readDelivered(env, store)).quarantined].filter((name) => KEY.test(name)).sort()) {
    const file = path.join(root, "quarantine", slugOf(store), key)
    let record
    try {
      record = JSON.parse(await fsp.readFile(file, "utf8"))
    } catch {
      continue
    }
    if (record?.reason !== UNBOUND_REASON || (await labelBinding(env, store, key)) !== "bound") continue
    await fsp.unlink(file)
    lifted.push(key)
  }
  return lifted
}
