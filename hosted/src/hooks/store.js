// The hooks store on Azure Table Storage, in the accounts storage account, signed in as the gateway's user-assigned
// identity (AZURE_CLIENT_ID), which holds Storage Table Data Contributor there. Without a clientId it uses
// DefaultAzureCredential (an `az` sign-in locally); tests pass Azurite's development key.
//
// The accounts backend (accounts/store.js) has no delete, partition query or transaction, so this is its own small
// TableClient wrapper with the same deadline and error handling: every call has a deadline (5 s, covering the SDK's one
// retry), and every failure becomes a HooksStoreError that names the status but never a key. When Table Storage
// throttles (503 ServerBusy, or 429), the error carries the Retry-After it gave, so the receiver can pass it on.
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

function retryAfterOf(error) {
  const value = error?.response?.headers?.get?.("retry-after");
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 3600 ? seconds : undefined;
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
  const clientOptions = { allowInsecureConnection: url.protocol === "http:", retryOptions: { maxRetries: 1, retryDelayInMs: 200, maxRetryDelayInMs: 1_000 } };
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
