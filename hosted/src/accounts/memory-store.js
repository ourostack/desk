// The accounts store in memory: the same interface and logic as the Table Storage store (core.js), over Maps with
// Table Storage's ETag semantics. Every operation yields to the event loop first, so concurrent callers interleave
// the way they do against a real store. For unit tests and local runs; nothing persists.
import { Conflict, PreconditionFailed, TABLE_NAMES, storeOn } from "./core.js";

export function createMemoryStore(options = {}) {
  const tables = new Map(TABLE_NAMES.map((name) => [name, new Map()]));
  let version = 0;
  const nextEtag = () => `W/"${++version}"`;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const rowsOf = (table) => {
    const rows = tables.get(table);
    if (!rows) throw new Error(`no table named ${table}`);
    return rows;
  };
  const id = (entity) => `${entity.partitionKey}\u0000${entity.rowKey}`;
  const copy = (entity) => structuredClone(entity);

  const backend = {
    async get(table, partitionKey, rowKey) {
      await tick();
      const row = rowsOf(table).get(`${partitionKey}\u0000${rowKey}`);
      return row ? { entity: copy(row.entity), etag: row.etag } : null;
    },
    async create(table, entity) {
      await tick();
      const rows = rowsOf(table);
      if (rows.has(id(entity))) throw new Conflict(table);
      const etag = nextEtag();
      rows.set(id(entity), { entity: copy(entity), etag });
      return etag;
    },
    async update(table, entity, etag) {
      await tick();
      const rows = rowsOf(table);
      const row = rows.get(id(entity));
      if (!row || row.etag !== etag) throw new PreconditionFailed(table);
      const next = nextEtag();
      rows.set(id(entity), { entity: copy(entity), etag: next });
      return next;
    },
    async upsert(table, entity) {
      await tick();
      const etag = nextEtag();
      rowsOf(table).set(id(entity), { entity: copy(entity), etag });
      return etag;
    },
    async list(table) {
      await tick();
      return [...rowsOf(table).values()].map((row) => copy(row.entity));
    },
  };

  return storeOn(backend, options);
}
