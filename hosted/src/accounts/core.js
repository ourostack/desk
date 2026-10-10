// The accounts store's logic, shared by the Table Storage store and its in-memory twin. Both supply the same five
// table operations, so invite redemption runs the same code against Azurite's real conditional updates in CI as
// against the memory store in unit tests.
//
// Tables (spec item 10): `accounts` (PartitionKey accountId), `identities` (PartitionKey tid, RowKey oid),
// `invites` (PartitionKey: SHA-256 of the invite token, base64url; the token itself is never stored) and
// `bindings` (PartitionKey accountId). Single-row partitions use an empty RowKey.
//
// A `tables` backend provides:
//   get(table, partitionKey, rowKey) -> { entity, etag } | null
//   create(table, entity)            -> etag; throws Conflict if the row exists
//   update(table, entity, etag)      -> etag; replaces the row only if its ETag still matches, else PreconditionFailed
//   upsert(table, entity)            -> etag
//   list(table)                      -> entity[]
// where an entity is `{ partitionKey, rowKey, ...string or boolean properties }`.
//
// Nothing here logs; callers name accounts by accountId only.

export class Conflict extends Error {
  constructor(table) {
    super(`a ${table} row with that key already exists`);
    this.name = "Conflict";
  }
}

export class PreconditionFailed extends Error {
  constructor(table) {
    super(`the ${table} row changed since it was read`);
    this.name = "PreconditionFailed";
  }
}

export const TABLE_NAMES = ["accounts", "identities", "invites", "bindings"];

// Table Storage keys can't hold / \ # ? or control characters; ours are GUIDs, UUIDs and base64url hashes.
const KEY = /^[A-Za-z0-9_.-]{1,128}$/;
const TOKEN_HASH = /^[A-Za-z0-9_-]{43}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function key(value, what) {
  if (typeof value !== "string" || !KEY.test(value)) throw new TypeError(`${what} isn't a valid store key`);
  return value;
}

function tokenHashKey(value) {
  if (typeof value !== "string" || !TOKEN_HASH.test(value)) throw new TypeError("tokenHash isn't a base64url SHA-256");
  return value;
}

const millis = (time) => {
  const ms = time instanceof Date ? time.getTime() : time;
  if (!Number.isFinite(ms)) throw new TypeError("a time must be a Date or milliseconds since the epoch");
  return ms;
};

function checkBinding(binding) {
  if (binding?.kind === "hosted") throw new Error("hosted bindings are reserved for v1c and refused");
  if (binding?.kind !== "github") throw new Error("a binding's kind must be github");
  if (typeof binding.repo !== "string" || !REPO.test(binding.repo)) throw new Error("a binding's repo must be owner/name");
  if (binding.installationId !== undefined && !(Number.isSafeInteger(binding.installationId) && binding.installationId > 0)) {
    throw new Error("a binding's installationId must be a positive integer");
  }
  const { name, email } = binding.author ?? {};
  if (typeof name !== "string" || !name || typeof email !== "string" || !email) throw new Error("a binding needs an author name and email");
}

const noop = async () => {};

// `onStep(name)` is a test seam: it is awaited after each step of a redemption ("invite-read", "claimed",
// "identity-created"), so tests can line up concurrent redemptions or interrupt one half-way.
export function storeOn(tables, { onStep = noop } = {}) {
  async function findIdentity(tid, oid) {
    const found = await tables.get("identities", key(tid, "tid"), key(oid, "oid"));
    return found ? found.entity.accountId : null;
  }

  async function redeemInvite({ tokenHash, tid, oid, now }) {
    tokenHashKey(tokenHash);
    key(tid, "tid");
    key(oid, "oid");
    const at = millis(now);
    // Each pass either finishes or loses a conditional update to a concurrent writer and re-reads.
    for (let attempt = 0; attempt < 5; attempt++) {
      const found = await tables.get("invites", tokenHash, "");
      if (!found) return { refused: "unknown" };
      await onStep("invite-read");
      const invite = found.entity;
      const claimed = Boolean(invite.claimTid);
      const mine = claimed && invite.claimTid === tid && invite.claimOid === oid;
      if (claimed && !mine) return { refused: "used" };
      // A claim made before expiry may still be completed afterwards.
      if (!mine && Date.parse(invite.expiresAt) <= at) return { refused: "expired" };
      const existing = await findIdentity(tid, oid);
      if (existing !== null && !(mine && existing === invite.accountId)) return { refused: "identity_has_account" };

      // 1. Claim the invite for this identity, only if nobody has changed it since the read.
      let current = invite;
      let etag = found.etag;
      if (!mine) {
        current = { ...invite, claimTid: tid, claimOid: oid, claimedAt: new Date(at).toISOString() };
        try {
          etag = await tables.update("invites", current, etag);
        } catch (error) {
          if (error instanceof PreconditionFailed) continue;
          throw error;
        }
        await onStep("claimed");
      }

      // 2. Map the identity to the invite's account; the row's creation fails if the identity was mapped meanwhile.
      if (existing === null) {
        try {
          await tables.create("identities", { partitionKey: tid, rowKey: oid, accountId: invite.accountId });
        } catch (error) {
          if (!(error instanceof Conflict)) throw error;
          if ((await findIdentity(tid, oid)) !== invite.accountId) {
            await release(tokenHash, current, etag);
            return { refused: "identity_has_account" };
          }
        }
        await onStep("identity-created");
      }

      // 3. Mark it redeemed. A lost race here is a concurrent retry by the same identity finishing the same step.
      if (!current.redeemedAt) {
        try {
          await tables.update("invites", { ...current, redeemedAt: new Date(at).toISOString() }, etag);
        } catch (error) {
          if (!(error instanceof PreconditionFailed)) throw error;
        }
      }
      return { accountId: invite.accountId };
    }
    throw new Error("the invite kept changing during redemption; try again");
  }

  // Undo a claim whose identity turned out to belong to another account, so the invite stays usable.
  async function release(tokenHash, claimedInvite, etag) {
    const { claimTid, claimOid, claimedAt, ...unclaimed } = claimedInvite;
    try {
      await tables.update("invites", unclaimed, etag);
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }

  return {
    tables,

    async ensureTables() {
      await tables.ensure?.();
    },

    async getAccount(accountId) {
      const found = await tables.get("accounts", key(accountId, "accountId"), "");
      if (!found) return null;
      const { displayName, deskAccess } = found.entity;
      return { accountId, displayName: displayName ?? "", deskAccess: deskAccess === true };
    },

    async putAccount({ accountId, displayName, deskAccess }) {
      if (typeof displayName !== "string") throw new TypeError("displayName must be a string");
      if (typeof deskAccess !== "boolean") throw new TypeError("deskAccess must be true or false");
      await tables.upsert("accounts", { partitionKey: key(accountId, "accountId"), rowKey: "", displayName, deskAccess });
    },

    findIdentity,

    async getBinding(accountId) {
      const found = await tables.get("bindings", key(accountId, "accountId"), "");
      if (!found) return null;
      const { kind, repo, installationId, authorName, authorEmail } = found.entity;
      const binding = { kind, repo };
      if (installationId) binding.installationId = Number(installationId);
      binding.author = { name: authorName, email: authorEmail };
      checkBinding(binding);
      return binding;
    },

    async putBinding(accountId, binding) {
      key(accountId, "accountId");
      checkBinding(binding);
      const entity = { partitionKey: accountId, rowKey: "", kind: binding.kind, repo: binding.repo, authorName: binding.author.name, authorEmail: binding.author.email };
      // Stored as text: Table Storage numbers are 32-bit unless typed, and installation ids may outgrow that.
      if (binding.installationId !== undefined) entity.installationId = String(binding.installationId);
      await tables.upsert("bindings", entity);
    },

    async putInvite({ tokenHash, accountId, expiresAt }) {
      tokenHashKey(tokenHash);
      key(accountId, "accountId");
      await tables.create("invites", { partitionKey: tokenHash, rowKey: "", accountId, expiresAt: new Date(millis(expiresAt)).toISOString() });
    },

    async getInvite(tokenHash) {
      const found = await tables.get("invites", tokenHashKey(tokenHash), "");
      if (!found) return null;
      const { accountId, expiresAt, redeemedAt } = found.entity;
      return { accountId, expiresAt: Date.parse(expiresAt), redeemed: Boolean(redeemedAt) };
    },

    redeemInvite,
  };
}
