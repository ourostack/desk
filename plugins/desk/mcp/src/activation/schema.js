export const ACTIVATION_SCHEMA_VERSION = 1

export const activationManifestSchema = {
  schema_version: ACTIVATION_SCHEMA_VERSION,
  required: [
    "schema_version",
    "id",
    "version",
    "dependencies",
    "provides",
    "mcp_servers",
    "desk_root",
    "desk_runtime",
    "host_support",
    "permissions",
  ],
}
