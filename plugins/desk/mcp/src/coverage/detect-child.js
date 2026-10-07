// A migration Detect script as the migration driver runs it: `node <script> --detect` with DESK_PLUGIN_ROOT set (pending-migrations.js sets it for every block; the Detect blocks pass --detect). The coverage gate leaves these children uninstrumented because they run under a fixed production budget (MIGRATION_BUDGET_MS), and instrumentation time grows with the number of files a change touches. The gate strips DESK_PLUGIN_ROOT from its own environment so only the driver can set it.
// The predicate is one source string: the gate inlines it into its data-URL registration, and this module builds the function from the same string. (Inlining `String(fn)` would copy the coverage counters nyc adds when the gate measures this file.)
export const DETECT_CHILD_SOURCE = '(argv, env) => argv.includes("--detect") && Boolean(env.DESK_PLUGIN_ROOT)'

export const isMigrationDetectChild = new Function(`return ${DETECT_CHILD_SOURCE}`)()
