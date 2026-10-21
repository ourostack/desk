// Retained native-owned profile partition boundary. Never rotate an existing
// token on update, reconnect, worker restart or malformed storage.
const TOKEN_KEY = "deskBrowserProfileToken"

export function readProfileToken(storage, random = bytes => crypto.getRandomValues(bytes)) {
  const existing = storage.getItem(TOKEN_KEY)
  if (existing !== null) {
    if (!/^[a-f0-9]{64}$/u.test(existing)) throw new Error("NATIVE_PROFILE_TOKEN_INVALID")
    return existing
  }
  const bytes = random(new Uint8Array(32))
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error("NATIVE_PROFILE_TOKEN_INVALID")
  const token = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")
  storage.setItem(TOKEN_KEY, token)
  if (storage.getItem(TOKEN_KEY) !== token) throw new Error("NATIVE_PROFILE_TOKEN_WRITE_FAILED")
  return token
}

if (typeof chrome !== "undefined" && typeof localStorage !== "undefined") {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "desk-profile-token") return
    try { respond({ token: readProfileToken(localStorage) }) }
    catch { respond({ error: "NATIVE_PROFILE_TOKEN_INVALID" }) }
  })
}
