import { deskVersion } from "../package-metadata.js"

export function diagnosticFormat(input) {
  const format = input?.format
  if (format !== undefined && format !== "full" && format !== "preview") {
    throw Object.assign(new TypeError("Pass full or preview: unsupported diagnostic format; use full or preview"), { code: "preview_snapshot_pass_full_or_preview_unsupported" })
  }
  return format ?? "full"
}

export function previewRuntimeSnapshot(runtimeState) {
  return {
    schema_version: 1,
    purpose: "preview-runtime-diagnostics",
    collection: "local-on-demand",
    desk_version: deskVersion(),
    runtime_state: runtimeState,
    platform: process.platform,
    architecture: process.arch,
    node_major: Number(process.versions.node.split(".")[0]),
    node_abi: process.versions.modules,
  }
}
