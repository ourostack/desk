import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { once } from "node:events"

const DIMENSIONS = 768
const MODEL = "nomic-embed-text"

function normalize(vector) {
  const magnitude = Math.hypot(...vector)
  if (magnitude === 0) return vector
  return vector.map((value) => value / magnitude)
}

function tokenVector(token) {
  const digest = createHash("sha256").update(token).digest()
  const vector = new Array(DIMENSIONS).fill(0)
  for (let index = 0; index < DIMENSIONS; index += 1) {
    const byte = digest[index % digest.length]
    const sign = (byte & 1) === 0 ? 1 : -1
    vector[index] = sign * (((byte >> 1) % 31) + 1)
  }
  return normalize(vector)
}

function embeddingFor(prompt) {
  const tokens = String(prompt ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
  if (tokens.length === 0) return new Array(DIMENSIONS).fill(0)
  const summed = new Array(DIMENSIONS).fill(0)
  for (const token of tokens) {
    const vector = tokenVector(token)
    for (let index = 0; index < DIMENSIONS; index += 1) {
      summed[index] += vector[index]
    }
  }
  return normalize(summed)
}

export async function startDeterministicEmbeddingService() {
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/embeddings") {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not_found" }))
      return
    }
    let body = ""
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body || "{}")
    requests.push(payload)
    if (payload.model !== MODEL) {
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: `expected model ${MODEL}` }))
      return
    }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ embedding: embeddingFor(payload.prompt) }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const endpoint = `http://127.0.0.1:${server.address().port}`
  return {
    endpoint,
    requests,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const service = await startDeterministicEmbeddingService()
  process.stdout.write(`${JSON.stringify({ endpoint: service.endpoint })}\n`)
}
