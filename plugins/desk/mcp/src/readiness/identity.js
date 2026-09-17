import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import * as path from "node:path"

export function controllerIdentity({
  root,
  protocolVersion,
  lexicalContract,
} = {}) {
  const canonicalRoot = realpathSync(path.resolve(root))
  const stat = statSync(canonicalRoot)
  const contract = stableStringify({
    protocol_version: protocolVersion,
    lexical_contract: lexicalContract,
  })
  const id = digest(stableStringify({
    root: canonicalRoot,
    device: stat.dev,
    inode: stat.ino,
    contract,
  }))
  return Object.freeze({
    id,
    root: canonicalRoot,
    protocol_version: protocolVersion,
    lexical_contract: lexicalContract,
  })
}

export function semanticPartitionIdentity(embeddingSpec) {
  return digest(stableStringify(embeddingSpec ?? null))
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
