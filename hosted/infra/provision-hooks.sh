#!/usr/bin/env bash
# Creates the hooks receiver, Container App ouro-desk-hooks, beside hosted Desk (plugins/desk/docs/webhooks.md).
# Run it after a Desk release that carries hosted/src/hooks has been deployed to the gateway, and again after adding
# the DNS records it prints; later releases reach the receiver through .github/workflows/hosted-deploy.yml. Safe to
# run again: an existing app gets only its domain binding and DESK_HOOKS_PUBLIC_URL, never a new spec or secret.
#
#   hosted/infra/provision-hooks.sh --dry-run     # read Azure and print every change it would make, secret masked
#   hosted/infra/provision-hooks.sh               # make them
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
# Then, on every run, it binds the receiver's custom domain, hooks.ouro.bot (HOOKS_DOMAIN for another), with a managed
# certificate and points DESK_HOOKS_PUBLIC_URL at it, once ouro.bot's DNS has the two records it prints. It never
# changes the gateway, and it never writes DNS (_meta/tips/ouro-bot-dns.md in the desk has how to add the records).
set -euo pipefail
umask 077

SUBSCRIPTION=261e0bf1-934d-41ab-9295-229b0d254418
RESOURCE_GROUP=rg-ouro-work-substrate
ENVIRONMENT=ouro-prod-cae
GATEWAY=ouro-desk-hosted
APP=ouro-desk-hooks
DOMAIN="${HOOKS_DOMAIN:-hooks.ouro.bot}"

DRY_RUN="${DRY_RUN:-0}"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) printf 'unknown-argument: unknown argument %s; use --dry-run or nothing\n' "$arg" >&2; exit 2 ;;
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

exists=0
if show_error="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query name -o tsv 2>&1 >/dev/null)"; then
  exists=1
  say "$APP exists at https://$fqdn (hosted-deploy.yml keeps its image current)"
elif ! not_found "$show_error"; then
  printf 'read-failed: Could not read Container App %s:\n%s\n' "$APP" "$show_error" >&2
  exit 1
fi

# Wait for the latest revision, then for /healthz, as hosted-deploy.yml does. READY_TIMEOUT_SECONDS and
# READY_POLL_SECONDS exist for the tests.
wait_ready() {
  local deadline=$((SECONDS + ${READY_TIMEOUT_SECONDS:-600}))
  until [[ "$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query properties.latestReadyRevisionName -o tsv)" == \
           "$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query properties.latestRevisionName -o tsv)" ]]; do
    if ((SECONDS >= deadline)); then printf 'not-ready: %s was not ready after %s seconds; see az containerapp logs show -n %s -g %s\n' "$APP" "${READY_TIMEOUT_SECONDS:-600}" "$APP" "$RESOURCE_GROUP" >&2; exit 1; fi
    sleep "${READY_POLL_SECONDS:-10}"
  done
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$fqdn/healthz")" == 200 ]]; do
    if ((SECONDS >= deadline)); then printf 'not-ready: https://%s/healthz did not answer 200\n' "$fqdn" >&2; exit 1; fi
    sleep "${READY_POLL_SECONDS:-10}"
  done
}

create_app() {

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
  return 0
fi

az containerapp create -n "$APP" -g "$RESOURCE_GROUP" --yaml "$work/app.json" --output none --subscription "$SUBSCRIPTION"
rm -f "$work/client-key" "$work/app.json"

wait_ready
}

[[ "$exists" == 1 ]] || create_app

# --- Custom domain -------------------------------------------------------------------------------------------------
# The same steps as hosted/infra/provision.sh's for desk.ouro.bot: a DNS-only CNAME to the app's Azure address and an
# asuid TXT record holding the environment's verification id, then a managed certificate.
verification_id="$(az_read containerapp env show -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" --query properties.customDomainConfiguration.customDomainVerificationId -o tsv)"
bound=""
[[ "$exists" == 1 ]] && bound="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query "properties.configuration.ingress.customDomains[?name=='$DOMAIN'].bindingType" -o tsv)"
public_url="https://$fqdn"
if [[ "$bound" == SniEnabled ]]; then
  say "$DOMAIN is bound with a certificate"
  public_url="https://$DOMAIN"
else
  cname="$(dig +short CNAME "$DOMAIN" | sed 's/\.$//')"
  # asuid may hold more than one TXT value; any line equal to the verification id counts.
  txt_matches=0
  dig +short TXT "asuid.$DOMAIN" | tr -d '"' | grep -qxF "$verification_id" && txt_matches=1
  if [[ "$cname" == "$fqdn" && "$txt_matches" == 1 ]]; then
    if [[ "$DRY_RUN" == 1 ]]; then
      printf '    would run: az containerapp hostname add and bind -n %s --hostname %s (managed certificate)\n' "$APP" "$DOMAIN"
      public_url="https://$DOMAIN"
    else
      [[ -n "$bound" ]] || { say "Adding $DOMAIN to $APP"; az_read containerapp hostname add -n "$APP" -g "$RESOURCE_GROUP" --hostname "$DOMAIN" --output none; }
      say "Binding $DOMAIN with a managed certificate (this can take up to 20 minutes)"
      az_read containerapp hostname bind -n "$APP" -g "$RESOURCE_GROUP" --hostname "$DOMAIN" --environment "$ENVIRONMENT" --validation-method CNAME --output none
      public_url="https://$DOMAIN"
    fi
  else
    say "dns-missing: skipping $DOMAIN until its DNS exists. Create these records in ouro.bot's DNS (Cloudflare, DNS only, not proxied), then run this again:"
    printf '    CNAME  %-26s %s\n' "$DOMAIN" "$fqdn"
    printf '    TXT    %-26s %s\n' "asuid.$DOMAIN" "$verification_id"
  fi
fi

if [[ "$public_url" == "https://$DOMAIN" ]]; then
  current=""
  [[ "$exists" == 1 ]] && current="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query "properties.template.containers[0].env[?name=='DESK_HOOKS_PUBLIC_URL'].value" -o tsv)"
  if [[ "$current" != "$public_url" ]]; then
    if [[ "$DRY_RUN" == 1 ]]; then
      printf '    would run: az containerapp update -n %s --set-env-vars DESK_HOOKS_PUBLIC_URL=%s\n' "$APP" "$public_url"
    else
      say "Pointing DESK_HOOKS_PUBLIC_URL at $public_url"
      az_read containerapp update -n "$APP" -g "$RESOURCE_GROUP" --set-env-vars "DESK_HOOKS_PUBLIC_URL=$public_url" --output none
      wait_ready
    fi
  fi
fi

[[ "$DRY_RUN" == 1 ]] && say "Dry run: nothing was changed."
say "Done. $APP answers at $public_url"
