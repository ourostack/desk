// Waits for broker behaviour that must finish on its own: a released lock, a timed-out request, a rejected call, a published readiness file.
//
// The limit fails a hang or a lock that stayed held without mistaking a loaded machine for either. These operations take tens of milliseconds on an idle machine and have taken over 500 ms under contention. The limit stays below the broker's own waits, so a regression still fails here: a held broker lock surfaces as BROKER_LOCK_TIMEOUT after 5 s, and a request that fell back to the default internal request timeout would take 10 s. Every wait records its measured time in the test output, so a slowdown stays visible.
export const SETTLE_LIMIT_MS = 4_000;

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
