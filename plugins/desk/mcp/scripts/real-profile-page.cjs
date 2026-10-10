"use strict";

const { randomBytes } = require("node:crypto");
const BRIDGE = "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html";

function createPageInitializer(owner) {
  const contexts = new WeakMap();
  return async function initialize({ page }) {
    if (typeof owner !== "string" || !owner) throw new Error("browser_owner_identity_missing");
    const context = page.context();
    let state = contexts.get(context);
    if (!state) {
      if (!page.url().startsWith(BRIDGE + "?")) throw new Error("browser_owner_bridge_missing");
      state = { control: null, url: BRIDGE + "#desk-owner-control-" + randomBytes(12).toString("hex"), ready: null, created: null, creating: false, scope: null };
      contexts.set(context, state);
      context.once("close", () => contexts.delete(context));
      state.ready = (async () => {
        const scope = await page.evaluate(async expected => {
          const tab = await chrome.tabs.getCurrent();
          const status = await chrome.runtime.sendMessage({ type: "getConnectionStatus" });
          const own = status.connections.filter(c => c.connectedTabIds.includes(tab.id));
          if (own.length !== 1 || own[0].clientName !== expected || tab.groupId < 0) throw new Error("browser_owner_connection_mismatch");
          return { tabId: tab.id, windowId: tab.windowId, groupId: tab.groupId };
        }, owner);
        state.scope = scope;
        // Create through the extension API with an exact window ID; no active
        // window lookup, browser-global attachment, or focus change is needed.
        const appeared = context.waitForEvent("page", { predicate: candidate => candidate.url() === state.url, timeout: 10000 });
        state.creating = true;
        const create = page.evaluate(async data => {
          const tab = await chrome.tabs.create({ windowId: data.scope.windowId, active: false, url: data.url });
          await chrome.tabs.group({ groupId: data.scope.groupId, tabIds: [tab.id] });
          return tab.id;
        }, { scope, url: state.url }).then(id => { state.created = id; return id; });
        const [created, control] = await Promise.all([create, appeared]);
        await control.waitForURL(state.url, { timeout: 10000 });
        await control.evaluate(async data => {
          const tab = await chrome.tabs.getCurrent();
          if (tab.id !== data.created || tab.windowId !== data.scope.windowId || tab.groupId !== data.scope.groupId) throw new Error("browser_owner_control_mismatch");
          document.title = "Desk browser owner control";
          document.body.textContent = "Desk uses this owned tab to keep task pages responsive without activating browser windows. Keep it open until browser_close.";
        }, { created, scope });
        state.control = control;
      })().catch(async error => {
        if (!state.creating) {
          contexts.delete(context);
        } else if (state.created !== null && !page.isClosed() && page.url().startsWith(BRIDGE + "?")) {
          try {
            const absent = await page.evaluate(async data => {
              let tab;
              try { tab = await chrome.tabs.get(data.id); }
              catch (error) {
                if (/No tab with id:/.test(String(error.message))) return true;
                throw error;
              }
              if (tab.windowId !== data.scope.windowId || tab.groupId !== data.scope.groupId) throw new Error("browser_owner_control_cleanup_mismatch");
              await chrome.tabs.remove(tab.id);
              try { await chrome.tabs.get(tab.id); return false; }
              catch (error) {
                if (/No tab with id:/.test(String(error.message))) return true;
                throw error;
              }
            }, { id: state.created, scope: state.scope });
            if (absent) contexts.delete(context);
          } catch (cleanupError) {
            throw new Error("browser_owner_control_cleanup_unverified", { cause: cleanupError });
          }
        }
        throw error;
      });
    }
    if (page.url() === state.url) return;
    await state.ready;
    if (state.control.isClosed() || state.control.url() !== state.url) throw new Error("browser_owner_control_missing");
    const key = "__desk_owner_" + randomBytes(12).toString("hex");
    await page.evaluate(key => Object.defineProperty(globalThis, key, { value: true, configurable: true }), key);
    try {
      await state.control.evaluate(async data => {
        const control = await chrome.tabs.getCurrent();
        const status = await chrome.runtime.sendMessage({ type: "getConnectionStatus" });
        const own = status.connections.filter(c => c.connectedTabIds.includes(control.id));
        if (own.length !== 1 || own[0].clientName !== data.owner) throw new Error("browser_owner_connection_mismatch");
        const matches = [];
        for (const id of own[0].connectedTabIds) {
          const value = await chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", {
            expression: "globalThis[" + JSON.stringify(data.key) + "] === true", returnByValue: true
          });
          if (value.result.value === true) matches.push(id);
        }
        if (matches.length !== 1) throw new Error("browser_owner_target_ambiguous");
        const target = await chrome.tabs.get(matches[0]);
        if (target.windowId !== control.windowId || target.groupId !== control.groupId) throw new Error("browser_owner_target_mismatch");
        // This changes only the owned renderer's active/visible state. It does
        // not activate a browser window or grant user-gesture permissions.
        await chrome.debugger.sendCommand({ tabId: target.id }, "Emulation.setFocusEmulationEnabled", { enabled: true });
      }, { key, owner });
    } finally {
      if (!page.isClosed()) await page.evaluate(key => { delete globalThis[key]; }, key);
    }
  };
}

module.exports = {
  createPageInitializer,
  default: createPageInitializer(process.env.DESK_BROWSER_OWNER)
};
