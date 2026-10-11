// What az 2.77's `containerapp update --yaml` sends to ARM for a document, offline: process_loaded_yaml replaces
// each user-assigned identity's entry with {}, _populate_secret_values copies every value-less secret's value from
// listSecrets (Key Vault references included, when listSecrets returns one), and clean_null_values then drops
// every empty object, which removes the identity map (custom.py update_containerapp_yaml; _utils.py).
const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean).filter((item) => item !== undefined && item !== null && !(typeof item === "object" && Object.keys(item).length === 0));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const cleaned = clean(item);
      if (cleaned === null || cleaned === undefined) continue;
      if (typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
      result[key] = cleaned;
    }
    return result;
  }
  return value;
};

// listSecrets returned this secret without a `value` key. az then fails before sending anything: its
// `next(s["value"] for s in secret_values if s["name"] == ...)` raises KeyError, and it catches only StopIteration.
export const LISTED_WITHOUT_VALUE = Symbol("listed without a value");
export const AZ_KEYERROR_STDERR = "The command failed with an unexpected error. Here is the traceback:\n'value'\nTraceback (most recent call last):\n  File \"_utils.py\", line 987, in _populate_secret_values\n    value[\"value\"] = next(s[\"value\"] for s in secret_values if s[\"name\"] == value[\"name\"])\nKeyError: 'value'";

export function azUpdateModel(document, listSecretValues) {
  const sent = structuredClone(document);
  for (const id of Object.keys(sent.identity?.userAssignedIdentities ?? {})) sent.identity.userAssignedIdentities[id] = {};
  for (const secret of sent.properties?.configuration?.secrets ?? []) {
    if (!secret.value && listSecretValues[secret.name] === LISTED_WITHOUT_VALUE) throw Object.assign(new Error("KeyError: 'value'"), { stderr: AZ_KEYERROR_STDERR });
    if (!secret.value && listSecretValues[secret.name] !== undefined) secret.value = listSecretValues[secret.name];
  }
  return clean(sent);
}

// ARM's PATCH on what az sent: no identity map keeps the app's identities (v1a's provision.sh updates, which
// sent the same, kept the pull identity); the secret list replaces the app's; a Key Vault reference that arrives
// with a value is modelled as the worst case, a plain secret.
export function armPatch(current, sent) {
  const next = structuredClone(sent);
  next.identity = structuredClone(current.identity);
  const values = {};
  next.properties.configuration.secrets = sent.properties.configuration.secrets.map((secret) => {
    if (secret.value !== undefined) values[secret.name] = secret.value;
    if (secret.keyVaultUrl && secret.value !== undefined) return { name: secret.name };
    const { value, ...rest } = secret;
    return rest;
  });
  next.name = current.name;
  next.id = current.id;
  next.properties.latestReadyRevisionName = current.properties.latestReadyRevisionName;
  return { app: next, values };
}
