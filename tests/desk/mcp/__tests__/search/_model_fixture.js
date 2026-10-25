// A tiny model in the same file formats as the real one (a tokenizer.json and a safetensors table), served by a fake
// fetch, so tests run the real embedder without downloading anything. Words in one group share a direction, so
// "automobile" finds a section about cars by meaning, with no word in common.
import { createHash } from "node:crypto"

const GROUPS = [
  ["car", "automobile", "vehicle", "engine"],
  ["cooking", "recipe", "kitchen", "soup"],
  ["garden", "plants", "flowers", "soil"],
]
const OTHER = ["the", "a", "is", "about", "my", "notes", "task", "track", "status", "##s", "re", "##pair", "café", ","]
const DIMENSION = GROUPS.length + 1

export function fixtureModel() {
  const words = ["[PAD]", "[UNK]", ...GROUPS.flat(), ...OTHER]
  const vocab = Object.fromEntries(words.map((word, id) => [word, id]))
  const table = new Float32Array(words.length * DIMENSION)
  words.forEach((word, id) => {
    const group = GROUPS.findIndex((members) => members.includes(word))
    table[id * DIMENSION + (group < 0 ? GROUPS.length : group)] = group < 0 ? 0.05 : 1
  })
  const tokenizer = Buffer.from(JSON.stringify({ model: { vocab } }))
  const header = Buffer.from(JSON.stringify({ embeddings: { dtype: "F32", shape: [words.length, DIMENSION], data_offsets: [0, table.byteLength] } }))
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(header.length))
  const weights = Buffer.concat([length, header, Buffer.from(table.buffer)])
  const files = { "tokenizer.json": tokenizer, "model.safetensors": weights }
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
  const model = { id: "fixture/model@1", url: "https://models.invalid/fixture", files: { "tokenizer.json": sha(tokenizer), "model.safetensors": sha(weights) } }
  const requests = []
  const fetch = async (url) => {
    requests.push(url)
    const bytes = files[url.slice(model.url.length + 1)]
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  }
  return { model, fetch, requests, files, vocab: new Map(Object.entries(vocab)) }
}
