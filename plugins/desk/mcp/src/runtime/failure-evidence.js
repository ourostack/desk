// The evidence a bug report about a Desk failure carries, gathered for `friction_add` with an `error_code`:
// the failure's code, message and stack, the Desk version, the host, the desk path and the recent sync status.
// Credentials are redacted; Desk's own paths stay, because the entry is written to the desk and the public card holds structured fields only.
import { deskVersion } from "../package-metadata.js"
import { redactCredentialLikeText } from "../util/redact.js"
import { recentFailure } from "./desk-failure.js"
import { hostFromEnv, readSyncStatus } from "./sync-worker.js"

export function failureEvidence({ code, deskRoot, env }) {
  const failure = recentFailure(code)
  const sync = readSyncStatus({ root: deskRoot, env })
  const lines = [
    `Desk error \`${code}\`${failure === null ? ": this process holds no record of it (it came from another Desk process, such as session start), so the message and stack are missing" : ` at ${failure.at}`}`,
    ...(failure === null ? [] : [`Message: ${failure.message}`, `Stack:\n${failure.stack}`]),
    `Desk version: ${deskVersion(env) ?? "unknown"}`,
    `Host: ${hostFromEnv(env)}`,
    `Desk path: ${deskRoot}`,
    `Recent sync status: ${sync === null ? "none recorded" : JSON.stringify(sync)}`,
  ]
  return redactCredentialLikeText(lines.join("\n"))
}
