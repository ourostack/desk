#!/usr/bin/env bash
# Provisions hosted Desk on Azure. Safe to run again: each step checks what
# exists and only creates or reconciles what is missing or different.
#
#   hosted/infra/provision.sh                 # make the changes
#   DRY_RUN=1 hosted/infra/provision.sh       # read Azure, print every change instead of making it
#   DESK_PUBLIC_URL=https://<url> hosted/infra/provision.sh
#                                             # set the public URL (OAuth issuer, resource and GitHub callback)
#   DESK_REDIRECTS=<url>,<url> hosted/infra/provision.sh
#                                             # set the OAuth redirect allowlist (hosted/README.md); empty clears it
#   DESK_GITHUB_SIGNIN=on|off hosted/infra/provision.sh
#                                             # turn the GitHub sign-in fallback on or off; a rerun keeps the app's value.
#                                             # Refused until identity-<env>.json is complete.
#   REMOVE_OURO_SETTINGS=1 hosted/infra/provision.sh
#                                             # take every Ouro sign-in setting off the app (GitHub sign-in for
#                                             # DESK_ALLOWED_LOGINS again); secrets and identities stay
#   STAGE=staging [IMAGE=<tag>] hosted/infra/provision.sh
#                                             # the rehearsal app ouro-desk-hosted-staging (below)
#
# STAGE=staging makes or reconciles ouro-desk-hosted-staging instead: it scales to
# zero (at most 1 replica, 1 vCPU / 2 GiB), its DESK_PUBLIC_URL is always its own
# Azure address, it serves arimendelow/desk-rehearsal, and it has no custom domain
# and no deploy credential. A create uses IMAGE (a tag in the registry, or a full
# image reference) instead of building one, so the rehearsal starts on
# production's image; a rerun keeps the running image. Staging never holds
# production's pull identity ouro-prod-services-mi, which also holds roles on
# production storage and the email domain: it pulls with its own gateway identity
# id-ouro-desk-hosted-staging (rg-ouro-identity), which the script creates if it
# is missing and grants AcrPull on the registry only, reading first so a rerun
# writes nothing. A staging app that holds the production identity is refused.
#
# Every write to an existing app is the whole app as `az containerapp show`
# printed it, with only the script's own settings changed (app-yaml.mjs): az
# replaces the app's secret and container lists with the file's, so a rerun built
# from a template would drop DESK_CLIENT_KEY, the previous signing key and any
# secret or env var this script doesn't know. Missing secrets are added the same
# way, with their values made inside app-yaml.mjs, never as arguments. az drops
# the identity map from such an update, so the gateway identity is attached
# first with `az containerapp identity assign`; after each update the script
# reads the app back and stops unless every secret, Key Vault reference and
# identity is still there. A rerun keeps the app's probes, scale and resources
# as they are; only a create applies the template's (fix a hand-made change in
# the portal or by creating the app again).
#
# Ouro sign-in: both stages read the Ouro tenant's settings from
# hosted/infra/identity-<env>.json (prod, or test for staging), which
# provision-identity.mjs writes: the tenant id and subdomain, the gateway app's
# client id, the accounts store, the gateway identity (added to the app; it reads
# the Entra client secret as a Key Vault reference and the store through RBAC),
# Ari's accountId for DESK_GITHUB_ACCOUNTS and DESK_GITHUB_LOGINS, and the legacy
# cutoff, which is never recomputed here. Until the record is complete, Ouro
# sign-in settings are left as they are. The settings are checked first, with
# the gateway's own reader, and a cutoff must have a zone, come after releasedAt
# and, unless the app already holds it, lie in the future. DESK_GITHUB_SIGNIN is
# "on" the first time and keeps the app's value after that unless it is passed.
# After every update the script waits until the new revision is the ready one,
# and fails if it doesn't start. DESK_ALLOWED_LOGINS and every existing
# secret stay until the day-14 check.
#
# DESK_PUBLIC_URL: a create uses https://desk.ouro.bot unless it is passed. A rerun
# keeps the app's current value unless it is passed, so a reconcile never moves
# the live issuer; passing it is the DNS cut-over (hosted/README.md).
# DESK_REDIRECTS works the same way: a rerun keeps the app's current value unless
# it is passed, and the app carries it only when it is not empty (the gateway's
# default allowlist applies otherwise).
#
# What it creates or reconciles, all in subscription 261e0bf1-…, resource group
# rg-ouro-work-substrate:
#   1. Container image ouro-desk-hosted:<HEAD sha> in registry ouroworkprodk2aumligevt3e,
#      built from this checkout, only when the Container App does not exist yet
#      (later images come from .github/workflows/hosted-deploy.yml).
#   2. Container App ouro-desk-hosted in environment ouro-prod-cae (Consumption):
#      exactly 1 replica, external ingress on 8080, 2 vCPU / 4 GiB (provisional until
#      Task 8 measures), pulls with identity ouro-prod-services-mi (staging: its own), a startup and a
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
# Every file this script writes (the app document can hold a secret) is for its user only.
umask 077

SUBSCRIPTION=261e0bf1-934d-41ab-9295-229b0d254418
RESOURCE_GROUP=rg-ouro-work-substrate
ENVIRONMENT=ouro-prod-cae
REGISTRY=ouroworkprodk2aumligevt3e
PROD_PULL_IDENTITY=ouro-prod-services-mi
DEPLOY_IDENTITY=id-ourowork-github-prod
STAGE="${STAGE:-prod}"
case "$STAGE" in
  prod)
    APP=ouro-desk-hosted IDENTITY_ENV=prod DESK_REPO=arimendelow/desk
    MIN_REPLICAS=1 CPU=2.0 MEMORY=4Gi
    PULL_IDENTITY=$PROD_PULL_IDENTITY PULL_IDENTITY_GROUP=$RESOURCE_GROUP
    ;;
  staging)
    APP=ouro-desk-hosted-staging IDENTITY_ENV=test DESK_REPO=arimendelow/desk-rehearsal
    MIN_REPLICAS=0 CPU=1.0 MEMORY=2Gi
    # Its own gateway identity (identity-record.mjs GATEWAY_IDENTITIES.test), never production's (re-review N-I1).
    PULL_IDENTITY=id-ouro-desk-hosted-staging PULL_IDENTITY_GROUP=rg-ouro-identity
    ;;
  *) printf 'STAGE must be prod or staging, not %s\n' "$STAGE" >&2; exit 1 ;;
esac
DOMAIN=desk.ouro.bot
FEDERATED_NAME=ourostack-desk-main-ids
FEDERATED_SUBJECT=repo:ourostack@265728804/desk@1386529300:ref:refs/heads/main
PUBLIC_URL_PASSED="${DESK_PUBLIC_URL:+1}"
REDIRECTS_PASSED="${DESK_REDIRECTS+1}"
case "${REMOVE_OURO_SETTINGS:-}" in
  "" | 0 | 1) ;;
  *) printf 'REMOVE_OURO_SETTINGS must be 1 or unset, not %s\n' "$REMOVE_OURO_SETTINGS" >&2; exit 1 ;;
esac
case "${DESK_GITHUB_SIGNIN:-}" in
  "" | on | off) ;;
  *) printf 'DESK_GITHUB_SIGNIN must be on or off, not %s\n' "$DESK_GITHUB_SIGNIN" >&2; exit 1 ;;
esac
APP_SECRETS=(desk-app-id desk-app-client-id desk-app-client-secret desk-app-key)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_YAML="$REPO_ROOT/hosted/infra/app-yaml.mjs"
IDENTITY_FILE="${IDENTITY_DIR:-$REPO_ROOT/hosted/infra}/identity-$IDENTITY_ENV.json"
# REMOVE_OURO_SETTINGS=1 takes every Ouro setting off and applies no identity record.
if [[ "${REMOVE_OURO_SETTINGS:-}" == 1 ]]; then IDENTITY_FILE=""; fi
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
login_server="$(az_read acr show -n "$REGISTRY" --query loginServer -o tsv)"

# The identity the app pulls images with. Staging's is its own, made here if missing and granted AcrPull on the
# registry only; the role is read first, so a rerun writes nothing.
not_found() { grep -qiE "ResourceNotFound|was not found|could not be found" <<<"$1"; }
if [[ "$STAGE" == staging ]]; then
  if identity_error="$(az_read identity show -n "$PULL_IDENTITY" -g "$PULL_IDENTITY_GROUP" --query id -o tsv 2>&1 >/dev/null)"; then
    pull_identity_id="$(az_read identity show -n "$PULL_IDENTITY" -g "$PULL_IDENTITY_GROUP" --query id -o tsv)"
    pull_principal="$(az_read identity show -n "$PULL_IDENTITY" -g "$PULL_IDENTITY_GROUP" --query principalId -o tsv)"
  elif not_found "$identity_error"; then
    say "Creating identity $PULL_IDENTITY in $PULL_IDENTITY_GROUP; staging pulls images with it"
    write identity create -n "$PULL_IDENTITY" -g "$PULL_IDENTITY_GROUP" -l eastus2 --output none
    if [[ "${DRY_RUN:-0}" == 1 ]]; then
      pull_identity_id="<$PULL_IDENTITY id>" pull_principal="<$PULL_IDENTITY principal id>"
    else
      pull_identity_id="$(az_read identity show -n "$PULL_IDENTITY" -g "$PULL_IDENTITY_GROUP" --query id -o tsv)"
      pull_principal="$(az_read identity show -n "$PULL_IDENTITY" -g "$PULL_IDENTITY_GROUP" --query principalId -o tsv)"
    fi
  else
    printf 'Could not read identity %s:\n%s\n' "$PULL_IDENTITY" "$identity_error" >&2
    exit 1
  fi
  registry_id="$(az_read acr show -n "$REGISTRY" --query id -o tsv)"
  acr_pullers=""
  if [[ "$pull_principal" != "<"* ]]; then
    acr_pullers="$(az_read role assignment list --scope "$registry_id" --role AcrPull --query "[].principalId" -o tsv)"
  fi
  if grep -qxF -- "$pull_principal" <<<"$acr_pullers"; then
    say "$PULL_IDENTITY holds AcrPull on $REGISTRY"
  else
    say "Granting $PULL_IDENTITY AcrPull on registry $REGISTRY only"
    write role assignment create --assignee-object-id "$pull_principal" --assignee-principal-type ServicePrincipal --role AcrPull --scope "$registry_id" --output none
    say "A new role can take a few minutes to apply; until it does, the app's first image pull may be retried."
  fi
else
  pull_identity_id="$(az_read identity show -n "$PULL_IDENTITY" -g "$PULL_IDENTITY_GROUP" --query id -o tsv)"
fi
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
      minReplicas: $MIN_REPLICAS
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
          cpu: $CPU
          memory: $MEMORY
        env:
          - name: DESK_PUBLIC_URL
            value: $DESK_PUBLIC_URL
          - name: DESK_REPO
            value: $DESK_REPO
          - name: DESK_ALLOWED_LOGINS
            value: arimendelow
$redirects_env_yaml
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

# In a dry run, shows the spec a create would send, without the signing key.
show_spec() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    sed -E 's/^( +value: )"[0-9a-f]{64}"$/\1"***"/; s/^/    | /' "$work/app.yaml"
  fi
}

# In a dry run, shows the document an update would send, every secret value as ***.
show_document() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    node "$APP_YAML" --mask "$1" | sed 's/^/    | /'
  fi
}

# The whole app as shown, with this script's settings applied (app-yaml.mjs). Prints the document's path.
build_update() {
  local args=(--shown "$work/shown.json" --out "$work" --ensure-secret desk-signing-key --set-env "DESK_REPO=$DESK_REPO")
  local name
  for name in "${APP_SECRETS[@]}"; do args+=(--ensure-placeholder "$name"); done
  if [[ -n "$PUBLIC_URL_PASSED" ]]; then args+=(--set-env "DESK_PUBLIC_URL=$DESK_PUBLIC_URL"); fi
  if [[ -n "$REDIRECTS_PASSED" ]]; then
    if [[ -n "$DESK_REDIRECTS" ]]; then args+=(--set-env "DESK_REDIRECTS=$DESK_REDIRECTS"); else args+=(--remove-env DESK_REDIRECTS); fi
  fi
  if [[ -n "${DESK_GITHUB_SIGNIN:-}" ]]; then args+=(--set-env "DESK_GITHUB_SIGNIN=$DESK_GITHUB_SIGNIN"); fi
  args+=(--identity-env "$IDENTITY_ENV")
  if [[ "${REMOVE_OURO_SETTINGS:-}" == 1 ]]; then
    args+=(--remove-ouro)
  elif [[ -f "$IDENTITY_FILE" ]]; then
    args+=(--identity-record "$IDENTITY_FILE")
  else
    say "No identity-$IDENTITY_ENV.json yet; Ouro sign-in settings stay as they are" >&2
  fi
  if [[ "$STAGE" == staging ]]; then args+=(--forbid-identity "$PROD_PULL_IDENTITY"); fi
  node "$APP_YAML" "${args[@]}"
}

# --- 1–4. The Container App, its secrets and volumes ---------------------------
# Present, absent, or stop: any failure other than "not found" (an expired
# sign-in, throttling) must not be read as absent, which would create the app.
app_exists=0
if show_error="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query name -o tsv 2>&1 >/dev/null)"; then
  app_exists=1
elif ! not_found "$show_error"; then
  printf 'Could not read Container App %s:\n%s\n' "$APP" "$show_error" >&2
  exit 1
fi

if [[ "$STAGE" == staging ]]; then
  # Staging always answers on its own Azure address.
  DESK_PUBLIC_URL="https://$fqdn"
  PUBLIC_URL_PASSED=1
fi
if ((app_exists)); then
  az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" -o json >"$work/shown.json"
  if [[ -z "$PUBLIC_URL_PASSED" ]]; then DESK_PUBLIC_URL="$(node "$APP_YAML" --shown "$work/shown.json" --get-env DESK_PUBLIC_URL)"; fi
  if [[ -z "$REDIRECTS_PASSED" ]]; then DESK_REDIRECTS="$(node "$APP_YAML" --shown "$work/shown.json" --get-env DESK_REDIRECTS)"; fi
fi
DESK_PUBLIC_URL="${DESK_PUBLIC_URL:-https://$DOMAIN}"
DESK_PUBLIC_URL="${DESK_PUBLIC_URL%/}"
say "Public URL: $DESK_PUBLIC_URL"

DESK_REDIRECTS="${DESK_REDIRECTS:-}"
redirects_env_yaml=""
if [[ -n "$DESK_REDIRECTS" ]]; then
  quoted="${DESK_REDIRECTS//\\/\\\\}"
  quoted="${quoted//\"/\\\"}"
  redirects_env_yaml="$(printf '          - name: DESK_REDIRECTS\n            value: "%s"' "$quoted")"
  say "Redirect allowlist: $DESK_REDIRECTS"
else
  say "Redirect allowlist: the gateway's default"
fi

# Reconciles the existing app: attach the gateway identity first (az's YAML update drops the identity map, so it
# can't arrive through the document), send the whole app with this script's settings, then read the app back and
# stop unless every secret, Key Vault reference and identity is still there (az fills value-less secrets, Key
# Vault references included, from listSecrets before it sends).
reconcile_app() {
  az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" -o json >"$work/shown.json"
  # The check after the update compares with the app as it was before anything here wrote: the identity assign is
  # itself a full PUT that rewrites the secrets from listSecrets (re-review N-m2).
  cp "$work/shown.json" "$work/before.json"
  local identity_args=() stage_args=() id missing
  # What this run has already sent to the app, for an honest message if the update below can't be sent.
  local sent_before=()
  if ((created_now)); then sent_before+=("the creation of $APP"); fi
  if [[ -f "$IDENTITY_FILE" ]]; then identity_args=(--identity-record "$IDENTITY_FILE"); fi
  if [[ "$STAGE" == staging ]]; then stage_args=(--forbid-identity "$PROD_PULL_IDENTITY" --registry-identity "$pull_identity_id"); fi
  if ((${#identity_args[@]})); then
    # Captured first, so a failure here stops the script before any write.
    missing="$(node "$APP_YAML" --shown "$work/shown.json" --missing-identities "${identity_args[@]}")"
    for id in $missing; do
      say "Attaching identity ${id##*/} to $APP"
      write containerapp identity assign -n "$APP" -g "$RESOURCE_GROUP" --user-assigned "$id" --output none
      sent_before+=("the identity attach of ${id##*/}")
    done
    if [[ -n "$missing" && "${DRY_RUN:-0}" != 1 ]]; then
      az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" -o json >"$work/shown.json"
    fi
  fi
  local document
  document="$(build_update)"
  say "Updating $APP: missing secrets added, every existing secret, env var, volume and identity kept"
  show_document "$document"
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    write containerapp update -n "$APP" -g "$RESOURCE_GROUP" --yaml "$document" --output none
    return
  fi
  if ! az containerapp update -n "$APP" -g "$RESOURCE_GROUP" --yaml "$document" --output none --subscription "$SUBSCRIPTION" 2>"$work/update.err"; then
    if grep -qF "KeyError: 'value'" "$work/update.err"; then
      # az fills each value-less secret from listSecrets and catches only a missing name, not a missing value.
      # The same text as app-yaml.mjs's keyVaultFillFailure().
      local before="Nothing else was sent to the app before it in this step." joined
      if ((${#sent_before[@]})); then
        printf -v joined '%s; ' "${sent_before[@]}"
        before="Already sent to the app before it, and still in effect: ${joined%; }."
      fi
      printf '%s\n' "az could not send the update: listSecrets returned a Key Vault reference without a value, which az 2.77's YAML update can't handle (KeyError: 'value'). az stops there before sending the update, so none of this update's changes reached the app. $before Record this for the rehearsal; the update path needs a fix before this app can be updated again." >&2
    else
      cat "$work/update.err" >&2
    fi
    exit 1
  fi
  az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" -o json >"$work/after.json"
  az_read containerapp secret list -n "$APP" -g "$RESOURCE_GROUP" -o json >"$work/secrets.json"
  node "$APP_YAML" --verify --before "$work/before.json" --after "$work/after.json" --secret-list "$work/secrets.json" ${identity_args[@]+"${identity_args[@]}"} ${stage_args[@]+"${stage_args[@]}"}
  await_revision
}

# After an update, wait until the app's latest revision is its latest ready one, as hosted-deploy.yml does, so a
# setting the gateway refuses at start fails this script instead of leaving the old revision serving unnoticed
# (final review finding 1). READY_TIMEOUT_SECONDS and READY_POLL_SECONDS exist for the tests.
await_revision() {
  local deadline=$((SECONDS + ${READY_TIMEOUT_SECONDS:-900})) latest ready state
  while :; do
    latest="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query properties.latestRevisionName -o tsv)"
    ready="$(az_read containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query properties.latestReadyRevisionName -o tsv)"
    state="$(az_read containerapp revision show -n "$APP" -g "$RESOURCE_GROUP" --revision "$latest" --query properties.runningState -o tsv 2>/dev/null || true)"
    # As hosted-deploy.yml: ready is enough, whatever the running state (a scaled-to-zero revision may not say
    # Running); only Failed, while not ready, stops the wait early.
    if [[ -n "$latest" && "$latest" == "$ready" ]]; then
      say "Revision $latest is ready (running state: ${state:-unknown})"
      return
    fi
    if [[ "$state" == Failed ]]; then
      printf '%s did not start (running state: %s); %s still serves. See its logs with az containerapp logs show -n %s -g %s --revision %s --subscription %s.\n' "$latest" "$state" "${ready:-no revision}" "$APP" "$RESOURCE_GROUP" "$latest" "$SUBSCRIPTION" >&2
      exit 1
    fi
    if ((SECONDS >= deadline)); then
      printf '%s was not ready after %s seconds (running state: %s); %s still serves.\n' "${latest:-the new revision}" "${READY_TIMEOUT_SECONDS:-900}" "${state:-unknown}" "${ready:-no revision}" >&2
      exit 1
    fi
    sleep "${READY_POLL_SECONDS:-15}"
  done
}

created_now=0
if ((app_exists)); then
  say "Container App $APP exists; reconciling it from its current spec"
  reconcile_app
else
  if [[ -n "${IMAGE:-}" ]]; then
    if [[ "$IMAGE" == */* ]]; then image="$IMAGE"; else image="$login_server/ouro-desk-hosted:$IMAGE"; fi
    say "Using the pinned image $image"
  else
    tag="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    image="$login_server/ouro-desk-hosted:$tag"
    say "Building the first image $image from $REPO_ROOT"
    write acr build --registry "$REGISTRY" --image "ouro-desk-hosted:$tag" --file hosted/Dockerfile "$REPO_ROOT"
  fi
  secrets_yaml="$(
    printf '      - name: desk-signing-key\n        value: "%s"\n' "$(openssl rand -hex 32)"
    printf '      - name: %s\n        value: unset\n' "${APP_SECRETS[@]}"
  )"
  render_spec "$image" "$secrets_yaml" null >"$work/app.yaml"
  say "Creating Container App $APP"
  show_spec
  write containerapp create -n "$APP" -g "$RESOURCE_GROUP" --yaml "$work/app.yaml" --output none
  created_now=1
  # The Ouro settings join through the same attach, update and check once the app exists.
  if [[ "${DRY_RUN:-0}" != 1 && -f "$IDENTITY_FILE" ]]; then
    say "Adding the Ouro sign-in settings to $APP"
    reconcile_app
  fi
fi

if [[ "$STAGE" == staging ]]; then
  [[ "${DRY_RUN:-0}" == 1 ]] && say "Dry run: nothing above was changed."
  say "Done. Staging app $APP answers at https://$fqdn and serves $DESK_REPO; it has no custom domain and is not deployed by hosted-deploy.yml."
  exit 0
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
