// Waits for broker behaviour that must finish on its own: a released lock, a timed-out request, a rejected call, a published readiness file.
//
// These operations take tens of milliseconds on an idle machine and have taken over 2 s under contention. Every wait records its measured time in the test output, so a slowdown stays visible.
//
// SETTLE_LIMIT_MS only has to catch a hang. A lock that stayed held is caught sooner and more precisely by the broker itself: the waiting call rejects with BROKER_LOCK_TIMEOUT after 5 s, which fails the test's own expectation.
export const SETTLE_LIMIT_MS = 30_000;
// A configured short internal request timeout must answer well before the broker's 10 s default, so a request that fell back to the default still fails.
export const REQUEST_TIMEOUT_LIMIT_MS = 8_000;

/** Resolve with `promise`, or reject with `failure` when it has not settled within `limitMs`. Records the measured time on `t`. */
export async function settlesWithin(t, failure, promise, limitMs = SETTLE_LIMIT_MS) {
  const started = performance.now();
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${failure} (not settled within ${limitMs} ms)`)), limitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    t.diagnostic(`settled in ${Math.round(performance.now() - started)} ms (limit ${limitMs} ms), guarding: ${failure}`);
  }
}

/** Poll `condition` until it returns a truthy value, which is returned; throw `failure` after `limitMs`. */
export async function waitUntil(condition, failure, { limitMs = SETTLE_LIMIT_MS, intervalMs = 5 } = {}) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${failure} (not within ${limitMs} ms)`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
