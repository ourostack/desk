"use strict";

function createPageInitializer(options) {
  const initialized = new WeakSet();
  const initializing = new WeakMap();
  const wrappedContexts = new WeakSet();
  const { leaseId, owner, request } = options;
  if (typeof leaseId !== "string" || !leaseId || typeof owner !== "string" || !owner || typeof request !== "function") {
    throw new Error("browser_owner_identity_missing");
  }
  async function install(page, state) {
    const targetId = await page.evaluate(() => globalThis.__deskNativeTargetId);
    if (state.expired) throw new Error("browser_owner_initialization_timeout");
    if (typeof targetId !== "string" || !targetId.startsWith(leaseId + ":")) {
      throw new Error("browser_owner_target_mismatch");
    }
    if (initialized.has(page)) return;
    if (Object.hasOwn(page, "deskBrowserOwner")) throw new Error("browser_owner_page_api_conflict");
    const helper = Object.freeze({
      newPage(...args) {
        return page.context().newPage(...args);
      },
      async labelTask(work) {
        if (work !== null && (typeof work !== "string" || !work.trim() || work.length > 160 || /[\x00-\x1f\x7f]/u.test(work))) {
          throw new Error("browser_owner_work_invalid");
        }
        const fresh = await page.evaluate(() => globalThis.__deskNativeTargetId);
        if (fresh !== targetId) throw new Error("browser_owner_target_mismatch");
        return request("purpose", { leaseId, owner, targetId, work });
      },
      peers() {
        return request("peers", { leaseId, owner });
      },
      async peek(options) {
        if (!options || typeof options.leaseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(options.leaseId) ||
            typeof options.targetId !== "string" || !options.targetId.startsWith(options.leaseId + ":") ||
            !["snapshot", "screenshot"].includes(options.format)) {
          throw new Error("browser_owner_peek_invalid");
        }
        return request("peek", {
          leaseId, owner, peerLeaseId: options.leaseId, targetId: options.targetId, format: options.format,
        });
      },
    });
    Object.defineProperty(page, "deskBrowserOwner", { value: helper, configurable: false, writable: false });
    initialized.add(page);
  }
  function initialize({ page }) {
    const context = typeof page.context === "function" ? page.context() : undefined;
    if (context && !wrappedContexts.has(context)) {
      const descriptor = Object.getOwnPropertyDescriptor(context, "newPage");
      if (typeof context.newPage !== "function" || !Object.isExtensible(context) ||
          (descriptor && descriptor.configurable === false)) {
        throw new Error("browser_owner_new_page_api_conflict");
      }
      const original = context.newPage;
      Object.defineProperty(context, "newPage", {
        configurable: false, writable: false,
        value: async function (...args) {
          const created = await original.apply(this, args);
          await initialize({ page: created });
          return created;
        },
      });
      wrappedContexts.add(context);
    }
    if (initialized.has(page)) return Promise.resolve();
    if (initializing.has(page)) return initializing.get(page);
    let timer;
    const state = { expired: false };
    const operation = Promise.race([
      install(page, state),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          state.expired = true;
          reject(new Error("browser_owner_initialization_timeout"));
        }, 10000);
      }),
    ]).finally(() => clearTimeout(timer));
    initializing.set(page, operation);
    return operation;
  }
  return initialize;
}

async function providerRequest(endpoint, operation, payload) {
  const response = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation, payload }), signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  if (!response.ok || value.ok !== true) throw new Error(value.error?.code || "NATIVE_PROVIDER_REQUEST_FAILED");
  return value.result;
}

const lazy = new WeakMap();
module.exports = async function initialize(options) {
  let initialize = lazy.get(options.page.context());
  if (!initialize) {
    initialize = createPageInitializer({
      leaseId: process.env.DESK_NATIVE_LEASE_ID, owner: process.env.DESK_BROWSER_OWNER,
      request: (operation, payload) => providerRequest(process.env.DESK_NATIVE_PROVIDER_URL, operation, payload),
    });
    lazy.set(options.page.context(), initialize);
  }
  return initialize(options);
};
module.exports.createPageInitializer = createPageInitializer;
module.exports.default = module.exports;
