import { existsSync } from "node:fs"

export function rootStatus(deskRoot, rootContext = {}) {
  const pathValue = typeof deskRoot === "string" && deskRoot.trim().length > 0
    ? deskRoot
    : null
  const source = typeof rootContext?.source === "string" && rootContext.source.trim().length > 0
    ? rootContext.source
    : "unknown"
  const tried = Array.isArray(rootContext?.tried)
    ? rootContext.tried.filter(isRootAttempt)
    : []
  const exists = pathValue === null ? false : existsSync(pathValue)
  const malformed_context = rootContext !== null
    && typeof rootContext === "object"
    && (rootContext.source !== undefined && source === "unknown"
      || rootContext.tried !== undefined && !Array.isArray(rootContext.tried))

  return {
    path: pathValue,
    source,
    tried,
    exists,
    valid: exists,
    diagnostic: exists ? null : rootDiagnostic(pathValue),
    malformed_context,
  }
}

function isRootAttempt(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.source === "string"
    && typeof value.path === "string"
}

function rootDiagnostic(pathValue) {
  return pathValue === null ? "missing_desk_root" : "desk_root_not_found"
}
