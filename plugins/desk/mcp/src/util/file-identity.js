// A file's identity is its device and file id. On Windows a file id can exceed 2^53 (one was measured at 10414574139658612), and above that a JavaScript Number cannot tell n from n + 1, so two different files can compare as the same file. Every comparison of file identity therefore reads the stat with `{ bigint: true }` (EXACT) and compares BigInts, which are exact at any size.

import { promises as fsp } from "node:fs"

export const EXACT = Object.freeze({ bigint: true })

function exact(stat) {
  if (typeof stat.ino !== "bigint" || typeof stat.dev !== "bigint") throw new TypeError("file identity needs a stat read with { bigint: true }")
  return stat
}

/** True when both stats, read with EXACT, describe the same file. */
export function sameFile(left, right) {
  return exact(left).dev === exact(right).dev && left.ino === right.ino
}

/**
 * True when `stat` (read with EXACT) is the file a record names. A record written by an earlier build, or by hand, holds Numbers; a Number above 2^53 has already lost its low bits, so against such a record the best available answer is whether the exact id rounds to it. A record holding a decimal string or a BigInt is compared exactly.
 */
export function matchesRecordedFile(stat, recorded) {
  exact(stat)
  return sameRecordedValue(stat.dev, recorded?.dev) && sameRecordedValue(stat.ino, recorded?.ino)
}

function sameRecordedValue(actual, recorded) {
  if (typeof recorded === "bigint") return actual === recorded
  if (typeof recorded === "string") return /^\d+$/u.test(recorded) && actual === BigInt(recorded)
  if (typeof recorded !== "number") return false
  return Number.isSafeInteger(recorded) ? actual === BigInt(recorded) : Number(actual) === recorded
}

/** `lstat` with EXACT, or null for a path that is not there. Any other failure is named with the caller's label and subject, as the outbox's own inspection names it. */
export async function lstatExactIfPresent(target, { label, subject }) {
  try {
    return await fsp.lstat(target, EXACT)
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw new Error(`${label}: private ${subject} path ${target} could not be inspected (${error.code})`)
  }
}
