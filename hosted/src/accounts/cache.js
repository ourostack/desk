// The account cache in front of the accounts store (spec item 11). A row is served from the cache for up to
// `maxAgeMs` (60 s) after it was read; after that the store is read again. When the store can't answer, a row up to
// `maxAgeMs` old is still served, and past that the cache fails closed with StoreUnavailable, which callers turn
// into `server_error` (not `invalid_token`, which would send clients to a sign-in that can't succeed either).
// A missing account is cached as null like any other answer. The cache never serves a row it has not read itself.

export class StoreUnavailable extends Error {
  constructor(accountId, options) {
    super(`the accounts store can't answer for account ${accountId} and no row read in the last minute is cached`, options);
    this.name = "StoreUnavailable";
  }
}

export function createAccountCache({ store, now = Date.now, maxAgeMs = 60_000 }) {
  // accountId -> { row, at }, where `at` is when the read that produced `row` started.
  const rows = new Map();

  return {
    // `fresh: true` reads the store even when the cached row is young (the access sweep), still falling back to a
    // row within maxAgeMs when the read fails.
    async account(accountId, { fresh = false } = {}) {
      const hit = rows.get(accountId);
      if (hit && !fresh && now() - hit.at < maxAgeMs) return hit.row;
      const startedAt = now();
      let row;
      try {
        row = await store.getAccount(accountId);
      } catch (error) {
        const cached = rows.get(accountId);
        if (cached && now() - cached.at <= maxAgeMs) return cached.row;
        throw new StoreUnavailable(accountId, { cause: error });
      }
      // A slow read that started before the cached one never replaces it.
      const cached = rows.get(accountId);
      if (!cached || cached.at <= startedAt) rows.set(accountId, { row, at: startedAt });
      return rows.get(accountId).row;
    },

    forget(accountId) {
      rows.delete(accountId);
    },
  };
}
