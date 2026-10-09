#!/usr/bin/env bash
# Provisions hosted Desk on Azure. Safe to run again: each step checks what
# exists and only creates or reconciles what is missing or different.
#
#   hosted/infra/provision.sh                 # make the changes
#   DRY_RUN=1 hosted/infra/provision.sh       # read Azure, print every change instead of making it
#   DESK_PUBLIC_URL=https://<url> hosted/infra/provision.sh
#                                             # set the public URL (OAuth issuer, resource and GitHub callback)
#
# DESK_PUBLIC_URL: a create uses https://desk.ouro.bot unless it is passed. A rerun
# keeps the app's current value unless it is passed, so a reconcile never moves
# the live issuer; passing it is the DNS cut-over (hosted/README.md).
#
# What it creates or reconciles, all in subscription 261e0bf1-…, resource group
# rg-ouro-work-substrate:
#   1. Container image ouro-desk-hosted:<HEAD sha> in registry ouroworkprodk2aumligevt3e,
#      built from this checkout, only when the Container App does not exist yet
#      (later images come from .github/workflows/hosted-deploy.yml).
#   2. Container App ouro-desk-hosted in environment ouro-prod-cae (Consumption):
#      exactly 1 replica, external ingress on 8080, 2 vCPU / 4 GiB (provisional until
#      Task 8 measures), pulls with identity ouro-prod-services-mi, a startup and a
#      liveness probe on /healthz, and the desk clone on the container's own disk
#      (/data/desk, set in the image).
#   3. Its secrets: desk-signing-key (random, generated once, never rotated by a
#      rerun) and the GitHub App's desk-app-id, desk-app-client-id,
#      desk-app-client-secret and desk-app-key, created as the placeholder `unset`.
#      hosted/infra/create-github-app.mjs overwrites the App's four; a rerun never
#      touches an existing secret's value. While they are `unset` the gateway serves
#      /healthz and refuses sign-in with "Hosted Desk is not set up yet".
#   4. A secret volume that mounts desk-app-key at /secrets/app-key.pem (DESK_APP_KEY_FILE).
#   5. Custom domain desk.ouro.bot with a managed certificate, once DNS has the
#      records the script prints (ouro.bot's DNS is not in Azure, so it never writes DNS).
#   6. Federated credential ourostack-desk-main-ids on identity id-ourowork-github-prod for
#      subject repo:ourostack@265728804/desk@1386529300:ref:refs/heads/main (the ourostack
#      organization puts owner and repository ids in its OIDC subjects), so the deploy workflow on main
#      signs in with OIDC. The identity already holds Contributor and AcrPush on the
#      resource group, which covers `az acr build` and `az containerapp update`.
# It finishes by printing the GitHub repository variables the deploy workflow reads.
#
# It never resolves anything through Microsoft Graph (no lookups by name of users,
# groups or service principals), so it works where Graph is blocked.
set -euo pipefail

SUBSCRIPTION=261e0bf1-934d-41ab-9295-229b0d254418
RESOURCE_GROUP=rg-ouro-work-substrate
ENVIRONMENT=ouro-prod-cae
REGISTRY=ouroworkprodk2aumligevt3e
PULL_IDENTITY=ouro-prod-services-mi
DEPLOY_IDENTITY=id-ourowork-github-prod
APP=ouro-desk-hosted
DOMAIN=desk.ouro.bot
FEDERATED_NAME=ourostack-desk-main-ids
FEDERATED_SUBJECT=repo:ourostack@265728804/desk@1386529300:ref:refs/heads/main
PUBLIC_URL_PASSED="${DESK_PUBLIC_URL:+1}"
APP_SECRETS=(desk-app-id desk-app-client-id desk-app-client-secret desk-app-key)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

say() { printf '==> %s\n' "$*"; }

# Reads run in every mode. Writes go through `write`, which only prints them in a
# dry run, with any `name=value` secret argument shown as `name=***`.
az_read() { az "$@" --subscription "$SUBSCRIPTION"; }
write() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    local shown=() arg
    for arg in "$@"; do
      if [[ "$arg" =~ ^(desk-[a-z-]+)= ]]; then shown+=("${BASH_REMATCH[1]}=***"); else shown+=("$arg"); fi
    done
    printf '    would run: az %s --subscription %s\n' "${shown[*]}" "$SUBSCRIPTION"
  else
    az "$@" --subscription "$SUBSCRIPTION"
  fi
}

environment_id="$(az_read containerapp env show -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" --query id -o tsv)"
default_domain="$(az_read containerapp env show -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" --query properties.defaultDomain -o tsv)"
verification_id="$(az_read containerapp env show -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" --query properties.customDomainConfiguration.customDomainVerificationId -o tsv)"
pull_identity_id="$(az_read identity show -n "$PULL_IDENTITY" -g "$RESOURCE_GROUP" --query id -o tsv)"
login_server="$(az_read acr show -n "$REGISTRY" --query loginServer -o tsv)"
fqdn="$APP.$default_domain"

# The app's whole spec. `secrets_yaml` lists secret names (an update keeps their
# values) or names with values (a create). `custom_domains` carries the app's
# current bindings as JSON, so an update never drops one.
render_spec() {
  local image="$1" secrets_yaml="$2" custom_domains="$3"
  cat <<YAML
name: $APP
type: Microsoft.App/containerApps
location: eastus2
identity:
  type: UserAssigned
  userAssignedIdentities:
    $pull_identity_id: {}
properties:
  managedEnvironmentId: $environment_id
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 8080
      transport: auto
      allowInsecure: false
      customDomains: $custom_domains
    registries:
      - server: $login_server
        identity: $pull_identity_id
    secrets:
$secrets_yaml
  template:
    # Shutdown stops every Desk child (up to 10 s) and then runs Desk's own
    # push of any unpushed desk writes (up to 60 s) before the gateway exits.
    terminationGracePeriodSeconds: 90
    scale:
      minReplicas: 1
      maxReplicas: 1
    volumes:
      - name: app-key
        storageType: Secret
        secrets:
          - secretRef: desk-app-key
            path: app-key.pem
    containers:
      - name: gateway
        image: $image
        resources:
          cpu: 2.0
          memory: 4Gi
        env:
          - name: DESK_PUBLIC_URL
            value: $DESK_PUBLIC_URL
          - name: DESK_REPO
            value: arimendelow/desk
          - name: DESK_ALLOWED_LOGINS
            value: arimendelow
          - name: DESK_SIGNING_KEY
            secretRef: desk-signing-key
          - name: DESK_APP_ID
            secretRef: desk-app-id
          - name: DESK_APP_CLIENT_ID
            secretRef: desk-app-client-id
          - name: DESK_APP_CLIENT_SECRET
            secretRef: desk-app-client-secret
          - name: DESK_APP_KEY_FILE
            value: /secrets/app-key.pem
        volumeMounts:
          - volumeName: app-key
            mountPath: /secrets
        probes:
          # The gateway listens only after it has cloned the desk; this allows
          # it about five minutes (Container Apps caps failureThreshold at 10).
          - type: Startup
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 30
            failureThreshold: 10
          - type: Liveness
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 30
            failureThreshold: 3
YAML
}

# In a dry run, shows the spec a create or update would send, without the signing key.
show_spec() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    sed -E 's/^( +value: )"[0-9a-f]{64}"$/\1"***"/; s/^/    | /' "$work/app.yaml"
  fi
}

# --- 1–4. The Container App, its secrets and volumes ---------------------------
# Present, absent, or stop: any failure other than "not found" (an expired
# sign-in, throttling) must not be read as absent, which would create the app.
app_exists=0
if show_error="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query name -o tsv 2>&1 >/dev/null)"; then
  app_exists=1
elif ! grep -qiE "ResourceNotFound|was not found|could not be found" <<<"$show_error"; then
  printf 'Could not read Container App %s:\n%s\n' "$APP" "$show_error" >&2
  exit 1
fi

if ((app_exists)) && [[ -z "$PUBLIC_URL_PASSED" ]]; then
  DESK_PUBLIC_URL="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query "properties.template.containers[0].env[?name=='DESK_PUBLIC_URL'].value | [0]" -o tsv)"
fi
DESK_PUBLIC_URL="${DESK_PUBLIC_URL:-https://$DOMAIN}"
DESK_PUBLIC_URL="${DESK_PUBLIC_URL%/}"
say "Public URL: $DESK_PUBLIC_URL"

existing_secrets=""
if ((app_exists)); then
  say "Container App $APP exists; reconciling it"
  existing_secrets="$(az_read containerapp secret list -n "$APP" -g "$RESOURCE_GROUP" --query "[].name" -o tsv)"
  missing=()
  if ! grep -qx desk-signing-key <<<"$existing_secrets"; then missing+=("desk-signing-key=$(openssl rand -hex 32)"); fi
  for name in "${APP_SECRETS[@]}"; do
    grep -qx "$name" <<<"$existing_secrets" || missing+=("$name=unset")
  done
  if ((${#missing[@]})); then
    say "Adding missing secrets"
    write containerapp secret set -n "$APP" -g "$RESOURCE_GROUP" --output none --secrets "${missing[@]}"
  fi
  image="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query "properties.template.containers[0].image" -o tsv)"
  domains="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query "properties.configuration.ingress.customDomains" -o json | tr -d '\n')"
  [[ -n "$domains" ]] || domains=null
  secrets_yaml="$(printf '      - name: %s\n' desk-signing-key "${APP_SECRETS[@]}")"
  render_spec "$image" "$secrets_yaml" "$domains" >"$work/app.yaml"
  say "Updating $APP to the spec (image stays $image)"
  show_spec
  write containerapp update -n "$APP" -g "$RESOURCE_GROUP" --yaml "$work/app.yaml" --output none
else
  tag="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  image="$login_server/$APP:$tag"
  say "Building the first image $image from $REPO_ROOT"
  write acr build --registry "$REGISTRY" --image "$APP:$tag" --file hosted/Dockerfile "$REPO_ROOT"
  secrets_yaml="$(
    printf '      - name: desk-signing-key\n        value: "%s"\n' "$(openssl rand -hex 32)"
    printf '      - name: %s\n        value: unset\n' "${APP_SECRETS[@]}"
  )"
  render_spec "$image" "$secrets_yaml" null >"$work/app.yaml"
  say "Creating Container App $APP"
  show_spec
  write containerapp create -n "$APP" -g "$RESOURCE_GROUP" --yaml "$work/app.yaml" --output none
fi

# --- 5. Custom domain ---------------------------------------------------------
bound="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query "properties.configuration.ingress.customDomains[?name=='$DOMAIN'].bindingType" -o tsv 2>/dev/null || true)"
if [[ "$bound" == SniEnabled ]]; then
  say "$DOMAIN is bound with a certificate"
else
  cname="$(dig +short CNAME "$DOMAIN" | sed 's/\.$//')"
  txt="$(dig +short TXT "asuid.$DOMAIN" | tr -d '"')"
  if [[ "$cname" == "$fqdn" && "$txt" == "$verification_id" ]]; then
    if [[ -z "$bound" ]]; then
      say "Adding $DOMAIN to $APP"
      write containerapp hostname add -n "$APP" -g "$RESOURCE_GROUP" --hostname "$DOMAIN" --output none
    fi
    say "Binding $DOMAIN with a managed certificate (this can take several minutes)"
    write containerapp hostname bind -n "$APP" -g "$RESOURCE_GROUP" --hostname "$DOMAIN" --environment "$ENVIRONMENT" --validation-method CNAME --output none
  else
    say "Skipping $DOMAIN until its DNS exists. Create these records in ouro.bot's DNS (Cloudflare, DNS only, not proxied), then run this again:"
    printf '    CNAME  %-22s %s\n' "$DOMAIN" "$fqdn"
    printf '    TXT    %-22s %s\n' "asuid.$DOMAIN" "$verification_id"
  fi
fi

# --- 6. Federated credential for the deploy workflow ---------------------------
if az_read identity federated-credential show --name "$FEDERATED_NAME" --identity-name "$DEPLOY_IDENTITY" -g "$RESOURCE_GROUP" -o none >/dev/null 2>&1; then
  say "Federated credential $FEDERATED_NAME exists"
else
  say "Adding federated credential $FEDERATED_NAME ($FEDERATED_SUBJECT) to $DEPLOY_IDENTITY"
  write identity federated-credential create --name "$FEDERATED_NAME" --identity-name "$DEPLOY_IDENTITY" -g "$RESOURCE_GROUP" \
    --issuer https://token.actions.githubusercontent.com --subject "$FEDERATED_SUBJECT" --audiences api://AzureADTokenExchange --output none
fi

deploy_client_id="$(az_read identity show -n "$DEPLOY_IDENTITY" -g "$RESOURCE_GROUP" --query clientId -o tsv)"
tenant_id="$(az_read identity show -n "$DEPLOY_IDENTITY" -g "$RESOURCE_GROUP" --query tenantId -o tsv)"

[[ "${DRY_RUN:-0}" == 1 ]] && say "Dry run: nothing above was changed."
say "Done. $APP answers at https://$fqdn (public URL $DESK_PUBLIC_URL)."
cat <<EOF
Repository variables for ourostack/desk (.github/workflows/hosted-deploy.yml):
    gh variable set AZURE_CLIENT_ID --repo ourostack/desk --body $deploy_client_id
    gh variable set AZURE_TENANT_ID --repo ourostack/desk --body $tenant_id
    gh variable set AZURE_SUBSCRIPTION_ID --repo ourostack/desk --body $SUBSCRIPTION
EOF
# The deploy's health check calls DESK_PUBLIC_URL, so the variable waits until that URL answers: a custom domain only
# once it is bound with its certificate. Unset, the check uses the app's Azure address.
if [[ "$DESK_PUBLIC_URL" != "https://$DOMAIN" || "$bound" == SniEnabled ]]; then
  echo "    gh variable set DESK_PUBLIC_URL --repo ourostack/desk --body $DESK_PUBLIC_URL"
else
  echo "    (leave DESK_PUBLIC_URL unset until $DOMAIN is bound; rerun this script after the DNS records exist)"
fi
echo "Then create the GitHub App: node hosted/infra/create-github-app.mjs --public-url $DESK_PUBLIC_URL"
