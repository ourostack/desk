// Which Desk release installed each native runtime capsule and extension source, so that a running provider and extension can be
// ordered against the Desk copy a session runs. Several Desk copies (one per host and release) share one browser, and without an
// order an older copy that started a session later pointed the browser back at its older runtime.
//
// versions.json, private beside the runtime capsules: { version: 1, capsules: { <digest>: <desk version> }, extensions: { ... } }.
// Each entry keeps the newest release that installed it. A digest that no entry names was installed by a Desk copy older than this
// record, and orders before every named release.
import fs from 'node:fs/promises';
import path from 'node:path';

const FILE = 'versions.json';
const DIGEST = /^[a-f0-9]{64}$/u;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

/** Orders two Desk versions as semantic versions; null, or a value that is not one, orders first. */
export function compareVersions(left, right) {
  const a = VERSION.exec(left ?? '');
  const b = VERSION.exec(right ?? '');
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  if (!a[4] || !b[4]) return (a[4] ? -1 : 0) - (b[4] ? -1 : 0);
  const x = a[4].split('.');
  const y = b[4].split('.');
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === undefined || y[index] === undefined) return x[index] === undefined ? -1 : 1;
    const numeric = /^\d+$/u.test(x[index]) && /^\d+$/u.test(y[index]);
    const difference = numeric ? Number(x[index]) - Number(y[index]) : x[index].localeCompare(y[index]);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** The Desk version of the plugin that holds this MCP folder, or null when it cannot be read. */
export async function readDeskVersion(mcpRoot) {
  for (const file of ['plugin.json', '.claude-plugin/plugin.json']) {
    try {
      const version = JSON.parse(await fs.readFile(path.resolve(mcpRoot, '..', file), 'utf8')).version;
      if (VERSION.test(version ?? '')) return version;
    } catch {
      // Try the next manifest.
    }
  }
  return null;
}

export async function readVersions(root) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, FILE), 'utf8'));
    if (value?.version === 1 && value.capsules && value.extensions) return value;
  } catch {
    // No record yet, or an unreadable one: every digest orders as older.
  }
  return { version: 1, capsules: {}, extensions: {} };
}

/** The release that installed a capsule or extension digest, or null when an older Desk copy did. */
export function versionOf(versions, kind, digest) {
  const value = versions?.[kind]?.[digest];
  return typeof value === 'string' && VERSION.test(value) ? value : null;
}

/** Records that `deskVersion` installed these digests. Callers hold the native-extension-update lock. */
export async function recordVersions(root, { capsule, extension, deskVersion }) {
  if (!VERSION.test(deskVersion ?? '')) return;
  const versions = await readVersions(root);
  let changed = false;
  for (const [kind, digest] of [['capsules', capsule], ['extensions', extension]]) {
    if (!DIGEST.test(digest ?? '')) continue;
    if (compareVersions(deskVersion, versions[kind][digest]) > 0) {
      versions[kind][digest] = deskVersion;
      changed = true;
    }
  }
  if (!changed) return;
  const temporary = path.join(root, `.${FILE}.${process.pid}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(versions), { mode: 0o600, flag: 'w' });
  await fs.rename(temporary, path.join(root, FILE));
}
