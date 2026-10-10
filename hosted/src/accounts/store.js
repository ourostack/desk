// The accounts store on Azure Table Storage (spec item 10). In Azure it signs in with DefaultAzureCredential: the
// gateway's managed identity (AZURE_CLIENT_ID picks the user-assigned one), holding Storage Table Data Contributor on
// the accounts storage account, which has shared-key access off. Locally, the same credential uses an `az` sign-in.
// Tests pass Azurite's development key instead. Redemption uses Table Storage's ETag `If-Match` for its
// compare-and-swap; see core.js.
import { TableClient } from "@azure/data-tables";
import { DefaultAzureCredential } from "@azure/identity";
import { Conflict, PreconditionFailed, TABLE_NAMES, storeOn } from "./core.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Properties Table Storage adds to every entity it returns, which a replace must not send back.
function ownProperties(entity) {
  const result = {};
  for (const [name, value] of Object.entries(entity)) {
    if (name === "etag" || name === "timestamp" || name.startsWith("odata.")) continue;
    result[name] = value;
  }
  return result;
}

export function createTableStore({ endpoint, credential, onStep } = {}) {
  const url = new URL(endpoint);
  // Plain HTTP only for a local emulator; anything else must be TLS.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("the accounts store endpoint must be https (plain http is allowed only on loopback, for Azurite)");
  }
  const clientOptions = { allowInsecureConnection: url.protocol === "http:" };
  const auth = credential ?? new DefaultAzureCredential();
  const clients = new Map(TABLE_NAMES.map((name) => [name, new TableClient(endpoint, name, auth, clientOptions)]));
  const client = (table) => {
    const found = clients.get(table);
    if (!found) throw new Error(`no table named ${table}`);
    return found;
  };

  const backend = {
    async ensure() {
      // createTable succeeds quietly when the table already exists.
      for (const table of clients.values()) await table.createTable();
    },
    async get(table, partitionKey, rowKey) {
      try {
        const entity = await client(table).getEntity(partitionKey, rowKey);
        return { entity: ownProperties(entity), etag: entity.etag };
      } catch (error) {
        if (error.statusCode === 404) return null;
        throw error;
      }
    },
    async create(table, entity) {
      try {
        return (await client(table).createEntity(entity)).etag;
      } catch (error) {
        if (error.statusCode === 409) throw new Conflict(table);
        throw error;
      }
    },
    async update(table, entity, etag) {
      try {
        return (await client(table).updateEntity(entity, "Replace", { etag })).etag;
      } catch (error) {
        // 412: the ETag no longer matches. 404: the row is gone, which is no match either.
        if (error.statusCode === 412 || error.statusCode === 404) throw new PreconditionFailed(table);
        throw error;
      }
    },
    async upsert(table, entity) {
      return (await client(table).upsertEntity(entity, "Replace")).etag;
    },
    async list(table) {
      const rows = [];
      for await (const entity of client(table).listEntities()) rows.push(ownProperties(entity));
      return rows;
    },
  };

  return storeOn(backend, { onStep });
}
