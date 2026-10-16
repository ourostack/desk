let fault

export function initialize(data) {
  fault = data.fault
}

export async function load(url, context, nextLoad) {
  if (url.endsWith("/mcp/scripts/factory.js")) {
    if (fault === "delayed") await new Promise(resolve => setTimeout(resolve, 2000))
    else if (fault === "rejected") throw new Error("test-only full factory CLI import rejection")
  }
  return nextLoad(url, context)
}
