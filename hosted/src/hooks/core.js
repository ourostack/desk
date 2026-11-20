// The hooks store's logic, shared by the Table Storage store (store.js) and its in-memory twin (memory-store.js), so
// the same code runs against Azurite in CI as against memory in unit tests.
//
// Tables:
//   hooks       PartitionKey `id:<hook id>`, RowKey "": the hook itself (account, name, verify spec, sealed secret,
//               created, last event, last rejection). The receive path reads only this row.
//               PartitionKey <accountId>, RowKey <name>: the name's index, holding the hook id.
//   hookevents  PartitionKey <hook id>, RowKey <event id>: one pending event. Event ids are the received time in
//               zero-padded milliseconds and 6 random hex digits, so they sort oldest first and before any letter.
//               RowKey `d:<SHA-256 of the delivery id, base64url>`: marks a delivery id already stored, written in the
//               same transaction as its event, so a repeat is dropped and a failed write leaves no mark behind.
//
// The body is split into binary properties b0..b7 of at most 64 KB each, because Table Storage holds at most 64 KB in
// one binary property and 1 MB in one entity; that is why a body may be at most 512 KB.
//
// A backend provides, all async:
//   ensure()                                  create the tables if they don't exist
//   get(table, pk, rk)                        -> entity | null
//   create(table, entity)                     throws Conflict if the row exists
//   createAll(table, entities)                one transaction in one partition; throws Conflict if any row exists
//   merge(table, entity)                      -> false if the row is gone; never creates it
//   remove(table, pk, rk)                     -> false if the row was already gone
//   query(table, pk, { from, below, select }) -> entities in RowKey order with from <= RowKey < below
import { createHash, randomBytes } from "node:crypto";

export class Conflict extends Error {
  constructor(table) {
    super(`a ${table} row with that key already exists`);
    this.name = "Conflict";
  }
}

// A store call that failed: the store is down, slow, throttling or refusing. Its message names the operation, table
// and status only, never a key, which would carry a hook id. `retryAfter` is the seconds Table Storage asked for, if any.
export class HooksStoreError extends Error {
  constructor(operation, table, { statusCode, code, retryAfter } = {}) {
    super(`the hooks store failed: ${operation} on table ${table}${statusCode ? ` (HTTP ${statusCode}${code ? ` ${code}` : ""})` : code ? ` (${code})` : ""}`);
    this.name = "HooksStoreError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

export const TABLES = ["hooks", "hookevents"];
export const CHUNK_BYTES = 64 * 1024;
export const MAX_CHUNKS = 8;
export const MAX_BODY_BYTES = CHUNK_BYTES * MAX_CHUNKS;
export const EXPIRY_MS = 7 * 24 * 3600 * 1000;

const EVENTS_END = "a";
const DELIVERY_FROM = "d:";
const DELIVERY_END = "d;";

export function tableNames(prefix = "") {
  if (!/^[A-Za-z0-9]*$/.test(prefix)) throw new TypeError("tablePrefix must be alphanumeric");
  return Object.fromEntries(TABLES.map((name) => [name, `${prefix}${name}`]));
}

/** A new event id: the received time in zero-padded milliseconds, then 6 random hex digits. */
export const newEventId = (receivedAt) => `${String(receivedAt).padStart(15, "0")}-${randomBytes(3).toString("hex")}`;
export const EVENT_ID = /^\d{15}-[0-9a-f]{6}$/;

const deliveryKey = (deliveryId) => `${DELIVERY_FROM}${createHash("sha256").update(deliveryId).digest("base64url")}`;
const iso = (ms) => new Date(ms).toISOString();

function hookOf(row) {
  return {
    id: row.partitionKey.slice(3),
    accountId: row.accountId,
    name: row.name,
    verify: JSON.parse(row.verify),
    sealedSecret: row.sealedSecret || null,
    createdAt: row.createdAt,
    lastEventAt: row.lastEventAt || null,
    lastRejection: row.lastRejectionAt ? { reason: row.lastRejectionReason, at: row.lastRejectionAt } : null,
  };
}

function chunks(body) {
  const properties = {};
  for (let index = 0; index * CHUNK_BYTES < body.length; index++) properties[`b${index}`] = new Uint8Array(body.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
  return properties;
}

function bodyOf(row) {
  const parts = [];
  for (let index = 0; index < MAX_CHUNKS && row[`b${index}`]; index++) parts.push(Buffer.from(row[`b${index}`]));
  return Buffer.concat(parts);
}

export function hooksStoreOn(backend, names) {
  const HOOKS = names.hooks;
  const EVENTS = names.hookevents;
  const idRow = (id) => ({ partitionKey: `id:${id}`, rowKey: "" });

  async function hookById(id) {
    const row = await backend.get(HOOKS, `id:${id}`, "");
    return row ? hookOf(row) : null;
  }

  async function hookByName(accountId, name) {
    const index = await backend.get(HOOKS, accountId, name);
    if (!index) return null;
    const hook = await hookById(index.id);
    return hook && hook.accountId === accountId ? hook : null;
  }

  const pendingKeys = (hookId) => backend.query(EVENTS, hookId, { from: "", below: EVENTS_END, select: ["RowKey", "receivedAt"] });

  return {
    ensure: () => backend.ensure(),

    async createHook({ accountId, name, id, verify, sealedSecret, createdAt }) {
      await backend.create(HOOKS, { partitionKey: accountId, rowKey: name, id });
      try {
        await backend.create(HOOKS, { ...idRow(id), accountId, name, verify: JSON.stringify(verify), sealedSecret: sealedSecret ?? "", createdAt: iso(createdAt) });
      } catch (error) {
        await backend.remove(HOOKS, accountId, name).catch(() => false);
        throw error;
      }
    },

    hookById,
    hookByName,

    async listHooks(accountId) {
      const index = await backend.query(HOOKS, accountId, { from: "", below: "\u{10FFFF}" });
      const hooks = [];
      for (const row of index) {
        const hook = await hookById(row.id);
        if (hook && hook.accountId === accountId) hooks.push(hook);
      }
      return hooks;
    },

    /** The number of events waiting for a hook. */
    async pending(hookId) {
      return (await pendingKeys(hookId)).length;
    },

    async deleteHook(accountId, name) {
      const hook = await hookByName(accountId, name);
      if (!hook) return false;
      // The id row first, so the receiver stops accepting events before they are cleared.
      await backend.remove(HOOKS, `id:${hook.id}`, "");
      for (const row of await backend.query(EVENTS, hook.id, { from: "", below: "\u{10FFFF}", select: ["RowKey"] })) await backend.remove(EVENTS, hook.id, row.rowKey);
      await backend.remove(HOOKS, accountId, name);
      return true;
    },

    /** Stores one event. "duplicate" when its delivery id was stored in the last 7 days; then nothing is written. */
    async addEvent(hookId, { eventId, receivedAt, deliveryId, headers, body }) {
      const event = { partitionKey: hookId, rowKey: eventId, receivedAt: iso(receivedAt), deliveryId: deliveryId ?? "", headers: JSON.stringify(headers), size: body.length, ...chunks(body) };
      const rows = deliveryId ? [event, { partitionKey: hookId, rowKey: deliveryKey(deliveryId), receivedAt: iso(receivedAt), eventId }] : [event];
      try {
        await backend.createAll(EVENTS, rows);
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
        // A mark older than 7 days is stale: the sender's retries are long over, so this is a new delivery.
        const mark = await backend.get(EVENTS, hookId, rows[1].rowKey);
        if (mark && receivedAt - Date.parse(mark.receivedAt) <= EXPIRY_MS) return "duplicate";
        await backend.remove(EVENTS, hookId, rows[1].rowKey);
        await backend.createAll(EVENTS, rows);
      }
      // Only shown by `hooks list`, so a failure here never turns a stored event into an error the sender retries.
      await backend.merge(HOOKS, { ...idRow(hookId), lastEventAt: iso(receivedAt) }).catch(() => false);
      return "stored";
    },

    /** Pending events, oldest first, after deleting those older than 7 days (counted in `expired`). */
    async listEvents(hookId, { limit, now }) {
      const cutoff = now - EXPIRY_MS;
      let expired = 0;
      const keep = [];
      for (const row of await pendingKeys(hookId)) {
        if (Date.parse(row.receivedAt) < cutoff) {
          if (await backend.remove(EVENTS, hookId, row.rowKey)) expired += 1;
        } else {
          keep.push(row.rowKey);
        }
      }
      for (const mark of await backend.query(EVENTS, hookId, { from: DELIVERY_FROM, below: DELIVERY_END, select: ["RowKey", "receivedAt"] })) {
        if (Date.parse(mark.receivedAt) < cutoff) await backend.remove(EVENTS, hookId, mark.rowKey);
      }
      const events = [];
      for (const eventId of keep.slice(0, limit)) {
        const row = await backend.get(EVENTS, hookId, eventId);
        if (!row) continue;
        events.push({ eventId, receivedAt: row.receivedAt, deliveryId: row.deliveryId || null, headers: JSON.parse(row.headers), body: bodyOf(row) });
      }
      return { events, expired };
    },

    deleteEvent: (hookId, eventId) => backend.remove(EVENTS, hookId, eventId),

    async noteRejection(hookId, reason, at) {
      await backend.merge(HOOKS, { ...idRow(hookId), lastRejectionReason: reason, lastRejectionAt: iso(at) });
    },
  };
}
