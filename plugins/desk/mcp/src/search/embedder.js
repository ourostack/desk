// Meaning-based search embeds text with a small static embedding model (Model2Vec potion-base-8M, MIT licence), run here
// in plain JavaScript: a text's vector is the average of its word pieces' vectors, so no neural network, native code or
// service is needed. The model's two files are downloaded once, at a pinned revision, into the desk's state folder.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"

const REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23"
export const MODEL = Object.freeze({
  id: `minishlab/potion-base-8M@${REVISION.slice(0, 8)}`,
  url: `https://huggingface.co/minishlab/potion-base-8M/resolve/${REVISION}`,
  files: Object.freeze({
    "tokenizer.json": "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50",
    "model.safetensors": "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2",
  }),
})

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

// Reads a model file from `dir`, downloading it first when it is missing or does not match its pinned hash.
async function modelFile(dir, name, { model, fetchImpl }) {
  const file = path.join(dir, name)
  try {
    const bytes = readFileSync(file)
    if (sha256(bytes) === model.files[name]) return bytes
  } catch { /* not downloaded yet */ }
  const response = await fetchImpl(`${model.url}/${name}`)
  if (!response.ok) throw new Error(`downloading ${name} failed with HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (sha256(bytes) !== model.files[name]) throw new Error(`downloaded ${name} does not match its pinned hash`)
  mkdirSync(dir, { recursive: true })
  const partial = `${file}.${process.pid}.partial`
  writeFileSync(partial, bytes)
  renameSync(partial, file)
  return bytes
}

/** Loads the model from `<stateDir>/embedding-model/`, downloading it on first use. Resolves to `{ id, embed(text) }`. */
export async function loadEmbedder(options) {
  const { stateDir, fetch: fetchImpl, model } = { fetch: globalThis.fetch, model: MODEL, ...options }
  const dir = path.join(stateDir, "embedding-model", model.id.replace(/[/@]/g, "-"))
  const tokenizer = JSON.parse((await modelFile(dir, "tokenizer.json", { model, fetchImpl })).toString("utf8"))
  const weights = await modelFile(dir, "model.safetensors", { model, fetchImpl })
  const headerLength = Number(weights.readBigUInt64LE(0))
  const { embeddings } = JSON.parse(weights.subarray(8, 8 + headerLength).toString("utf8"))
  const [rows, dimension] = embeddings.shape
  const start = 8 + headerLength + embeddings.data_offsets[0]
  const table = new Float32Array(weights.buffer.slice(weights.byteOffset + start, weights.byteOffset + start + rows * dimension * 4))
  const vocab = new Map(Object.entries(tokenizer.model.vocab))
  return { id: model.id, dimension, embed: (text) => embedWith(text, { vocab, table, dimension }) }
}

function embedWith(text, { vocab, table, dimension }) {
  const vector = new Float32Array(dimension)
  for (const id of tokenize(text, vocab)) {
    const offset = id * dimension
    for (let i = 0; i < dimension; i++) vector[i] += table[offset + i]
  }
  // Averaging then normalizing equals normalizing the sum.
  let norm = 0
  for (let i = 0; i < dimension; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dimension; i++) vector[i] /= norm
  return vector
}

// BERT's uncased tokenizer, as the model's tokenizer.json describes it: lowercase, strip accents, split on whitespace
// and punctuation (Chinese characters stand alone), then split each word into the longest word pieces in the vocabulary.
// Unknown words are dropped, as Model2Vec does.
const PUNCTUATION = /[\p{P}!-/:-@[-`{-~]/u
const CJK = /[一-鿿㐀-䶿\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}豈-﫿\u{2F800}-\u{2FA1F}]/u

export function tokenize(text, vocab) {
  const normalized = String(text).toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "")
  const ids = []
  for (const word of normalized.split(/[\s\p{Cc}]+/u)) {
    let piece = ""
    for (const char of word) {
      if (PUNCTUATION.test(char) || CJK.test(char)) {
        wordPieces(piece, vocab, ids)
        wordPieces(char, vocab, ids)
        piece = ""
      } else {
        piece += char
      }
    }
    wordPieces(piece, vocab, ids)
  }
  return ids
}

function wordPieces(word, vocab, ids) {
  if (word.length === 0 || word.length > 100) return
  const found = []
  for (let start = 0; start < word.length;) {
    let end = word.length
    let id
    while (end > start) {
      id = vocab.get(start > 0 ? `##${word.slice(start, end)}` : word.slice(start, end))
      if (id !== undefined) break
      end -= 1
    }
    if (end === start) return
    found.push(id)
    start = end
  }
  ids.push(...found)
}
