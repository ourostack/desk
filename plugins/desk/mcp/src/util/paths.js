// Resolve the desk root path from --root flag, host/session defaults, an
// activation config, DESK env var, or the personal home-folder fallbacks.
//
// Resolution order:
//   1. Explicit --root argument
//   2. Host/session root
//   2b. Host project directory, only when it is itself a desk workspace
//       (Claude Code passes CLAUDE_PROJECT_DIR; opening a desk binds to it)
//   3. Activation config desk.root (the saved binding)
//   4. $DESK env var (if set and path exists)
//   5. A loaded work overlay's home-folder desk: $HOME/ms-desk/, only while the
//      ms-desk overlay is loaded in the same Agency session as this Desk
//   6. $HOME/desk/ (if exists)
//   7. $HOME/worker-workspace/ (legacy operators may still have this)
//   8. Fail — listing every path tried, so the operator can diagnose
//
// We don't auto-create the dir here; consumers expect to point at an
// existing desk workspace. An explicit binding (--root, the host/session root
// or the activation config's desk.root) never falls back: when its folder is
// missing, not a folder or unreadable, resolution fails with
// DESK_ROOT_UNAVAILABLE naming the configured path, and Desk degrades to
// root_unavailable until the folder exists. Malformed activation config also
// fails closed. Plain Desk never binds a work overlay's desk on its own: the
// home-folder fallbacks are personal locations, and $HOME/ms-desk belongs to
// the ms-desk overlay.

import * as path from "node:path"
import * as os from "node:os"
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync, promises as fs } from "node:fs"
import { fileURLToPath } from "node:url"

// Raised only when no source names a desk at all, as opposed to an explicit
// root that is wrong. Hosts may treat it as "no desk yet" and start setup.
export const DESK_ROOT_NOT_FOUND = "DESK_ROOT_NOT_FOUND"
// An explicit binding (--root, the host/session root or the activation config's
// desk.root) whose folder is missing, not a folder or unreadable.
export const DESK_ROOT_UNAVAILABLE = "DESK_ROOT_UNAVAILABLE"
// An activation config that cannot be read, is not JSON, or has the wrong schema.
export const ACTIVATION_CONFIG_INVALID = "ACTIVATION_CONFIG_INVALID"

export function resolveDeskRoot(explicit, options = {}) {
  return resolveDeskRootWithSource({
    ...options,
    explicitRoot: explicit,
  }).root
}

// The source of a personal home-folder fallback ($HOME/desk, $HOME/worker-workspace).
export const HOME_FALLBACK = "home_fallback"
// The source of a loaded work overlay's home-folder desk ($HOME/ms-desk).
export const OVERLAY_HOME_FALLBACK = "overlay_home_fallback"

// Agency copies every plugin a session selects into one per-session container
// named agency-plugin-<id>.p<pid>, one folder per plugin. A plugin folder next
// to Desk's own in that container is loaded in the same session.
export const AGENCY_SESSION_CONTAINER = /^agency-plugin-[A-Za-z0-9_-]+\.p[1-9][0-9]*$/u

// Work overlays whose home-folder desk Desk may bind when nothing else binds a
// desk, and only while that overlay is loaded next to Desk.
const OVERLAY_HOME_DESKS = Object.freeze([
  Object.freeze({ overlay: "ms-desk", folder: "ms-desk" }),
])

// The Desk plugin root this module ships in (plugins/desk/mcp/src/util → plugins/desk).
const MODULE_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

export function resolveDeskRootWithSource({
  activationConfigPath,
  cwd = process.cwd(),
  deskPluginRoot = MODULE_PLUGIN_ROOT,
  env = process.env,
  explicitRoot,
  homeDir = os.homedir(),
  hostProjectRoot,
  hostSessionRoot,
  readActivationConfig = readFileSync,
} = {}) {
  const tried = []

  // 1. Explicit --root argument — if passed, this is authoritative.
  if (hasText(explicitRoot)) {
    const resolved = resolveRootPath(explicitRoot, { cwd, homeDir })
    tried.push({ source: "explicit-root", path: resolved })
    const problem = explicitRootProblem(resolved)
    if (problem === null) return { root: resolved, source: "explicit-root", tried }
    throw codedError(
      `desk-mcp: --root path ${problem}: ${resolved}. ` +
        `Pass --root <path> pointing at an existing desk workspace, or set $DESK.`,
      DESK_ROOT_UNAVAILABLE,
      { path: resolved, source: "explicit-root", problem, tried },
    )
  }

  if (hasText(hostSessionRoot)) {
    const resolved = resolveRootPath(hostSessionRoot, { cwd, homeDir })
    tried.push({ source: "host-session-root", path: resolved })
    const problem = explicitRootProblem(resolved)
    if (problem === null) return { root: resolved, source: "host-session-root", tried }
    throw codedError(
      `desk-mcp: host/session root path ${problem}: ${resolved}.`,
      DESK_ROOT_UNAVAILABLE,
      { path: resolved, source: "host-session-root", problem, tried },
    )
  }

  // A host project that is itself a desk wins over machine-wide defaults: the
  // operator opened that desk. Any other project falls through silently.
  if (hasText(hostProjectRoot)) {
    const resolved = resolveRootPath(hostProjectRoot, { cwd, homeDir })
    tried.push({ source: "host-project", path: resolved })
    if (isDeskWorkspace(resolved)) return { root: resolved, source: "host-project", tried }
  }

  // The saved binding is explicit too: a folder that is gone never falls
  // through to $DESK or a home folder, which may be a different desk.
  const activationConfig = loadActivationConfig({ configPath: activationConfigPath, cwd, homeDir, read: readActivationConfig })
  if (activationConfig !== null) {
    const resolved = resolveRootPath(activationConfig.desk.root, { cwd, homeDir })
    const configPath = resolveRootPath(activationConfigPath, { cwd, homeDir })
    tried.push({ source: "activation-config", path: resolved })
    const problem = explicitRootProblem(resolved)
    if (problem === null) return { root: resolved, source: "activation-config", tried }
    throw codedError(
      `desk-mcp: the saved desk binding ${configPath} names ${resolved}, which ${problem}. ` +
        `Desk does not fall back to another desk.`,
      DESK_ROOT_UNAVAILABLE,
      { path: resolved, source: "activation-config", problem, activation_config: configPath, tried },
    )
  }

  // $DESK env var.
  if (hasText(env.DESK)) {
    const resolved = resolveRootPath(env.DESK, { cwd, homeDir })
    tried.push({ source: "env:DESK", path: resolved })
    if (existsSync(resolved)) return { root: resolved, source: "env:DESK", tried }
  }

  // Home-folder fallbacks: a loaded work overlay's own desk first, then the
  // personal locations. Plain Desk never consults an overlay's desk.
  const fallbacks = [
    ...loadedOverlayHomeDesks({ deskPluginRoot, homeDir }),
    { source: HOME_FALLBACK, path: path.join(homeDir, "desk") },
    { source: HOME_FALLBACK, path: path.join(homeDir, "worker-workspace") },
  ]
  for (const candidate of fallbacks) {
    tried.push(candidate)
    if (existsSync(candidate.path)) {
      return { root: candidate.path, source: candidate.source, tried }
    }
  }

  // Fail with diagnostic listing every path tried.
  const error = new Error(
    `desk-mcp: no desk workspace found. Tried (in order):\n` +
      tried.map((entry) => `  - ${formatTriedEntry(entry)}`).join("\n") +
      `\nPass --root <path> pointing at an existing desk workspace, or set $DESK.`,
  )
  error.code = DESK_ROOT_NOT_FOUND
  error.tried = tried
  throw error
}

// The home-folder desks of work overlays loaded in the same Agency session as
// this Desk: the overlay's plugin folder sits next to Desk's own in the
// session container and declares the overlay's name. Anywhere else (a plain
// install, Claude Code, Codex, a checkout) there are none.
export function loadedOverlayHomeDesks({ deskPluginRoot = MODULE_PLUGIN_ROOT, homeDir = os.homedir() } = {}) {
  if (!hasText(deskPluginRoot)) return []
  const container = path.dirname(path.resolve(deskPluginRoot))
  if (!AGENCY_SESSION_CONTAINER.test(path.basename(container))) return []
  return OVERLAY_HOME_DESKS
    .filter(({ overlay }) => pluginDeclares(path.join(container, overlay), overlay))
    .map(({ overlay, folder }) => ({ source: OVERLAY_HOME_FALLBACK, overlay, path: path.join(homeDir, folder) }))
}

function pluginDeclares(pluginRoot, name) {
  try {
    return JSON.parse(readFileSync(path.join(pluginRoot, "plugin.json"), "utf8"))?.name === name
  } catch {
    return false
  }
}

// Why an explicit binding's folder cannot be used, or null when it can.
function explicitRootProblem(resolved) {
  let stat
  try {
    stat = statSync(resolved)
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR" ? "does not exist" : "cannot be read"
  }
  if (!stat.isDirectory()) return "is not a folder"
  try {
    accessSync(resolved, fsConstants.R_OK | fsConstants.X_OK)
  } catch {
    return "cannot be read"
  }
  return null
}

// A desk workspace has `_meta/` plus either `_archive/` (a solo desk) or
// `desks/` (a crew workspace). `_meta/` alone is too common to trust.
export function isDeskWorkspace(dir) {
  if (!hasText(dir)) return false
  const isDir = (child) => {
    try {
      return statSync(path.join(dir, child)).isDirectory()
    } catch {
      return false
    }
  }
  return isDir("_meta") && (isDir("_archive") || isDir("desks"))
}

// Where Claude Code keeps this plugin's desk binding. CLAUDE_PLUGIN_DATA
// survives plugin updates, so a binding written once stays bound.
export function claudeBindingPath(env = process.env) {
  return hasText(env?.CLAUDE_PLUGIN_DATA)
    ? path.join(env.CLAUDE_PLUGIN_DATA, "desk.activation.json")
    : null
}

// The activation config a host session uses: an explicit path, then
// $DESK_ACTIVATION_CONFIG, then Codex's and Claude's host-owned bindings.
export function resolveActivationConfigPath({ explicit, env = process.env } = {}) {
  if (hasText(explicit)) return explicit
  if (hasText(env.DESK_ACTIVATION_CONFIG)) return env.DESK_ACTIVATION_CONFIG
  if (hasText(env.CODEX_HOME)) {
    const candidate = path.join(env.CODEX_HOME, "desk.activation.json")
    if (existsSync(candidate)) return candidate
  }
  const claudeBinding = claudeBindingPath(env)
  if (claudeBinding !== null && existsSync(claudeBinding)) return claudeBinding
  return null
}

export function loadActivationConfig({ configPath, cwd = process.cwd(), homeDir = os.homedir(), read = readFileSync } = {}) {
  if (!hasText(configPath)) return null
  const resolvedPath = resolveRootPath(configPath, { cwd, homeDir })
  let raw
  try {
    raw = read(resolvedPath, "utf8")
  } catch {
    throw codedError(`desk-mcp: activation config ${resolvedPath} could not be read`, ACTIVATION_CONFIG_INVALID, { path: resolvedPath })
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw codedError(`desk-mcp: activation config ${resolvedPath} must be valid JSON`, ACTIVATION_CONFIG_INVALID, { path: resolvedPath })
  }
  if (parsed?.schema_version !== 1) {
    throw codedError("desk-mcp: activation config schema_version must be 1", ACTIVATION_CONFIG_INVALID, { path: resolvedPath })
  }
  if (!hasText(parsed?.desk?.root)) {
    throw codedError("desk-mcp: activation config desk.root must be a non-empty string", ACTIVATION_CONFIG_INVALID, { path: resolvedPath })
  }
  return parsed
}

export function expandHome(p, homeDir = os.homedir()) {
  if (p.startsWith("~/")) return path.join(homeDir, p.slice(2))
  if (p === "~") return homeDir
  return p
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0
}

function codedError(message, code, detail) {
  return Object.assign(new Error(message), { code, ...detail })
}

function resolveRootPath(value, { cwd, homeDir }) {
  const expanded = expandHome(value, homeDir)
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded))
}

function formatTriedEntry(entry) {
  if (entry.source === "env:DESK") return `$DESK=${entry.path}`
  return entry.path
}

// ── Shared-workspace write-prefix ─────────────────────────────────────────────
//
// `--person <alias>` scopes a session's WRITES to `<deskRoot>/desks/<alias>/`
// while reads/search still span the whole repo. This single helper is the seam
// every write-path builder routes through, so the default-OFF path stays
// byte-identical to today.
//
//   personPrefix(deskRoot, person)
//     person null / undefined / "" / whitespace-only → deskRoot  (OFF)
//     valid alias                                     → join(deskRoot, "desks", alias)
//     alias with "..", "/" , "\", or absolute         → throws    (path-traversal reject)
//
// Validation rule: a valid alias is a single path segment with no traversal.
// We reject anything that, when treated as a path, would escape the `desks/`
// dir or split into multiple segments — i.e. it must contain no separators,
// no "..", and must not be "." or absolute.

export function personPrefix(deskRoot, person) {
  // OFF: null / undefined / empty / whitespace-only → no remap.
  if (person == null) return deskRoot
  if (typeof person !== "string") return deskRoot
  const alias = person.trim()
  if (alias === "") return deskRoot

  // Reject path-traversal and multi-segment aliases.
  if (
    alias === "." ||
    alias === ".." ||
    alias.includes("..") ||
    alias.includes("/") ||
    alias.includes("\\") ||
    path.isAbsolute(alias)
  ) {
    throw new Error(
      `desk-mcp: invalid --person alias ${JSON.stringify(person)} — ` +
        `an alias must be a single path segment with no ".." or path separators.`,
    )
  }

  return path.join(deskRoot, "desks", alias)
}

// ── Confined write targets ───────────────────────────────────────────────────

export async function resolveWriteTarget({
  deskRoot,
  person = null,
  segments,
  createPersonRoot = true,
}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("desk-mcp: write target requires at least one path segment")
  }
  for (const segment of segments) {
    validateWriteSegment(segment)
  }

  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  const target = path.resolve(effectiveRoot, ...segments)
  // Segment validation makes this invariant redundant by construction; retain the lexical boundary as defense in depth if validation evolves.
  /* node:coverage ignore next 3 */
  if (!isPathContained(effectiveRoot, target)) {
    throw new Error(`desk-mcp: write target is outside effective write root: ${target}`)
  }

  const realEffectiveRoot = await prepareEffectiveRoot({
    deskRoot,
    effectiveRoot,
    createPersonRoot,
  })
  await validateExistingTarget({
    effectiveRoot,
    realEffectiveRoot,
    segments,
  })
  return target
}

export function validateWriteSegment(segment) {
  if (
    typeof segment !== "string" ||
    segment.trim() === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("..") ||
    segment.includes("/") ||
    segment.includes("\\")
  ) {
    throw new Error(
      `desk-mcp: invalid write path segment ${JSON.stringify(segment)} — ` +
        `segments must be non-empty single path components with no ".." or separators.`,
    )
  }
}

async function prepareEffectiveRoot({ deskRoot, effectiveRoot, createPersonRoot }) {
  const lexicalDeskRoot = path.resolve(deskRoot)
  const realDeskRoot = await realDirectory(lexicalDeskRoot, "desk root")
  if (effectiveRoot === lexicalDeskRoot) return realDeskRoot

  const relativeRoot = path.relative(lexicalDeskRoot, effectiveRoot)
  const rootSegments = relativeRoot.split(path.sep)
  let lexicalCursor = lexicalDeskRoot
  let realCursor = realDeskRoot

  for (const segment of rootSegments) {
    lexicalCursor = path.join(lexicalCursor, segment)
    realCursor = path.join(realCursor, segment)
    let stat = await lstatIfExists(lexicalCursor)
    if (stat === null) {
      if (createPersonRoot === false) {
        throw new Error(`desk-mcp: effective write root does not exist: ${lexicalCursor}`)
      }
      await fs.mkdir(lexicalCursor)
      stat = await fs.lstat(lexicalCursor)
    }
    const resolved = await realpathOrSymlinkError(lexicalCursor)
    if (resolved !== realCursor) {
      throw new Error(
        `desk-mcp: effective write root resolves outside its canonical person path: ${lexicalCursor}`,
      )
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `desk-mcp: effective write root component is not a directory: ${lexicalCursor}`,
      )
    }
  }

  const resolvedRoot = await fs.realpath(effectiveRoot)
  return resolvedRoot
}

async function validateExistingTarget({
  effectiveRoot,
  realEffectiveRoot,
  segments,
}) {
  let cursor = effectiveRoot
  for (const segment of segments) {
    cursor = path.join(cursor, segment)
    const stat = await lstatIfExists(cursor)
    if (stat === null) return

    const resolved = await realpathOrSymlinkError(cursor)
    if (!isPathContained(realEffectiveRoot, resolved)) {
      throw new Error(
        `desk-mcp: write target resolves outside effective write root: ${cursor}`,
      )
    }
  }
}

async function realDirectory(candidate, label) {
  const stat = await fs.stat(candidate)
  if (!stat.isDirectory()) {
    throw new Error(`desk-mcp: ${label} is not a directory: ${candidate}`)
  }
  return fs.realpath(candidate)
}

async function realpathOrSymlinkError(candidate) {
  try {
    return await fs.realpath(candidate)
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`desk-mcp: broken symlink in write target: ${candidate}`)
    }
    throw error
  }
}

async function lstatIfExists(candidate) {
  try {
    return await fs.lstat(candidate)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

export function isPathContained(root, candidate) {
  const relative = path.relative(root, candidate)
  // path.relative can only return an absolute path for cross-drive Windows inputs, which cannot be constructed by these macOS/Linux test fixtures.
  /* node:coverage ignore next */
  if (path.isAbsolute(relative)) return false
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  )
}
