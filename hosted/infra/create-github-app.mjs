#!/usr/bin/env node
// Creates the "Ouro Desk" GitHub App with GitHub's manifest flow and stores its
// credentials in the hosted Desk Container App, without printing any of them.
//
//   node hosted/infra/create-github-app.mjs [--public-url https://desk.ouro.bot]
//
// Open http://127.0.0.1:8787/ in a browser signed in to GitHub as an ourostack
// owner. The page posts the App's manifest to GitHub; confirming there sends the
// browser back to /created, where this script converts the one-time code into
// the App's id, client id, client secret and private key, writes them over the
// placeholder secrets that provision.sh created and prints the App's install
// URL. Once the App is installed on the desk repository it restarts the
// running revision, so the gateway reads the secrets, and exits.
//
// Needs `az` signed in with write access to the Container App.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { appJwt } from "../src/github-app.js";

const ORG = "ourostack";
const PORT = 8787;
const DESK_REPO = "arimendelow/desk";
// The two public addresses the gateway serves sign-in on: its own domain, and
// the Container App's Azure address used until that domain's DNS exists.
const DESK_DOMAIN_URL = "https://desk.ouro.bot";
const AZURE_URL = "https://ouro-desk-hosted.blueflower-44af4710.eastus2.azurecontainerapps.io";
const TARGET = {
  app: "ouro-desk-hosted",
  resourceGroup: "rg-ouro-work-substrate",
  subscription: "261e0bf1-934d-41ab-9295-229b0d254418",
};

// The Container App secrets this script writes, in the order of the conversion
// fields they come from. provision.sh creates each with the value `unset`.
export const APP_SECRETS = ["desk-app-id", "desk-app-client-id", "desk-app-client-secret", "desk-app-key"];

// The App: sign-in (callback on the gateway), and Git and gh access to the desk
// repository through installation tokens. It receives no webhooks. It is public
// because GitHub lets a private App be installed only on the account that owns
// it (ourostack), and the desk repository belongs to arimendelow; a public App
// installed elsewhere gains nothing, since the gateway mints tokens only for its
// own repository and admits only its allowed logins.
//
// Its callbacks cover the public URL and both known addresses, so moving
// DESK_PUBLIC_URL from the Azure address to desk.ouro.bot needs no App change.
export function appManifest({ publicUrl, redirectUrl }) {
  const base = publicUrl.replace(/\/+$/, "");
  const callbacks = new Set([base, DESK_DOMAIN_URL, AZURE_URL].map((origin) => `${origin}/oauth/github/callback`));
  return {
    name: "Ouro Desk",
    url: base,
    callback_urls: [...callbacks],
    redirect_url: redirectUrl,
    public: true,
    request_oauth_on_install: false,
    default_permissions: { contents: "write", pull_requests: "read", metadata: "read" },
    hook_attributes: { url: `${base}/`, active: false },
  };
}

const escapeHtml = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Ouro Desk GitHub App</title></head><body>${body}</body></html>`;

export function manifestFormPage({ org, manifest, state }) {
  const action = `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
  return page(
    `<form id="manifest" method="post" action="${escapeHtml(action)}">` +
      `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">` +
      `<p>Sending the Ouro Desk App's manifest to GitHub…</p><noscript><button type="submit">Create the App on GitHub</button></noscript>` +
      `</form><script>document.getElementById("manifest").submit()</script>`,
  );
}

export async function convertManifestCode(code, { fetch = globalThis.fetch } = {}) {
  if (!/^[\w-]+$/.test(code ?? "")) throw new Error("GitHub sent back no usable code.");
  const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "ouro-desk-hosted", "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} to the manifest conversion.`);
  return response.json();
}

export function secretsFromConversion(conversion) {
  const values = [conversion.id, conversion.client_id, conversion.client_secret, conversion.pem];
  return APP_SECRETS.map((name, index) => {
    const value = values[index];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new Error(`GitHub's conversion is missing the field for ${name} (id, client_id, client_secret, pem).`);
    }
    return { name, value: String(value) };
  });
}

// Runs a command and resolves with its stdout. A failure names the command's
// first three words and its stderr, never its arguments, which carry secrets.
function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${[command, ...args.slice(0, 3)].join(" ")} failed: ${stderr.trim() || `exit ${error.code}`}`));
      else resolve(stdout);
    });
  });
}

const azTarget = ({ app, resourceGroup, subscription }) => ["--name", app, "--resource-group", resourceGroup, "--subscription", subscription];

export async function setSecrets({ secrets, run = runCommand, ...target }) {
  await run("az", ["containerapp", "secret", "set", ...azTarget(target), "--output", "none", "--secrets", ...secrets.map(({ name, value }) => `${name}=${value}`)]);
}

// Secrets reach a container's environment and volumes only when it starts.
export async function restartRevision({ run = runCommand, ...target }) {
  const revision = (await run("az", ["containerapp", "show", ...azTarget(target), "--query", "properties.latestReadyRevisionName", "--output", "tsv"])).trim();
  if (!revision) throw new Error(`${target.app} has no ready revision to restart; it reads the secrets when its next revision starts.`);
  await run("az", ["containerapp", "revision", "restart", ...azTarget(target), "--revision", revision, "--output", "none"]);
}

export const installUrl = (conversion) => `${conversion.html_url}/installations/new`;

// Resolves once the App is installed on `repo`. The gateway clones the desk at
// start and exits if it cannot, so its revision restarts only after this.
export async function waitForInstallation({ conversion, repo, fetch = globalThis.fetch, sleep, now = Date.now, timeoutMs = 30 * 60_000 }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const jwt = appJwt({ appId: conversion.id, privateKeyPem: conversion.pem, now: Math.floor(now() / 1000) });
    const response = await fetch(`https://api.github.com/repos/${repo}/installation`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "user-agent": "ouro-desk-hosted", "x-github-api-version": "2022-11-28" },
    });
    if (response.ok) return;
    if (response.status !== 404) throw new Error(`GitHub answered ${response.status} when asked for the App's installation on ${repo}.`);
    if (now() >= deadline) throw new Error(`The App was not installed on ${repo} within ${Math.round(timeoutMs / 60_000)} minutes.`);
    await sleep(5000);
  }
}

// Handles GitHub's redirect back to /created: converts the code and stores the
// secrets. Resolves with `{ ok, html, conversion }`; the caller then waits for
// the installation and restarts the revision.
export function createdHandler({ state, app, resourceGroup, subscription, fetch, run, print }) {
  return async (query) => {
    if (query.get("state") !== state) {
      print("Refused a /created request whose state does not match this run's.");
      return { ok: false, html: page(`<p>This link does not belong to this run. Start again from http://127.0.0.1:${PORT}/.</p>`) };
    }
    let conversion;
    try {
      conversion = await convertManifestCode(query.get("code"), { fetch });
      print(`Created GitHub App ${conversion.slug} (id ${conversion.id}).`);
    } catch (error) {
      print(`Failed: ${error.message}`);
      return { ok: false, html: page(`<p>Failed: ${escapeHtml(error.message)}</p><p>See the terminal.</p>`) };
    }
    try {
      await setSecrets({ secrets: secretsFromConversion(conversion), app, resourceGroup, subscription, run });
      print(`Stored its credentials in ${app}.`);
      const url = installUrl(conversion);
      print(`Install it on ${DESK_REPO} (choose arimendelow, then "Only select repositories": desk):\n  ${url}`);
      return {
        ok: true,
        conversion,
        html: page(`<p>The Ouro Desk App exists and hosted Desk has its credentials.</p><p>Next, <a href="${escapeHtml(url)}">install it on ${DESK_REPO}</a>. The terminal finishes once it is installed.</p>`),
      };
    } catch (error) {
      // GitHub hands over the client secret and private key only once, and this
      // script never prints them, so they are lost. The App itself exists.
      const settings = `https://github.com/organizations/${ORG}/settings/apps/${conversion.slug}`;
      print(
        `Failed: ${error.message}\nThe App exists, but its credentials were not stored. Open ${settings}, generate a new ` +
          `client secret and a new private key, and set them with az containerapp secret set on ${app} ` +
          `(desk-app-id=${conversion.id}, desk-app-client-id, desk-app-client-secret, desk-app-key).`,
      );
      return { ok: false, html: page(`<p>Failed: ${escapeHtml(error.message)}</p><p>See the terminal for how to recover.</p>`) };
    }
  };
}

async function main() {
  const { values } = parseArgs({ options: { "public-url": { type: "string", default: process.env.DESK_PUBLIC_URL || "https://desk.ouro.bot" } } });
  const state = randomBytes(16).toString("hex");
  const origin = `http://127.0.0.1:${PORT}`;
  const manifest = appManifest({ publicUrl: values["public-url"], redirectUrl: `${origin}/created` });
  const print = (line) => process.stdout.write(`${line}\n`);
  const handle = createdHandler({ state, ...TARGET, fetch: globalThis.fetch, run: runCommand, print });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(manifestFormPage({ org: ORG, manifest, state }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/created") {
      const result = await handle(url.searchParams);
      res.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" }).end(result.html);
      if (!result.ok) return;
      server.close();
      try {
        print(`Waiting for the App to be installed on ${DESK_REPO}…`);
        await waitForInstallation({ conversion: result.conversion, repo: DESK_REPO, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
        await restartRevision({ ...TARGET, run: runCommand });
        print(`Installed. Restarted ${TARGET.app}, which now clones ${DESK_REPO} and serves Desk.`);
        process.exit(0);
      } catch (error) {
        print(`Failed: ${error.message}`);
        process.exit(1);
      }
    }
    res.writeHead(404).end();
  });
  server.listen(PORT, "127.0.0.1", () => print(`Open ${origin}/ in a browser signed in to GitHub as an ${ORG} owner.`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`create-github-app: ${error.message}\n`);
    process.exit(1);
  });
}
