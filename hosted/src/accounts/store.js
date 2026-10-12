// The accounts store on Azure Table Storage (spec item 10). In Azure it signs in as the gateway's user-assigned
// managed identity (`clientId`, from AZURE_CLIENT_ID), which holds Storage Table Data Contributor on the accounts
// storage account; that account has shared-key access off. Without a clientId it uses DefaultAzureCredential, which
// locally means an `az` sign-in. Tests pass Azurite's development key instead. Redemption uses Table Storage's ETag
// `If-Match` for its compare-and-swap; see core.js.
//
// Every call has a deadline (`timeoutMs`, 5 s by default, covering the SDK's retries, of which there is one), so a
// store that stops answering fails the call instead of hanging it, and the account cache can fail closed on time.
import { TableClient } from "@azure/data-tables";
import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";
import { Conflict, PreconditionFailed, StoreError, storeOn, tableNames } from "./core.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const STORE_TIMEOUT_MS = 5_000;

export function defaultCredential({ clientId } = {}) {
  return clientId ? new ManagedIdentityCredential({ clientId }) : new DefaultAzureCredential();
}

// Properties Table Storage adds to every entity it returns, which a replace must not send back.
function ownProperties(entity) {
  const result = {};
  for (const [name, value] of Object.entries(entity)) {
    if (name === "etag" || name === "timestamp" || name.startsWith("odata.")) continue;
    result[name] = value;
  }
  return result;
}

// The service's error code (ResourceNotFound, TableNotFound, EntityAlreadyExists, ...), which the SDK puts in
// `details`, not in `code`.
function serviceCode(error) {
  const code = error?.details?.errorCode ?? error?.details?.odataError?.code ?? error?.code;
  return typeof code === "string" && /^[A-Za-z_]{1,64}$/.test(code) ? code : undefined;
}

// The SDK's errors carry the request, whose URL holds the row's keys; keep only the status and the service's code.
function storeError(operation, table, error) {
  if (error?.name === "AbortError") return new StoreError(operation, table, { code: "timed out" });
  return new StoreError(operation, table, { statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : undefined, code: serviceCode(error) });
}

export function createTableStore({ endpoint, credential, clientId, timeoutMs = STORE_TIMEOUT_MS, tablePrefix = "", onStep } = {}) {
  const url = new URL(endpoint);
  // Plain HTTP only for a local emulator; anything else must be TLS.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("the accounts store endpoint must be https (plain http is allowed only on loopback, for Azurite)");
  }
  const clientOptions = { allowInsecureConnection: url.protocol === "http:", retryOptions: { maxRetries: 1, retryDelayInMs: 200, maxRetryDelayInMs: 1_000 } };
  const auth = credential ?? defaultCredential({ clientId });
  const names = tableNames(tablePrefix);
  const clients = new Map(Object.entries(names).map(([table, name]) => [table, new TableClient(endpoint, name, auth, clientOptions)]));

  // Runs one SDK call with the deadline, turning its failures into the store's own errors.
  async function call(operation, table, run, expected = {}) {
    const client = clients.get(table);
    if (!client) throw new Error(`no table named ${table}`);
    try {
      return await run(client, { abortSignal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const outcome = expected[error?.statusCode];
      if (outcome && (outcome.code === undefined || outcome.code === serviceCode(error))) return outcome.handle();
      throw storeError(operation, table, error);
    }
  }

  const backend = {
    async ensure() {
      // createTable succeeds quietly when the table already exists.
      for (const table of clients.keys()) await call("create table", table, (client, options) => client.createTable(options));
    },
    async get(table, partitionKey, rowKey) {
      // Only a missing row is "not found"; a missing table (TableNotFound) is a configuration error.
      return call(
        "get",
        table,
        async (client, options) => {
          const entity = await client.getEntity(partitionKey, rowKey, options);
          return { entity: ownProperties(entity), etag: entity.etag };
        },
        { 404: { code: "ResourceNotFound", handle: () => null } },
      );
    },
    async create(table, entity) {
      return call("create", table, async (client, options) => (await client.createEntity(entity, options)).etag, {
        409: { code: "EntityAlreadyExists", handle: () => { throw new Conflict(table); } },
      });
    },
    async update(table, entity, etag) {
      // 412: the ETag no longer matches. 404 ResourceNotFound: the row is gone, which is no match either.
      return call("update", table, async (client, options) => (await client.updateEntity(entity, "Replace", { ...options, etag })).etag, {
        412: { handle: () => { throw new PreconditionFailed(table); } },
        404: { code: "ResourceNotFound", handle: () => { throw new PreconditionFailed(table); } },
      });
    },
    async upsert(table, entity) {
      return call("upsert", table, async (client, options) => (await client.upsertEntity(entity, "Replace", options)).etag);
    },
    async list(table) {
      return call("list", table, async (client, options) => {
        const rows = [];
        for await (const entity of client.listEntities(options)) rows.push(ownProperties(entity));
        return rows;
      });
    },
  };

  return storeOn(backend, { onStep });
}
