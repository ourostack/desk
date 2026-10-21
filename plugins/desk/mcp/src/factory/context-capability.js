import { isPlainObject } from "./schema.js"

export async function storeAcceptsContext(client, store, ref, feature = "task_context") {
  if (!["task_context", "loop_context"].includes(feature)) throw new TypeError("unsupported context capability")
  const response = await client.api("GET", `repos/${store}/contents/context.json?ref=${encodeURIComponent(ref)}`)
  if (response.status !== 200 || response.json?.type !== "file" || response.json.encoding !== "base64" || typeof response.json.content !== "string") return false
  const bytes = Buffer.from(response.json.content, "base64")
  if (bytes.length > 1024) return false
  try {
    const config = JSON.parse(bytes.toString("utf8"))
    return isPlainObject(config) && config.task_context === 1 &&
      Object.keys(config).every((key) => ["task_context", "loop_context"].includes(key) && config[key] === 1) &&
      config[feature] === 1
  } catch { return false }
}
