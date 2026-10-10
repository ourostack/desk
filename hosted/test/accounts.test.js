// The accounts store, its 60-second account cache, and invites. The store suite runs against the in-memory store
// and, with DESK_AZURITE=1, the same suite against the Table store on Azurite, whose conditional updates are real.
// Test names carry `[memory]` or `[azurite]` so CI can count the Azurite tests that ran.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createMemoryStore } from "../src/accounts/memory-store.js";
import { createTableStore } from "../src/accounts/store.js";
import { createAccountCache, StoreUnavailable } from "../src/accounts/cache.js";
import { newInvite, hashToken, seed, issueInvite, INVITE_TTL_MS } from "../src/accounts/invites.js";
import { azuriteFromEnv } from "./fixtures/azurite.mjs";

const azurite = await azuriteFromEnv();

const NOW = Date.parse("2026-11-01T00:00:00Z");
const TID = randomUUID();
const BINDING = { kind: "github", repo: "arimendelow/desk", installationId: 12345678, author: { name: "Ari Mendelow", email: "16390116+arimendelow@users.noreply.github.com" } };

// A fresh identity per call, so suites sharing one Azurite never collide.
const identity = () => ({ tid: TID, oid: randomUUID() });

// Holds every caller at `step` until `count` callers have reached it, so concurrent redemptions really overlap.
function barrier(step, count) {
  const waiting = [];
  let open = false;
  return async (name) => {
    if (name !== step || open) return;
    await new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length === count) {
        open = true;
        waiting.forEach((go) => go());
      }
    });
  };
}

async function seededInvite(store, { ttlMs = INVITE_TTL_MS, now = NOW } = {}) {
  const { accountId } = await seed({ store, displayName: "Test account", binding: BINDING });
  const { token } = await issueInvite({ store, accountId, ttlMs, now });
  return { accountId, token, tokenHash: hashToken(token) };
}

function storeSuite(label, make) {
  const name = (text) => `${label} ${text}`;
  const skip = make === null && "set DESK_AZURITE=1 with Azurite running to run the Table store suite";

  describe(`${label} accounts store`, { skip }, () => {
    test(name('two concurrent redemptions of one invite give exactly one accountId and one refused "used"'), async () => {
      // Both redemptions read the invite (and its ETag) before either claims it, so exactly one conditional update wins.
      const store = await make({ onStep: barrier("invite-read", 2) });
      const { accountId, tokenHash } = await seededInvite(store);
      const [a, b] = [identity(), identity()];
      const results = await Promise.all([a, b].map((who) => store.redeemInvite({ tokenHash, ...who, now: NOW })));
      const won = results.filter((result) => result.accountId !== undefined);
      assert.equal(won.length, 1, JSON.stringify(results));
      assert.equal(won[0].accountId, accountId);
      assert.deepEqual(results.filter((result) => result.refused), [{ refused: "used" }]);
      const mapped = await Promise.all([a, b].map((who) => store.findIdentity(who.tid, who.oid)));
      assert.deepEqual(mapped.filter(Boolean), [accountId], "exactly one identity is mapped");
      assert.equal((await store.getInvite(tokenHash)).redeemed, true);
    });

    test(name("many concurrent redemptions of one invite map exactly one identity"), async () => {
      const store = await make();
      const { accountId, tokenHash } = await seededInvite(store);
      const who = Array.from({ length: 6 }, identity);
      const results = await Promise.all(who.map((id) => store.redeemInvite({ tokenHash, ...id, now: NOW })));
      assert.equal(results.filter((result) => result.accountId === accountId).length, 1, JSON.stringify(results));
      assert.equal(results.filter((result) => result.refused === "used").length, 5, JSON.stringify(results));
      const mapped = await Promise.all(who.map((id) => store.findIdentity(id.tid, id.oid)));
      assert.equal(mapped.filter(Boolean).length, 1);
    });

    test(name("an identity that already has an account can't redeem an invite"), async () => {
      const store = await make();
      const first = await seededInvite(store);
      const second = await seededInvite(store);
      const who = identity();
      assert.deepEqual(await store.redeemInvite({ tokenHash: first.tokenHash, ...who, now: NOW }), { accountId: first.accountId });
      assert.deepEqual(await store.redeemInvite({ tokenHash: second.tokenHash, ...who, now: NOW }), { refused: "identity_has_account" });
      assert.equal(await store.findIdentity(who.tid, who.oid), first.accountId, "the mapping is unchanged");
      // The refused attempt didn't use up the second invite.
      const other = identity();
      assert.deepEqual(await store.redeemInvite({ tokenHash: second.tokenHash, ...other, now: NOW }), { accountId: second.accountId });
    });

    test(name("an expired invite and an unknown token are refused"), async () => {
      const store = await make();
      const { tokenHash } = await seededInvite(store, { ttlMs: 60_000 });
      const who = identity();
      assert.deepEqual(await store.redeemInvite({ tokenHash, ...who, now: NOW + 60_000 }), { refused: "expired" });
      assert.deepEqual(await store.redeemInvite({ tokenHash: newInvite().tokenHash, ...who, now: NOW }), { refused: "unknown" });
      assert.equal(await store.findIdentity(who.tid, who.oid), null);
      // One millisecond earlier it was still good.
      const { accountId } = await store.getInvite(tokenHash);
      assert.deepEqual(await store.redeemInvite({ tokenHash, ...who, now: NOW + 59_999 }), { accountId });
    });

    test(name("a used invite is refused for another identity and answers again for its own"), async () => {
      const store = await make();
      const { accountId, tokenHash } = await seededInvite(store);
      const who = identity();
      assert.deepEqual(await store.redeemInvite({ tokenHash, ...who, now: NOW }), { accountId });
      assert.deepEqual(await store.redeemInvite({ tokenHash, ...identity(), now: NOW }), { refused: "used" });
      assert.deepEqual(await store.redeemInvite({ tokenHash, ...who, now: NOW + INVITE_TTL_MS * 2 }), { accountId });
    });

    test(name("the invites table holds the token's hash and never the token"), async () => {
      const store = await make();
      const { token, tokenHash } = await seededInvite(store);
      const check = async () => {
        const rows = await store.tables.list("invites");
        const text = JSON.stringify(rows);
        assert.ok(rows.some((row) => row.partitionKey === tokenHash), "the invite is keyed by its hash");
        assert.ok(!text.includes(token), "the token is nowhere in the table");
      };
      await check();
      await store.redeemInvite({ tokenHash, ...identity(), now: NOW });
      await check();
      assert.equal(tokenHash, createHash("sha256").update(token).digest("base64url"));
    });

    test(name("a redemption interrupted after the claim completes on retry by the same identity and is refused for any other"), async () => {
      for (const step of ["claimed", "identity-created"]) {
        let interrupt = true;
        const store = await make({
          onStep: async (name) => {
            if (name === step && interrupt) {
              interrupt = false;
              throw new Error(`interrupted at ${step}`);
            }
          },
        });
        const { accountId, tokenHash } = await seededInvite(store);
        const who = identity();
        await assert.rejects(store.redeemInvite({ tokenHash, ...who, now: NOW }), /interrupted/);
        assert.deepEqual(await store.redeemInvite({ tokenHash, ...identity(), now: NOW }), { refused: "used" }, step);
        // The retry may come after the invite's expiry: the claim was made in time.
        assert.deepEqual(await store.redeemInvite({ tokenHash, ...who, now: NOW + INVITE_TTL_MS + 1 }), { accountId }, step);
        assert.equal(await store.findIdentity(who.tid, who.oid), accountId, step);
        assert.equal((await store.getInvite(tokenHash)).redeemed, true, step);
        assert.deepEqual(await store.redeemInvite({ tokenHash, ...identity(), now: NOW }), { refused: "used" }, step);
      }
    });

    test(name("an identity mapped elsewhere while its claim was in flight releases the invite"), async () => {
      let other;
      let store;
      store = await make({
        onStep: async (step) => {
          // Between the claim and the identity row, the same identity gets an account through another invite.
          if (step === "claimed" && other) {
            const pending = other;
            other = null;
            assert.deepEqual(await store.redeemInvite({ tokenHash: pending.tokenHash, ...pending.who, now: NOW }), { accountId: pending.accountId });
          }
        },
      });
      const first = await seededInvite(store);
      const second = await seededInvite(store);
      const who = identity();
      other = { ...second, who };
      assert.deepEqual(await store.redeemInvite({ tokenHash: first.tokenHash, ...who, now: NOW }), { refused: "identity_has_account" });
      assert.equal(await store.findIdentity(who.tid, who.oid), second.accountId);
      assert.deepEqual(await store.redeemInvite({ tokenHash: first.tokenHash, ...identity(), now: NOW }), { accountId: first.accountId }, "the first invite is free again");
    });

    test(name("accounts, identities and bindings round-trip"), async () => {
      const store = await make();
      const accountId = randomUUID();
      assert.equal(await store.getAccount(accountId), null);
      assert.equal(await store.getBinding(accountId), null);
      assert.equal(await store.findIdentity(TID, randomUUID()), null);
      await store.putAccount({ accountId, displayName: "Someone", deskAccess: true });
      assert.deepEqual(await store.getAccount(accountId), { accountId, displayName: "Someone", deskAccess: true });
      await store.putAccount({ accountId, displayName: "Someone", deskAccess: false });
      assert.deepEqual(await store.getAccount(accountId), { accountId, displayName: "Someone", deskAccess: false });
      await store.putBinding(accountId, BINDING);
      assert.deepEqual(await store.getBinding(accountId), BINDING);
      const { installationId, ...noInstallation } = BINDING;
      await store.putBinding(accountId, noInstallation);
      assert.deepEqual(await store.getBinding(accountId), noInstallation);
    });

    test(name("a hosted binding is refused"), async () => {
      const store = await make();
      const accountId = randomUUID();
      await assert.rejects(store.putBinding(accountId, { kind: "hosted", deskId: "d1" }), /hosted/);
      assert.equal(await store.getBinding(accountId), null);
      // A hosted row written by something else is refused on read too, not treated as a GitHub desk.
      await store.tables.upsert("bindings", { partitionKey: accountId, rowKey: "", kind: "hosted", deskId: "d1" });
      await assert.rejects(store.getBinding(accountId), /hosted/);
      for (const bad of [{ ...BINDING, repo: "no-owner" }, { ...BINDING, author: { name: "x" } }, { ...BINDING, installationId: -1 }, { ...BINDING, kind: "gitlab" }]) {
        await assert.rejects(store.putBinding(accountId, bad), undefined, JSON.stringify(bad));
      }
    });

    test(name("keys that Table Storage can't hold are refused before any call"), async () => {
      const store = await make();
      for (const bad of ["a/b", "a#b", "a?b", "a\\b", "", "x".repeat(200)]) {
        await assert.rejects(store.getAccount(bad), TypeError, JSON.stringify(bad));
        await assert.rejects(store.findIdentity(bad, "oid"), TypeError, JSON.stringify(bad));
        await assert.rejects(store.redeemInvite({ tokenHash: bad, tid: TID, oid: "o", now: NOW }), TypeError, JSON.stringify(bad));
      }
    });
  });
}

storeSuite("[memory]", async (options) => createMemoryStore(options));
storeSuite(
  "[azurite]",
  azurite &&
    (async (options) => {
      const store = createTableStore({ ...azurite, ...options });
      await store.ensureTables();
      return store;
    }),
);

describe("Azurite in CI", () => {
  test("the run fails if DESK_AZURITE is set and Azurite isn't reachable", async () => {
    // A port nothing listens on.
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    await assert.rejects(azuriteFromEnv({ DESK_AZURITE: "1", DESK_AZURITE_ENDPOINT: `http://127.0.0.1:${port}/devstoreaccount1` }), /DESK_AZURITE=1 but Azurite isn't reachable/);
    assert.equal(await azuriteFromEnv({}), null, "without DESK_AZURITE the Table suite is skipped, not failed");
  });

  test("the Table store refuses a plain-HTTP endpoint other than loopback", () => {
    assert.throws(() => createTableStore({ endpoint: "http://stouroaccounts261e0b.table.core.windows.net", credential: {} }), /https/);
    assert.doesNotThrow(() => createTableStore({ endpoint: "https://stouroaccounts261e0b.table.core.windows.net", credential: {} }));
  });
});

// A store whose getAccount answers from `rows` or throws while `down` is set.
function fakeStore(rows) {
  const store = {
    down: false,
    reads: 0,
    async getAccount(accountId) {
      store.reads += 1;
      if (store.down) throw new Error("store unreachable");
      return rows.get(accountId) ?? null;
    },
  };
  return store;
}

const account = (accountId, deskAccess = true) => ({ accountId, displayName: "Someone", deskAccess });

describe("account cache", () => {
  test("the cache serves a row 60 s old when the store throws and throws StoreUnavailable at 61 s", async () => {
    let clock = NOW;
    const store = fakeStore(new Map([["acc-1", account("acc-1")]]));
    const cache = createAccountCache({ store, now: () => clock });
    assert.deepEqual(await cache.account("acc-1"), account("acc-1"));
    store.down = true;
    clock = NOW + 60_000;
    assert.deepEqual(await cache.account("acc-1"), account("acc-1"));
    clock = NOW + 61_000;
    await assert.rejects(cache.account("acc-1"), StoreUnavailable);
    // Once the store answers again, so does the cache.
    store.down = false;
    assert.deepEqual(await cache.account("acc-1"), account("acc-1"));
  });

  test("the cache reads the store at most once per maxAgeMs for a row", async () => {
    let clock = NOW;
    const store = fakeStore(new Map([["acc-1", account("acc-1")]]));
    const cache = createAccountCache({ store, now: () => clock });
    await cache.account("acc-1");
    clock = NOW + 59_999;
    await cache.account("acc-1");
    assert.equal(store.reads, 1);
    clock = NOW + 60_000;
    await cache.account("acc-1");
    assert.equal(store.reads, 2);
    // A fresh read is forced on request (the access sweep), still falling back to a row within maxAgeMs.
    await cache.account("acc-1", { fresh: true });
    assert.equal(store.reads, 3);
    store.down = true;
    clock = NOW + 90_000;
    assert.deepEqual(await cache.account("acc-1", { fresh: true }), account("acc-1"));
  });

  test("the cache never serves a row it has not read", async () => {
    let clock = NOW;
    const store = fakeStore(new Map([["acc-1", account("acc-1")], ["acc-2", account("acc-2")]]));
    const cache = createAccountCache({ store, now: () => clock });
    store.down = true;
    await assert.rejects(cache.account("acc-1"), StoreUnavailable, "nothing cached yet");
    store.down = false;
    await cache.account("acc-1");
    store.down = true;
    await assert.rejects(cache.account("acc-2"), StoreUnavailable, "another account's row is not this one's");
    cache.forget("acc-1");
    await assert.rejects(cache.account("acc-1"), StoreUnavailable, "a forgotten row is gone");
    const error = await cache.account("acc-1").catch((caught) => caught);
    assert.equal(error.name, "StoreUnavailable");
    assert.ok(!error.message.includes("Someone"), "the error names no display name");
  });

  test("a fresh read showing deskAccess false is returned, not the cached true, after maxAgeMs", async () => {
    let clock = NOW;
    const rows = new Map([["acc-1", account("acc-1", true)]]);
    const cache = createAccountCache({ store: fakeStore(rows), now: () => clock });
    assert.equal((await cache.account("acc-1")).deskAccess, true);
    rows.set("acc-1", account("acc-1", false));
    clock = NOW + 60_000;
    assert.equal((await cache.account("acc-1")).deskAccess, false);
  });

  test("a missing account is null, and a slow older read never replaces a newer one", async () => {
    let clock = NOW;
    const pending = [];
    const store = {
      async getAccount(accountId) {
        if (accountId === "nobody") return null;
        return new Promise((resolve) => pending.push(resolve));
      },
    };
    const cache = createAccountCache({ store, now: () => clock });
    assert.equal(await cache.account("nobody"), null);
    const older = cache.account("acc-1", { fresh: true });
    clock = NOW + 1;
    const newer = cache.account("acc-1", { fresh: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 2);
    pending[1](account("acc-1", false));
    assert.equal((await newer).deskAccess, false);
    pending[0](account("acc-1", true));
    assert.equal((await older).deskAccess, false, "the older read answers with the newer row");
    assert.equal((await cache.account("acc-1")).deskAccess, false, "and the newer row stays cached");
  });
});

describe("invites", () => {
  test("newInvite makes a 32-byte base64url token and its SHA-256 hash", () => {
    const { token, tokenHash } = newInvite();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.equal(tokenHash, createHash("sha256").update(token).digest("base64url"));
    assert.equal(hashToken(token), tokenHash);
    assert.notEqual(newInvite().token, token);
  });

  test("seed creates an account with Desk access on and its binding", async () => {
    const store = createMemoryStore();
    const { accountId } = await seed({ store, displayName: "Ari", binding: BINDING });
    assert.match(accountId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await store.getAccount(accountId), { accountId, displayName: "Ari", deskAccess: true });
    assert.deepEqual(await store.getBinding(accountId), BINDING);
  });

  test("issueInvite lasts 7 days by default, stores only the hash and refuses an unknown account", async () => {
    const store = createMemoryStore();
    const { accountId } = await seed({ store, displayName: "Ari", binding: BINDING });
    const { token } = await issueInvite({ store, accountId, now: NOW });
    assert.equal(INVITE_TTL_MS, 7 * 24 * 3600 * 1000);
    assert.deepEqual(await store.getInvite(hashToken(token)), { accountId, expiresAt: NOW + INVITE_TTL_MS, redeemed: false });
    await assert.rejects(issueInvite({ store, accountId: randomUUID(), now: NOW }), /no account/);
    await assert.rejects(issueInvite({ store, accountId, ttlMs: 0, now: NOW }), /ttlMs/);
  });
});
