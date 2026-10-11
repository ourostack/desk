const SECRET_KEY = /(capability|token|secret|password|cookie|authorization|environment|^env$)/iu;
const NATIVE_ENDPOINT = /(https?:\/\/[^\s/"'<>]+)\/native\/[a-f0-9]{64}\/[A-Za-z0-9._:-]+(?:\/[^\s"'<>]*)?/giu;

export function redactNativeSurface(value, { secrets = [] } = {}) {
  if (typeof value === 'string') {
    let text = value.replace(NATIVE_ENDPOINT, '$1');
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[redacted]');
    }
    return text;
  }
  if (Array.isArray(value)) return value.map(item => redactNativeSurface(item, { secrets }));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, item]) => [key, redactNativeSurface(item, { secrets })]));
}
