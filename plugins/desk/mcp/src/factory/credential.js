// Credential-shaped values: the factory's own copy of Desk's
// `isCredentialLike` rules (`src/desk/naming.js`), because `src/factory/**`
// imports only `node:` built-ins and other `src/factory/` files. A parity
// test runs Desk's case table through both.
//
// A value is credential-like when it starts with a known token prefix
// (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`, `sk-`, any case),
// or when, split on every non-alphanumeric character and case-folded, with
// and without a trailing file extension, it holds:
//   - a secret run: a word of 16 or more characters that is pure hex or mixes
//     letters and digits;
//   - a password value: `pw`, `pwd` or `passwd` followed by another word; or
//   - an IPv4-looking run: four consecutive numeric words of at most 255.

const TOKEN_PREFIX = /^(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|sk-)/iu
const PASSWORD_PREFIX_WORDS = new Set(["pw", "pwd", "passwd"])
const EXTENSION = /\.[A-Za-z0-9]{1,10}$/u

function secretRun(word) {
  if (word.length < 16) return false
  if (/^[0-9a-f]+$/u.test(word)) return true
  return /[0-9]/u.test(word) && /[a-z]/u.test(word)
}

function ipv4Run(words) {
  for (let index = 0; index + 4 <= words.length; index += 1) {
    if (words.slice(index, index + 4).every((word) => /^\d{1,3}$/u.test(word) && Number(word) <= 255)) return true
  }
  return false
}

function credentialWords(words) {
  if (words.some(secretRun)) return true
  for (let index = 0; index + 1 < words.length; index += 1) {
    if (PASSWORD_PREFIX_WORDS.has(words[index])) return true
  }
  return ipv4Run(words)
}

/** `isCredentialLike(value) -> boolean`; a non-string is never credential-like. */
export function isCredentialLike(value) {
  if (typeof value !== "string") return false
  if (TOKEN_PREFIX.test(value)) return true
  return [value, value.replace(EXTENSION, "")].some((candidate) => credentialWords(candidate.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word !== "")))
}
