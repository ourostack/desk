import { createBrowserExtension } from "./context-engine.mjs"
import { SOURCE_DIGEST } from "./source-digest.mjs"

export const extension = typeof chrome === "undefined" ? undefined : createBrowserExtension(chrome, {
  sourceDigest: SOURCE_DIGEST,
  onStatus: code => console.error(code),
})

if (extension) {
  const start = () => extension.start().catch(() => console.error("native_host_unavailable"))
  chrome.runtime.onInstalled.addListener(start)
  chrome.runtime.onStartup.addListener(start)
  start()
}
