#!/usr/bin/env node
// The daily identity checks and the monthly Apple client-secret renewal for one Ouro tenant, run by
// .github/workflows/identity-checks.yml (and by hand under the operator's az sign-in).
//
//   node hosted/infra/identity-checks.mjs --env test|prod [--renew-apple] [--alert-file <path>]
//       Refuses to run unless az's current account is in the tenant identity-<env>.json records. Then, with
//       --renew-apple (outcome A only), PATCHes the Apple provider with the other key slot, read inside this process,
//       unless that slot is revoked or missing: then it re-sends the live slot and alerts. apple-renewed-at is
//       written only after Graph accepts a PATCH that changes the slot. Then it checks:
//         entra-client-secret   the gateway app's newest client secret ends more than 30 days from now
//         apple-secret-age      the Apple client secret (six months from apple-renewed-at) ends more than 30 days out
//         legacy-cutoff         (prod) DESK_LEGACY_CUTOFF is set on the app once releasedAt is more than a day old
//       Any failure exits 1 with one line on stderr. --alert-file then holds the alert: check names and dates only,
//       because the issue it becomes is public.
//   node hosted/infra/identity-checks.mjs --env test|prod --record-apple-upload a|b
//       Outcome B: after a manual admin-center upload, records that slot and the time once Graph's Apple provider
//       shows that slot's Key ID, so the daily check counts the six months from the upload.
//
// Graph calls go to az's current account, which must be the Ouro tenant (the automation app in the workflow); Key
// Vault and Container Apps calls name the subscription, which selects the id-ouro-identity-checks sign-in. Nothing
// here calls Graph in the subscription's own tenant. Every call goes through `runner`, so tests replace it. No key,
// secret, hint or accountId is ever an argument or printed.
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { APPLE_RENEWED_TAG, ENVIRONMENTS, SUBSCRIPTION, APPS_RESOURCE_GROUP, VAULT, appleActiveSecretName, appleActiveSetArgs, appleKeySecretName, environment, loadRecord } from "./identity-record.mjs";
import { defaultRunner, trimOneNewline } from "./runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = "https://graph.microsoft.com/v1.0/";
const SUB = ["--subscription", SUBSCRIPTION];
const APPLE_TYPE = "#microsoft.graph.appleManagedIdentityProvider";
const DAY = 24 * 3600 * 1000;
const WARN_DAYS = 30;
// Entra's Apple client secret, generated from the key, lasts six months.
const APPLE_SECRET_MONTHS = 6;
const SLOTS = ["a", "b"];

// Every line an alert or a check result can say, by check and result code. `{date}` is the only variable part, so the
// alert (a public issue) never carries an id, a key or an error text.
export const ALERT_PHRASES = {
  "graph-tenant": {
    ok: "az's current account is in this env's Ouro tenant",
    "wrong-tenant": "az's current account is not in this env's Ouro tenant; nothing else was checked",
    unrecorded: "identity-<env>.json records no tenant id; nothing else was checked",
    unreadable: "az's current account could not be read; nothing else was checked",
  },
  "entra-client-secret": {
    ok: "the newest client secret ends {date}",
    "ends-soon": "the newest client secret ends {date}, within 30 days",
    ended: "the newest client secret ended {date}",
    none: "the gateway app has no client secret",
    unrecorded: "identity-<env>.json records no gateway app",
    unreadable: "the gateway app could not be read",
  },
  "apple-secret-age": {
    ok: "renewed {date}; the client secret lasts until about {date}",
    "ends-soon": "renewed {date}; the client secret ends about {date}, within 30 days",
    ended: "renewed {date}; the client secret ended about {date}",
    unrecorded: "no renewal or upload date is recorded",
    unreadable: "the renewal date could not be read",
  },
  "legacy-cutoff": {
    ok: "DESK_LEGACY_CUTOFF is set",
    "not-released": "no release is recorded yet",
    "not-due": "released {date}; the cutoff is due a day later",
    "no-mappings": "the app maps no GitHub accounts, so no cutoff is needed",
    missing: "released {date}, and DESK_LEGACY_CUTOFF is still not set",
    unreadable: "the app's settings could not be read",
  },
  "apple-renewal": {
    renewed: "sent the other key slot on {date}",
    "resent-live": "the next key slot is revoked or missing; re-sent the live slot on {date}, and the renewal date is unchanged",
    "renewed-unrecorded": "sent the other key slot on {date}, but the renewal date could not be recorded",
    refused: "Graph refused the update; the renewal date is unchanged",
    "no-usable-slot": "neither key slot is usable; nothing was sent",
    "live-unknown": "the Apple provider uses neither recorded key; nothing was sent",
    "not-outcome-a": "renewal runs only under outcome A; nothing was sent",
    unreadable: "failed before it finished; see the run log",
  },
  "apple-upload": {
    recorded: "recorded the upload on {date}",
    mismatch: "the Apple provider doesn't use that slot's key; nothing was recorded",
    unreadable: "failed before it finished; see the run log",
  },
};

const OK_CODES = new Set(["ok", "renewed", "recorded", "not-released", "not-due", "no-mappings"]);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const result = (check, code, dates = [], detail = undefined) => ({ check, ok: OK_CODES.has(code), code, dates, ...(detail ? { detail } : {}) });

export function phrase({ check, code, dates = [] }) {
  let index = 0;
  return (ALERT_PHRASES[check]?.[code] ?? ALERT_PHRASES[check]?.unreadable ?? "failed").replace(/\{date\}/g, () => dates[index++] ?? "?");
}

// The issue text: a heading with the env and the day, then one line per failing check. Built only from phrases.
export function alertText({ env, now, results }) {
  const lines = results.filter(({ ok }) => !ok).map((entry) => `- ${entry.check}: ${phrase(entry)}`);
  return `Identity checks for ${env === "prod" ? "prod" : "test"} failed on ${day(now)}.\n\n${lines.join("\n")}\n`;
}

const isNotFound = (error) => /NotFound|not found|HTTP 404|\(404\)/i.test(`${error?.stderr ?? ""} ${error?.message ?? ""}`);
const addMonths = (ms, months) => {
  const date = new Date(ms);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
};

async function out(ctx, args, input) {
  return (await ctx.runner("az", args, input === undefined ? undefined : { input })).stdout ?? "";
}
async function azJson(ctx, args) {
  const text = (await out(ctx, args)).trim();
  return text ? JSON.parse(text) : null;
}
const graphGet = (ctx, path) => azJson(ctx, ["rest", "--method", "get", "--url", `${GRAPH}${path}`]);

// Error text for the run log only: the command's own first line, with any accountId removed. Never for the alert.
function detailOf(ctx, error) {
  return ctx.redact(String(error?.message ?? error).split("\n")[0].slice(0, 300));
}

// --- Checks ------------------------------------------------------------------------------------------------------

async function checkTenant(ctx) {
  const expected = ctx.record.tenant?.id;
  if (!expected) return result("graph-tenant", "unrecorded");
  try {
    const signedIn = (await out(ctx, ["account", "show", "--query", "tenantId", "-o", "tsv"])).trim();
    if (signedIn !== expected) {
      ctx.log(`az's current account is in tenant ${signedIn || "(none)"}, not ${ctx.record.tenant.name} (${expected}); sign in to it (az login --tenant ${expected} --allow-no-subscriptions) and run this again.`);
      return result("graph-tenant", "wrong-tenant");
    }
    return result("graph-tenant", "ok");
  } catch (error) {
    return result("graph-tenant", "unreadable", [], detailOf(ctx, error));
  }
}

async function checkEntraSecret(ctx) {
  const objectId = ctx.record.gatewayApp?.objectId;
  if (!objectId) return result("entra-client-secret", "unrecorded");
  try {
    // passwordCredentials carry a hint (the secret's first characters); only endDateTime is used, and nothing printed.
    const app = await graphGet(ctx, `applications/${objectId}?$select=passwordCredentials`);
    const ends = (app?.passwordCredentials ?? []).map(({ endDateTime }) => Date.parse(endDateTime)).filter(Number.isFinite);
    if (!ends.length) return result("entra-client-secret", "none");
    const newest = Math.max(...ends);
    if (newest <= ctx.now) return result("entra-client-secret", "ended", [day(newest)]);
    if (newest - ctx.now <= WARN_DAYS * DAY) return result("entra-client-secret", "ends-soon", [day(newest)]);
    return result("entra-client-secret", "ok", [day(newest)]);
  } catch (error) {
    return result("entra-client-secret", "unreadable", [], detailOf(ctx, error));
  }
}

async function checkAppleAge(ctx) {
  try {
    let tags;
    try {
      tags = await azJson(ctx, ["keyvault", "secret", "show", "--vault-name", VAULT, "--name", appleActiveSecretName(ctx.env), "--query", "tags", "-o", "json", ...SUB]);
    } catch (error) {
      if (isNotFound(error)) return result("apple-secret-age", "unrecorded");
      throw error;
    }
    const renewed = Date.parse(tags?.[APPLE_RENEWED_TAG] ?? "");
    if (!Number.isFinite(renewed)) return result("apple-secret-age", "unrecorded");
    const ends = addMonths(renewed, APPLE_SECRET_MONTHS);
    const dates = [day(renewed), day(ends)];
    if (ends <= ctx.now) return result("apple-secret-age", "ended", dates);
    if (ends - ctx.now <= WARN_DAYS * DAY) return result("apple-secret-age", "ends-soon", dates);
    return result("apple-secret-age", "ok", dates);
  } catch (error) {
    return result("apple-secret-age", "unreadable", [], detailOf(ctx, error));
  }
}

// Production only: a forgotten cutoff would let legacy tokens live forever (plan ruling on DESK_LEGACY_CUTOFF).
async function checkCutoff(ctx) {
  const releasedAt = Date.parse(ctx.record.releasedAt ?? "");
  if (!Number.isFinite(releasedAt)) return result("legacy-cutoff", "not-released");
  if (ctx.now - releasedAt <= DAY) return result("legacy-cutoff", "not-due", [day(releasedAt)]);
  try {
    // Only the names of env vars that hold a value or a secret reference leave az; no value does.
    const names = (await azJson(ctx, ["containerapp", "show", "-n", ENVIRONMENTS.prod.app, "-g", APPS_RESOURCE_GROUP, "--query", "properties.template.containers[].env[] | [?value || secretRef].name", "-o", "json", ...SUB])) ?? [];
    if (names.includes("DESK_LEGACY_CUTOFF")) return result("legacy-cutoff", "ok");
    if (!names.includes("DESK_GITHUB_ACCOUNTS")) return result("legacy-cutoff", "no-mappings", [day(releasedAt)]);
    return result("legacy-cutoff", "missing", [day(releasedAt)]);
  } catch (error) {
    return result("legacy-cutoff", "unreadable", [], detailOf(ctx, error));
  }
}

// --- Apple ---------------------------------------------------------------------------------------------------------

// The slot whose Key ID Graph's Apple provider holds now, or null.
async function liveSlot(ctx) {
  const apple = ctx.record.apple ?? {};
  let providerId = apple.providerId;
  if (!providerId) {
    const providers = (await graphGet(ctx, "identity/identityProviders"))?.value ?? [];
    providerId = providers.find((provider) => provider["@odata.type"] === APPLE_TYPE)?.id;
  }
  if (!providerId) return { providerId: null, slot: null };
  const provider = await graphGet(ctx, `identity/identityProviders/${providerId}`);
  const slot = SLOTS.find((candidate) => apple.keyIds?.[candidate] && apple.keyIds[candidate] === provider?.keyId) ?? null;
  return { providerId, slot };
}

// A slot is usable when its key is in Key Vault and not tagged revoked (plan ruling N2).
async function usable(ctx, slot) {
  try {
    const tags = await azJson(ctx, ["keyvault", "secret", "show", "--vault-name", VAULT, "--name", appleKeySecretName(slot, ctx.env), "--query", "tags", "-o", "json", ...SUB]);
    return !tags?.revoked;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function renewApple(ctx) {
  const apple = ctx.record.apple ?? {};
  if (apple.outcome !== "A") return result("apple-renewal", "not-outcome-a");
  try {
    const { providerId, slot: live } = await liveSlot(ctx);
    if (!live) return result("apple-renewal", "live-unknown");
    const next = live === "a" ? "b" : "a";
    let send;
    if (await usable(ctx, next)) send = next;
    else if (await usable(ctx, live)) send = live;
    else return result("apple-renewal", "no-usable-slot");
    const certificateData = trimOneNewline(await out(ctx, ["keyvault", "secret", "show", "--vault-name", VAULT, "--name", appleKeySecretName(send, ctx.env), "--query", "value", "-o", "tsv", ...SUB]));
    const body = { "@odata.type": APPLE_TYPE, keyId: apple.keyIds[send], certificateData };
    try {
      await out(ctx, ["rest", "--method", "patch", "--url", `${GRAPH}identity/identityProviders/${providerId}`, "--headers", "Content-Type=application/json", "--body", "@/dev/stdin"], JSON.stringify(body));
    } catch (error) {
      // Graph's error body is never passed on; only its status words, which can't hold the key.
      const status = /ERROR: ([A-Za-z ]{3,40})\(/.exec(`${error?.stderr ?? ""}`)?.[1]?.trim();
      ctx.log(`apple-renewal: Graph did not accept the PATCH of slot ${send}${status ? ` (${status})` : ""}.`);
      return result("apple-renewal", "refused");
    }
    if (send === live) {
      // A re-send of the same key can't be shown to make a new client secret (plan ruling on alternating), so the
      // renewal date keeps counting from the last real renewal.
      ctx.log(`apple-renewal: slot ${next} is revoked or missing; re-sent live slot ${live} (Key ID ${apple.keyIds[live]}).`);
      return result("apple-renewal", "resent-live", [day(ctx.now)]);
    }
    ctx.log(`apple-renewal: Graph accepted slot ${send} (Key ID ${apple.keyIds[send]}), replacing slot ${live}.`);
    try {
      await out(ctx, appleActiveSetArgs(ctx.env, new Date(ctx.now).toISOString()), send);
    } catch (error) {
      return result("apple-renewal", "renewed-unrecorded", [day(ctx.now)], detailOf(ctx, error));
    }
    return result("apple-renewal", "renewed", [day(ctx.now)]);
  } catch (error) {
    return result("apple-renewal", "unreadable", [], detailOf(ctx, error));
  }
}

async function recordUpload(ctx, slot) {
  try {
    const { slot: live } = await liveSlot(ctx);
    if (live !== slot) return result("apple-upload", "mismatch");
    await out(ctx, appleActiveSetArgs(ctx.env, new Date(ctx.now).toISOString()), slot);
    ctx.log(`apple-upload: recorded slot ${slot} in ${appleActiveSecretName(ctx.env)}.`);
    return result("apple-upload", "recorded", [day(ctx.now)]);
  } catch (error) {
    return result("apple-upload", "unreadable", [], detailOf(ctx, error));
  }
}

// --- Entry -------------------------------------------------------------------------------------------------------

export async function runChecks({ env, renewApple: renew = false, recordAppleUpload, runner = defaultRunner, now = Date.now, recordDir = HERE, log = () => {} }) {
  environment(env);
  const record = loadRecord(env, recordDir);
  const accountId = record.ari?.accountId;
  const redact = (text) => (accountId ? String(text).split(accountId).join("<accountId>") : String(text));
  const ctx = { env, record, runner, now: now(), log: (line) => log(redact(line)), redact };
  const results = [await checkTenant(ctx)];
  if (results[0].ok) {
    if (recordAppleUpload) {
      results.push(await recordUpload(ctx, recordAppleUpload));
    } else {
      if (renew) results.push(await renewApple(ctx));
      results.push(await checkEntraSecret(ctx), await checkAppleAge(ctx));
      if (env === "prod") results.push(await checkCutoff(ctx));
    }
  }
  return { ok: results.every(({ ok }) => ok), results, now: ctx.now, redact };
}

export function parseFlags(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      env: { type: "string" },
      "renew-apple": { type: "boolean", default: false },
      "record-apple-upload": { type: "string" },
      "alert-file": { type: "string" },
    },
  });
  environment(values.env);
  if (values["renew-apple"] && values["record-apple-upload"] !== undefined) throw new Error("Run one action at a time: --renew-apple or --record-apple-upload.");
  if (values["record-apple-upload"] !== undefined && !SLOTS.includes(values["record-apple-upload"])) throw new Error("--record-apple-upload takes a or b.");
  return { env: values.env, renewApple: values["renew-apple"], recordAppleUpload: values["record-apple-upload"], alertFile: values["alert-file"] };
}

// The command line: one `ok` or `FAIL` line per check on stdout, and on failure one line on stderr and the alert file.
export async function main(argv, { runner = defaultRunner, now = Date.now, recordDir = HERE, stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text) } = {}) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    stderr(`identity-checks: ${error.message}\n`);
    return 1;
  }
  const outcome = await runChecks({ ...flags, runner, now, recordDir, log: (line) => stdout(`${line}\n`) });
  for (const entry of outcome.results) {
    stdout(`${entry.ok ? "ok" : "FAIL"} ${entry.check}: ${phrase(entry)}\n`);
    if (entry.detail) stdout(`   ${entry.detail}\n`);
  }
  if (outcome.ok) return 0;
  const failing = outcome.results.filter(({ ok }) => !ok).map((entry) => `${entry.check}: ${phrase(entry)}`);
  stderr(`identity-checks: ${failing.join("; ")}\n`);
  if (flags.alertFile) writeFileSync(flags.alertFile, alertText({ env: flags.env, now: outcome.now, results: outcome.results }));
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
