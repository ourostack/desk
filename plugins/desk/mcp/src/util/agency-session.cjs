"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SESSION = /^agency-plugin-[A-Za-z0-9_-]+\.p[1-9][0-9]*$/u;
const SOURCE_ROOT = /^root-[0-9]+$/u;

// Only the current Agency composition is authoritative; never walk ancestors
// or inspect neighboring sessions. Numbered roots preserve acquisition order.
function agencySessionPluginParents(pluginRoot) {
  const parent = path.dirname(path.resolve(pluginRoot));
  const numbered = SOURCE_ROOT.test(path.basename(parent));
  const container = numbered ? path.dirname(parent) : parent;
  if (!SESSION.test(path.basename(container))) return null;
  if (!numbered) return [container];
  try {
    return fs.readdirSync(container, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && SOURCE_ROOT.test(entry.name))
      .sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)))
      .map(entry => path.join(container, entry.name));
  } catch {
    const error = new Error(`desk-mcp: Agency session composition cannot be read: ${container}. Desk does not fall back to another desk.`);
    Object.assign(error, { code: "DESK_ROOT_UNAVAILABLE", path: container, source: "agency-session", problem: "cannot be read", tried: [] });
    throw error;
  }
}

module.exports = { agencySessionPluginParents };
