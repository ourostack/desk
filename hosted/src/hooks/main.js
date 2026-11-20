// The hooks receiver's entry point, run as Container App ouro-desk-hooks from the gateway's own image
// (`node hosted/src/hooks/main.js`). It needs no desk clone and no Desk child, so it starts in seconds and stays up
// on one small replica, which senders that give up after about 10 s require.
//
// Environment:
//   DESK_CLIENT_KEY                        seals signing secrets (seal.js); the gateway's own value
//   DESK_GITHUB_ACCOUNTS, DESK_GITHUB_LOGINS who may manage and read hooks, as the gateway reads them
//   DESK_ACCOUNTS_ENDPOINT, AZURE_CLIENT_ID the Table Storage account and the identity that reads it
//   DESK_HOOKS_PUBLIC_URL                  the address senders use; default the Container App's own Azure address
//   PORT                                   default 8080
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { isSet, keySetting, readGithubAccounts } from "../identity-config.js";
import { createHooksApp } from "./app.js";
import { githubIdentity } from "./identity.js";
import { hooksKey } from "./seal.js";
import { createHooksTableStore } from "./store.js";

/** The receiver's settings, or an Error naming what is missing. Never repeats a key. */
export function hooksConfig(env) {
  const clientKey = keySetting(env, "DESK_CLIENT_KEY");
  if (!clientKey) throw new Error("DESK_CLIENT_KEY is not set; the hooks receiver seals signing secrets with it");
  const accounts = readGithubAccounts(env);
  if (accounts.size === 0) throw new Error("DESK_GITHUB_ACCOUNTS names no account, so nobody could manage or read hooks");
  if (!isSet(env.DESK_ACCOUNTS_ENDPOINT)) throw new Error("DESK_ACCOUNTS_ENDPOINT is not set; hooks and events are stored in that Table Storage account");
  let publicUrl = isSet(env.DESK_HOOKS_PUBLIC_URL) ? env.DESK_HOOKS_PUBLIC_URL.trim() : "";
  // Container Apps sets these in every container.
  if (!publicUrl && isSet(env.CONTAINER_APP_NAME) && isSet(env.CONTAINER_APP_ENV_DNS_SUFFIX)) publicUrl = `https://${env.CONTAINER_APP_NAME}.${env.CONTAINER_APP_ENV_DNS_SUFFIX}`;
  if (!/^https:\/\/[^/\s]+\/?$/.test(publicUrl)) throw new Error("DESK_HOOKS_PUBLIC_URL must be the receiver's https origin, such as https://ouro-desk-hooks.<environment domain>");
  const port = Number(env.PORT ?? 8080);
  return { clientKey, accounts, endpoint: env.DESK_ACCOUNTS_ENDPOINT.trim(), clientId: isSet(env.AZURE_CLIENT_ID) ? env.AZURE_CLIENT_ID.trim() : undefined, publicUrl: publicUrl.replace(/\/$/, ""), port };
}

/** Builds the receiver, creates its tables and listens. `store` and `fetch` are for tests. */
export async function startHooks({ env = process.env, store, fetch = globalThis.fetch, log = console.log } = {}) {
  const config = hooksConfig(env);
  const hooksStore = store ?? createHooksTableStore({ endpoint: config.endpoint, clientId: config.clientId });
  await hooksStore.ensure();
  const app = createHooksApp({ store: hooksStore, identity: githubIdentity({ accounts: config.accounts, fetch }), key: hooksKey(config.clientKey), publicUrl: config.publicUrl, log });
  const server = app.listen(config.port);
  await once(server, "listening");
  log(`hooks: listening on ${server.address().port} for ${config.publicUrl}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startHooks();
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
