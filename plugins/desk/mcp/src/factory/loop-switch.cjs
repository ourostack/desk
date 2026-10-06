"use strict";

// The one off switch for the whole improvement loop: `DESK_FACTORY_LOOP` set to anything but 1, true, on or yes
// (padded or in capitals) turns it off, the same rule as the evaluator's `DESK_FACTORY_HEADLESS_EVALUATOR`.
// Unset means on. The loop worker (loop-worker.js) and the launcher hook (hooks/loop-start.cjs) both read it here.

const ON = new Set(["1", "true", "on", "yes"]);

function isLoopEnabled(env) {
  const value = env?.DESK_FACTORY_LOOP;
  return value === undefined || ON.has(String(value).trim().toLowerCase());
}

module.exports = { isLoopEnabled };
