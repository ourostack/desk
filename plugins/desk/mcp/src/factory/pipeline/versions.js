// Plugin version order for the factory: semantic-version precedence, exactly
// as Desk's release checks (`scripts/check-release-integrity.cjs`) order
// versions.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { PATTERNS } from "../schema.js"

/** True for a published plugin version (`schema.js`' semver shape). */
export function isVersion(value) {
  return typeof value === "string" && PATTERNS.semver.test(value)
}

function parseVersion(version) {
  if (!isVersion(version)) throw new TypeError(`compareVersions: ${JSON.stringify(version)} is not a version`)
  const [core, prerelease] = version.split(/-(.*)/su)
  return { core: core.split(".").map(Number), prerelease: prerelease === undefined ? [] : prerelease.split(".") }
}

/**
 * `compareVersions(left, right) -> number`: negative, zero or positive by
 * semantic-version precedence, as Desk's release checks order versions: a
 * release after its prereleases, numeric prerelease identifiers compared as
 * numbers (alpha.10 after alpha.9), others as text, and a shorter prerelease
 * first when every shared identifier is equal.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x !== y) return /^\d+$/u.test(x) && /^\d+$/u.test(y) ? Number(x) - Number(y) : x < y ? -1 : 1
  }
  return 0
}
