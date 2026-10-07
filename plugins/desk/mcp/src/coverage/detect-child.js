// A migration Detect script as the migration driver runs it: `node <script> --detect` with DESK_PLUGIN_ROOT set (pending-migrations.js sets it for every block; the Detect blocks pass --detect). The coverage gate leaves these children uninstrumented because they run under a fixed production budget (MIGRATION_BUDGET_MS), and instrumentation time grows with the number of files a change touches. The gate strips DESK_PLUGIN_ROOT from its own environment so only the driver can set it. Self-contained, so the gate can inline `String(isMigrationDetectChild)` into its data-URL registration.
export function isMigrationDetectChild(argv, env) {
  return argv.includes("--detect") && Boolean(env.DESK_PLUGIN_ROOT)
}
