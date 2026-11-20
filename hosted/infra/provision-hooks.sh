#!/usr/bin/env bash
# Creates the hooks receiver, Container App ouro-desk-hooks, beside hosted Desk (plugins/desk/docs/webhooks.md).
# Run it once, after a Desk release that carries hosted/src/hooks has been deployed to the gateway; later releases
# reach the receiver through .github/workflows/hosted-deploy.yml. Safe to run again: an existing app is left alone.
#
#   hosted/infra/provision-hooks.sh --dry-run     # read Azure and print the app it would create, secret masked
#   hosted/infra/provision-hooks.sh               # create it
#   IMAGE=<full image> hosted/infra/provision-hooks.sh
#                                                 # a given image instead of the gateway's current one
#
# What it creates, in subscription 261e0bf1-…, resource group rg-ouro-work-substrate, environment ouro-prod-cae:
#   Container App ouro-desk-hooks: 0.25 vCPU / 0.5 GiB, exactly one replica always on, external ingress on 8080,
#   running `node hosted/src/hooks/main.js` from the gateway's image. It takes from the gateway app, as shown now:
#   the registry and the identity that pulls from it, the identity that reads the accounts Table Storage account
#   (AZURE_CLIENT_ID), DESK_ACCOUNTS_ENDPOINT, DESK_GITHUB_ACCOUNTS, DESK_GITHUB_LOGINS, and the value of its
#   desk-client-key secret, copied into the receiver's own desk-client-key secret through a file only this user can
#   read (never an argument, never printed). The receiver creates its tables, hooks and hookevents, in that storage
#   account when it starts.
# It never changes the gateway, and it never writes DNS: the receiver answers at its Azure address.
set -euo pipefail
umask 077

SUBSCRIPTION=261e0bf1-934d-41ab-9295-229b0d254418
RESOURCE_GROUP=rg-ouro-work-substrate
ENVIRONMENT=ouro-prod-cae
GATEWAY=ouro-desk-hosted
APP=ouro-desk-hooks

DRY_RUN="${DRY_RUN:-0}"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) printf 'unknown argument %s; use --dry-run or nothing\n' "$arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPEC="$REPO_ROOT/hosted/infra/hooks-app.mjs"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

say() { printf '==> %s\n' "$*"; }
az_read() { az "$@" --subscription "$SUBSCRIPTION"; }
not_found() { grep -qiE "ResourceNotFound|was not found|could not be found" <<<"$1"; }

default_domain="$(az_read containerapp env show -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" --query properties.defaultDomain -o tsv)"
fqdn="$APP.$default_domain"

if show_error="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query name -o tsv 2>&1 >/dev/null)"; then
  say "$APP exists at https://$fqdn; nothing to do (hosted-deploy.yml keeps its image current)"
  exit 0
elif ! not_found "$show_error"; then
  printf 'Could not read Container App %s:\n%s\n' "$APP" "$show_error" >&2
  exit 1
fi

az_read containerapp show -n "$GATEWAY" -g "$RESOURCE_GROUP" -o json >"$work/gateway.json"
image="${IMAGE:-$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).properties.template.containers[0].image)' "$work/gateway.json")}"
say "Image: $image"
say "Public URL: https://$fqdn"

if [[ "$DRY_RUN" == 1 ]]; then
  # A dry run never reads the secret's value.
  printf 'dry-run-placeholder' >"$work/client-key"
else
  az_read containerapp secret show -n "$GATEWAY" -g "$RESOURCE_GROUP" --secret-name desk-client-key --query value -o tsv >"$work/client-key"
fi

say "Creating Container App $APP"
node "$SPEC" --gateway "$work/gateway.json" --image "$image" --public-url "https://$fqdn" --client-key-file "$work/client-key" --out "$work/app.json" --mask | sed 's/^/    | /'

if [[ "$DRY_RUN" == 1 ]]; then
  printf '    would run: az containerapp create -n %s -g %s --yaml <the spec above> --output none --subscription %s\n' "$APP" "$RESOURCE_GROUP" "$SUBSCRIPTION"
  say "Dry run: nothing was changed."
  exit 0
fi

az containerapp create -n "$APP" -g "$RESOURCE_GROUP" --yaml "$work/app.json" --output none --subscription "$SUBSCRIPTION"
rm -f "$work/client-key" "$work/app.json"

# Wait for the first revision, then for /healthz, as hosted-deploy.yml does. READY_TIMEOUT_SECONDS and
# READY_POLL_SECONDS exist for the tests.
deadline=$((SECONDS + ${READY_TIMEOUT_SECONDS:-600}))
until [[ "$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query properties.latestReadyRevisionName -o tsv)" == \
         "$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query properties.latestRevisionName -o tsv)" ]]; do
  if ((SECONDS >= deadline)); then printf '%s was not ready after %s seconds; see az containerapp logs show -n %s -g %s\n' "$APP" "${READY_TIMEOUT_SECONDS:-600}" "$APP" "$RESOURCE_GROUP" >&2; exit 1; fi
  sleep "${READY_POLL_SECONDS:-10}"
done
until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$fqdn/healthz")" == 200 ]]; do
  if ((SECONDS >= deadline)); then printf 'https://%s/healthz did not answer 200\n' "$fqdn" >&2; exit 1; fi
  sleep "${READY_POLL_SECONDS:-10}"
done
say "Done. $APP answers at https://$fqdn"
