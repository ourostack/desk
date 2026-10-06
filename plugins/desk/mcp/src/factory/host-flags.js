// What each host never records, or records only in part. A reader that finds an old (`/1`) facts file lists these in `unavailable`, so a missing value is not read as a measured zero.
const freeze = (flags) => Object.freeze(flags.map((flag) => Object.freeze(flag)))

export const HOST_FLAGS = Object.freeze({
  "claude-code": freeze([
    { field: "compaction_waits", reason: "host_does_not_record" },
    { field: "reasoning_tokens", reason: "host_does_not_record" },
    { field: "commits", reason: "host_does_not_record" },
    { field: "permission_waits", reason: "host_does_not_record" },
    { field: "prs", reason: "host_records_partly" },
    { field: "api_retries", reason: "host_records_partly" },
  ]),
  "codex-cli": freeze([
    { field: "compaction_waits", reason: "host_does_not_record" },
    { field: "commits", reason: "host_does_not_record" },
    { field: "permission_waits", reason: "host_does_not_record" },
    { field: "api_retries", reason: "host_does_not_record" },
    { field: "prs", reason: "host_records_partly" },
    { field: "tool_outcomes", reason: "host_records_partly" },
    { field: "requests", reason: "host_records_partly" },
    { field: "tokens", reason: "host_records_partly" },
  ]),
  "copilot-cli": freeze([
    { field: "prs", reason: "host_records_partly" },
  ]),
})

export function hostFlagsFor(host, details) {
  if (typeof host !== "string" || !Object.hasOwn(HOST_FLAGS, host)) return []
  const flags = HOST_FLAGS[host].map((flag) => ({ ...flag }))
  if (host === "copilot-cli" && details?.entrypoint === "cli") flags.push({ field: "entrypoint", reason: "host_does_not_record" })
  return flags
}
