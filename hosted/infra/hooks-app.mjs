#!/usr/bin/env node
// The Container App spec for the hooks receiver, ouro-desk-hooks (provision-hooks.sh). It is built from the gateway
// app as `az containerapp show` prints it, so the receiver uses exactly the gateway's environment, registry, pull
// identity, store identity, accounts store and GitHub account mapping. The hosted deploy copies the mapping and store
// settings from the gateway again on every release (.github/workflows/hosted-deploy.yml), so they don't drift.
//
//   node hosted/infra/hooks-app.mjs --gateway <shown.json> --image <image> --public-url <url> \
//     --client-key-file <file> --out <app.json> [--mask]
//
// The client key is read from a file (never an argument), written only into --out (mode 0600), and --mask prints the
// spec with it as ***. az reads the JSON file as YAML.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const HOOKS_APP = "ouro-desk-hooks";
// From the gateway, unchanged: who may manage hooks, and the Table Storage account and identity that hold them.
export const COPIED_ENV = ["DESK_GITHUB_ACCOUNTS", "DESK_GITHUB_LOGINS", "DESK_ACCOUNTS_ENDPOINT", "AZURE_CLIENT_ID"];

const envOf = (app) => app.properties.template.containers[0].env ?? [];

export function hooksAppSpec({ gateway, image, publicUrl, clientKey }) {
  const env = new Map(envOf(gateway).filter((entry) => entry.value).map((entry) => [entry.name, entry.value]));
  for (const name of COPIED_ENV) if (!env.get(name)) throw new Error(`the gateway has no ${name}; turn on Ouro sign-in (hosted/README.md) before provisioning the hooks receiver`);
  if (!envOf(gateway).some((entry) => entry.name === "DESK_CLIENT_KEY" && entry.secretRef)) throw new Error("the gateway has no DESK_CLIENT_KEY secret to share with the hooks receiver");
  const identities = Object.entries(gateway.identity?.userAssignedIdentities ?? {});
  const store = identities.find(([, value]) => value.clientId === env.get("AZURE_CLIENT_ID"));
  if (!store) throw new Error("none of the gateway's identities has AZURE_CLIENT_ID's client id");
  const registry = gateway.properties.configuration.registries?.[0];
  if (!registry?.identity) throw new Error("the gateway pulls its image without an identity; the hooks receiver needs one");
  if (!/^https:\/\/[^/\s]+$/.test(publicUrl)) throw new Error("--public-url must be an https origin");
  if (typeof clientKey !== "string" || clientKey === "" || /\s/.test(clientKey)) throw new Error("the client key file is empty or holds whitespace");
  const probe = (type, extra) => ({ type, httpGet: { path: "/healthz", port: 8080 }, ...extra });
  return {
    name: HOOKS_APP,
    type: "Microsoft.App/containerApps",
    location: gateway.location,
    identity: { type: "UserAssigned", userAssignedIdentities: Object.fromEntries([registry.identity, store[0]].map((id) => [id, {}])) },
    properties: {
      managedEnvironmentId: gateway.properties.managedEnvironmentId,
      configuration: {
        activeRevisionsMode: "Single",
        ingress: { external: true, targetPort: 8080, transport: "auto", allowInsecure: false },
        registries: [{ server: registry.server, identity: registry.identity }],
        secrets: [{ name: "desk-client-key", value: clientKey }],
      },
      template: {
        // Always one replica: senders give up after about 10 s, so the receiver can't wait for a cold start.
        scale: { minReplicas: 1, maxReplicas: 1 },
        containers: [
          {
            name: "hooks",
            image,
            // The image's entrypoint (tini) stays; only its command changes.
            args: ["node", "hosted/src/hooks/main.js"],
            resources: { cpu: 0.25, memory: "0.5Gi" },
            env: [
              ...COPIED_ENV.map((name) => ({ name, value: env.get(name) })),
              { name: "DESK_HOOKS_PUBLIC_URL", value: publicUrl },
              { name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" },
            ],
            probes: [probe("Startup", { initialDelaySeconds: 2, periodSeconds: 5, failureThreshold: 10 }), probe("Liveness", { periodSeconds: 30, failureThreshold: 3 })],
          },
        ],
      },
    },
  };
}

export function masked(spec) {
  const copy = structuredClone(spec);
  for (const secret of copy.properties.configuration.secrets) secret.value = "***";
  return copy;
}

function flags(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index].replace(/^--/, "");
    if (name === "mask") result.mask = true;
    else result[name] = argv[++index];
  }
  return result;
}

export function main(argv) {
  const options = flags(argv);
  const spec = hooksAppSpec({
    gateway: JSON.parse(readFileSync(options.gateway, "utf8")),
    image: options.image,
    publicUrl: options["public-url"],
    clientKey: readFileSync(options["client-key-file"], "utf8").replace(/\n$/, ""),
  });
  writeFileSync(options.out, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
  if (options.mask) process.stdout.write(`${JSON.stringify(masked(spec), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
