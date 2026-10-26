import { createHash } from "node:crypto"

// A section's text hash keys its vector in `.state/desk-vectors.sqlite` (src/search/vectors.js), so changing how it is
// computed makes every stored vector unreachable and the whole desk is embedded again.
function normalizeChunkText(text) {
  return String(text ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/ /gu, " ")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/gu, " "))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
}

export function chunkTextHash(text) {
  return `sha256:${createHash("sha256").update(normalizeChunkText(text)).digest("hex")}`
}
