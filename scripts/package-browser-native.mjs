#!/usr/bin/env node
// Maintained packaging only; never installs, enrolls, activates a feed or claims browser acceptance.
// Reuses E6's reviewed qualification ZIP/CRX3/signature algorithm.
// --check-source REPO             offline source admission
// --verify REPO [ARTIFACTS]        STRICT offline verification; never reads a signer receipt or calls Azure
// --sign REPO PRIVATE_RECEIPT OUT  explicit LOCAL authority only; OUT must be fresh and outside REPO
// Public output is exactly a versioned CRX, updates.xml and allowlisted provenance.json.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import cp from "node:child_process"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"

export const NORMAL_FEED = "https://raw.githubusercontent.com/ourostack/desk/main/artifacts/browser-native/updates.xml"
export const PUBLISHER = Object.freeze({
  extensionId: "idfkhmkoaimndgacinjkjbagnnefgdel",
  spkiSha256: "835a7cae08cd36028d9a9106dd45634b678f14c585f6f93501908775cb498d23",
})
const FILES = ["README.md", "background.mjs", "build.mjs", "context-engine.mjs", "manifest.json",
  "source-digest.mjs", "token.html", "token.mjs", "vendor/LICENSE", "vendor/PROVENANCE.md", "vendor/maintained.mjs"]
const EXECUTION = ["background.mjs", "context-engine.mjs", "manifest.json", "token.html", "token.mjs", "vendor/maintained.mjs"]
const LIMIT = 1048576
const PROVENANCE_KEYS = ["sourceCommit", "extensionId", "extensionVersion", "extensionSourceDigest",
  "normalDistributionDigest", "archiveInventory", "zipSha256", "algorithm", "signedInputSha256",
  "crxFile", "crxSha256", "crxBytes", "status", "publisherPublicSpkiSha256", "verification"]
const VERIFIED = Object.freeze({
  packetReadback: true, publicKeyIdMatch: true, localSignature: true, exactElevenFileArchive: true,
  archiveTamperRefused: true, signedHeaderTamperRefused: true,
  browserFetch: "UNPROVED", browserInstall: "UNPROVED", enrollment: "UNPROVED", updateContinuity: "UNPROVED",
})
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex")
const refuse = code => { throw Object.assign(new Error(code), { code }) }
const sorted = entries => [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
const inventory = entries => sorted(entries).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) }))
const inventoryDigest = entries => sha(JSON.stringify(sorted(entries).map(([name, bytes]) => [name, sha(bytes)])))
const sourceDigest = extension => {
  const hash = crypto.createHash("sha256")
  for (const name of EXECUTION) {
    const bytes = extension.get(name)
    hash.update(`${name}\0${bytes.length}\0`).update(bytes)
  }
  return hash.digest("hex")
}
function run(file, args, options = {}) {
  const result = cp.spawnSync(file, args, { maxBuffer: 4 * LIMIT, timeout: 45000, ...options })
  if (result.status !== 0) refuse("BROWSER_PACKAGE_COMMAND_FAILED")
  return result.stdout
}
const git = (repo, ...args) => run("git", ["-C", repo, ...args])
const nativeEntries = d => new Map([...d.sources,
  ...[...d.extension].map(([name, bytes]) => [`extension/${name}`, bytes]), ["artifact-manifest.json", d.artifactManifest]])
function version(value) {
  assert.match(value, /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/u)
  const numbers = value.split(".").map(Number)
  assert.ok(numbers.every(n => n <= 65535))
  return [...numbers, ...Array(4 - numbers.length).fill(0)]
}
function compareVersions(a, b) {
  const left = version(a), right = version(b)
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i])
  return 0
}
export function publicationDecision(next, previous, versionFileExists) {
  if (previous !== null) {
    assert.ok(compareVersions(next, previous) >= 0)
    if (compareVersions(next, previous) === 0) {
      assert.equal(next, previous, "one canonical filename for a numeric version")
      return "reuse"
    }
  }
  assert.equal(versionFileExists, false, "never overwrite an existing version without matching verified provenance")
  return "new"
}

export async function reuseVerifiedPackage({ next, previous, versionFileExists, verify }) {
  if (publicationDecision(next, previous, versionFileExists) !== "reuse") return null
  return verify()
}

export function signingCommonDirectory(repo) {
  return fs.realpathSync(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").toString().trim())
}

// Repository-local non-replay, shared by its worktrees, NOT provider exactly-once.
// Another clone or deliberately deleted state is outside this guarantee. There
// is no automatic retry/unlock: even an incomplete journal permanently reserves
// the publisher + numeric version. Source/input/OUT are evidence, never the key.
export function createSigningAttempt({ commonDirectory, publisher, extensionVersion,
  sourceCommit, signedInputSha256, output }) {
  assert.equal(fs.realpathSync(commonDirectory), commonDirectory)
  assert.match(publisher.spkiSha256, /^[0-9a-f]{64}$/u)
  assert.match(sourceCommit, /^[0-9a-f]{40}$/u)
  assert.match(signedInputSha256, /^[0-9a-f]{64}$/u)
  assert.ok(path.isAbsolute(output))
  const numericVersion = version(extensionVersion).join(".")
  const directory = path.join(commonDirectory, "browser-native-sign-attempts")
  const journal = path.join(directory, `${publisher.spkiSha256}-${numericVersion}.json`)
  const evidence = { publisherPublicSpkiSha256: publisher.spkiSha256, extensionVersion: numericVersion,
    sourceCommit, signedInputSha256, output, status: "reserved" }
  let descriptor = null
  const close = () => {
    if (descriptor !== null) { fs.closeSync(descriptor); descriptor = null }
  }
  const record = status => {
    assert.notEqual(descriptor, null)
    evidence.status = status
    const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + "\n")
    let at = 0
    while (at < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, at, bytes.length - at, at)
      assert.ok(written > 0)
      at += written
    }
    fs.ftruncateSync(descriptor, bytes.length)
    fs.fsyncSync(descriptor)
  }
  const protect = async (target, kind, created) => {
    const info = fs.lstatSync(target)
    assert.ok(!info.isSymbolicLink() && (kind === "directory" ? info.isDirectory() : info.isFile() && info.nlink === 1))
    if (process.platform === "win32") {
      const { protectWindowsPaths } = await import("../plugins/desk/mcp/src/factory/windows-acl.js")
      await protectWindowsPaths([{ path: target, kind, created }], { label: "desk_browser_package" })
    } else {
      assert.equal(info.uid, process.getuid())
      assert.equal(info.mode & 0o077, 0, "private attempt paths must already be owner-only")
    }
  }
  return { journal, record, close, async reserve() {
    assert.equal(descriptor, null)
    let created = false
    try { fs.mkdirSync(directory, { mode: 0o700 }); created = true }
    catch (error) { if (error.code !== "EEXIST") throw error }
    await protect(directory, "directory", created)
    // Atomic across processes/worktrees and numeric aliases, independent of OUT.
    // Never overwrite/read/unlink an existing slot, including an empty one.
    descriptor = fs.openSync(journal, "wx", 0o600)
    try {
      await protect(journal, "file", true)
      record("reserved")
      if (process.platform !== "win32") {
        for (const parent of [directory, commonDirectory]) {
          const fd = fs.openSync(parent, "r")
          try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        }
      }
      fs.mkdirSync(output, { mode: 0o700 })
    } catch (error) {
      close()
      throw error // Preserve the journal/output; uncertainty never authorizes replay.
    }
  } }
}

// Library callers supply their expected PUBLIC identity explicitly. Only the CLI establishes
// production authority, with the fixed PUBLISHER above; there is no CLI/env test-key override.
export function validateDistribution(d, publisher) {
  assert.deepEqual([...d.extension.keys()].sort(), FILES)
  assert.ok([...d.extension.values()].every(Buffer.isBuffer))
  assert.ok([...d.extension.values()].reduce((n, b) => n + b.length, 0) < LIMIT)
  const manifest = JSON.parse(d.extension.get("manifest.json"))
  assert.equal(manifest.update_url, NORMAL_FEED)
  assert.ok(compareVersions(manifest.version, "1.1.0") > 0)
  const spki = Buffer.from(manifest.key, "base64")
  assert.equal(spki.toString("base64"), manifest.key)
  crypto.createPublicKey({ key: spki, format: "der", type: "spki" })
  assert.equal(sha(spki), publisher.spkiSha256)
  const id = sha(spki).slice(0, 32).replace(/[0-9a-f]/gu, digit => String.fromCharCode(97 + parseInt(digit, 16)))
  assert.equal(id, publisher.extensionId)
  assert.equal(d.extensionId, id)
  assert.equal(sourceDigest(d.extension), d.extensionSourceDigest)
  assert.equal(d.extension.get("source-digest.mjs").toString(),
    `// Generated by build.mjs; no profile or relay credentials.\nexport const SOURCE_DIGEST = "${d.extensionSourceDigest}";\n`)
  assert.equal(inventoryDigest(nativeEntries(d)), d.distributionDigest)
  return manifest
}

// Python's standard ZIP implementation is the qualification builder's maintained
// byte/CRC oracle. All data goes through stdin; no package copies or shell interpolation.
const ZIP_CREATE = `import io,sys,json,zipfile,time,base64
v=json.load(sys.stdin); out=io.BytesIO()
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for n,b in v['files']:
  i=zipfile.ZipInfo(n,time.gmtime(v['epoch'])[:6]);i.create_system=3;i.external_attr=0o100644<<16;i.compress_type=zipfile.ZIP_DEFLATED
  z.writestr(i,base64.b64decode(b))
 z.comment=v['binding'].encode()
sys.stdout.write(base64.b64encode(out.getvalue()).decode())`
const ZIP_VERIFY = `import io,sys,json,zipfile,base64
v=json.load(sys.stdin); expected={n:base64.b64decode(b) for n,b in v['files']}
with zipfile.ZipFile(io.BytesIO(base64.b64decode(v['zip']))) as z:
 assert z.comment==v['binding'].encode()
 assert z.namelist()==list(expected)
 assert sum(i.file_size for i in z.infolist())<1048576
 for i in z.infolist():
  assert i.file_size==len(expected[i.filename]) and i.compress_type==zipfile.ZIP_DEFLATED and not(i.flag_bits&1)
  assert i.external_attr>>16==0o100644 and z.read(i)==expected[i.filename]
 assert z.testzip() is None`
function python(program, value) {
  return run(process.platform === "win32" ? "python" : "python3", ["-c", program],
    { input: JSON.stringify(value), encoding: "utf8" })
}
const zipFiles = extension => sorted(extension).map(([name, bytes]) => [name, bytes.toString("base64")])
export function createZip(extension, epoch, binding = "") {
  assert.ok(Number.isSafeInteger(epoch) && epoch >= 315532800 && epoch <= 4354819199)
  assert.ok(typeof binding === "string" && Buffer.byteLength(binding) < 65536)
  return Buffer.from(python(ZIP_CREATE, { files: zipFiles(extension), epoch, binding }), "base64")
}
export function verifyArchive(archive, extension, binding = "") {
  assert.ok(archive.length < 2 * LIMIT)
  python(ZIP_VERIFY, { zip: archive.toString("base64"), files: zipFiles(extension), binding })
}
const variable = n => {
  const bytes = []
  do { bytes.push((n & 127) | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128) } while (n)
  return Buffer.from(bytes)
}
const bytesField = (number, bytes) => Buffer.concat([variable(number * 8 + 2), variable(bytes.length), bytes])
const little = n => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(n); return bytes }
function fields(bytes) {
  const result = new Map()
  let at = 0
  const read = () => {
    let value = 0, shift = 0, byte
    do {
      assert.ok(at < bytes.length && shift < 35)
      byte = bytes[at++]; value += (byte & 127) * 2 ** shift; shift += 7
    } while (byte & 128)
    return value
  }
  while (at < bytes.length) {
    const tag = read(), size = read(), field = Math.floor(tag / 8)
    assert.equal(tag & 7, 2)
    assert.ok(size <= bytes.length - at && !result.has(field))
    result.set(field, bytes.subarray(at, at + size)); at += size
  }
  return result
}
function signedData(spki) {
  return bytesField(1, crypto.createHash("sha256").update(spki).digest().subarray(0, 16))
}
export function signingInput(archive, spki) {
  const data = signedData(spki)
  return Buffer.concat([Buffer.from("CRX3 SignedData\0"), little(data.length), data, archive])
}
export async function issueSignature(input, signDigest, { reserve, record }) {
  await reserve()
  await record("sign-issued")
  const signature = await signDigest(crypto.createHash("sha256").update(input).digest(), input)
  await record("signature-returned")
  return signature
}
export function encodeCrx(archive, spki, signature) {
  const proof = Buffer.concat([bytesField(1, spki), bytesField(2, signature)])
  const header = Buffer.concat([bytesField(2, proof), bytesField(10000, signedData(spki))])
  assert.ok(header.length < 65536)
  return Buffer.concat([Buffer.from("Cr24"), little(3), little(header.length), header, archive])
}
export function verifyCrx(packet, expectedSpki) {
  assert.ok(packet.length > 12 && packet.length < 2 * LIMIT)
  assert.equal(packet.subarray(0, 4).toString(), "Cr24")
  assert.equal(packet.readUInt32LE(4), 3)
  const size = packet.readUInt32LE(8)
  assert.ok(size < 65536 && 12 + size < packet.length)
  const parsed = fields(packet.subarray(12, 12 + size))
  assert.deepEqual([...parsed.keys()], [2, 10000])
  const proof = fields(parsed.get(2))
  assert.deepEqual([...proof.keys()], [1, 2])
  assert.deepEqual(proof.get(1), expectedSpki)
  assert.deepEqual(parsed.get(10000), signedData(expectedSpki))
  const archive = packet.subarray(12 + size), input = signingInput(archive, expectedSpki)
  const key = crypto.createPublicKey({ key: expectedSpki, format: "der", type: "spki" })
  const verify = bytes => crypto.verify("sha256", bytes, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, proof.get(2))
  assert.equal(verify(input), true)
  const alteredArchive = Buffer.from(input)
  alteredArchive[alteredArchive.length - 1] ^= 1
  assert.equal(verify(alteredArchive), false)
  const alteredHeader = Buffer.from(input)
  alteredHeader[20] ^= 1
  assert.equal(verify(alteredHeader), false)
  return { archive, input }
}
function exactKeys(value, keys) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value))
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
}
export function validatePublicProvenance(proof) {
  exactKeys(proof, PROVENANCE_KEYS)
  assert.match(proof.sourceCommit, /^[0-9a-f]{40}$/u)
  for (const key of ["extensionSourceDigest", "normalDistributionDigest", "zipSha256", "signedInputSha256",
    "crxSha256", "publisherPublicSpkiSha256"]) assert.match(proof[key], /^[0-9a-f]{64}$/u)
  assert.match(proof.extensionId, /^[a-p]{32}$/u)
  assert.equal(proof.algorithm, "RS256")
  assert.equal(proof.status, "signed-package-not-installed-proof")
  assert.deepEqual(proof.verification, VERIFIED)
  assert.ok(Number.isSafeInteger(proof.crxBytes) && proof.crxBytes > 12 && proof.crxBytes < 2 * LIMIT)
  assert.equal(proof.crxFile, `desk-browser-${proof.extensionVersion}.crx`)
  assert.ok(compareVersions(proof.extensionVersion, "1.1.0") > 0)
  assert.equal(proof.archiveInventory.length, FILES.length)
  for (const item of proof.archiveInventory) {
    exactKeys(item, ["name", "bytes", "sha256"])
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes < LIMIT)
    assert.match(item.sha256, /^[0-9a-f]{64}$/u)
  }
  assert.deepEqual(proof.archiveInventory.map(item => item.name), FILES)
  return proof
}
const xml = (id, ver) => `<?xml version="1.0" encoding="UTF-8"?>\n<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${id}"><updatecheck codebase="${new URL(`desk-browser-${ver}.crx`, NORMAL_FEED).href}" version="${ver}"/></app></gupdate>\n`
// ZIP comments add no payload file. This public binding is inside the CRX signature,
// so byte-equivalent later commits cannot be substituted as the packaging source.
const archiveBinding = proof => JSON.stringify({
  sourceCommit: proof.sourceCommit, extensionSourceDigest: proof.extensionSourceDigest,
  normalDistributionDigest: proof.normalDistributionDigest,
})
export function validateArtifactNames(names, ver) {
  assert.ok(names.every(name => name === "provenance.json" || name === "updates.xml" ||
    /^desk-browser-(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}\.crx$/u.test(name)),
  "public output excludes private authority, attempt journals and installation proposals")
  for (const required of ["provenance.json", "updates.xml", `desk-browser-${ver}.crx`]) {
    assert.ok(names.includes(required))
  }
}
function readArtifact(directory, name, limit = 2 * LIMIT) {
  assert.equal(fs.realpathSync(directory), path.resolve(directory))
  const file = path.join(directory, name)
  const info = fs.lstatSync(file)
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < limit)
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file)
  for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"]) assert.equal(info[field], after[field])
  assert.equal(bytes.length, info.size)
  return bytes
}
function sourceEntries(distribution) {
  return new Map([...distribution.sources,
    ...[...distribution.extension].map(([name, bytes]) => [`browser-extension/${name}`, bytes]),
    ["mcp/artifacts/browser-messaging/manifest.json", distribution.artifactManifest]])
}
function verifySourceCommit(repo, commit, distribution) {
  assert.match(commit, /^[0-9a-f]{40}$/u)
  assert.equal(git(repo, "cat-file", "-t", commit).toString().trim(), "commit")
  // Re-read the recorded Git source, including EVERY capsule source and asset manifest.
  // A normal Desk-only version fold does not change this inventory. No recorded digest
  // is ignored, and the packaging source is never relabeled as the later release SHA.
  const entries = sourceEntries(distribution)
  const files = [...entries.keys()].map(name => `plugins/desk/${name}`)
  const recorded = git(repo, "ls-tree", "-z", commit, "--", ...files).toString().split("\0").filter(Boolean)
  assert.equal(recorded.length, files.length)
  for (const entry of recorded) {
    const [metadata, name] = entry.split("\t")
    assert.match(metadata, /^100(?:644|755) blob [0-9a-f]{40}$/u)
    assert.ok(files.includes(name), "recorded source must be ordinary Git files, not symlink payloads")
  }
  for (const [name, bytes] of entries) {
    assert.ok(!path.posix.isAbsolute(name) && !name.split("/").includes(".."))
    assert.deepEqual(git(repo, "show", `${commit}:plugins/desk/${name}`), bytes)
  }
}
export async function verifyPackage({ repo, distribution, artifacts = path.join(repo, "artifacts/browser-native"), publisher = PUBLISHER }) {
  const manifest = validateDistribution(distribution, publisher)
  validateArtifactNames(fs.readdirSync(artifacts), manifest.version)
  const proof = validatePublicProvenance(JSON.parse(readArtifact(artifacts, "provenance.json", LIMIT)))
  assert.equal(proof.extensionId, distribution.extensionId)
  assert.equal(proof.extensionVersion, manifest.version)
  assert.equal(proof.extensionSourceDigest, distribution.extensionSourceDigest)
  assert.equal(proof.normalDistributionDigest, distribution.distributionDigest)
  assert.equal(proof.publisherPublicSpkiSha256, publisher.spkiSha256)
  assert.deepEqual(proof.archiveInventory, inventory(distribution.extension))
  verifySourceCommit(repo, proof.sourceCommit, distribution)
  const packet = readArtifact(artifacts, proof.crxFile)
  assert.equal(packet.length, proof.crxBytes)
  assert.equal(sha(packet), proof.crxSha256)
  const parsed = verifyCrx(packet, Buffer.from(manifest.key, "base64"))
  assert.equal(sha(parsed.archive), proof.zipSha256)
  assert.equal(sha(parsed.input), proof.signedInputSha256)
  verifyArchive(parsed.archive, distribution.extension, archiveBinding(proof))
  assert.equal(readArtifact(artifacts, "updates.xml", 8192).toString(), xml(distribution.extensionId, manifest.version))
  return proof
}
export async function createPackage({ repo, distribution, output, signDigest, publisher = PUBLISHER,
  existingArtifacts = path.join(repo, "artifacts/browser-native") }) {
  const manifest = validateDistribution(distribution, publisher)
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all").toString().trim(), "")
  const sourceCommit = git(repo, "rev-parse", "HEAD").toString().trim()
  verifySourceCommit(repo, sourceCommit, distribution)
  let prior = null
  if (fs.existsSync(existingArtifacts)) {
    assert.ok(fs.lstatSync(existingArtifacts).isDirectory() && !fs.lstatSync(existingArtifacts).isSymbolicLink())
    assert.equal(fs.realpathSync(existingArtifacts), path.resolve(existingArtifacts))
  }
  if (fs.existsSync(existingArtifacts) && fs.readdirSync(existingArtifacts).length > 0) {
    prior = validatePublicProvenance(JSON.parse(readArtifact(existingArtifacts, "provenance.json", LIMIT)))
    validateArtifactNames(fs.readdirSync(existingArtifacts), prior.extensionVersion)
  }
  const reused = await reuseVerifiedPackage({ next: manifest.version, previous: prior?.extensionVersion ?? null,
    versionFileExists: fs.existsSync(path.join(existingArtifacts, `desk-browser-${manifest.version}.crx`)),
    verify: () => verifyPackage({ repo, distribution, artifacts: existingArtifacts, publisher }) })
  if (reused) return { status: "reused", sourceCommit: reused.sourceCommit,
    extensionId: reused.extensionId, crxSha256: reused.crxSha256 }
  assert.ok(!fs.existsSync(output), "output must be fresh")
  assert.ok(path.isAbsolute(output))
  const parent = fs.realpathSync(path.dirname(output)), root = fs.realpathSync(repo)
  assert.equal(path.dirname(output), parent, "output parent must use its canonical path before signing")
  assert.ok(parent !== root && !parent.startsWith(root + path.sep), "signed output stays outside the source repository")
  const disk = fs.statfsSync(parent)
  assert.ok(disk.bavail * disk.bsize > 1610612736 + 67108864)
  const epoch = Number(git(repo, "show", "-s", "--format=%ct", sourceCommit).toString().trim())
  const binding = archiveBinding({ sourceCommit, extensionSourceDigest: distribution.extensionSourceDigest,
    normalDistributionDigest: distribution.distributionDigest })
  const archive = createZip(distribution.extension, epoch, binding), spki = Buffer.from(manifest.key, "base64")
  verifyArchive(archive, distribution.extension, binding)
  const input = signingInput(archive, spki)
  assert.equal(typeof signDigest, "function")
  const attempt = createSigningAttempt({
    commonDirectory: signingCommonDirectory(repo), publisher, extensionVersion: manifest.version,
    sourceCommit, signedInputSha256: sha(input), output,
  })
  try {
    const signature = await issueSignature(input, signDigest, attempt)
    const packet = encodeCrx(archive, spki, signature)
    const parsed = verifyCrx(packet, spki)
    assert.deepEqual(parsed.archive, archive)
    const proof = {
      sourceCommit, extensionId: distribution.extensionId, extensionVersion: manifest.version,
      extensionSourceDigest: distribution.extensionSourceDigest, normalDistributionDigest: distribution.distributionDigest,
      archiveInventory: inventory(distribution.extension), zipSha256: sha(archive), algorithm: "RS256",
      signedInputSha256: sha(input), crxFile: `desk-browser-${manifest.version}.crx`, crxSha256: sha(packet),
      crxBytes: packet.length, status: "signed-package-not-installed-proof", publisherPublicSpkiSha256: publisher.spkiSha256,
      verification: { ...VERIFIED },
    }
    validatePublicProvenance(proof)
    // Inputs must still be the same committed bytes after the remote signing interval.
    assert.equal(git(repo, "rev-parse", "HEAD").toString().trim(), sourceCommit)
    assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all").toString().trim(), "")
    verifySourceCommit(repo, sourceCommit, distribution)
    for (const [name, bytes] of [[proof.crxFile, packet], ["updates.xml", xml(proof.extensionId, manifest.version)],
      ["provenance.json", JSON.stringify(proof, null, 2) + "\n"]]) {
      fs.writeFileSync(path.join(output, name), bytes, { flag: "wx", mode: 0o600 })
    }
    const verified = await verifyPackage({ repo, distribution, artifacts: output, publisher })
    attempt.record("signed-locally-verified")
    return verified
  } finally { attempt.close() }
}

async function main(args) {
  const [mode, root, third, fourth] = args
  if (!["--check-source", "--verify", "--sign"].includes(mode) || !root ||
    (mode === "--check-source" && args.length !== 2) ||
    (mode === "--verify" && ![2, 3].includes(args.length)) ||
    (mode === "--sign" && args.length !== 4)) refuse("BROWSER_PACKAGE_USAGE")
  if (mode === "--sign" && (process.env.CI || process.env.GITHUB_ACTIONS)) refuse("BROWSER_CI_SIGNING_UNAUTHORIZED")
  const repo = path.resolve(root)
  const artifacts = path.resolve(third || path.join(repo, "artifacts/browser-native"))
  if (mode === "--verify" && !fs.existsSync(path.join(artifacts, "provenance.json"))) refuse("BROWSER_PACKAGE_MISSING")
  // Always import the verifier belonging to THIS maintained producer, never code
  // selected by a source/provenance/receipt argument.
  const { verifyNativeDistribution } = await import("../plugins/desk/mcp/native-messaging-install.mjs")
  const distribution = await verifyNativeDistribution(path.join(repo, "plugins/desk"))
  validateDistribution(distribution, PUBLISHER)
  if (mode === "--check-source") return { status: "source-checked-not-signed", extensionId: distribution.extensionId }
  if (mode === "--verify") return verifyPackage({ repo, distribution, artifacts })
  const receiptPath = fs.realpathSync(path.resolve(third)), output = path.resolve(fourth)
  assert.ok(!receiptPath.startsWith(repo + path.sep), "private authority receipts stay outside source")
  // LOCAL user authority only. Validate the existing private receipt before the
  // attempt is reserved. No CI/WIF identity, account switch, export or grant.
  const receipt = JSON.parse(fs.readFileSync(receiptPath))
  assert.equal(receipt.signingProof.localVerification, true)
  assert.equal(receipt.publicKeyAttributes.exportable, false)
  assert.deepEqual([...receipt.publicKey.key_ops].sort(), ["sign", "verify"])
  assert.equal(receipt.publicIdentity.extensionId, PUBLISHER.extensionId)
  assert.equal(sha(Buffer.from(receipt.publicIdentity.spkiBase64, "base64")), PUBLISHER.spkiSha256)
  assert.match(receipt.subscriptionId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu)
  const kid = new URL(receipt.publicKey.kid)
  assert.equal(kid.protocol, "https:")
  assert.match(kid.hostname, /^[a-z0-9-]+\.vault\.azure\.net$/u)
  assert.equal(kid.username + kid.password + kid.port + kid.search + kid.hash, "")
  assert.match(kid.pathname, /^\/keys\/[A-Za-z0-9-]+\/[0-9a-f]{32}$/u)
  const signDigest = digest => {
    const signed = JSON.parse(run("az", ["rest", "--subscription", receipt.subscriptionId,
      "--resource", "https://vault.azure.net", "--method", "post",
      "--url", kid.href + "/sign?api-version=7.4",
      "--body", JSON.stringify({ alg: "RS256", value: digest.toString("base64url") }), "-o", "json"], { encoding: "utf8" }))
    assert.equal(signed.kid, receipt.publicKey.kid)
    return Buffer.from(signed.value, "base64url")
  }
  return createPackage({ repo, distribution, output, signDigest })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify({ status: result.status, sourceCommit: result.sourceCommit,
      extensionId: result.extensionId, crxSha256: result.crxSha256 }))
  }).catch(error => {
    // No private receipt, resource identifiers, local paths or subprocess output.
    console.error(["BROWSER_PACKAGE_MISSING", "BROWSER_PACKAGE_USAGE", "BROWSER_CI_SIGNING_UNAUTHORIZED"].includes(error.code)
      ? error.code : "BROWSER_PACKAGE_REFUSED")
    process.exitCode = 1
  })
}
