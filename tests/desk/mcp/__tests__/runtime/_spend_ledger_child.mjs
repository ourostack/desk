// A separate process for spend_ledger.test.js: sends reads whose answers carry a falling `remaining`, so racing processes meet in one rate file.
import { ledgeredFetch } from "../../../../../plugins/desk/mcp/src/runtime/spend-ledger.js"

const [dir, reset, first, steps] = process.argv.slice(2)
const headers = (remaining) => ({ get: (name) => ({ "x-ratelimit-remaining": String(remaining), "x-ratelimit-limit": "5000", "x-ratelimit-reset": reset, "x-ratelimit-resource": "core" })[name] ?? null })
let remaining = Number(first)
const fetchFn = ledgeredFetch(async () => ({ ok: true, status: 200, headers: headers(remaining), text: async () => "{}" }), { env: { MS_DESK_QUOTA_DIR: dir, COPILOT_AGENT_SESSION_ID: `child-${process.pid}` }, login: () => "ari", now: () => Number(reset) * 1000 - 1_800_000 })
for (let step = 0; step < Number(steps); step += 1) {
  await fetchFn("https://api.github.com/repos/o/r/pulls/1", { headers: { Authorization: "Bearer synthetic" } })
  remaining -= 1
}
