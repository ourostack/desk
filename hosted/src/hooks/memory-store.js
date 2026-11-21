// The hooks store in memory, for tests and local runs: the same logic (core.js) over a Map per table.
import { Conflict, hooksStoreOn, tableNames } from "./core.js";

const copy = (entity) => Object.fromEntries(Object.entries(entity).map(([key, value]) => [key, value instanceof Uint8Array ? new Uint8Array(value) : value]));

/** The Map backend alone, so a test can wrap one call to make it fail. */
export function memoryBackend(names) {
  const tables = new Map(Object.values(names).map((name) => [name, new Map()]));
  const rowKey = (pk, rk) => `${pk}\u0000${rk}`;
  const backend = {
    async ensure() {},
    async get(table, pk, rk) {
      const row = tables.get(table).get(rowKey(pk, rk));
      return row ? copy(row) : null;
    },
    async create(table, entity) {
      const key = rowKey(entity.partitionKey, entity.rowKey);
      if (tables.get(table).has(key)) throw new Conflict(table);
      tables.get(table).set(key, copy(entity));
    },
    async createAll(table, entities) {
      if (entities.some((entity) => tables.get(table).has(rowKey(entity.partitionKey, entity.rowKey)))) throw new Conflict(table);
      for (const entity of entities) tables.get(table).set(rowKey(entity.partitionKey, entity.rowKey), copy(entity));
    },
    async merge(table, entity) {
      const key = rowKey(entity.partitionKey, entity.rowKey);
      const row = tables.get(table).get(key);
      if (!row) return false;
      tables.get(table).set(key, { ...row, ...copy(entity) });
      return true;
    },
    async remove(table, pk, rk) {
      return tables.get(table).delete(rowKey(pk, rk));
    },
    async query(table, pk, { from, below }) {
      return [...tables.get(table).values()]
        .filter((row) => row.partitionKey === pk && row.rowKey >= from && row.rowKey < below)
        .sort((a, b) => (a.rowKey < b.rowKey ? -1 : 1))
        .map(copy);
    },
  };
  return backend;
}

export function createHooksMemoryStore({ tablePrefix = "" } = {}) {
  const names = tableNames(tablePrefix);
  return hooksStoreOn(memoryBackend(names), names);
}
