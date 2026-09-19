import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import * as filesystem from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export function controllerIdentity({
  root,
  protocolVersion,
  lexicalContract,
  semanticContract = null,
} = {}) {
  const canonicalRoot = realpathSync(path.resolve(root))
  const stat = statSync(canonicalRoot)
  const user = os.userInfo()
  const contract = stableStringify({
    protocol_version: protocolVersion,
    lexical_contract: lexicalContract,
    semantic_contract: semanticContract,
  })
  const id = digest(stableStringify({
    root: canonicalRoot,
    device: stat.dev,
    inode: stat.ino,
    user: {
      uid: user.uid,
      username: user.username,
    },
    contract,
  }))
  return Object.freeze({
    id,
    root: canonicalRoot,
    protocol_version: protocolVersion,
    lexical_contract: lexicalContract,
    semantic_contract: semanticContract,
    user: Object.freeze({
      uid: user.uid,
      username: user.username,
    }),
  })
}

export function semanticPartitionIdentity(embeddingSpec) {
  return digest(stableStringify(embeddingSpec ?? null))
}

export function validateControllerEndpoint(endpoint, platform = process.platform) {
  if (platform === "win32") return
  if (typeof endpoint !== "string" || !path.posix.isAbsolute(endpoint)
    || endpoint.includes("\0") || Buffer.byteLength(endpoint) > 100) {
    throw new Error("readiness controller endpoint must be an absolute POSIX path of at most 100 bytes")
  }
}

export function validatePrivateDirectory(directory, {
  uid = process.getuid?.(), fs = filesystem,
} = {}) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
    || (stat.mode & 0o777) !== 0o700) {
    throw new Error("readiness controller has unsafe directory ownership or permissions")
  }
}

export function deriveControllerEndpoint({
  identity, platform = process.platform, uid = process.getuid?.(),
  env = process.env, fs = filesystem,
} = {}) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\desk-readiness-${identity.user.username}-${identity.id}`
  }
  if (!Number.isSafeInteger(uid) || uid < 0 || identity.user.uid !== uid) {
    throw new Error("readiness controller identity has unsafe OS-user ownership")
  }
  const basename = `${digest(stableStringify(identity)).slice(0, 32)}.sock`
  const runtimeDir = env.XDG_RUNTIME_DIR
  if (typeof runtimeDir === "string" && path.posix.isAbsolute(runtimeDir)) {
    try {
      validatePrivateDirectory(runtimeDir, { uid, fs })
      const canonicalRuntimeDir = fs.realpathSync(runtimeDir)
      validatePrivateDirectory(canonicalRuntimeDir, { uid, fs })
      validateRuntimeAncestors(path.posix.dirname(canonicalRuntimeDir), { uid, fs })
      const endpoint = path.posix.join(canonicalRuntimeDir, basename)
      validateControllerEndpoint(endpoint, platform)
      return endpoint
    } catch {
      // An optional, unusable XDG directory never weakens the private fallback.
    }
  }
  // Do not inherit TMPDIR: it can be long, shared, or caller-controlled.
  const tempRoot = fs.realpathSync("/tmp")
  validateRuntimeAncestors(tempRoot, { uid, fs })
  const directory = path.posix.join(tempRoot, `desk-readiness-${uid}`)
  const endpoint = path.posix.join(directory, basename)
  validateControllerEndpoint(endpoint, platform)
  try {
    fs.mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (error.code !== "EEXIST") throw error
  }
  validatePrivateDirectory(directory, { uid, fs })
  return endpoint
}

function validateRuntimeAncestors(directory, { uid, fs }) {
  for (let current = directory; ; current = path.posix.dirname(current)) {
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid)
      || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw new Error("readiness controller has unsafe runtime directory ancestry")
    }
    if (current === "/") return
  }
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value))
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
    )
  }
  return value
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}
