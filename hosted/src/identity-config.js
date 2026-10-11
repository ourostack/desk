// The gateway's own reading of its settings that provisioning also needs: the Ouro sign-in settings (spec items 9 to
// 13) and the small helpers they use. Kept free of the gateway's other modules so infra scripts can check a setting
// exactly as the gateway will read it, before writing it to the app.

export const isSet = (value) => typeof value === "string" && value.trim() !== "" && value.trim() !== "unset";

// A key setting's value, or undefined when it is missing or "unset". A key
// holding any whitespace is refused rather than trimmed: the HMAC uses every
// byte, so a stray newline would silently be a different key. The message
// never repeats the value.
export function keySetting(env, name) {
  if (!isSet(env[name])) return undefined;
  if (/\s/.test(env[name])) throw new Error(`${name} contains whitespace; set it to the key alone, with no newline or spaces.`);
  return env[name];
}

export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// The Ouro tenant and the accounts store (spec items 9 to 13). Without any of their settings, as in today's
// production, the gateway runs as it always has: GitHub sign-in for DESK_ALLOWED_LOGINS. With them, every setting in
// IDENTITY_REQUIRED must be set; a partial set is refused, so a typo can't quietly leave the old sign-in running.
const IDENTITY_REQUIRED = ["DESK_ENTRA_TENANT_ID", "DESK_ENTRA_SUBDOMAIN", "DESK_ENTRA_CLIENT_ID", "DESK_ENTRA_CLIENT_SECRET", "DESK_ACCOUNTS_ENDPOINT"];
const IDENTITY_OPTIONAL = ["DESK_GITHUB_SIGNIN", "DESK_GITHUB_ACCOUNTS", "DESK_GITHUB_LOGINS", "DESK_LEGACY_CUTOFF"];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// `<GitHub user id>=<value>,...` as a Map keyed by the numeric id.
function userIdMap(env, name, valuePattern) {
  const map = new Map();
  if (!isSet(env[name])) return map;
  for (const entry of env[name].split(",").map((part) => part.trim()).filter(Boolean)) {
    const [id, value, extra] = entry.split("=");
    const userId = /^\d{1,15}$/.test(id ?? "") ? Number(id) : NaN;
    if (!Number.isSafeInteger(userId) || userId <= 0 || !valuePattern.test(value ?? "") || extra !== undefined || map.has(userId)) {
      throw new Error(`${name} must be a comma-separated list of <GitHub user id>=<value>, each id once.`);
    }
    map.set(userId, value);
  }
  return map;
}

export function readIdentity(env, publicUrl) {
  const present = [...IDENTITY_REQUIRED, ...IDENTITY_OPTIONAL].filter((name) => isSet(env[name]));
  if (present.length === 0) return null;
  const missing = IDENTITY_REQUIRED.filter((name) => !isSet(env[name]));
  if (missing.length) throw new Error(`Ouro sign-in is partly configured (${present.join(", ")} set); also set ${missing.join(", ")}.`);
  if (!GUID.test(env.DESK_ENTRA_TENANT_ID)) throw new Error("DESK_ENTRA_TENANT_ID must be the tenant's id, a GUID.");
  if (!GUID.test(env.DESK_ENTRA_CLIENT_ID)) throw new Error("DESK_ENTRA_CLIENT_ID must be the gateway app's client id, a GUID.");
  const clientSecret = keySetting(env, "DESK_ENTRA_CLIENT_SECRET");

  const signIn = isSet(env.DESK_GITHUB_SIGNIN) ? env.DESK_GITHUB_SIGNIN.trim() : "off";
  if (signIn !== "on" && signIn !== "off") throw new Error("DESK_GITHUB_SIGNIN must be on or off.");

  const accounts = userIdMap(env, "DESK_GITHUB_ACCOUNTS", ACCOUNT_ID);
  const logins = userIdMap(env, "DESK_GITHUB_LOGINS", GITHUB_LOGIN);
  const ids = (map) => [...map.keys()].sort().join(",");
  if (ids(accounts) !== ids(logins)) throw new Error("DESK_GITHUB_LOGINS must name the GitHub login of exactly the user ids in DESK_GITHUB_ACCOUNTS.");
  const byUserId = new Map([...accounts].map(([userId, accountId]) => [userId, { login: logins.get(userId), accountId }]));

  let cutoff = null;
  if (isSet(env.DESK_LEGACY_CUTOFF)) {
    if (!ISO_TIME.test(env.DESK_LEGACY_CUTOFF) || Number.isNaN(Date.parse(env.DESK_LEGACY_CUTOFF))) {
      throw new Error("DESK_LEGACY_CUTOFF must be an ISO time with its zone, such as 2026-11-15T00:00:00Z.");
    }
    cutoff = new Date(env.DESK_LEGACY_CUTOFF);
  }

  return {
    tenantId: env.DESK_ENTRA_TENANT_ID,
    subdomain: env.DESK_ENTRA_SUBDOMAIN,
    clientId: env.DESK_ENTRA_CLIENT_ID,
    clientSecret,
    callbackUrl: `${publicUrl}/oauth/entra/callback`,
    accountsEndpoint: env.DESK_ACCOUNTS_ENDPOINT,
    azureClientId: isSet(env.AZURE_CLIENT_ID) ? env.AZURE_CLIENT_ID : undefined,
    githubSignIn: signIn === "on",
    legacy: { byUserId, cutoff },
    allowedLoginsIgnored: isSet(env.DESK_ALLOWED_LOGINS),
  };
}
