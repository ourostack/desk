Pull requests now fail when they leave unused code behind. A new required check, "Unused code", runs [knip](https://knip.dev) over the repository and fails on a file no entry point reaches, an export nothing imports, an unused dependency or a duplicate export. The entry points (the MCP server, hooks, scripts and tests) and every exception, each with its reason, are in `tools/unused-code/knip.jsonc`; run it locally with `cd tools/unused-code && npm ci && npm run knip`.

### Deleted, with the code left without purpose

- 73 exports that nothing outside their own file imported are now private to that file, so the next reader can see they have no outside callers. Their values and behaviour are unchanged.
- The unused `readinessStates` function, the `diagnosticTools` list and a re-export of `ELSEWHERE_NOTE` that nothing imported are gone.
- The `runtimeSupportMatrixPath` and `generateRuntimeSupportMatrix` aliases are gone; their caller uses the canonical names `deriveRuntimeSupportMatrixPath` and `buildRuntimeSupportMatrix`.

No record Desk writes or publishes changes.
