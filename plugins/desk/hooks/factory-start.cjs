#!/usr/bin/env node
"use strict";

// Started detached, with ignored stdio, by both session-start hooks once their
// output is built (boot-checks.cjs `startFactory`, only when a store has
// `contribute: true`). It runs one sweep of pending session markers and then,
// for every consented store, a flush and a refresh of its open andon issues
// (mcp/src/factory/flush.js `flushConsented`), all within one 120-second
// deadline. It prints nothing and
// always exits 0; a hard stop 30 seconds after the deadline ends a process
// held up outside the flush's own runner boundaries.


const DEADLINE_MS = 120000;
const GRACE_MS = 30000;

async function main({ env = process.env, deadlineMs = DEADLINE_MS } = {}) {
  const { flushConsented, ghRunner } = await import("../mcp/src/factory/flush.js");
  return flushConsented(env, { runner: ghRunner({ env }), deadlineMs });
}

module.exports = { main, DEADLINE_MS, GRACE_MS };

if (require.main === module) {
  setTimeout(() => process.exit(0), DEADLINE_MS + GRACE_MS).unref();
  main().then(() => process.exit(0), () => process.exit(0));
}
