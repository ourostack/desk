// The hooks store on Azure Table Storage, in the accounts storage account, signed in as the gateway's user-assigned
// identity (AZURE_CLIENT_ID), which holds Storage Table Data Contributor there. Without a clientId it uses
// DefaultAzureCredential (an `az` sign-in locally); tests pass Azurite's development key.
//
// The accounts backend (accounts/store.js) has no delete, partition query or transaction, so this is its own small
// TableClient wrapper with the same deadline and error handling: every call has a deadline (5 s), and every failure
// becomes a HooksStoreError that names the status but never a key. The SDK retries nothing here. Its throttling retry
// would sleep for Table Storage's Retry-After inside the 5 s deadline and then time out, losing the value; every caller
// of this store already retries (the sender resends on a 503, the poll runs again), so a throttle comes straight back
// and the error carries the Retry-After Table Storage gave, which the receiver passes on to the sender.
import { TableClient, odata } from "@azure/data-tables";
import { STORE_TIMEOUT_MS, defaultCredential } from "../accounts/store.js";
import { Conflict, HooksStoreError, hooksStoreOn, tableNames } from "./core.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function ownProperties(entity) {
  const result = {};
  for (const [name, value] of Object.entries(entity)) {
    if (name === "etag" || name === "timestamp" || name.startsWith("odata.")) continue;
    result[name] = value;
  }
  return result;
}

function serviceCode(error) {
  const code = error?.details?.errorCode ?? error?.details?.odataError?.code ?? error?.code;
  return typeof code === "string" && /^[A-Za-z_]{1,64}$/.test(code) ? code : undefined;
}

/** Table Storage's wait in whole seconds, from retry-after-ms, x-ms-retry-after-ms or Retry-After (seconds or a date). */
export function retryAfterOf(error, now = Date.now()) {
  const header = (name) => error?.response?.headers?.get?.(name);
  let ms;
  for (const name of ["retry-after-ms", "x-ms-retry-after-ms"]) {
    const value = Number(header(name));
    if (ms === undefined && header(name) && Number.isFinite(value) && value > 0) ms = value;
  }
  const plain = header("retry-after");
  if (ms === undefined && plain) ms = /^\d+$/.test(plain.trim()) ? Number(plain) * 1000 : Date.parse(plain) - now;
  if (!(ms > 0)) return undefined;
  return Math.min(3600, Math.max(1, Math.ceil(ms / 1000)));
}

export function hooksStoreError(operation, table, error) {
  if (error?.name === "AbortError") return new HooksStoreError(operation, table, { code: "timed out" });
  return new HooksStoreError(operation, table, { statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : undefined, code: serviceCode(error), retryAfter: retryAfterOf(error) });
}

export function createHooksTableStore({ endpoint, credential, clientId, timeoutMs = STORE_TIMEOUT_MS, tablePrefix = "" } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("the hooks store endpoint must be https (plain http is allowed only on loopback, for Azurite)");
  }
  const clientOptions = { allowInsecureConnection: url.protocol === "http:", retryOptions: { maxRetries: 0 } };
  const auth = credential ?? defaultCredential({ clientId });
  const names = tableNames(tablePrefix);
  const clients = new Map(Object.values(names).map((name) => [name, new TableClient(endpoint, name, auth, clientOptions)]));

  async function call(operation, table, run, expected = {}) {
    try {
      return await run(clients.get(table), { abortSignal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const outcome = expected[error?.statusCode];
      if (outcome) return outcome(error);
      throw hooksStoreError(operation, table, error);
    }
  }

  const conflict = (table) => () => {
    throw new Conflict(table);
  };

  const backend = {
    async ensure() {
      for (const table of clients.keys()) await call("create table", table, (client, options) => client.createTable(options));
    },
    get(table, pk, rk) {
      return call("get", table, async (client, options) => ownProperties(await client.getEntity(pk, rk, options)), { 404: () => null });
    },
    create(table, entity) {
      return call("create", table, (client, options) => client.createEntity(entity, options), { 409: conflict(table) });
    },
    createAll(table, entities) {
      return call("create", table, (client, options) => client.submitTransaction(entities.map((entity) => ["create", entity]), options), { 409: conflict(table) });
    },
    merge(table, entity) {
      return call("merge", table, async (client, options) => {
        await client.updateEntity(entity, "Merge", { ...options, etag: "*" });
        return true;
      }, { 404: () => false });
    },
    remove(table, pk, rk) {
      return call("delete", table, async (client, options) => {
        await client.deleteEntity(pk, rk, options);
        return true;
      }, { 404: () => false });
    },
    query(table, pk, { from, below, select }) {
      return call("query", table, async (client, options) => {
        const rows = [];
        const queryOptions = { filter: odata`PartitionKey eq ${pk} and RowKey ge ${from} and RowKey lt ${below}`, ...(select ? { select } : {}) };
        for await (const entity of client.listEntities({ ...options, queryOptions })) rows.push(ownProperties(entity));
        return rows;
      });
    },
  };
  return hooksStoreOn(backend, names);
}
