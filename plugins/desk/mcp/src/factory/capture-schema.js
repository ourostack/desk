// The published capture record (`desk.factory.capture/1`): how many of a
// machine's sessions on disk each host kept, as counts and fixed enums only.
//
// It travels like facts: through the outbox, as a pull request to a factory
// store, at `capture/<intake id>.json`, and the store's CI gates it
// (`pipeline/validate-pr.js`). It carries no date, time, path, session id,
// store name, desk name, account or machine name. The one name in the file
// name is the machine's intake id, which is already public as its intake
// branch name.
//
// The shape is exact (any other key is `unknown_key`):
//   - `schema` is the constant and `basis` is `still_on_disk`: a required
//     field, so the upper-bound caveat (a host that deleted old transcripts is
//     invisible here) cannot be dropped.
//   - `hosts` holds zero to three of the known hosts. Each entry has the eight
//     bucket keys; each count is a safe integer from 0 to 1,000,000,
//     `not_in_a_desk` may also be `null` (a host whose folders name no working
//     directory), and `unverified` is a boolean. The buckets must add up to
//     `on_disk` (else `inconsistent`; a `null` counts as zero).
//   - `loop` is one optional slot, reserved for the closed loop's health
//     record. Until that record is defined it is a plain object of at most 512
//     canonical bytes whose keys and values are content-free: keys and strings
//     match `^[a-z_]{1,32}$`, numbers are safe integers up to 1,000,000, and
//     booleans and `null` are allowed. It never nests. A record without it is
//     valid; the empty retraction record has none. The rule is `validateLoopSlot`,
//     exported so its owner can replace it.
// The empty record, `hosts: {}`, is a retraction: any contributor may send it.
//
// Errors are `{ code, path }` with stable codes and a path built only from
// field names and the fixed host names, never from a value. The engine is
// `schema.js`'s spec walker.
import {
  ENUMS,
  addError,
  booleanField,
  customField,
  enumField,
  isPlainObject,
  joinPath,
  objectField,
  rangeIntField,
  validateCanonicalBytes,
  validateObject,
} from "./schema.js"

export const CAPTURE_SCHEMA = "desk.factory.capture/1"
export const CAPTURE_PATH = /^capture\/[0-9a-f]{16}\.json$/u
export const CAPTURE_MAX_BYTES = 2048
export const CAPTURE_LOOP_KEY = "loop"

const MAX_COUNT = 1000000
const LOOP_MAX_BYTES = 512
const LOOP_TEXT = /^[a-z_]{1,32}$/u
const BUCKETS = ["derived", "held", "frozen", "pending", "not_seen"]

const count = () => rangeIntField(0, MAX_COUNT)
const nullableCount = () => customField((value, path, errors) => (value === null ? true : count().check(value, path, errors)))

const HOST_SPEC = {
  on_disk: count(),
  derived: count(),
  held: count(),
  frozen: count(),
  pending: count(),
  not_seen: count(),
  not_in_a_desk: nullableCount(),
  unverified: booleanField(),
}

/**
 * The loop slot's rule, in the shape of every leaf check: reports into `errors`
 * at `path` and returns whether the slot is sound. Replace the body when the
 * closed loop's health record is defined; keep the name and the slot.
 */
export function validateLoopSlot(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return false
  }
  if (Buffer.byteLength(JSON.stringify(value)) > LOOP_MAX_BYTES) {
    addError(errors, "size", path)
    return false
  }
  let sound = true
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = joinPath(path, LOOP_TEXT.test(key) ? key : "?")
    if (!LOOP_TEXT.test(key)) {
      addError(errors, "pattern", entryPath)
      sound = false
    }
    if (entry === null || typeof entry === "boolean") continue
    if (typeof entry === "string") {
      if (!LOOP_TEXT.test(entry)) {
        addError(errors, "pattern", entryPath)
        sound = false
      }
    } else if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry) || entry < 0 || entry > MAX_COUNT) {
        addError(errors, "range", entryPath)
        sound = false
      }
    } else {
      addError(errors, "type", entryPath)
      sound = false
    }
  }
  return sound
}

// The buckets must add up; checked only when every count is sound, so one bad
// count is one error.
function checkSum(value, path, results, errors) {
  if (["on_disk", ...BUCKETS, "not_in_a_desk"].some((key) => results[key] !== true)) return
  const total = BUCKETS.reduce((sum, key) => sum + value[key], value.not_in_a_desk ?? 0)
  if (total !== value.on_disk) addError(errors, "inconsistent", path)
}

function hostsField() {
  return customField((value, path, errors, ctx) => {
    if (!isPlainObject(value)) {
      addError(errors, "type", path)
      return false
    }
    if (Object.keys(value).some((key) => !ENUMS.host.includes(key))) addError(errors, "unknown_key", path)
    for (const host of ENUMS.host) {
      if (!Object.hasOwn(value, host)) continue
      objectField(HOST_SPEC, (entry, entryPath, results, entryErrors) => checkSum(entry, entryPath, results, entryErrors)).check(value[host], joinPath(path, host), errors, ctx)
    }
    return true
  })
}

const TOP = {
  schema: enumField([CAPTURE_SCHEMA]),
  basis: enumField(["still_on_disk"]),
  hosts: hostsField(),
}

/** The record's closed key lists, for the documentation check: the top-level keys (with the optional loop slot last) and each host entry's keys. */
export const CAPTURE_TOP_KEYS = Object.freeze([...Object.keys(TOP), CAPTURE_LOOP_KEY])
export const CAPTURE_HOST_KEYS = Object.freeze(Object.keys(HOST_SPEC))

/** `validateCapture(value) -> { ok, errors }`. */
export function validateCapture(value) {
  const errors = []
  const spec = isPlainObject(value) && Object.hasOwn(value, CAPTURE_LOOP_KEY)
    ? { ...TOP, [CAPTURE_LOOP_KEY]: customField(validateLoopSlot) }
    : TOP
  validateObject(value, "", spec, errors)
  return { ok: errors.length === 0, errors }
}

/** `validateCaptureBytes(buffer) -> { ok, errors }`: a string or Buffer (else `type`), at most 2 KiB, canonical bytes, then `validateCapture`. */
export function validateCaptureBytes(buffer) {
  if (typeof buffer !== "string" && !Buffer.isBuffer(buffer)) return { ok: false, errors: [{ code: "type", path: "" }] }
  if (Buffer.byteLength(buffer) > CAPTURE_MAX_BYTES) return { ok: false, errors: [{ code: "size", path: "" }] }
  return validateCanonicalBytes(buffer, validateCapture)
}
