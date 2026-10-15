import { delimiter, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const FIRST_UID = 10_000;
const LAST_UID = 60_000;
const GATEWAY_CAPS = 0xc1n; // chown, setgid, setuid
const SHIM_DIR = fileURLToPath(new URL("../bin", import.meta.url));

function requireValid(condition) {
  if (!condition) throw Object.assign(new Error("Invalid hosted desk isolation input."), { code: "DESK_ISOLATION_INVALID" });
}

function validUid(uid) {
  return Number.isSafeInteger(uid) && uid >= FIRST_UID && uid <= LAST_UID;
}

function requireIdentity(uid, gid) {
  requireValid(validUid(uid) && gid === uid);
}

export function createUidAllocator({ firstUid = FIRST_UID, lastUid = LAST_UID } = {}) {
  requireValid(validUid(firstUid) && validUid(lastUid) && firstUid <= lastUid);
  const allocated = new Map();
  let next = firstUid;
  return (desk) => {
    requireValid(typeof desk === "string" && desk.length > 0 && desk.trim() === desk && !/[\0\r\n]/.test(desk));
    if (allocated.has(desk)) return allocated.get(desk);
    if (next > lastUid) throw Object.assign(new Error("Hosted desk UID capacity exhausted."), { code: "DESK_UID_EXHAUSTED" });
    const uid = next++;
    allocated.set(desk, uid);
    return uid;
  };
}

export function isolationArgs({ uid, gid = uid, command, args = [] }) {
  requireIdentity(uid, gid);
  requireValid(typeof command === "string" && isAbsolute(command) && !command.includes("\0"));
  requireValid(Array.isArray(args) && args.every(arg => typeof arg === "string" && !arg.includes("\0")));
  return [
    `--reuid=${uid}`, `--regid=${gid}`, "--clear-groups",
    "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
    "--", command, ...args,
  ];
}

export function isolatedDeskEnv({ realm, baseEnv, author, issuer }) {
  requireValid(realm !== null && typeof realm === "object");
  requireIdentity(realm.uid, realm.gid);
  requireValid(typeof realm.root === "string" && isAbsolute(realm.root) &&
    realm.root !== "/" && normalize(realm.root) === realm.root && !realm.root.includes("\0"));
  requireValid(baseEnv !== null && typeof baseEnv === "object");
  requireValid(typeof author?.name === "string" && author.name.trim().length > 0 &&
    !/[\0\r\n]/.test(author.name) && typeof author.email === "string" &&
    /^[a-zA-Z0-9.+_-]+@users\.noreply\.github\.com$/.test(author.email));
  const env = {};
  for (const key of ["LANG", "LC_ALL", "TZ"]) {
    if (baseEnv[key] !== undefined) {
      requireValid(typeof baseEnv[key] === "string" && !baseEnv[key].includes("\0"));
      env[key] = baseEnv[key];
    }
  }
  requireValid(baseEnv.PATH === undefined || (typeof baseEnv.PATH === "string" && !baseEnv.PATH.includes("\0")));
  return {
    ...env,
    PATH: [SHIM_DIR, baseEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(delimiter),
    HOME: join(realm.root, "home"),
    USER: `desk-${realm.uid}`,
    TMPDIR: join(realm.root, "tmp"),
    XDG_CONFIG_HOME: join(realm.root, "config"),
    XDG_CACHE_HOME: join(realm.root, "cache"),
    XDG_DATA_HOME: join(realm.root, "data"),
    XDG_STATE_HOME: join(realm.root, "state"),
    GIT_CONFIG_GLOBAL: join(realm.root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    DESK: join(realm.root, "clone"),
    DESK_HOSTED: "1",
    ...(issuer ? { DESK_MCP_ICON_URL: new URL("/assets/desk-logo.png", issuer).href } : {}),
    DESK_TOKEN_SOCKET: join(realm.root, "git-token.sock"),
    GIT_AUTHOR_NAME: author.name,
    GIT_COMMITTER_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

function requireProtected(condition) {
  if (!condition) throw Object.assign(new Error("Hosted desk kernel isolation is not protected."), { code: "DESK_ISOLATION_UNPROTECTED" });
}

function kernelFields(status) {
  requireProtected(typeof status === "string");
  const fields = {};
  for (const name of ["Uid", "Gid", "Groups", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"]) {
    const matches = [...status.matchAll(new RegExp(`^${name}:[\\t ]*([^\\r\\n]*)$`, "gm"))];
    requireProtected(matches.length === 1);
    fields[name] = matches[0][1].trim();
  }
  for (const name of ["Uid", "Gid"]) {
    requireProtected(/^\d+[ \t]+\d+[ \t]+\d+[ \t]+\d+$/.test(fields[name]));
    fields[name] = fields[name].split(/\s+/).map(Number);
    requireProtected(fields[name].every(Number.isSafeInteger));
  }
  requireProtected(/^(?:\d+(?:[ \t]+\d+)*)?$/.test(fields.Groups));
  fields.Groups = fields.Groups ? fields.Groups.split(/\s+/).map(Number) : [];
  requireProtected(fields.Groups.every(Number.isSafeInteger));
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    requireProtected(/^[0-9a-fA-F]{1,16}$/.test(fields[name]));
    fields[name] = BigInt(`0x${fields[name]}`);
  }
  requireProtected(fields.NoNewPrivs === "1");
  return fields;
}

function requireKernelIdentity(fields, uid, gid) {
  requireProtected(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
  requireProtected(fields.Uid.every(value => value === uid) && fields.Gid.every(value => value === gid));
  requireProtected(fields.Groups.every(value => value === gid));
  requireProtected((fields.CapBnd & ~GATEWAY_CAPS) === 0n);
}

export function assertChildKernelBoundary({ status, uid, gid = uid }) {
  requireProtected(validUid(uid) && gid === uid);
  const fields = kernelFields(status);
  requireKernelIdentity(fields, uid, gid);
  requireProtected(["CapInh", "CapPrm", "CapEff", "CapAmb"].every(name => fields[name] === 0n));
}

export function assertGatewayKernelBoundary({ status, uid, gid = uid }) {
  const fields = kernelFields(status);
  requireKernelIdentity(fields, uid, gid);
  requireProtected(uid < FIRST_UID && gid === uid);
  requireProtected(["CapInh", "CapPrm", "CapEff", "CapAmb"].every(name => fields[name] === GATEWAY_CAPS));
}
