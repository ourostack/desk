// The Desk-problem fingerprint: a plain, secret-free hash that lets any
// agent, on any machine, recognize "this is the same failure someone already
// reported" without a shared database -- the mapping lives only in the
// issues themselves (spec.md §1, "Where the mapping lives").
//
// This is the one deliberate departure from `kaizen-file.js`'s own
// fingerprint (spec.md, "the one deliberate departure from the
// kaizen-file.js precedent"): a kaizen card's fingerprint is
// `HMAC-SHA256(machine secret, ...)`, deliberately machine-local, so one
// machine does not re-file its own retries and the fingerprint is
// unguessable from the public issue. A Desk-problem fingerprint's job is the
// opposite: catching that a *different* agent on a *different* machine
// already hit and reported the exact same failure. Keying it to a
// machine-local secret would produce a different hash per machine for the
// identical failure, defeating cross-operator dedup entirely -- so this is
// plain `SHA-256(mechanism + "\n" + normalized signature)`, no secret, and
// deliberately guessable: guessability is not a concern for a report that
// carries no private data in the first place.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createHash } from "node:crypto"

// Any path shape with at least one separator: an absolute machine path in
// either slash convention, a `~`-relative one, or a bare relative one such as
// a desk-relative `<track>/<task>/file.md` -- two runs of the same failure
// naming two different stray filenames or two different task paths are the
// same failure signature (spec.md §1), so the exact path never survives into
// the signature at all, only its shape did.
const PATH_LIKE = /(?:[A-Za-z]:\\|~[\\/]|\/)?[\w.-]+(?:[\\/][\w.-]+)+/gu
// A commit-hash-shaped run of hex digits (Git's short hashes start at 7).
const HASH_LIKE = /\b[0-9a-f]{7,40}\b/giu
// An ISO-8601-shaped timestamp, with or without fractional seconds or a `Z`.
const TIMESTAMP_LIKE = /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/giu
// Any other run of digits: exit codes, counts, port numbers, line numbers.
const NUMBER_LIKE = /\d+/gu

/**
 * `normalizeErrorSignature(rawText) -> string`: strips the run-specific
 * detail out of an error message -- file paths, commit hashes, timestamps,
 * counts -- the same way `kaizen-file.js`'s `normalizeTitle` strips
 * punctuation, so two instances of the same underlying failure (two pulls
 * blocked by two different stray filenames; the same push rejected at two
 * different times) normalize to the same signature, and two instances of a
 * genuinely different failure (a real merge conflict on different files)
 * still normalize to a different one. Never throws: a non-string input
 * normalizes to the empty string.
 */
export function normalizeErrorSignature(rawText) {
  if (typeof rawText !== "string") return ""
  return rawText
    .replace(PATH_LIKE, " ")
    .replace(TIMESTAMP_LIKE, " ")
    .replace(HASH_LIKE, " ")
    .replace(NUMBER_LIKE, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/**
 * `deskProblemFingerprint(mechanism, signature) -> string`: the first 32 hex
 * characters of `SHA-256(mechanism + "\n" + signature)`, embedded in issue
 * bodies as `<!-- desk-problem-fingerprint: <hex> -->` (see
 * `desk-problem-template.js`). No secret is involved -- see the header.
 */
export function deskProblemFingerprint(mechanism, signature) {
  return createHash("sha256").update(`${mechanism}\n${signature}`).digest("hex").slice(0, 32)
}
