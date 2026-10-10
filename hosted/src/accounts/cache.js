// The account cache in front of the accounts store (spec item 11). A row is served from the cache for up to
// `maxAgeMs` (60 s) after it was read; after that the store is read again. When the store can't answer, a row up to
// `maxAgeMs` old is still served, and past that the cache fails closed with StoreUnavailable, which callers turn
// into `server_error` (not `invalid_token`, which would send clients to a sign-in that can't succeed either).
//
// - A read that takes longer than `readTimeoutMs` (5 s) counts as a failed read, so a silent store can't hang a
//   request past its answer.
// - Concurrent reads of one account share one store read.
// - `forget(accountId)` drops the row, and any read already in flight for it is neither joined nor cached.
// - A missing account is cached as null like any other answer. The cache never serves a row it has not read itself.
// - Ages use a monotonic clock (`performance.now`), so a wall-clock step can't keep a row young.

export class StoreUnavailable extends Error {
  constructor(accountId, options) {
    super(`the accounts store can't answer for account ${accountId} and no row read in the last minute is cached`, options);
    this.name = "StoreUnavailable";
  }
}

class ReadTimedOut extends Error {
  constructor() {
    super("the accounts store didn't answer in time");
    this.name = "ReadTimedOut";
  }
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimedOut()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function createAccountCache({ store, now = () => performance.now(), maxAgeMs = 60_000, readTimeoutMs = 5_000 }) {
  // accountId -> { row, at }, where `at` is when the read that produced `row` started.
  const rows = new Map();
  // accountId -> { promise, generation }: the read in flight, shared by every caller that arrives while it runs.
  const reads = new Map();
  // accountId -> generation, bumped by forget so an older read's answer is dropped.
  const generations = new Map();
  const generationOf = (accountId) => generations.get(accountId) ?? 0;

  function read(accountId) {
    const generation = generationOf(accountId);
    const inFlight = reads.get(accountId);
    if (inFlight && inFlight.generation === generation) return inFlight.promise;
    const startedAt = now();
    const promise = withDeadline(Promise.resolve().then(() => store.getAccount(accountId)), readTimeoutMs).then(
      (row) => {
        // A read that started before forget, or before the cached row's read, never replaces it.
        const cached = rows.get(accountId);
        if (generationOf(accountId) === generation && (!cached || cached.at <= startedAt)) rows.set(accountId, { row, at: startedAt });
        return { ok: true, row: generationOf(accountId) === generation ? rows.get(accountId).row : row };
      },
      (error) => ({ ok: false, error }),
    );
    const entry = { promise, generation };
    reads.set(accountId, entry);
    promise.finally(() => {
      if (reads.get(accountId) === entry) reads.delete(accountId);
    });
    return promise;
  }

  return {
    // `fresh: true` reads the store even when the cached row is young (the access sweep), still falling back to a
    // row within maxAgeMs when the read fails.
    async account(accountId, { fresh = false } = {}) {
      const hit = rows.get(accountId);
      if (hit && !fresh && now() - hit.at < maxAgeMs) return hit.row;
      const result = await read(accountId);
      if (result.ok) return result.row;
      const cached = rows.get(accountId);
      if (cached && now() - cached.at <= maxAgeMs) return cached.row;
      throw new StoreUnavailable(accountId, { cause: result.error });
    },

    forget(accountId) {
      rows.delete(accountId);
      reads.delete(accountId);
      generations.set(accountId, generationOf(accountId) + 1);
    },
  };
}
