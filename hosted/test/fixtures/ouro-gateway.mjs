// The end-to-end test's gateway with Ouro sign-in (run as `node --import stub-github.mjs ouro-gateway.mjs`): the real
// main() with the in-memory accounts store and a stub Ouro tenant in place of Azure Table Storage and ciamlogin.com,
// so nothing reaches the network. Before starting, it seeds one account (DESK_E2E_ACCOUNT_ID) bound to DESK_REPO with
// the author in DESK_E2E_AUTHOR_NAME and DESK_E2E_AUTHOR_EMAIL, and writes a fresh invite token to
// DESK_E2E_INVITE_FILE (mode 0600). The stub tenant redeems the self-describing codes `codeFor` makes.
import { writeFileSync } from "node:fs";
import { createMemoryStore } from "../../src/accounts/memory-store.js";
import { issueInvite, seed } from "../../src/accounts/invites.js";
import { main } from "../../src/main.js";
import { stubTenant, DISCOVERY } from "./stub-tenant.mjs";

const env = process.env;
const store = createMemoryStore();
await seed({
  store,
  accountId: env.DESK_E2E_ACCOUNT_ID,
  displayName: "Ouro E2E",
  binding: { kind: "github", repo: env.DESK_REPO, installationId: 1, author: { name: env.DESK_E2E_AUTHOR_NAME, email: env.DESK_E2E_AUTHOR_EMAIL } },
});
const { token } = await issueInvite({ store, accountId: env.DESK_E2E_ACCOUNT_ID });
writeFileSync(env.DESK_E2E_INVITE_FILE, token, { mode: 0o600 });

const tenant = await stubTenant({ clientId: env.DESK_ENTRA_CLIENT_ID });
const tenantUrls = new Set([`https://${env.DESK_ENTRA_SUBDOMAIN}.ciamlogin.com/${env.DESK_ENTRA_TENANT_ID}/v2.0/.well-known/openid-configuration`, DISCOVERY.jwks_uri, DISCOVERY.token_endpoint]);
const github = globalThis.fetch;
const fetch = (input, init) => (tenantUrls.has(String(input instanceof Request ? input.url : input)) ? tenant.fetch(input, init) : github(input, init));

main(env, { store, fetch }).catch((error) => {
  process.stderr.write(`desk-hosted: ${error.message}\n`);
  process.exit(1);
});
