import { appendFileSync } from "node:fs"

let fault
let record

export function initialize(data) {
  fault = data.fault
  record = data.record
}

const isFactoryCli = url => url.endsWith("/mcp/scripts/factory.js")

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  // Only an import from another module counts: a detached job started with factory.js as its entry has no parent and is not the bounded path.
  if (record && context.parentURL && isFactoryCli(result.url)) appendFileSync(record, `${process.pid} ${context.parentURL}\n`)
  return result
}

export async function load(url, context, nextLoad) {
  if (isFactoryCli(url)) {
    if (fault === "delayed") await new Promise(resolve => setTimeout(resolve, 2000))
    else if (fault === "rejected") throw new Error("test-only full factory CLI import rejection")
  }
  return nextLoad(url, context)
}
