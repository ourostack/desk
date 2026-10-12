// Seeding accounts and issuing invites (spec item 13; creating invites from the CLI is v1b-2's item 16). An invite
// token is 32 random bytes, base64url; the store keeps only its SHA-256, so someone who can read the store can't
// redeem an invite. The token is a single-use bearer credential: never log it.
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export const hashToken = (token) => createHash("sha256").update(token).digest("base64url");

export function newInvite() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

// Creates an account with Desk access on and its binding. `accountId` may be given to re-run a seed idempotently.
export async function seed({ store, displayName, binding, accountId = randomUUID() }) {
  await store.ensureTables();
  await store.putAccount({ accountId, displayName, deskAccess: true });
  await store.putBinding(accountId, binding);
  return { accountId };
}

export async function issueInvite({ store, accountId, ttlMs = INVITE_TTL_MS, now = Date.now() }) {
  if (!(Number.isFinite(ttlMs) && ttlMs > 0)) throw new Error("ttlMs must be a positive number of milliseconds");
  if ((await store.getAccount(accountId)) === null) throw new Error(`there is no account ${accountId} to invite to`);
  const { token, tokenHash } = newInvite();
  await store.putInvite({ tokenHash, accountId, expiresAt: (now instanceof Date ? now.getTime() : now) + ttlMs });
  return { token };
}
