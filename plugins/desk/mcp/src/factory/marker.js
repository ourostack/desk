import fs from "node:fs"
import * as path from "node:path"
import { ENUMS, LIMITS, PATTERNS, isPlainObject, validPluginSource } from "./schema.js"

export const MAX_MARKER_BYTES = 64 * 1024
const REQUIRED = ["schema_version", "host", "session_id", "log_path", "cwd", "desk_root", "end_reason", "ended_at", "plugins", "updated_at"]
const OPTIONAL = ["entrypoint", "person_prefix", "routing"]
const time = (value) => typeof value === "string" && PATTERNS.timestamp.test(value) && Number.isFinite(Date.parse(value))
const unchangedFile = (left, right) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => left[key] === right[key])
export const absolutePath = (value) => typeof value === "string" && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value) && path.isAbsolute(value)

export function validRouting(value) {
  return isPlainObject(value) && Object.keys(value).sort().join(",") === "source,store,warnings"
    && ["desk", "overlay", "default", "invalid_declaration"].includes(value.source)
    && (value.source === "invalid_declaration" ? value.store === null : typeof value.store === "string" && PATTERNS.prRepo.test(value.store))
    && Array.isArray(value.warnings) && value.warnings.length <= 192
    && value.warnings.every((warning) => isPlainObject(warning) && Object.keys(warning).sort().join(",") === "code,manifest"
      && ["manifest_unreadable", "manifest_unparseable"].includes(warning.code) && absolutePath(warning.manifest))
}

export function validMarker(marker) {
  if (!isPlainObject(marker) || REQUIRED.some((key) => !Object.hasOwn(marker, key))
    || Object.keys(marker).some((key) => !REQUIRED.includes(key) && !OPTIONAL.includes(key))) return false
  return marker.schema_version === 1 && ENUMS.host.includes(marker.host)
    && typeof marker.session_id === "string" && PATTERNS.sessionId.test(marker.session_id)
    && absolutePath(marker.log_path) && absolutePath(marker.cwd)
    && (marker.desk_root === null || absolutePath(marker.desk_root))
    && (marker.end_reason === null || ENUMS.endReason.includes(marker.end_reason))
    && (marker.ended_at === null || time(marker.ended_at)) && time(marker.updated_at)
    && Array.isArray(marker.plugins) && marker.plugins.length <= LIMITS.plugins
    && marker.plugins.every((plugin) => isPlainObject(plugin) && ["name,version", "name,source,version"].includes(Object.keys(plugin).sort().join(","))
      && typeof plugin.name === "string" && PATTERNS.pluginName.test(plugin.name)
      && typeof plugin.version === "string" && PATTERNS.semver.test(plugin.version)
      && validPluginSource(plugin))
    && (!Object.hasOwn(marker, "entrypoint") || ENUMS.entrypoint.includes(marker.entrypoint))
    && (!Object.hasOwn(marker, "person_prefix") || (typeof marker.person_prefix === "string" && /^(?:desks\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})?$/u.test(marker.person_prefix)))
    && (!Object.hasOwn(marker, "routing") || validRouting(marker.routing))
}

// Metadata only: never block on a pipe or read an unbounded manifest.
export function readSmallText(file, limit = MAX_MARKER_BYTES) {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error("metadata_unreadable")
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("metadata_unreadable")
    const bytes = Buffer.alloc(limit + 1)
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (size > limit) throw new Error("metadata_unreadable")
    const after = fs.fstatSync(fd)
    const atPath = fs.lstatSync(file)
    if (!atPath.isFile() || atPath.nlink !== 1 || !unchangedFile(stat, after) || !unchangedFile(after, atPath)) throw new Error("metadata_unreadable")
    return bytes.toString("utf8", 0, size)
  } finally {
    fs.closeSync(fd)
  }
}
