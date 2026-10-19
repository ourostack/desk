"use strict"
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const core = require("../../../../../../plugins/desk/mcp/scripts/owned-git-child.cjs")
const ALLOCATION_SHA = "e46fbabf1bc604b2531d3c3e573ea2110cbfb2282e3717ca72d68766ce6acee4"
const PRODUCT_BASE = "55b82d6949ddf475d122f2cd2dce5fa767d7a422"
const SOURCE_PATHS = Object.freeze([
  "plugins/desk/mcp/native/windows-owned-git.c", "plugins/desk/mcp/scripts/owned-git-child.cjs",
  "plugins/desk/mcp/scripts/build-owned-git.ps1", "plugins/desk/mcp/scripts/verify-owned-git.js",
  ".github/workflows/desk-windows-suite.yml", ".github/scripts/run-as-standard-user.ps1",
  ".github/scripts/run-suite-files.mjs", ".github/scripts/owned-git-product-io.mjs",
  "tests/desk/mcp/__tests__/runtime/windows_owned_git.test.js",
  ...["driver.cjs", "fault_root.cjs", "fault_owner.c", "supervisor.c", "retention.cjs",
    "workload.cjs", "preload.cjs"].map((name) => `tests/desk/mcp/__tests__/runtime/fixtures/windows_owned_git_${name}`),
  "tests/desk/mcp/__tests__/runtime/fixtures/build_windows_owned_git_fixtures.ps1",
])

const PUBLIC_LEAVES = Object.freeze([
  "export/sources/s01-production-owner.c", "export/sources/s02-production-root.cjs",
  "export/sources/s03-production-builder.ps1", "export/sources/s04-production-verifier.js",
  "export/sources/s05-windows-workflow.yml", "export/sources/s06-standard-user.ps1",
  "export/sources/s07-suite-runner.mjs", "export/sources/s08-product-io.mjs",
  "export/sources/s09-product-test.js", "export/sources/s10-driver.cjs",
  "export/sources/s11-test-root.cjs", "export/sources/s12-fault-owner.c",
  "export/sources/s13-supervisor.c", "export/sources/s14-retention.cjs",
  "export/sources/s15-workload.cjs", "export/sources/s16-preload.cjs",
  "export/sources/s17-fixture-builder.ps1",
  "export/binaries/production-owner.exe", "export/binaries/production-owner-instrumented.exe",
  "export/binaries/fault-owner.exe", "export/binaries/fault-owner-instrumented.exe",
  "export/binaries/retained-supervisor.exe", "export/shim/owned-git-child.cjs",
  "export/manifests/production-assets.json", "export/manifests/fixture-assets.json",
  "export/manifests/source-assets.json", "safe-evidence/report.json", "safe-evidence/cases.json",
  "safe-evidence/clock.json", "safe-evidence/observer.json", "safe-evidence/runtime.json",
  "safe-evidence/build.json", "safe-evidence/retention-controls.json", "safe-evidence/manifest.json",
])
const EXCLUSIONS = Object.freeze(["PREPARE", "AUTH", "CONFIG", "payload", "capability", "environment",
  "raw-stdio", "raw-TAP", "raw-stderr", "raw-profile", "private-paths"])
const MANIFEST_SELF_ROW = Object.freeze({ id: 34, path: PUBLIC_LEAVES[33], presence: "present",
  bytes: null, sha256: null, origin: "unobserved", mandatory: true, gap: "none" })
const GAPS = Object.freeze(("none not_admitted source_mismatch runtime_mismatch tool_missing toolchain_shape build_failed " +
  "namespace_not_fresh guard_failed producer_unjoined bootstrap_missing bootstrap_invalid bootstrap_not_real_zero " +
  "model_origin role_missing role_withheld identity_changed quota clock_mismatch deadline case_mismatch " +
  "denominator_missing denominator_mismatch ci_envelope artifact_missing artifact_digest schema signal_failure " +
  "owner_join_missing retirement_unproved").split(" "))
function fail(code = "schema") { throw Object.assign(new Error(code), { code }) }
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")
function keys(v, names) {
  if (!v || typeof v !== "object" || Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Object.keys(v).length !== names.length || names.some((k) => !Object.hasOwn(v, k))) fail()
}
const integer = (lo, hi) => (v) => { if (!Number.isSafeInteger(v) || v < lo || v > hi) fail(); return v }
const N = integer(0, Number.MAX_SAFE_INTEGER), U32 = integer(0, 4294967295), B = (v) => { if (typeof v !== "boolean") fail(); return v }
const literal = (want) => (v) => { if (v !== want) fail(); return v }
const enumeration = (...values) => (v) => { if (!values.includes(v)) fail(); return v }
const text = (regex, max) => (v) => {
  if (typeof v !== "string" || Buffer.byteLength(v) > max || !regex.test(v)) fail()
  return v
}
const H = text(/^[0-9a-f]{64}$/, 64), G40 = text(/^[0-9a-f]{40}$/, 40)
const D = (v) => { text(/^(0|[1-9][0-9]{0,19})$/, 20)(v); if (BigInt(v) > 18446744073709551615n) fail(); return v }
const nullable = (check) => (v) => v === null ? null : check(v)
const array = (check, min, max = min) => (v) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail()
  return v.map(check)
}
const object = (fields) => (v) => {
  keys(v, Object.keys(fields))
  return Object.fromEntries(Object.entries(fields).map(([k, check]) => [k, check(v[k])]))
}
const gap = enumeration(...GAPS), role = enumeration("20", "22", "24")
const presence = enumeration("present", "missing", "expected_absent", "withheld", "not_attempted")
const origin = enumeration("ci_host_rehashed", "producer_reported", "retained_reference", "outer_artifact_rehashed", "unobserved")
const signal = nullable(text(/^SIG[A-Z0-9]{1,20}$/, 23))
const registry = () => require("./windows_owned_git_driver.cjs").getNativeCaseRegistry()
const caseId = (v) => { if (!registry().some((row) => row.id === v)) fail(); return v }
const sourceKey = enumeration(...Array.from({ length: 17 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`))
const binaryKeys = Object.freeze(["production-owner.exe", "production-owner-instrumented.exe", "fault-owner.exe",
  "fault-owner-instrumented.exe", "retained-supervisor.exe"])
const variants = Object.freeze(["wrong-pid-delay.cjs", "malformed.cjs", "replay-result.cjs", "trailing.cjs",
  "partial-header.cjs", "partial-body.cjs", "oversized.cjs", "eof-before-result.cjs", "pressure.cjs",
  "normal.cjs", "clock-companion.cjs"])
const retId = enumeration("RET01", "RET02", "RET03", "RET04", "RET05", "RET06", "RET07")
const producerId = enumeration("main", "RET01", "RET02", "RET03", "RET04", "RET05", "RET06", "RET07")
const producerOrigin = enumeration("real-supervisor", "fault-model")
function mapPlanningProducer(v) {
  if (v === "real-supervisor") return v
  if (v === "fault-owner-model") return "fault-model"
  fail()
}
const roleRead = object({ role: enumeration("bootstrap", "controller-report", "native-receipt",
  "preload-marker", "unexpected-bootstrap-marker", "retention-sentinel"), case: nullable(caseId), slot: nullable(integer(0, 1)),
  producer: producerId, presence, bytes: nullable(N), sha256: nullable(H), origin, gap })
const leaf = object({ id: integer(1, 34), path: enumeration(...PUBLIC_LEAVES), presence, bytes: nullable(N),
  sha256: nullable(H), origin: enumeration("ci_host_rehashed", "unobserved"), mandatory: literal(true), gap })
function validateLeaf(v, id) {
  const out = leaf(v)
  if (out.id !== id || out.path !== PUBLIC_LEAVES[id - 1] || out.presence === "expected_absent" ||
    out.presence === "withheld") fail()
  if (id === 34) {
    if (JSON.stringify(out) !== JSON.stringify(MANIFEST_SELF_ROW)) fail()
  } else if (out.presence === "present") {
    if (!(out.bytes > 0) || out.sha256 === null || out.origin !== "ci_host_rehashed" || out.gap !== "none") fail()
  } else if (out.bytes !== null || out.sha256 !== null || out.origin !== "unobserved" || out.gap === "none") fail()
  return out
}
function canonicalLeafMetadata(rows) {
  if (!Array.isArray(rows) || rows.length !== 33) fail()
  return Buffer.from(JSON.stringify(rows.map((row, i) => validateLeaf(row, i + 1))))
}
function computeLeafSetSha256(rows) {
  return crypto.createHash("sha256").update(canonicalLeafMetadata(rows)).digest("hex")
}
function projectManifest(v) {
  const out = object({ leaves: array((r) => r, 34), privateRoles: array(roleRead, 0, 104),
    exclusions: (x) => {
      if (JSON.stringify(x) !== JSON.stringify(EXCLUSIONS)) fail()
      return [...EXCLUSIONS]
    }, privateOriginalRehashedByOuter: literal(false), publicOriginalRehashedByOuter: literal(false),
    gaps: array(gap, 0, 32), leafSetSha256: nullable(H) })(v)
  out.leaves = out.leaves.map((row, i) => validateLeaf(row, i + 1))
  const complete = out.leaves.slice(0, 33).every((r) => r.presence === "present") && out.gaps.length === 0
  if (complete ? out.leafSetSha256 !== computeLeafSetSha256(out.leaves.slice(0, 33))
    : out.leafSetSha256 !== null || out.gaps.length === 0) fail()
  return out
}
const countKeys = ("componentCases retentionControls generations parentSTART nativeSTART genuineRESULT eligibleNativeCertificates " +
  "certificateNotStarted certificateReported certificateUnknown rootCreations ownerFullClose ownerFullCloseMissing " +
  "utilityProcesses modelRoots modelRootsRetiredReal receiptAbsent receiptWithheld").split(" ")
const counts = object(Object.fromEntries(countKeys.map((k) => [k, N])))
const claims = object(Object.fromEntries(["nativeQualified", "exact100Qualified", "original38Qualified", "full49Qualified",
  "recordsQualified", "integrationQualified", "releaseQualified"].map((k) => [k, literal(false)])))
const reportShape = object({ status: enumeration("complete-observation", "STOP", "incomplete"), gap, expected: counts,
  observed: nullable(counts), casesMatched: integer(0, 80), retentionMatched: integer(0, 7), bootstrapEligible: B,
  privateExportComplete: B, clockQualifiedObservation: B, denominatorCompared: B, producerFailed: B, claims })
function projectReport(v) {
  const out = reportShape(v)
  if (out.status === "complete-observation" && (out.gap !== "none" || out.observed === null ||
    !out.bootstrapEligible || !out.privateExportComplete || !out.clockQualifiedObservation ||
    !out.denominatorCompared || out.casesMatched !== 80 || out.retentionMatched !== 7)) fail()
  return out
}
const bootstrapShape = object({ schema: literal("desk.owned-git-real-retention/1"), nonce: H, sourceRevision: G40,
  sourceTree: G40, allocationSha256: literal(ALLOCATION_SHA), fixtureManifestSha256: H, Hns: D, controllerPid: U32,
  controllerRetired: literal(true), unassignedRetired: literal(true), jobSealed: literal(true), activeProcesses: literal(0),
  queryOrigin: literal("real-win32"), controlReaped: literal(true), criticalHandlesClosed: literal(true), complete: literal(true) })
function validateBootstrap(v, binding) {
  if (v && typeof v === "object" && v.activeProcesses !== 0 && Number.isSafeInteger(v.activeProcesses)) fail("bootstrap_not_real_zero")
  const out = bootstrapShape(v)
  if (!out.controllerPid) fail("bootstrap_invalid")
  for (const k of ["nonce", "sourceRevision", "sourceTree", "allocationSha256", "fixtureManifestSha256", "Hns", "controllerPid"]) {
    if (out[k] !== binding[k]) fail("bootstrap_invalid")
  }
  return out
}
function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.type === b.type && a.size === b.size &&
    (a.mtimeNs === undefined || b.mtimeNs === undefined || a.mtimeNs === b.mtimeNs) && !a.reparse && !b.reparse
}
function guardedRoleRead(io, bound) {
  const before = io.before()
  if (!before || before.reparse || before.type !== "file" || !Number.isSafeInteger(before.size) ||
    before.size < 0 || before.size > bound) fail("guard_failed")
  if (io.expected && !sameIdentity(io.expected, before)) fail("identity_changed")
  const bytes = io.read(before)
  if (!Buffer.isBuffer(bytes) || bytes.length !== before.size || !sameIdentity(before, io.after())) fail("identity_changed")
  return bytes
}
const FROZEN = Object.freeze([
  "05a68645f6b744ea6f76b685f973e1e0b727453ea23c7255fad9a23c1cf85122",
  "855f39ce6092a85c2285a6d45adc5403a0f772722bae496ec70d0a52e5093d38",
  "d8fa94904c58b245c342a98ca99dd2443e932b276c47cd0e3dcaaf2bd134ea37",
  "7fe7ac7b0dad4e6f379a7e7c8f546a765e64ceae36a6b262d7afd42856a09fc5",
])
// Disk policy: reviewed R1 2004f3a4f1a9377ea63655696a5e742657d93857b1ebc5938b900482495caf81
// plus superseding R2 9045060dd2d844315ca3f8dd3eca3000c8de21c08242ad4910b89f608c6dcd4a.
// This replaces runtime profiles, not the immutable eighty-case allocation.
// Git-chain policy A 907620e93e5eeaa55db3192b845cd3894a9dda0971a0c3df5e3c4dfc90c0740c
// plus erratum a548b8d2453de2864c1557ddfec7c138df75f94f3a6d9c46bb93325af6dfd6a1.
const BASELINE_TEXT_SHA = "662970fac258865cfe4002ed63efa04be7a132f9319451a70ffd15233a55eb1f"
function syntheticBaselineRecipe() {
  const text = Buffer.from(":fe\n!na1.synthetic.zero!\n0\n1\n0\n\n", "ascii")
  if (text.length !== 32 || sha(text) !== BASELINE_TEXT_SHA) fail("source_mismatch")
  return Object.freeze({ text, textSha256: BASELINE_TEXT_SHA, indexedMaxBytes: 1024,
    publicScratchBytes: 9248, normalizedTextBytes: 75,
    normalizedTextSha256: "2412e4ee68e65b57fe8cc8261699eaa69c2cf7ff23c9f63f90ec8aec9bca26f5" })
}
function validateSyntheticInput(bytes) {
  const recipe = syntheticBaselineRecipe()
  if (!Buffer.isBuffer(bytes) || !bytes.equals(recipe.text)) fail("source_mismatch")
  return recipe
}
function prepareSyntheticBuildInput(s) {
  if (process.hrtime.bigint() >= s.H - 90000000000n) fail("deadline")
  const bytes = validateSyntheticInput(syntheticBaselineRecipe().text).text
  fs.mkdirSync(s.layout.fixtureRoot)
  const directory = path.join(s.layout.fixtureRoot, "na1-known-scratch")
  fs.mkdirSync(directory)
  const execPath = path.join(s.layout.fixtureRoot, "na1-exec-empty")
  fs.mkdirSync(execPath)
  s.gitExecIdentity = diskIdentity(execPath)
  let fd
  try {
    fd = fs.openSync(path.join(directory, "zero.txt"), "wx", 0o600)
    let at = 0
    while (at < bytes.length) {
      if (process.hrtime.bigint() >= s.H - 90000000000n) fail("deadline")
      const n = fs.writeSync(fd, bytes, at, bytes.length - at)
      if (!n) fail("guard_failed")
      at += n
    }
    fs.fsyncSync(fd)
  } finally { if (fd !== undefined) closeOwnedFile(fd) }
}
const denominatorShape = object({ source: literal(FROZEN[0]), regions: integer(1, Number.MAX_SAFE_INTEGER),
  branches: integer(1, Number.MAX_SAFE_INTEGER), functions: integer(1, Number.MAX_SAFE_INTEGER),
  lines: integer(1, Number.MAX_SAFE_INTEGER), origin: literal("public-instrumented-mapping-synthetic-indexed-zero") })
function projectCoverage(v) {
  const out = object({ production: denominatorShape, fault: denominatorShape, equal: literal(true),
    scope: literal("identical-production-file-only"), exact100: literal(false),
    executionCounts: literal("synthetic-zero"), runtimeProfile: literal("not-collected"), baselineSha256: H })(v)
  for (const k of ["regions", "branches", "functions", "lines"]) if (out.production[k] !== out.fault[k]) fail("denominator_mismatch")
  return out
}
const phaseShape = object(Object.fromEntries(["clockReady", "clockAccepted", "ready", "configured", "parentSTARTSent",
  "nativeSTARTIssued", "resultReceived", "controlComplete", "sealSent", "cancelSent"].map((k) => [k, k === "nativeSTARTIssued" ? nullable(B) : B])))
const joinsShape = object({ ownerExitObserved: B, ownerCloseObserved: B, stdoutEOF: B, stdoutClosed: B,
  stderrEOF: B, stderrClosed: B, controlEOF: B, controlClosed: B, origin: literal("producer_reported") })
const resourceShape = object({ rootCreated: integer(0, 1), assigned: integer(0, 1), resumed: integer(0, 1),
  rootLiveAfterResult: nullable(B), privateRootRetirement: enumeration("real-certificate", "unproved", "not-created"),
  broaderRetirement: enumeration("real-sealed-zero", "unproved"), modelStrandedRoot: integer(0, 1),
  assignmentModeled: B, membershipModeled: B, queryModeled: B, rootWaitModeled: B, ioRouteInstrumented: B,
  pendingReads: nullable(U32), pendingWrites: nullable(U32), cancelRequests: nullable(U32),
  reapedReads: nullable(U32), reapedWrites: nullable(U32), registryPeak: nullable(integer(0, 64)), origin: literal("producer_reported") })
const dataShape = object({ stdinExpectedBytes: integer(0, 524288), stdoutBytes: integer(0, 4194304),
  stderrBytes: integer(0, 4194304), combinedOverflow: B, dataComplete: B, controlBytesRead: N,
  controlBytesWritten: N, decoderPushes: N, decoderProcessingNs: D, resultAtNs: nullable(D),
  inputSettledAtNs: nullable(D), actualEOFAtNs: nullable(D), controlCompleteAtNs: nullable(D),
  sealAtNs: nullable(D), terminalAtNs: nullable(D), ownerCloseAtNs: nullable(D), origin: literal("producer_reported") })
const productFailure = enumeration("none", "prepare", "configure", "start", "protocol", "io", "deadline", "retirement", "clock", "internal")
function generationShape(v) {
  const result = nullable((value) => core.decodeResult(Buffer.from(JSON.stringify(value), "ascii").toString("base64")))
  const out = object({ slot: integer(0, 1), generation: H, preparationDigest: H, proposedPayloadDigest: nullable(H),
    acceptedPayloadDigest: nullable(H), recordIdShape: literal("independent-H-fixture"), tokenShape: literal("T32-fixture"),
    durableOperationRecord: literal(false), phase: phaseShape, resultB64: nullable(text(/^[A-Za-z0-9+/]*={0,2}$/, 684)),
    result, certificate: (c) => c, certificateOrigin: enumeration("live-control", "receipt-after-gate", "none", "withheld-model", "withheld-owner-close"),
    terminalFailure: nullable(productFailure), invocation: enumeration("success", "failed-proved", "HOLD"),
    joins: joinsShape, resources: resourceShape, data: dataShape, clockRow: nullable(integer(0, 482)),
    deadlineNs: D, finishedNs: D, bindingOrigin: literal("producer_reported") })(v)
  if (out.certificate !== null) {
    if (out.certificateOrigin !== "live-control" && out.certificateOrigin !== "receipt-after-gate") fail()
    out.certificate = core.validateCertificate(out.certificate, {
      generation: out.generation, preparationDigest: out.preparationDigest, payloadDigest: out.acceptedPayloadDigest,
    })
    if (out.certificate.resultB64 !== out.resultB64) fail()
  } else if (["live-control", "receipt-after-gate"].includes(out.certificateOrigin)) fail()
  if (out.resources.privateRootRetirement === "real-certificate" && out.certificate === null) fail("retirement_unproved")
  if (out.resultB64 === null ? out.result !== null :
    JSON.stringify(core.decodeResult(out.resultB64)) !== JSON.stringify(out.result)) fail()
  if (out.phase.resultReceived !== (out.result !== null)) fail("case_mismatch")
  if (out.result && out.result.input.expectedBytes !== out.data.stdinExpectedBytes) fail()
  if ((out.phase.ready && !out.phase.clockAccepted) || (out.phase.resultReceived && !out.phase.parentSTARTSent) ||
    (out.phase.controlComplete && !out.phase.resultReceived) || (out.phase.sealSent && !out.phase.controlComplete)) fail()
  if (out.invocation === "success" && (BigInt(out.finishedNs) >= BigInt(out.deadlineNs) || !out.certificate ||
    !out.phase.controlComplete || !out.joins.ownerCloseObserved || !out.joins.ownerExitObserved ||
    !out.joins.stdoutEOF || !out.joins.stdoutClosed || !out.joins.stderrEOF || !out.joins.stderrClosed ||
    !out.joins.controlEOF || !out.joins.controlClosed || out.data.combinedOverflow || !out.data.dataComplete ||
    out.result?.command.state !== "exited" || out.result.command.code !== 0 || out.result.command.signal !== null ||
    out.result.input.state !== "complete" || out.terminalFailure !== "none")) fail()
  return out
}
const expectedShape = object({ generations: integer(0, 2), parentSTART: integer(0, 1), nativeSTART: integer(0, 1),
  genuineRESULT: integer(0, 1), eligibleNativeCertificates: integer(0, 2), rootCreations: integer(0, 2),
  ownerFullClose: integer(0, 2), utilityProcesses: integer(0, 2), modelStrandedRoots: integer(0, 1), HOLD: B })
function projectCase(v) {
  const out = object({ id: caseId, evidenceClass: enumeration("A", "B", "C"), parent: role, root: nullable(role),
    profile: enumeration("NONE", "G_BASELINE", "G_EXIT0", "G_EXIT7", "MISSING_GIT", "G_STDIN512K", "G_EPIPE",
      "G_BLOCK", "G_DATA_PRESSURE", "G_DELAY1500", "G_COMMIT", "RESULT_VECTORS", "CLOCK_SAMPLES", "REAL_IO_HELPERS", "DENOMINATOR_SEEDS"),
    expected: expectedShape, receiptPolicy: enumeration("required", "required_file_only", "expected_absent", "withheld_model", "withheld_owner_close", "none"),
    actual: nullable(object({ matched: B, disposition: enumeration("success", "failed-proved", "HOLD", "utility-only"),
      generations: array(generationShape, 0, 2), utilityId: nullable(caseId), sourceOrigin: literal("producer_reported"),
      caseDeadlineNs: D, finishedNs: D })), gap })(v)
  const plan = registry().find((row) => row.id === out.id)
  for (const k of ["evidenceClass", "parent", "root", "profile", "receiptPolicy"]) if (out[k] !== plan[k]) fail("case_mismatch")
  if (JSON.stringify(out.expected) !== JSON.stringify(plan.expected)) fail("case_mismatch")
  if (out.actual) {
    const gs = out.actual.generations
    if (gs.length > out.expected.generations || new Set(gs.map((g) => g.slot)).size !== gs.length) fail()
    if (out.receiptPolicy.startsWith("withheld_") && gs.some((g) => g.certificate !== null || g.joins.ownerCloseObserved)) fail()
    for (const g of gs) if (g.deadlineNs !== out.actual.caseDeadlineNs) fail("deadline")
  }
  return out
}
const ioChecks = object({ realPendingRead: B, realPendingWrite: B, cancelReadRequested: B, cancelWriteRequested: B,
  readReaped: B, writeReaped: B, storageRetainedUntilReap: B, syntheticEOF: literal(false) })
const utilityShape = object({ id: caseId, processes: integer(1, 2), fullcloseObserved: integer(0, 2),
  companionFullcloseObserved: nullable(B), checksExpected: enumeration(5, 136, 8, 4), checksPassed: N,
  kernelCredit: literal(false), resultVectorBits: nullable(array(B, 5)), io: nullable(ioChecks),
  clockRows: array(integer(0, 482), 0, 136), denominator: nullable(projectCoverage), gap })
function projectCases(v) {
  const out = object({ cases: array(projectCase, 80), utilities: array(utilityShape, 6),
    markers: array(object({ case: nullable(caseId), kind: enumeration("downstream", "unexpected-bootstrap"),
      runtime: role, optionsMatch: B, nodePathMatch: B, origin: literal("producer_reported") }), 0, 13), gap })(v)
  if (out.cases.some((row, i) => row.id !== registry()[i].id) ||
    out.cases.reduce((n, row) => n + (row.actual?.generations.length || 0), 0) > 75) fail("case_mismatch")
  const utilityIds = registry().filter((p) => p.expected.utilityProcesses).map((p) => p.id)
  if (out.utilities.some((u, i) => u.id !== utilityIds[i] || u.checksPassed > u.checksExpected ||
    u.fullcloseObserved > u.processes)) fail()
  return out
}
function projectClock(v) {
  return object({ samples: array(object({ case: caseId, generationSlot: nullable(integer(0, 1)), role,
    origin: enumeration("owner", "parent-companion", "root-companion", "fixed-vector"), index: integer(0, 74),
    q: D, f: D, converted: nullable(D), edge: nullable(D), beforeNs: nullable(D), afterNs: nullable(D),
    deadlineNs: D, accepted: B, modeled: B }), 0, 483), gaps: array(object({ case: caseId, code: gap }), 0, 80) })(v)
}
const producerShape = object({ id: producerId, origin: producerOrigin, imageSha256: H, observedPid: U32,
  exitObserved: B, closeObserved: B, stdoutEOF: B, stdoutClosed: B, stderrEOF: B, stderrClosed: B,
  code: nullable(integer(-2147483648, 4294967295)), signal, deadlineNs: D, closedAtNs: nullable(D),
  telemetryBytes: integer(0, 1048576), eligible: B, primaryFailurePreserved: B })
function projectObserver(v) {
  const out = object({ producers: array(producerShape, 8), guard: object({ freshNamespace: B, standardToken: B,
    longNamesOnly: B, identityStable: B, depthPeak: integer(0, 64), entries: integer(0, 8192),
    filesRead: integer(0, 1024), bytesRead: N, realBroaderZero: B, earlyPrivateReads: literal(0) }),
    privateReads: array(roleRead, 0, 104), gap })(v)
  if (out.producers.some((p, i) => p.id !== (i === 0 ? "main" : `RET${String(i).padStart(2, "0")}`) ||
    (p.eligible && (p.origin !== "real-supervisor" || !joined(p, BigInt(p.deadlineNs)))))) fail()
  return out
}
const RUNTIMES = Object.freeze([
  ["20", "20.0.0", "e7618fb5a5fc25d76b6474e2a6607f04fd6f10e0", "964d157e4ea07b6df6ce0eb81cc5e866e91dbda78583571ae60de08f132301e5"],
  ["22", "22.23.3", "80dc632040e6bada37aac1220dde9c79581c9c22", "9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e"],
  ["24", "24.18.0", "20da4aeadabc5b0a01e3fcf520f91df8285c68a2", "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de"],
])
function runtimeIdentity(value) {
  role(value)
  const [runtimeRole, version, sourceRevision, expectedExeSha256] = RUNTIMES.find((row) => row[0] === value)
  return Object.freeze({ role: runtimeRole, version, sourceRevision, expectedExeSha256 })
}
function gitPathApi(file) { return /^[A-Za-z]:[\\/]/.test(file) ? path.win32 : path.posix }
function gitCanonical(file, p, directory = false) {
  if (typeof file !== "string" || !p.isAbsolute(file) || p.normalize(file) !== file ||
    /[\0\r\n;"'!$`*?=]/.test(file) || file.startsWith("\\\\") ||
    (p === path.win32 && (!/^[A-Za-z]:\\/.test(file) || file.slice(2).includes(":"))) ||
    (directory && Buffer.byteLength(file, "utf8") > 241)) fail("guard_failed")
  return file
}
function gitExecutionLayout({ fixtureRoot, nodeExecutable, gitExecutable, shellExecutable, systemRoot }) {
  const p = gitPathApi(gitExecutable)
  for (const f of [fixtureRoot, nodeExecutable, gitExecutable, shellExecutable, systemRoot]) gitCanonical(f, p)
  const installationRoot = p.dirname(p.dirname(p.dirname(gitExecutable))), usr = p.join(installationRoot, "usr", "bin")
  const equal = (a, b) => a.toLowerCase() === b.toLowerCase()
  if (!equal(gitExecutable, p.join(installationRoot, "mingw64", "bin", "git.exe")) ||
    !equal(shellExecutable, p.join(usr, "sh.exe")) || p.basename(nodeExecutable).toLowerCase() !== "node.exe" ||
    p.basename(fixtureRoot) !== "fixtures") fail("runtime_mismatch")
  const execPath = p.join(fixtureRoot, "na1-exec-empty")
  const basePath = [p.dirname(nodeExecutable), usr, p.dirname(gitExecutable), p.join(systemRoot, "System32")]
  const effectivePath = [execPath, ...basePath]
  for (const dir of effectivePath) gitCanonical(dir, p, true)
  if (new Set(effectivePath.map((d) => d.toLowerCase())).size !== 5) fail("guard_failed")
  for (const dir of [execPath, basePath[0], basePath[3]]) {
    const r = p.relative(installationRoot.toLowerCase(), dir.toLowerCase())
    if (!r || (!p.isAbsolute(r) && r !== ".." && !r.startsWith(".." + p.sep))) fail("guard_failed")
  }
  return Object.freeze({ installationRoot, gitExecutable, shellExecutable, nodeExecutable,
    envExecutable: p.join(usr, "env.exe"), msysRuntime: p.join(usr, "msys-2.0.dll"),
    execPath, basePath: Object.freeze(basePath), effectivePath: Object.freeze(effectivePath) })
}
function gitArguments(layout, tail, sourceRoot = null) {
  const p = gitPathApi(layout.execPath)
  gitCanonical(layout.execPath, p, true)
  if (!Array.isArray(tail) || tail.length > 32 || tail.some((a) => typeof a !== "string" ||
    /[\0\r\n]/.test(a) || a.startsWith("--exec-path") || Buffer.byteLength(a) > 8192)) fail("guard_failed")
  const args = [`--exec-path=${layout.execPath}`]
  if (sourceRoot !== null) args.push("-c", `safe.directory=${gitCanonical(sourceRoot, p)}`)
  return [...args, ...tail]
}
function gitMountConfig(bytes) {
  if (bytes === null) return Object.freeze({ drivePrefix: "/cygdrive", sha256: null })
  if (!Buffer.isBuffer(bytes) || bytes.length > 4096 || bytes.some((b) => b > 127 || b === 0)) fail("guard_failed")
  const text = bytes.toString("ascii").replaceAll("\r\n", "\n")
  if (text.includes("\r")) fail("guard_failed")
  let record = false
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    if (record || line !== "none / cygdrive binary,posix=0,noacl,user 0 0") fail("guard_failed")
    record = true
  }
  return Object.freeze({ drivePrefix: record ? "/" : "/cygdrive", sha256: sha(bytes) })
}
function gitMsysPath(file, layout, drivePrefix) {
  const p = gitPathApi(file)
  gitCanonical(file, p)
  if (!["/", "/cygdrive"].includes(drivePrefix)) fail("guard_failed")
  if (p === path.posix) return file
  const relative = p.relative(layout.installationRoot.toLowerCase(), file.toLowerCase())
  if (!p.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\")) {
    const tail = file.slice(layout.installationRoot.length).replaceAll("\\", "/")
    if (tail.toLowerCase() === "/usr/bin" || tail.toLowerCase().startsWith("/usr/bin/")) return "/bin" + tail.slice(8)
    return tail || "/"
  }
  return (drivePrefix === "/" ? "" : drivePrefix) + "/" + file[0].toLowerCase() + file.slice(2).replaceAll("\\", "/")
}
function gitLookupCandidates(layout) {
  const p = gitPathApi(layout.execPath), wanted = new Set([
    layout.gitExecutable, layout.shellExecutable, layout.envExecutable, layout.nodeExecutable].map((f) => f.toLowerCase()))
  return layout.effectivePath.flatMap((dir) => [
    ...["git-owned", "sh", "env", "node", "git"].flatMap((base) =>
      ["", ".exe", ".lnk", ".exe.lnk"].map((suffix) => p.join(dir, base + suffix))),
    p.join(dir, "busybox.exe")].map((file) => Object.freeze({ file, required: wanted.has(file.toLowerCase()) })))
}
function inspectGitExecution(layout, { mountConfigSha256, live, io = fs, physical = absolutePhysical,
  read = (file) => guardedFile(path.dirname(file), path.basename(file), 4096) }) {
  if (typeof live !== "function") fail("guard_failed")
  const p = gitPathApi(layout.execPath), rows = []
  const identity = (st) => {
    if (["dev", "ino", "size", "mtimeNs"].some((k) => typeof st[k] !== "bigint")) fail("guard_failed")
    return [st.dev, st.ino, st.size, st.mtimeNs].map(String).join(":")
  }
  const stat = (file, optional = false) => {
    live()
    try { return io.lstatSync(file, { bigint: true }) }
    catch (error) { if (optional && error.code === "ENOENT") return null; throw error }
  }
  const empty = (file) => {
    live()
    const dir = io.opendirSync(file, { bufferSize: 1 })
    try { if (dir.readSync() !== null) fail("guard_failed") } finally { dir.closeSync() }
  }
  const directories = []
  for (const file of layout.effectivePath) {
    live(); physical(file)
    const st = stat(file)
    if (!st.isDirectory() || st.isSymbolicLink()) fail("guard_failed")
    const id = identity(st)
    if (directories.includes(`${st.dev}:${st.ino}`)) fail("guard_failed")
    directories.push(`${st.dev}:${st.ino}`); rows.push([file, id])
  }
  empty(layout.execPath)
  for (const { file, required } of gitLookupCandidates(layout)) {
    const st = stat(file, true)
    if (!required) { if (st !== null) fail("guard_failed"); continue }
    if (!st || !st.isFile() || st.isSymbolicLink()) fail("guard_failed")
    rows.push([file, identity(st)])
  }
  const config = p.join(layout.installationRoot, "etc", "fstab"), st = stat(config, true)
  let mount
  if (st === null) mount = gitMountConfig(null)
  else {
    physical(config)
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096n) fail("guard_failed")
    const before = identity(st)
    mount = gitMountConfig(read(config))
    if (identity(stat(config)) !== before) fail("identity_changed")
    rows.push([config, before])
  }
  if (mount.sha256 !== mountConfigSha256) fail("source_mismatch")
  const userMounts = p.join(layout.installationRoot, "etc", "fstab.d"), user = stat(userMounts, true)
  if (user !== null) {
    physical(userMounts)
    if (!user.isDirectory() || user.isSymbolicLink()) fail("guard_failed")
    empty(userMounts); rows.push([userMounts, identity(user)])
  }
  for (const [file, id] of rows) if (identity(stat(file)) !== id) fail("identity_changed")
  live()
  return JSON.stringify({ rows, mount, msysPath: layout.effectivePath.map((f) => gitMsysPath(f, layout, mount.drivePrefix)) })
}
function externalGitComponents(git, ownedRoot) {
  const files = [[git.executable, git.sha256], [git.shellExecutable, git.shellSha256],
    [path.join(path.dirname(git.shellExecutable), "env.exe"), git.envSha256],
    [path.join(path.dirname(git.shellExecutable), "msys-2.0.dll"), git.msysRuntimeSha256]]
  for (const [file, digest] of files) {
    if (typeof file !== "string" || !path.isAbsolute(file)) fail("guard_failed")
    H(digest)
    const relative = path.relative(ownedRoot.toLowerCase(), file.toLowerCase())
    if (!relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))) fail("guard_failed")
  }
  return Object.freeze(files.map((row) => Object.freeze(row)))
}
function projectGitBinding(value, { sourceRevision, sourceTree, fixtureRoot }) {
  const absolute = (v) => { if (typeof v !== "string" || !path.isAbsolute(v)) fail("guard_failed"); return v }
  const git = object({ schema: literal("desk.owned-git-fixture-git/2"), sourceRevision: literal(sourceRevision),
    sourceTree: literal(sourceTree), executable: absolute, sha256:H,
    version: text(/^git version [0-9]+(?:\.[0-9]+){1,3}(?:\.windows\.[0-9]+)?$/,64),
    shellExecutable:absolute,shellSha256:H,envSha256:H,msysRuntimeSha256:H,
    imagePolicy:literal("direct-mingw64-empty-exec-v1"),execPath:literal(path.join(fixtureRoot,"na1-exec-empty")),
    mountConfigSha256:nullable(H) })(value)
  if (path.basename(git.shellExecutable).toLowerCase()!=="sh.exe") fail("runtime_mismatch")
  const p=gitPathApi(git.executable)
  gitCanonical(git.executable,p); gitCanonical(git.shellExecutable,p)
  const home=p.dirname(p.dirname(p.dirname(git.executable)))
  if (git.executable.toLowerCase()!==p.join(home,"mingw64","bin","git.exe").toLowerCase() ||
    git.shellExecutable.toLowerCase()!==p.join(home,"usr","bin","sh.exe").toLowerCase()) fail("runtime_mismatch")
  return git
}
function projectRuntime(v) {
  const out = object({ runtimes: array(object({ role, version: text(/^[0-9]+\.[0-9]+\.[0-9]+$/, 32),
    sourceRevision: G40, expectedExeSha256: H, measuredExeSha256: H, exeHashOrigin: literal("ci_host_rehashed"),
    sourceSnapshotObservedInCI: literal(false) }), 3),
  selectedGit: object({ sha256: H, shellSha256: H, envSha256: H, msysRuntimeSha256: H,
    mountConfigSha256:nullable(H),fixturePolicy: literal("closed-native-git-empty-exec-v1"),
    version: text(/^git version [0-9]+(?:\.[0-9]+){1,3}(?:\.windows\.[0-9]+)?$/, 64),
    origin: literal("ci_host_rehashed") }),
  sourceReferences: object({ runtimeIdentities: literal("4b70be0b6344a1c001109f7fa9f1265d12b68b90cd78ca12a348ee030a382dce"),
    sourceFingerprints: literal("b1f38dbe37825acec443d6ea2aa180eda54715a839e6431baf44121c272b450c"),
    hostFsSourceIdentities: literal("ea2155078fd25dd43925bd4875c8e06feb9a9277a6c800a814e6c2faac32fd04"),
    origin: literal("retained_reference") }) })(v)
  if (out.runtimes.some((r, i) => r.role !== RUNTIMES[i][0] || r.version !== RUNTIMES[i][1] ||
    r.sourceRevision !== RUNTIMES[i][2] || r.expectedExeSha256 !== RUNTIMES[i][3] || r.measuredExeSha256 !== r.expectedExeSha256)) fail("runtime_mismatch")
  return out
}
const compilerShape = object({ name: literal("clang-cl"),
  version: text(/^clang version [0-9]+\.[0-9]+\.[0-9]+(?: \(https:\/\/github\.com\/llvm\/llvm-project(?:\.git)? [0-9a-f]{40}\))?$/, 180),
  sdkVersion: text(/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/, 32), imageSha256: H, llvmProfdataSha256: H, llvmCovSha256: H,
  pwshVersion: text(/^[0-9]+\.[0-9]+\.[0-9]+$/, 32), pwshImageSha256: H, interop: literal("in-process-fixed-source"),
  flagsProfiles: (v) => {
    const wanted = ["production", "production-coverage", "fault", "fault-coverage", "supervisor", "profile-support"]
    if (JSON.stringify(v) !== JSON.stringify(wanted)) fail()
    return wanted
  }, coverageMode: literal("synthetic-indexed-zero-v1"), runtimeProfilePolicy: literal("support-symbol-no-file-init-v1"),
  pathMappingApplied: B, privatePathScanPassed: B })
const binaryShape = object({ key: enumeration(...binaryKeys), sha256: H, bytes: integer(1, 4194304),
  sourceKey: enumeration("S01", "S12", "S13"), variant: enumeration("production", "production-coverage", "fault", "fault-coverage", "supervisor"),
  hashOrigin: literal("ci_host_rehashed"), profileSupportSha256: nullable(H) })
const profileSupportShape = object({ sourceKey: literal("S12"), basename: literal("na1-profile-support.obj"),
  sha256: H, bytes: integer(1, 4096), compileProfile: literal("profile-support"),
  definition: literal("DESK_NA1_PROFILE_SUPPORT=1"), instrumented: literal(false) })
const syntheticBaselineShape = object({ kind: literal("fe-synthetic-zero-v1"), textSha256: literal(BASELINE_TEXT_SHA),
  textBytes: literal(32), indexedSha256: H, indexedBytes: integer(1, 1024), producerSha256: H, roundTripObserved: B })
function checkSyntheticBindings(out) {
  if (!out.syntheticBaseline.roundTripObserved || out.syntheticBaseline.producerSha256 !== out.compiler.llvmProfdataSha256 ||
    out.binaries.some((b, i) => b.profileSupportSha256 !== ([1, 3].includes(i) ? out.profileSupport.sha256 : null)) ||
    (out.coverage && out.coverage.baselineSha256 !== out.syntheticBaseline.indexedSha256)) fail("source_mismatch")
}
const sourceShape = object({ key: sourceKey, repositoryPath: enumeration(...SOURCE_PATHS), sha256: H,
  bytes: integer(1, 2097152), hashOrigin: literal("ci_host_rehashed") })
const variantShape = object({ basename: enumeration(...variants), sourceKey: literal("S11"), sha256: H, production: literal(false) })
const infrastructureShape = object({ role: enumeration("build", "coverage-tools"), producerExitObserved: B,
  producerFullcloseObserved: B, workerRetired: B, realJobSealed: B, realActiveProcesses: nullable(literal(0)),
  controlReaped: B, criticalHandlesClosed: B, deadlineNs: D, finishedNs: nullable(D), gap })
function projectBuild(v) {
  const out = object({ compiler: compilerShape, binaries: array(binaryShape, 5), sources: array(sourceShape, 17),
    fixtureVariants: array(variantShape, 11), infrastructure: array(infrastructureShape, 2),
    profileSupport: profileSupportShape, syntheticBaseline: syntheticBaselineShape,
    coverage: nullable(projectCoverage), gap })(v)
  checkSyntheticBindings(out)
  const profiles = ["production", "production-coverage", "fault", "fault-coverage", "supervisor"]
  const binarySources = ["S01", "S01", "S12", "S12", "S13"]
  if (out.binaries.some((b, i) => b.key !== binaryKeys[i] || b.variant !== profiles[i] || b.sourceKey !== binarySources[i]) ||
    out.sources.some((s, i) => s.key !== `S${String(i + 1).padStart(2, "0")}` || s.repositoryPath !== SOURCE_PATHS[i] ||
      (i < 4 && s.sha256 !== FROZEN[i])) ||
    out.fixtureVariants.some((r, i) => r.basename !== variants[i] || r.sha256 !== out.sources[10].sha256) ||
    out.infrastructure.some((r, i) => r.role !== (i ? "coverage-tools" : "build"))) fail("source_mismatch")
  return out
}
function projectRetention(v) {
  const out = object({ controls: array(object({ id: retId, producer: producerOrigin, matched: B, bootstrap: presence,
    bootstrapRead: B, otherPrivateReads: integer(0, 1), signalFailed: B, primaryFailurePreserved: B, realZero: nullable(B),
    privateTargetWithheld: B, gap }), 7) })(v)
  if (out.controls.some((r, i) => r.id !== `RET${String(i + 1).padStart(2, "0")}` ||
    r.producer !== (i === 5 ? "fault-model" : "real-supervisor") || (i !== 0 && r.otherPrivateReads !== 0))) fail()
  return out
}
function fixtureLayout(publicMcpRoot) {
  if (typeof publicMcpRoot !== "string" || !path.isAbsolute(publicMcpRoot) ||
    path.basename(publicMcpRoot) !== "mcp" || path.basename(path.dirname(publicMcpRoot)) !== "public") fail("guard_failed")
  const root = path.dirname(path.dirname(publicMcpRoot)), pub = path.dirname(publicMcpRoot)
  return Object.freeze({ root, publicMcpRoot, fixtureRoot: path.join(pub, "fixtures"),
    testRoot: path.join(pub, "test-roots"), exportRoot: path.join(root, "export"), safeRoot: path.join(root, "safe-evidence") })
}
function checkSources(v) {
  const out = array(sourceShape, 17)(v)
  if (out.some((s, i) => s.key !== `S${String(i + 1).padStart(2, "0")}` ||
    s.repositoryPath !== SOURCE_PATHS[i] || (i < 4 && s.sha256 !== FROZEN[i]))) fail("source_mismatch")
  return out
}
function projectFixtureManifest(v, expectedSource = {}) {
  const out = object({ schema: literal("desk.owned-git-fixtures/1"), sourceRevision: G40, sourceTree: G40,
    allocationSha256: literal(ALLOCATION_SHA), compiler: compilerShape, binaries: array(binaryShape, 5),
    profileSupport: profileSupportShape, syntheticBaseline: syntheticBaselineShape,
    roots: array(variantShape, 11), productionManifestSha256: H, sourceManifestSha256: H })(v)
  checkSyntheticBindings(out)
  if ((expectedSource.sourceRevision && out.sourceRevision !== expectedSource.sourceRevision) ||
    (expectedSource.sourceTree && out.sourceTree !== expectedSource.sourceTree) ||
    !out.compiler.pathMappingApplied || !out.compiler.privatePathScanPassed ||
    out.binaries.some((b, i) => b.key !== binaryKeys[i] || b.sourceKey !== ["S01", "S01", "S12", "S12", "S13"][i] ||
      b.variant !== ["production", "production-coverage", "fault", "fault-coverage", "supervisor"][i]) ||
    out.roots.some((r, i) => r.basename !== variants[i])) fail("source_mismatch")
  return out
}
function projectPublicManifests({ production, fixture, source }, expectedSource = {}, exact = {}) {
  keys(source, ["schema", "sourceRevision", "sourceTree", "productContentBase", "allocationSha256", "sources"])
  const src = object({ schema: literal("desk.owned-git-sources/1"), sourceRevision: G40, sourceTree: G40,
    productContentBase: literal(PRODUCT_BASE), allocationSha256: literal(ALLOCATION_SHA), sources: checkSources })(source)
  const fx = projectFixtureManifest(fixture, { ...expectedSource, sourceTree: expectedSource.sourceTree || src.sourceTree })
  if (src.sourceRevision !== fx.sourceRevision || src.sourceTree !== fx.sourceTree) fail("source_mismatch")
  // The real verifier is additionally called by every launch. This closed
  // schema binds its unchanged builder manifest to the fixture/source bundle.
  const prod = object({ schema: literal("desk.owned-git-assets/1"), protocol: literal("desk.owned-git/1"),
    target: literal("win32-x64"), variant: literal("production"), sourceRevision: literal(src.sourceRevision),
    sources: array(object({ path: enumeration(...SOURCE_PATHS.slice(0, 4).map((p) => p.slice("plugins/desk/mcp/".length))), sha256: H }), 4),
    toolchain: object({ compiler: literal("clang-cl"), version: literal(fx.compiler.version),
      sdkVersion: literal(fx.compiler.sdkVersion), flags: (v) => {
        const flags = ["/W4", "/WX", "/MT", "/O2", "/fp:precise", "kernel32.lib", "advapi32.lib"]
        if (JSON.stringify(v) !== JSON.stringify(flags)) fail()
        return flags
      } }),
    files: object({ owner: object({ path: literal("desk-owned-git.exe"), sha256: H }),
      shim: object({ path: literal("owned-git-child.cjs"), sha256: H }) }) })(production)
  if (prod.sources.some((r, i) => r.path !== SOURCE_PATHS[i].slice("plugins/desk/mcp/".length) || r.sha256 !== FROZEN[i]) ||
    prod.files.owner.sha256 !== fx.binaries[0].sha256 || prod.files.shim.sha256 !== FROZEN[1] ||
    fx.roots.some((r) => r.sha256 !== src.sources[10].sha256)) fail("source_mismatch")
  if (exact.productionBytes && sha(exact.productionBytes) !== fx.productionManifestSha256) fail("artifact_digest")
  if (exact.sourceBytes && sha(exact.sourceBytes) !== fx.sourceManifestSha256) fail("artifact_digest")
  // Object-only callers still check canonical payload relations; file callers
  // supply exact original bytes, including their original trailing LF.
  if (!exact.sourceBytes && sha(Buffer.from(JSON.stringify(source) + "\n")) !== fx.sourceManifestSha256) fail("artifact_digest")
  return { production: prod, fixture: fx, source: src }
}
function diskIdentity(file) {
  const st = fs.lstatSync(file, { bigint: true })
  return { dev: st.dev, ino: st.ino, size: Number(st.size), mtimeNs: st.mtimeNs,
    type: st.isFile() ? "file" : st.isDirectory() ? "directory" : "other", reparse: st.isSymbolicLink() }
}
const heldFileDescriptors = new Set()
function closeOwnedFile(fd) {
  try { fs.closeSync(fd) }
  catch { heldFileDescriptors.add(fd); fail("guard_failed") }
}
function walkDeclared(root, relative, budget, bootstrap = false) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) fail("guard_failed")
  const parts = relative.split(path.sep)
  if (!parts.length || parts.length > 64 || parts.some((v) => !v || v === "." || v === ".." || /[~:\0]/.test(v))) fail("guard_failed")
  let current = root
  const base = diskIdentity(root)
  if (base.type !== "directory" || base.reparse) fail("guard_failed")
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    // Bootstrap is a constructor-declared literal. No private directory is
    // enumerated before this sole attempt; other reads require admission.
    if (!(bootstrap && parts.slice(0, i).includes("private"))) {
      let found = null, scanned = 0
      const dir = fs.opendirSync(current)
      try {
        let entry
        while ((entry = dir.readSync()) !== null) {
          if (++scanned > 8192) fail("quota")
          if (budget) {
            budget.entriesSeen.add(path.join(current, entry.name))
            if (budget.entriesSeen.size > 8192) fail("quota")
          }
          if (entry.name.toLowerCase() === part.toLowerCase()) {
            if (found !== null || entry.name !== part) fail("guard_failed")
            found = entry.name
          }
        }
      } finally { dir.closeSync() }
      if (found === null) throw Object.assign(new Error("role_missing"), { code: "ENOENT" })
    }
    current = path.join(current, part)
    const st = diskIdentity(current)
    if (st.reparse || (i < parts.length - 1 && st.type !== "directory")) fail("guard_failed")
    if (budget) budget.depthPeak = Math.max(budget.depthPeak, i + 1)
  }
  return current
}
function guardedFile(root, relative, limit, { budget, bootstrap = false, expected, onIdentity } = {}) {
  if (heldFileDescriptors.size) fail("guard_failed")
  const file = walkDeclared(root, relative, budget, bootstrap)
  let original
  const bytes = guardedRoleRead({
    expected, before: () => {
      const before = diskIdentity(file)
      if (budget && (budget.filesRead + 1 > 1024 || budget.bytesRead + before.size + 1 > 67108864)) fail("quota")
      original = before; return before
    },
    read(before) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
      if (budget) budget.filesRead++
      try {
        const st = fs.fstatSync(fd, { bigint: true })
        if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || Number(st.size) !== before.size) fail("identity_changed")
        const bytes = Buffer.alloc(before.size), extra = Buffer.alloc(1)
        let at = 0
        while (at < bytes.length) {
          const n = fs.readSync(fd, bytes, at, bytes.length - at, at)
          if (!n) fail("identity_changed")
          at += n; if (budget) budget.bytesRead += n
        }
        const surplus = fs.readSync(fd, extra, 0, 1, at)
        if (budget) budget.bytesRead += surplus
        if (surplus) fail("identity_changed")
        return bytes
      } finally { closeOwnedFile(fd) }
    }, after: () => diskIdentity(file),
  }, limit)
  onIdentity?.(original)
  return bytes
}
function verifyPublicBundle({ publicMcpRoot, expectedSource = {} }) {
  const layout = fixtureLayout(publicMcpRoot)
  const read = (relative, limit) => guardedFile(layout.root, relative, limit)
  const productionBytes = read(path.join("public", "mcp", "artifacts", "owned-git", "win32-x64", "manifest.json"), 65536)
  const fixtureBytes = read(path.join("public", "fixtures", "fixture-assets.json"), 65536)
  const sourceBytes = read(path.join("public", "fixtures", "source-assets.json"), 65536)
  const bundle = projectPublicManifests({ production: core.parseJSON(productionBytes, 65536),
    fixture: core.parseJSON(fixtureBytes, 65536), source: core.parseJSON(sourceBytes, 65536) },
  expectedSource, { productionBytes, sourceBytes })
  const expected = [...bundle.source.sources.map((s) => ({ bytes: s.bytes, sha256: s.sha256 })),
    ...bundle.fixture.binaries.map((b) => ({ bytes: b.bytes, sha256: b.sha256 })),
    { sha256: FROZEN[1] }, { sha256: sha(productionBytes) }, { sha256: sha(fixtureBytes) }, { sha256: sha(sourceBytes) }]
  let total = 0
  const rows = PUBLIC_LEAVES.slice(0, 26).map((relative, i) => {
    const bytes = read(relative, i < 17 || i === 22 ? 2097152 : i < 22 ? 4194304 : 65536)
    if (sha(bytes) !== expected[i].sha256 || (expected[i].bytes !== undefined && bytes.length !== expected[i].bytes) ||
      !bytes.length || (total += bytes.length) > 33554432) fail("artifact_digest")
    return validateLeaf({ id: i + 1, path: relative, presence: "present", bytes: bytes.length,
      sha256: sha(bytes), origin: "ci_host_rehashed", mandatory: true, gap: "none" }, i + 1)
  })
  const check = (relative, digest, max = 2097152) => { if (sha(read(relative, max)) !== digest) fail("artifact_digest") }
  for (let i = 0; i < 4; i++) check(path.join("public", "mcp", bundle.production.sources[i].path), FROZEN[i])
  for (const binary of bundle.fixture.binaries) check(path.join("public", "fixtures", binary.key), binary.sha256, 4194304)
  check(path.join("public", "mcp", "artifacts", "owned-git", "win32-x64", "desk-owned-git.exe"), bundle.fixture.binaries[0].sha256, 4194304)
  check(path.join("public", "mcp", "artifacts", "owned-git", "win32-x64", "owned-git-child.cjs"), FROZEN[1])
  for (const variant of bundle.fixture.roots) check(path.join("public", "test-roots", variant.basename), variant.sha256)
  check(path.join("public", "fixtures", "windows_owned_git_workload.cjs"), bundle.source.sources[14].sha256)
  check(path.join("public", "fixtures", "windows_owned_git_preload.cjs"), bundle.source.sources[15].sha256)
  check(path.join("public", "fixtures", "hooks", "pre-commit"), bundle.source.sources[14].sha256)
  const scratch = path.join("public", "fixtures", "na1-known-scratch")
  const support = read(path.join(scratch, "na1-profile-support.obj"), 4096)
  if (support.length !== bundle.fixture.profileSupport.bytes || sha(support) !== bundle.fixture.profileSupport.sha256) fail("artifact_digest")
  validateSyntheticInput(read(path.join(scratch, "zero.txt"), 32))
  const indexed = read(path.join(scratch, "zero.profdata"), 1024)
  if (indexed.length !== bundle.fixture.syntheticBaseline.indexedBytes ||
    sha(indexed) !== bundle.fixture.syntheticBaseline.indexedSha256) fail("artifact_digest")
  return { ...bundle, rows, layout, fixtureManifestSha256: sha(fixtureBytes), sourceManifestSha256: sha(sourceBytes) }
}
function finalizeManifestPayload({ rows33, report, privateRoles, gaps }) {
  const rows = core.parseJSON(canonicalLeafMetadata(rows33), 65536)
  const codes = [...new Set(array(gap, 0, 32)(gaps))]
  const projected = report === null ? null : projectReport(report)
  const complete = projected?.status === "complete-observation" && projected.gap === "none" &&
    projected.privateExportComplete && rows.every((r) => r.presence === "present") && codes.length === 0
  if (!complete && codes.length === 0) codes.push(projected?.gap && projected.gap !== "none" ? projected.gap : "artifact_missing")
  return projectManifest({ leaves: [...rows, { ...MANIFEST_SELF_ROW }], privateRoles,
    exclusions: [...EXCLUSIONS], privateOriginalRehashedByOuter: false, publicOriginalRehashedByOuter: false,
    gaps: codes, leafSetSha256: complete ? computeLeafSetSha256(rows) : null })
}
function createSupervisorEventReader({ nonce, producer, onEvent = () => {} }) {
  H(nonce); producerId(producer)
  const storage = Buffer.alloc(4100)
  let used = 0, target = 4, sent = false, stopped = false, pid = null, identity = null
  function reject() { stopped = true; fail("schema") }
  return {
    configSent() { if (sent || stopped) reject(); sent = true },
    push(bytes) {
      if (!sent || stopped || !Buffer.isBuffer(bytes) || bytes.length > 1048576) reject()
      let offset = 0
      while (offset < bytes.length) {
        const n = Math.min(target - used, bytes.length - offset)
        bytes.copy(storage, used, offset, offset + n); used += n; offset += n
        if (used !== target) continue
        if (target === 4) {
          const length = storage.readUInt32LE()
          if (!length || length > 4096) reject()
          target = length + 4
        } else {
          let value
          try {
            value = core.parseJSON(storage.subarray(4, target), 4096)
            const common = { schema: literal("desk.owned-git-supervisor-event/1"), type: (v) => v, nonce: literal(nonce) }
            if (value.type === "CONTROLLER_CREATED" && pid === null) {
              value = object({ ...common, controllerPid: integer(1, 4294967295), assigned: literal(true) })(value)
              pid = value.controllerPid
            } else if (value.type === "TARGET_IDENTITY" && producer === "RET07" && pid !== null && identity === null) {
              value = object({ ...common, volume: U32, indexHigh: U32, indexLow: U32,
                bytes: literal(17), replacementDistinct: literal(true) })(value)
              identity = { dev: BigInt(value.volume), ino: (BigInt(value.indexHigh) << 32n) | BigInt(value.indexLow),
                size: value.bytes, type: "file", reparse: false }
            } else reject()
          } catch { reject() }
          onEvent(Object.freeze(value)); used = 0; target = 4
        }
      }
    },
    end() { if (stopped || used || pid === null) reject(); stopped = true },
    snapshot() { return { controllerPid: pid, targetIdentity: identity && { ...identity } } },
  }
}
function createProducerTracker({ id, origin: producerType, imageSha256, observedPid, deadlineNs }) {
  producerId(id); producerOrigin(producerType); H(imageSha256); U32(observedPid); D(deadlineNs)
  const v = { id, origin: producerType, imageSha256, observedPid, exitObserved: false, closeObserved: false,
    stdoutEOF: false, stdoutClosed: false, stderrEOF: false, stderrClosed: false,
    code: null, signal: null, deadlineNs, closedAtNs: null, telemetryBytes: 0, eligible: false,
    primaryFailurePreserved: false }
  let failed = false
  const dataName = (name) => { if (!["stdout", "stderr"].includes(name) || v.closeObserved) fail(); return name }
  return {
    spawned(pid) {
      integer(1, 4294967295)(pid)
      if (v.closeObserved || (v.observedPid !== 0 && v.observedPid !== pid)) fail()
      v.observedPid = pid
    },
    data(name, bytes) {
      dataName(name)
      if (!Buffer.isBuffer(bytes) || v[`${name}EOF`] || v[`${name}Closed`]) fail()
      v.telemetryBytes += bytes.length
      if (v.telemetryBytes > 1048576) { failed = true; fail("quota") }
    },
    end(name) { dataName(name); v[`${name}EOF`] = true },
    close(name) { dataName(name); v[`${name}Closed`] = true },
    error() { failed = true },
    exit(code, sig) {
      if (v.exitObserved || v.closeObserved) fail()
      v.code = nullable(integer(-2147483648, 4294967295))(code); v.signal = signal(sig)
      v.exitObserved = true; v.primaryFailurePreserved = true
    },
    processClose(ns) {
      if (v.closeObserved) fail()
      v.closeObserved = true; v.closedAtNs = D(ns)
      v.eligible = !failed && producerType === "real-supervisor" && joined(v, BigInt(deadlineNs))
    },
    snapshot() { return Object.freeze({ ...v }) },
  }
}
let roleRegistry
function getPrivateRoleRegistry() {
  if (roleRegistry) return roleRegistry
  const definitions = []
  const add = (key, producer, role, relative, limit, extra = {}) => definitions.push(Object.freeze({
    key, producer, role, relative, limit, case: null, slot: null, ...extra,
  }))
  add("bootstrap", "main", "bootstrap", path.join("private", "bootstrap.json"), 4096)
  add("controller-report", "main", "controller-report", path.join("private", "controller-report.json"), 1048576)
  for (const plan of registry()) for (let slot = 0; slot < plan.expected.generations; slot++) {
    add(`receipt:${plan.id}:${slot}`, "main", "native-receipt",
      path.join("private", "generations", plan.id, String(slot), "retirement.json"), 4096,
      { case: plan.id, slot, policy: plan.receiptPolicy })
  }
  for (const plan of registry().filter((p) => p.profile === "G_BASELINE" || /^(A14|A24)-/.test(p.id))) {
    add(`marker:${plan.id}`, "main", "preload-marker", path.join("private", "markers", `${plan.id}.json`), 4096,
      { case: plan.id, runtime: plan.root })
  }
  add("unexpected-bootstrap-marker", "main", "unexpected-bootstrap-marker",
    path.join("private", "markers", "unexpected-bootstrap.json"), 4096)
  for (const id of ["RET01", "RET02", "RET03", "RET04", "RET05", "RET06", "RET07"]) {
    add(`${id}:bootstrap`, id, "bootstrap", path.join("private", "bootstrap.json"), 4096)
    if (id === "RET01" || id === "RET07") add(`${id}:sentinel`, id, "retention-sentinel",
      path.join("private", "retention-sentinel.json"), 256)
  }
  roleRegistry = Object.freeze(definitions)
  return roleRegistry
}
const errorGap = (error, fallback = "schema") => GAPS.includes(error?.code) ? error.code : fallback
function roleRow(def, presenceValue, code, bytes = null) {
  return roleRead({ role: def.role, case: def.case, slot: def.slot, producer: def.producer, presence: presenceValue,
    bytes: bytes === null ? null : bytes.length, sha256: bytes === null ? null : sha(bytes),
    origin: bytes === null ? "unobserved" : "ci_host_rehashed", gap: code })
}
function ownerFullJoined(g) {
  return !!g && g.joins.ownerExitObserved && g.joins.ownerCloseObserved &&
    g.joins.stdoutEOF && g.joins.stdoutClosed && g.joins.stderrEOF && g.joins.stderrClosed &&
    g.joins.controlEOF && g.joins.controlClosed
}
function receiptJoinEligible(g) {
  return ownerFullJoined(g) &&
    g.data.ownerCloseAtNs !== null && BigInt(g.data.ownerCloseAtNs) < BigInt(g.deadlineNs) &&
    BigInt(g.finishedNs) < BigInt(g.deadlineNs)
}
function classifyMainRoles(report, io) {
  const roles = [], receipts = [], markers = []
  const plans = new Map(report.cases.map((row) => [row.id, row]))
  const read = (def, validate) => {
    let bytes
    try {
      bytes = io.read(def)
      if (!Buffer.isBuffer(bytes) || bytes.length > def.limit) fail("quota")
      const value = validate(bytes)
      const row = roleRow(def, "present", "none", bytes); roles.push(row)
      return { row, value }
    } catch (error) {
      const row = roleRow(def, error?.code === "ENOENT" ? "missing" : bytes ? "present" : "withheld",
        error?.code === "ENOENT" ? "role_missing" : errorGap(error, "guard_failed"), bytes || null)
      roles.push(row); return { row, value: null }
    }
  }
  const absence = (def) => {
    try {
      const exists = io.lookup(def)
      const row = roleRow(def, exists ? "present" : "expected_absent", exists ? "case_mismatch" : "none")
      roles.push(row); return row
    } catch (error) {
      const row = roleRow(def, "not_attempted", errorGap(error, "guard_failed")); roles.push(row); return row
    }
  }
  for (const def of getPrivateRoleRegistry().filter((d) => d.producer === "main" && !["bootstrap", "controller-report"].includes(d.role))) {
    if (def.role === "native-receipt") {
      // Permanent withholding is a guard action, never an existence test.
      if (["withheld_model", "withheld_owner_close"].includes(def.policy)) {
        roles.push(roleRow(def, "withheld", "role_withheld")); continue
      }
      const g = plans.get(def.case)?.actual?.generations.find((g) => g.slot === def.slot)
      if (!g) { roles.push(roleRow(def, "not_attempted", "not_admitted")); continue }
      if (def.policy === "expected_absent") { absence(def); continue }
      if (!receiptJoinEligible(g)) { roles.push(roleRow(def, "not_attempted", "owner_join_missing")); continue }
      const result = read(def, (bytes) => core.validateCertificate(core.parseJSON(bytes, 4096),
        { generation: g.generation, preparationDigest: g.preparationDigest, payloadDigest: g.acceptedPayloadDigest }))
      receipts.push({ ...result, case: def.case, slot: def.slot })
    } else if (def.role === "preload-marker") {
      if (!plans.get(def.case)?.actual) { roles.push(roleRow(def, "not_attempted", "not_admitted")); continue }
      const result = read(def, (bytes) => {
        const value = object({ case: literal(def.case), kind: literal("downstream"), runtime: literal(def.runtime),
          optionsMatch: B, nodePathMatch: B, origin: literal("producer_reported") })(core.parseJSON(bytes, 4096))
        if (!value.optionsMatch || !value.nodePathMatch) fail("case_mismatch")
        return value
      })
      if (result.value) markers.push(result.value)
    } else absence(def)
  }
  return { roles, receipts, markers }
}
function foldReceiptFacts(cases, receipts, realBroaderZero) {
  B(realBroaderZero)
  return cases.map((input) => {
    const row = projectCase(input)
    if (!row.actual) return row
    const generations = row.actual.generations.map((g) => {
      const receipt = receipts.find((r) => r.case === row.id && r.slot === g.slot)
      const resources = { ...g.resources, broaderRetirement: realBroaderZero ? "real-sealed-zero" : "unproved" }
      if (!receipt?.value) return { ...g, resources }
      if (!receiptJoinEligible(g)) fail("owner_join_missing")
      const cert = core.validateCertificate(receipt.value, { generation: g.generation,
        preparationDigest: g.preparationDigest, payloadDigest: g.acceptedPayloadDigest })
      if ((g.certificate && JSON.stringify(g.certificate) !== JSON.stringify(cert)) ||
        (g.resultB64 !== null && g.resultB64 !== cert.resultB64)) fail("artifact_digest")
      if (row.receiptPolicy !== "required_file_only" && g.certificate === null) fail("artifact_digest")
      if (row.receiptPolicy === "required_file_only" && g.invocation === "success") fail("case_mismatch")
      return { ...g, resources: { ...resources, privateRootRetirement: resources.rootCreated ? "real-certificate" : "not-created" },
        certificate: cert, certificateOrigin: g.certificate ? "live-control" : "receipt-after-gate",
        invocation: row.receiptPolicy === "required_file_only" ? "failed-proved" : g.invocation,
        resultB64: cert.resultB64, result: cert.resultB64 === null ? null : core.decodeResult(cert.resultB64) }
    })
    const actualCounts = {
      generations: generations.length, parentSTART: generations.filter((g) => g.phase.parentSTARTSent).length,
      nativeSTART: generations.filter((g) => g.phase.nativeSTARTIssued === true).length,
      genuineRESULT: generations.filter((g) => g.result !== null).length,
      eligibleNativeCertificates: generations.filter((g) => g.certificate !== null && receiptJoinEligible(g)).length,
      rootCreations: generations.reduce((n, g) => n + g.resources.rootCreated, 0),
      ownerFullClose: generations.filter(ownerFullJoined).length,
      modelStrandedRoots: generations.reduce((n, g) => n + g.resources.modelStrandedRoot, 0),
    }
    const receiptCopies = row.receiptPolicy !== "required" && row.receiptPolicy !== "required_file_only" ||
      generations.every((g) => receipts.some((r) => r.case === row.id && r.slot === g.slot && r.value !== null))
    const matched = row.actual.matched && receiptCopies &&
      Object.entries(actualCounts).every(([key, value]) => value === row.expected[key])
    return projectCase({ ...row, actual: { ...row.actual, matched, generations,
      disposition: row.receiptPolicy === "required_file_only" && generations.length &&
        generations.every((g) => g.invocation === "failed-proved") ? "failed-proved" : row.actual.disposition } })
  })
}
const contexts = new WeakMap(), observations = new WeakMap(), launches = new WeakMap(), admissions = new WeakMap()
const modelPermits = new WeakMap(), privateFacts = new WeakMap()
function state(ctx, native = false) {
  const s = contexts.get(ctx)
  if (!s) fail("not_admitted")
  if (native && s.execution !== "native-windows") fail("model_origin")
  if (native) fail("not_admitted") // F0 never supplies a native context/build/launch/emitter permit.
  return s
}
function createModelContext({ H: deadline, deadlineNs = deadline.toString(), binding, read = () => fail("bootstrap_missing") }) {
  if (typeof deadline !== "bigint" || deadline < 0n) fail()
  const ctx = Object.freeze({})
  contexts.set(ctx, { execution: "portable-model", H: deadline, end: BigInt(D(deadlineNs)), binding, read, attempted: false,
    audit: { nativeHeaders: 0, nativeWrites: 0, privateReads: 0 } })
  return ctx
}
const modelAudit = (ctx) => ({ ...state(ctx).audit })
function joined(v, deadline) {
  return ["exitObserved", "closeObserved", "stdoutEOF", "stdoutClosed", "stderrEOF", "stderrClosed"].every((k) => v[k] === true) &&
    v.closedAtNs !== null && BigInt(D(v.closedAtNs)) < deadline
}
function mainProducerGap(observation) {
  if (!observation || !joined(observation,BigInt(observation.deadlineNs))) return "producer_unjoined"
  if (observation.signal!==null) return "signal_failure"
  return observation.code===0 ? "none" : "case_mismatch"
}
function bootstrapDecision(s, observation, read) {
  if (s.attempted) fail("not_admitted")
  s.attempted = true
  if (!joined(observation, s.end ?? s.H)) fail("producer_unjoined")
  const bytes = read()
  const parsed = core.parseJSON(bytes, 4096)
  s.bootstrapReportedZero = parsed.activeProcesses === 0 ? true : parsed.activeProcesses === 1 ? false : null
  const value = validateBootstrap(parsed, s.binding)
  return { value, primaryFailurePreserved: observation.code !== 0 || observation.signal !== null }
}
function modelBootstrapDecision(ctx, observation) {
  const s = state(ctx)
  if (s.execution !== "portable-model") fail()
  const answer = bootstrapDecision(s, observation, () => {
    s.audit.privateReads++
    return s.read("bootstrap")
  })
  const permit = Object.freeze({ execution: "portable-model", primaryFailurePreserved: answer.primaryFailurePreserved })
  modelPermits.set(permit, ctx)
  return permit
}
function modelCollectPrivateRoles(ctx, permit, report) {
  const s = state(ctx)
  if (s.execution !== "portable-model" || modelPermits.get(permit) !== ctx) fail("not_admitted")
  return classifyMainRoles({ cases: array(projectCase, 80)(report.cases), utilities: array(utilityShape, 0, 6)(report.utilities) }, {
    read: (def) => { s.audit.privateReads++; return s.read(def.key) },
    lookup: (def) => s.read(def.key, "lookup"),
  })
}
function immutable(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}
function absolutePhysical(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) fail("guard_failed")
  const root = path.parse(file).root
  walkDeclared(root, path.relative(root, file))
  return file
}
function hashPublicImage(file, end) {
  absolutePhysical(file)
  const before = diskIdentity(file)
  if (before.type !== "file" || before.size < 1 || before.size > 536870912) fail("quota")
  const fd = fs.openSync(file, "r"), hash = crypto.createHash("sha256"), chunk = Buffer.alloc(65536)
  try {
    const st = fs.fstatSync(fd, { bigint: true })
    if (st.dev !== before.dev || st.ino !== before.ino || Number(st.size) !== before.size) fail("identity_changed")
    let at = 0
    while (at < before.size) {
      if (process.hrtime.bigint() >= end) fail("deadline")
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, before.size - at), at)
      if (!n) fail("identity_changed")
      hash.update(chunk.subarray(0, n)); at += n
    }
    if (fs.readSync(fd, chunk, 0, 1, at) || !sameIdentity(before, diskIdentity(file))) fail("identity_changed")
    return hash.digest("hex")
  } finally { closeOwnedFile(fd) }
}
function cleanHostEnvironment() {
  const env = {}
  for (const k of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATH", "TEMP", "TMP", "PATHEXT",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k]
  }
  return env
}
function nativeAuthority(s) {
  if (heldFileDescriptors.size) fail("guard_failed")
  const origin = s.nativeOrigin
  if (!s.buildReady || !origin || !origin.started || origin.origin !== "real-supervisor" ||
    origin.role !== "main" || launches.get(origin.child) !== origin) fail("not_admitted")
  if (process.hrtime.bigint() >= s.H) fail("deadline")
}
function latch(s, error, fallback = "schema") {
  const code = errorGap(error, fallback)
  if (s.gaps.size < 32) s.gaps.add(code === "none" ? fallback : code)
  return code
}
function createRetentionContext({ workspace, expectedRun = {}, expectedSource, allocation, H: deadline }) {
  fail("not_admitted")
  if (process.platform !== "win32" || process.env.DESK_TEST_OWNED_GIT_NATIVE !== "1" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.DESK_TEST_SUITE_MODE !== "standard") fail("not_admitted")
  G40(expectedSource.sourceRevision)
  if (expectedSource.sourceTree != null) G40(expectedSource.sourceTree)
  if (expectedSource.sourceRevision !== process.env.GITHUB_SHA || typeof deadline !== "bigint" ||
    D(process.env.DESK_TEST_OWNED_GIT_H) !== deadline.toString() ||
    process.hrtime.bigint() >= deadline - 90000000000n || allocation !== ALLOCATION_SHA) fail("not_admitted")
  keys(expectedRun, [])
  const repository = path.resolve(__dirname, "../../../../../../")
  if (workspace !== repository) fail("source_mismatch")
  absolutePhysical(repository)
  const root = path.join(repository, "owned-git-product-output")
  try { fs.lstatSync(root); fail("namespace_not_fresh") }
  catch (error) { if (error.code !== "ENOENT") throw error }
  const hashes = SOURCE_PATHS.map((name, i) => {
    const digest = sha(guardedFile(repository, name.split("/").join(path.sep), 2097152))
    if (i < 4 && digest !== FROZEN[i]) fail("source_mismatch")
    return digest
  })
  const runtimeBytes = guardedFile(repository, "owned-git-product-interpreters.json", 16384)
  const runtimeInput = array(object({ path: (v) => { if (typeof v !== "string" || !path.isAbsolute(v)) fail(); return v },
    version: (v) => v, sha256: text(/^[a-fA-F0-9]{64}$/, 64) }), 3)(core.parseJSON(runtimeBytes, 16384))
  const runtimePaths = new Map()
  const runtimes = runtimeInput.map((r, i) => {
    const [role, version, sourceRevision, expectedExeSha256] = RUNTIMES[i]
    if (r.version !== `v${version}` || r.sha256.toLowerCase() !== expectedExeSha256 ||
      hashPublicImage(r.path, deadline - 90000000000n) !== expectedExeSha256) fail("runtime_mismatch")
    runtimePaths.set(role, r.path)
    return { role, version, sourceRevision, expectedExeSha256, measuredExeSha256: expectedExeSha256,
      exeHashOrigin: "ci_host_rehashed", sourceSnapshotObservedInCI: false }
  })
  if (process.versions.node !== RUNTIMES[2][1] ||
    hashPublicImage(process.execPath, deadline - 90000000000n) !== RUNTIMES[2][3]) fail("runtime_mismatch")
  if (process.hrtime.bigint() >= deadline - 90000000000n) fail("deadline")
  fs.mkdirSync(root)
  for (const name of ["public", "supervisor", "safe-evidence", "export"]) fs.mkdirSync(path.join(root, name))
  const ctx = Object.freeze({})
  contexts.set(ctx, { execution: "native-windows", ctx, root, workspace: repository, layout: fixtureLayout(path.join(root, "public", "mcp")),
    H: deadline, source: Object.freeze({ sourceRevision: expectedSource.sourceRevision, sourceTree: expectedSource.sourceTree || null }),
    nonce: crypto.randomBytes(32).toString("hex"), sourceHashes: Object.freeze(hashes),
    runtimes: immutable(runtimes), runtimePaths, buildReady: false, nativeOrigin: null,
    producers: new Map(), infrastructure: new Map(), leaves: new Map(), gaps: new Set(),
    privateBudget: { filesRead: 0, bytesRead: 0, entriesSeen: new Set(), depthPeak: 0 },
    reportFinal: false, reportAttempted: false, manifestFinal: false, manifestAttempted: false,
    audit: { nativeHeaders: 0, nativeWrites: 0, privateReads: 0 } })
  return ctx
}
function trackActualChild(s, record, child, { control = false, cues = false } = {}) {
  // Only the fixed launchers call this function; there is no registration API.
  record.child = child; launches.set(child, record)
  record.tracker = createProducerTracker({ id: record.role, origin: record.origin, imageSha256: record.imageSha256,
    observedPid: child.pid || 0, deadlineNs: record.end.toString() })
  record.fault = null; record.started = false; record.cues = new Set(); record.cueWaiters = new Map()
  const fault = (error) => {
    record.fault ||= errorGap(error, "producer_unjoined")
    record.tracker.error()
    try { child.kill("SIGTERM") } catch { /* No substitute handle or synthetic close. */ }
  }
  let line = [], discard = false
  const cueBytes = (bytes) => {
    for (const byte of bytes) {
      if (byte === 10) {
        if (!discard) {
          const cue = Buffer.from(line).toString("ascii")
          if (["BOOTSTRAP_CLOSED", "EXPORT_BARRIER", "MODEL_BOOTSTRAP_CLOSED"].includes(cue)) {
            record.cues.add(cue); record.cueWaiters.get(cue)?.(true)
          }
        }
        line = []; discard = false
      } else if (!discard) {
        if (line.length === 256) { line = []; discard = true }
        else line.push(byte)
      }
    }
  }
  for (const name of ["stdout", "stderr"]) {
    child[name].on("data", (bytes) => { try {
      record.tracker.data(name, bytes)
      if (cues && name === "stdout") cueBytes(bytes)
    } catch (error) { fault(error) } })
    child[name].once("end", () => { try { record.tracker.end(name) } catch (e) { fault(e) } })
    child[name].once("close", () => { try { record.tracker.close(name) } catch (e) { fault(e) } })
    child[name].on("error", () => fault({ code: "producer_unjoined" }))
  }
  if (control) {
    record.controlEOF = false; record.controlClosed = false
    record.reader = createSupervisorEventReader({ nonce: record.nonce, producer: record.role, onEvent(value) {
      if (value.type === "CONTROLLER_CREATED") record.controllerPid = value.controllerPid
    } })
    child.stdio[3].on("data", (bytes) => { try { record.reader.push(bytes) } catch (e) { fault(e) } })
    child.stdio[3].once("end", () => { try { record.reader.end(); record.controlEOF = true } catch (e) { fault(e) } })
    child.stdio[3].once("close", () => { record.controlClosed = true })
    child.stdio[3].on("error", () => fault({ code: "producer_unjoined" }))
  }
  child.once("spawn", () => {
    if (!Number.isInteger(child.pid) || child.pid < 1 || process.hrtime.bigint() >= record.end) return fault({ code: "deadline" })
    record.started = true; record.tracker.spawned(child.pid)
    if (record.role === "main" && record.origin === "real-supervisor") s.nativeOrigin = record
    if (control) {
      const config = { schema: "desk.owned-git-supervisor-config/1", Hns: s.H.toString(), deadlineNs: record.end.toString(),
        nonce: record.nonce, sourceRevision: s.source.sourceRevision, sourceTree: s.source.sourceTree,
        allocationSha256: ALLOCATION_SHA, fixtureManifestSha256: s.bundle.fixtureManifestSha256,
        sourceManifestSha256: s.bundle.sourceManifestSha256, node: s.runtimePaths.get("24"), repositoryRoot: s.workspace }
      const text = JSON.stringify(config), length = Buffer.byteLength(text)
      if (length > 4096) return fault({ code: "quota" })
      const frame = Buffer.alloc(length + 4); frame.writeUInt32LE(length); frame.write(text, 4, "utf8")
      record.configBuffer = frame; record.reader.configSent()
      try { child.stdio[3].write(frame, (error) => { record.configBuffer = null; if (error) fault({ code: "producer_unjoined" }) }) }
      catch { fault({ code: "producer_unjoined" }) }
    }
  })
  child.once("exit", (code, sig) => { try { record.tracker.exit(code, sig) } catch (e) { fault(e) } })
  child.on("error", () => fault({ code: "producer_unjoined" }))
  const timer = setTimeout(() => fault({ code: "deadline" }),
    Math.max(0, Number((record.end - process.hrtime.bigint() + 999999n) / 1000000n)))
  record.observed = new Promise((resolve) => child.once("close", () => {
    clearTimeout(timer)
    record.tracker.processClose(process.hrtime.bigint().toString())
    const snapshot = record.tracker.snapshot()
    const value = Object.freeze({ ...snapshot, eligible: snapshot.eligible && record.started && !record.fault &&
      (!control || (record.controlEOF && record.controlClosed && !!record.controllerPid)) })
    record.observation = value
    observations.set(value, { ctx: s.ctx, record })
    for (const settle of record.cueWaiters.values()) settle(false)
    record.cueWaiters.clear()
    resolve(value)
  }))
  return record
}
const workerFactsShape = object({ schema: literal("desk.owned-git-infrastructure-worker/1"), role: enumeration("build", "coverage-tools"),
  Hns: D, sourceRevision: G40, deadlineNs: D, finishedNs: D, workerExitObserved: literal(true),
  workerRetired: literal(true), workerStdoutEOF: literal(true), workerStderrEOF: literal(true),
  realJobSealed: literal(true), controlReaped: literal(true), criticalHandlesClosed: literal(true),
  realActiveProcesses: literal(0), workerExitCode: literal(0), gap: literal("none") })
async function launchInfrastructure(s, mode) {
  const end = mode === "build" ? s.H - 90000000000n : s.H
  if (process.hrtime.bigint() >= end || s.infrastructure.has(mode)) fail("deadline")
  const drive = process.env.SystemDrive
  if (typeof drive !== "string" || !/^[A-Za-z]:$/.test(drive)) fail("tool_missing")
  const image = path.join(drive + path.sep, "Program Files", "PowerShell", "7", "pwsh.exe")
  const imageSha256 = hashPublicImage(image, end)
  if (mode !== "build" && imageSha256 !== s.bundle.fixture.compiler.pwshImageSha256) fail("runtime_mismatch")
  const script = path.join(s.workspace, ...SOURCE_PATHS[16].split("/"))
  if (sha(guardedFile(s.workspace, SOURCE_PATHS[16].split("/").join(path.sep), 2097152)) !== s.sourceHashes[16]) fail("source_mismatch")
  if (process.hrtime.bigint() >= end) fail("deadline")
  const child = spawn(image, ["-NoProfile", "-NonInteractive", "-File", script,
    "-PublicMcpRoot", s.layout.publicMcpRoot, "-FixtureRoot", s.layout.fixtureRoot,
    "-SourceRevision", s.source.sourceRevision, "-EnvelopeDeadlineNs", s.H.toString(),
    "-WorkerMode", mode === "build" ? "host-build" : "host-coverage",
    "-GitNodeExecutable", s.runtimePaths.get("24")],
  { cwd: s.workspace, env: cleanHostEnvironment(), windowsHide: true, stdio: ["ignore", "overlapped", "overlapped"] })
  // Infrastructure is never registered as a real-supervisor origin.
  const record = trackActualChild(s, { ctx: s.ctx, role: "main", origin: "fault-model", imageSha256, end }, child)
  s.infrastructureAttempts ||= new Map(); s.infrastructureAttempts.set(mode, record)
  const observation = await record.observed
  if (!record.started || record.fault || !joined(observation, end) || observation.code !== 0 || observation.signal !== null) fail("build_failed")
  const bytes = guardedFile(s.root, path.join("public", "fixtures", `infrastructure-${mode}.json`), 65536)
  const facts = workerFactsShape(core.parseJSON(bytes, 65536))
  if (facts.role !== mode || facts.Hns !== s.H.toString() || facts.sourceRevision !== s.source.sourceRevision ||
    facts.deadlineNs !== end.toString() || BigInt(facts.finishedNs) > BigInt(observation.closedAtNs) ||
    BigInt(facts.finishedNs) >= end) fail("schema")
  const projected = infrastructureShape({ role: mode, producerExitObserved: observation.exitObserved,
    producerFullcloseObserved: joined(observation, end), workerRetired: facts.workerRetired,
    realJobSealed: facts.realJobSealed, realActiveProcesses: facts.realActiveProcesses,
    controlReaped: facts.controlReaped, criticalHandlesClosed: facts.criticalHandlesClosed,
    deadlineNs: facts.deadlineNs, finishedNs: observation.closedAtNs, gap: "none" })
  s.infrastructure.set(mode, projected)
  return { record, projected }
}
async function buildPublicFixtures(ctx) {
  const s = state(ctx, true)
  if (s.buildAttempted) fail("not_admitted")
  s.buildAttempted = true
  try {
    prepareSyntheticBuildInput(s)
    const { record } = await launchInfrastructure(s, "build")
    const bundle = verifyPublicBundle({ publicMcpRoot: s.layout.publicMcpRoot, expectedSource: s.source })
    if (bundle.source.sources.some((r, i) => r.sha256 !== s.sourceHashes[i]) ||
      bundle.fixture.compiler.pwshImageSha256 !== record.imageSha256) fail("source_mismatch")
    const bytes = guardedFile(s.root, path.join("public", "fixtures", "git-binding.json"), 4096)
    const git = projectGitBinding(core.parseJSON(bytes,4096),{sourceRevision:s.source.sourceRevision,
      sourceTree:bundle.source.sourceTree,fixtureRoot:s.layout.fixtureRoot})
    for (const [file, digest] of externalGitComponents(git, s.root)) {
      if (hashPublicImage(file, s.H - 90000000000n) !== digest) fail("runtime_mismatch")
    }
    s.source = Object.freeze({ sourceRevision: bundle.source.sourceRevision, sourceTree: bundle.source.sourceTree })
    if (process.hrtime.bigint() >= s.H - 90000000000n) fail("deadline")
    s.git = Object.freeze(git); s.bundle = immutable(bundle)
    inspectHostGit(s,s.H-90000000000n)
    s.buildReady = true
    return Object.freeze({ publicMcpRoot: s.layout.publicMcpRoot, fixtureRoot: s.layout.fixtureRoot,
      sourceRevision: s.source.sourceRevision, sourceTree: s.source.sourceTree })
  } catch (error) { latch(s, error, "build_failed"); throw error }
}
function inspectHostGit(s,end) {
  const layout=gitExecutionLayout({fixtureRoot:s.layout.fixtureRoot,nodeExecutable:s.runtimePaths.get("24"),
    gitExecutable:s.git.executable,shellExecutable:s.git.shellExecutable,systemRoot:process.env.SystemRoot})
  if (!sameIdentity(s.gitExecIdentity,diskIdentity(layout.execPath))) fail("identity_changed")
  const snapshot=inspectGitExecution(layout,{mountConfigSha256:s.git.mountConfigSha256,
    live:() => { if(process.hrtime.bigint()>=end) fail("deadline") }})
  if(s.gitInspection!==undefined && s.gitInspection!==snapshot) fail("identity_changed")
  s.gitInspection=snapshot
}
function launchProducer(ctx, roleName) {
  const s = state(ctx, true)
  producerId(roleName)
  if (arguments.length !== 2 || !s.buildReady || s.producers.has(roleName)) fail("not_admitted")
  const now = process.hrtime.bigint(), end = roleName === "main" ? s.H - 15000000000n :
    (now + 2000000000n < s.H - 12000000000n ? now + 2000000000n : s.H - 12000000000n)
  if (now >= end || (roleName !== "main" && !s.mainAdmission)) fail("not_admitted")
  const root = roleName === "main" ? s.root : path.join(s.root, "supervisor", roleName)
  if (roleName !== "main") fs.mkdirSync(root)
  const binary = s.bundle.fixture.binaries[roleName === "RET06" ? 2 : 4]
  const relative = path.join("public", "fixtures", binary.key)
  const image = path.join(s.root, relative)
  if (sha(guardedFile(s.root, relative, 4194304)) !== binary.sha256) fail("source_mismatch")
  const nonce = roleName === "main" ? s.nonce : crypto.randomBytes(32).toString("hex")
  const env = cleanHostEnvironment(); env.DESK_TEST_OWNED_GIT_H = s.H.toString()
  if (roleName === "RET06") Object.assign(env, { DESK_TEST_OWNED_GIT_MODEL_NONCE: nonce,
    DESK_TEST_OWNED_GIT_MODEL_REVISION: s.source.sourceRevision, DESK_TEST_OWNED_GIT_MODEL_TREE: s.source.sourceTree,
    DESK_TEST_OWNED_GIT_MODEL_FIXTURE_SHA256: s.bundle.fixtureManifestSha256, DESK_TEST_OWNED_GIT_MODEL_D: end.toString() })
  const origin = roleName === "RET06" ? "fault-model" : "real-supervisor"
  const mode = roleName === "main" ? "--supervise-main" : roleName === "RET06" ? "--retention-model-bootstrap" : `--${roleName.toLowerCase()}`
  if (process.hrtime.bigint() >= end) fail("deadline")
  const child = spawn(image, [mode], { cwd: root, env, windowsHide: true,
    stdio: ["ignore", "overlapped", "overlapped", "overlapped"] })
  const record = trackActualChild(s, { ctx, role: roleName, origin, imageSha256: binary.sha256, end, H: s.H,
    root, nonce, attempted: false, roles: [] },
  child, { control: origin === "real-supervisor", cues: roleName !== "main" })
  s.producers.set(roleName, record)
  return child
}
function observeProducer(ctx, child, roleName) {
  state(ctx, true)
  const record = launches.get(child)
  if (!record || record.ctx !== ctx || record.role !== roleName || record.child !== child) fail("model_origin")
  return record.observed
}
function recordPrivateReadDelta(record,before,after) {
  integer(0,1024)(before); integer(before,1024)(after)
  record.privateReadFiles=integer(0,1024)((record.privateReadFiles||0)+after-before)
}
function readNativeRole(s, record, def, expected) {
  if (!getPrivateRoleRegistry().includes(def) || def.producer !== record.role ||
    (!record.admission && def.role !== "bootstrap")) fail("not_admitted")
  const end = record.role === "main" ? s.H : record.end
  if (process.hrtime.bigint() >= end) fail("deadline")
  const beforeReads=s.privateBudget.filesRead
  try {
    const bytes = guardedFile(record.root, def.relative, def.limit, { budget: s.privateBudget, bootstrap: def.role === "bootstrap", expected,
      onIdentity: (value) => { record.identities ||= new Map(); record.identities.set(def.key, value) } })
    if (process.hrtime.bigint() >= end) fail("deadline")
    return bytes
  } finally {
    recordPrivateReadDelta(record,beforeReads,s.privateBudget.filesRead)
    s.audit.privateReads = s.privateBudget.filesRead
  }
}
function admitBootstrap(ctx, observation) {
  const s = state(ctx, true), proof = observations.get(observation)
  if (!proof || proof.ctx !== ctx || proof.record.origin !== "real-supervisor") {
    if (proof?.ctx === ctx) proof.record.attempted = true
    fail("model_origin")
  }
  const record = proof.record
  if (record.attempted) fail("not_admitted")
  if (record.role !== "main" && process.hrtime.bigint() >= record.end) { record.attempted = true; fail("deadline") }
  if (!record.started || record.fault || !record.controlEOF || !record.controlClosed ||
    !record.controllerPid || !joined(observation, record.end) || process.hrtime.bigint() >= s.H) {
    record.attempted = true; fail("producer_unjoined")
  }
  record.binding = Object.freeze({ nonce: record.nonce, sourceRevision: s.source.sourceRevision, sourceTree: s.source.sourceTree,
    allocationSha256: ALLOCATION_SHA, fixtureManifestSha256: s.bundle.fixtureManifestSha256,
    Hns: s.H.toString(), controllerPid: record.controllerPid })
  const def = getPrivateRoleRegistry().find((d) => d.producer === record.role && d.role === "bootstrap")
  let bytes
  try {
    const result = bootstrapDecision(record, observation, () => { bytes = readNativeRole(s, record, def); return bytes })
    const permit = Object.freeze({})
    admissions.set(permit, { ctx, record, bootstrap: result.value }); record.admission = permit
    record.roles.push(roleRow(def, "present", "none", bytes))
    if (record.role === "main") s.mainAdmission = permit
    return permit
  } catch (error) {
    const code = error?.code === "ENOENT" ? "bootstrap_missing" : errorGap(error, "bootstrap_invalid")
    record.bootstrapGap = code
    record.roles.push(roleRow(def, error?.code === "ENOENT" ? "missing" : bytes ? "present" : "withheld", code, bytes || null))
    throw Object.assign(new Error(code), { code })
  }
}
function nativeAdmission(ctx, permit) {
  const s = state(ctx, true), value = admissions.get(permit)
  if (!value || value.ctx !== ctx || value.record.admission !== permit || process.hrtime.bigint() >= s.H) fail("not_admitted")
  return s
}
function waitForCue(record, cue) {
  if (record.cues.has(cue)) return Promise.resolve(true)
  if (record.observation) return Promise.resolve(false)
  return new Promise((resolve) => record.cueWaiters.set(cue, resolve))
}
const retentionResults = new WeakMap()
function runRetentionControlGroup(runControl) {
  return Promise.all(["RET01","RET02","RET03","RET04","RET05","RET06","RET07"].map(runControl))
}
async function runRetentionControls(ctx, admission) {
  const s = nativeAdmission(ctx, admission)
  if (admissions.get(admission).record.role !== "main" || s.controlsAttempted) fail("not_admitted")
  s.controlsAttempted = true
  const results = await runRetentionControlGroup(async (id) => {
    if (process.hrtime.bigint() >= s.H - 12000000000n) { latch(s, { code: "deadline" }); return null }
    let child, record, observation, permit, code = "none", matched = false, signalRequested = false
    try {
      child = launchProducer(ctx, id); record = launches.get(child)
      if (["RET01", "RET02", "RET03", "RET04", "RET05", "RET06"].includes(id)) {
        const cue = id === "RET05" ? "EXPORT_BARRIER" : id === "RET06" ? "MODEL_BOOTSTRAP_CLOSED" : "BOOTSTRAP_CLOSED"
        if (!await waitForCue(record, cue)) fail("case_mismatch")
        if (id === "RET05") {
          const partial = record.tracker.snapshot()
          observations.set(partial, { ctx, record })
          try { admitBootstrap(ctx, partial); fail("case_mismatch") }
          catch (error) { if (error.code !== "producer_unjoined" || !record.attempted ||
            (record.privateReadFiles||0) !== 0) throw error; code = error.code }
        }
        if (id !== "RET06") {
          signalRequested = child.kill("SIGTERM")
          if (!signalRequested) fail("signal_failure")
        }
      }
      observation = await record.observed
      if (record.fault || !record.started || !joined(observation, record.end)) fail(record.fault || "producer_unjoined")
      if (id !== "RET05") {
        try { permit = admitBootstrap(ctx, observation) }
        catch (error) { code = errorGap(error, "bootstrap_invalid") }
      }
      if (id === "RET01") {
        if (!permit) fail(code)
        const def = getPrivateRoleRegistry().find((d) => d.key === `${id}:sentinel`)
        const bytes = readNativeRole(s, record, def)
        object({ sentinel: literal(true) })(core.parseJSON(bytes, 256))
        record.roles.push(roleRow(def, "present", "none", bytes))
        matched = signalRequested && observation.signal === "SIGTERM" && record.privateReadFiles === 2
      } else if (id === "RET07") {
        if (!permit) fail(code)
        const expected = record.reader.snapshot().targetIdentity
        if (!expected) fail("case_mismatch")
        const def = getPrivateRoleRegistry().find((d) => d.key === `${id}:sentinel`), before = record.privateReadFiles||0
        try { readNativeRole(s, record, def, expected); fail("case_mismatch") }
        catch (error) {
          if (error.code !== "identity_changed" || (record.privateReadFiles||0) !== before) throw error
          code = error.code; record.roles.push(roleRow(def, "withheld", code)); matched = true
        }
      } else {
        const expected = { RET02: "bootstrap_missing", RET03: "bootstrap_invalid", RET04: "bootstrap_not_real_zero",
          RET05: "producer_unjoined", RET06: "model_origin" }[id]
        const expectedReads = ["RET03", "RET04"].includes(id) ? 1 : 0
        matched = !permit && code === expected && (record.privateReadFiles||0) === expectedReads &&
          (id === "RET06" || (signalRequested && observation.signal === "SIGTERM"))
        if (id === "RET05" || id === "RET06") {
          const def = getPrivateRoleRegistry().find((d) => d.producer === id && d.role === "bootstrap")
          record.roles.push(roleRow(def, id === "RET06" ? "withheld" : "not_attempted", code))
        }
      }
    } catch (error) { code = errorGap(error, "case_mismatch") }
    finally {
      if (record && !record.observation) {
        try { child.kill("SIGTERM") } catch { /* Retain the original actor until actual close. */ }
        observation = await record.observed
      }
    }
    if (!record) { latch(s, { code }); return null }
    if (process.hrtime.bigint() >= record.end) { code = "deadline"; matched = false }
    const bootstrap = record.roles.find((r) => r.role === "bootstrap")
    const result={ id, producer: record.origin, matched, bootstrap: bootstrap?.presence || "not_attempted",
      bootstrapRead: bootstrap?.bytes !== null && bootstrap?.bytes !== undefined,
      otherPrivateReads: id === "RET01" ? Math.max(0, (record.privateReadFiles||0) - 1) : 0,
      signalFailed: observation?.signal !== null && observation?.signal !== undefined,
      primaryFailurePreserved: observation?.primaryFailurePreserved === true,
      realZero: permit ? true : record.bootstrapReportedZero === false ? false : null,
      privateTargetWithheld: id === "RET07" ? matched : id !== "RET01", gap: matched ? code : code === "none" ? "case_mismatch" : code }
    if (!matched) latch(s, { code: code === "none" ? "case_mismatch" : code })
    return result
  })
  const controls=results.filter((r) => r!==null)
  const token = Object.freeze({})
  retentionResults.set(token, { ctx, admission, controls: immutable(controls) })
  return token
}
async function launchCoverageTools(ctx, admission, token) {
  const s = nativeAdmission(ctx, admission), facts = privateFacts.get(token)
  if (!facts || facts.ctx !== ctx || facts.admission !== admission || facts.coverageAttempted ||
    !coverageSeedsComplete(facts.report)) fail("not_admitted")
  facts.coverageAttempted = true
  try {
    await launchInfrastructure(s, "coverage-tools")
    const bytes = guardedFile(s.root, path.join("public", "fixtures", "coverage-pair.json"), 65536)
    facts.coverage = immutable(projectCoverage(core.parseJSON(bytes, 65536)))
    if (facts.coverage.baselineSha256 !== s.bundle.fixture.syntheticBaseline.indexedSha256) fail("source_mismatch")
    return facts.coverage
  } catch (error) { latch(s, error, "denominator_missing"); throw error }
}
function collectPrivateRoles(ctx, admission, caseRegistry) {
  const s = nativeAdmission(ctx, admission)
  const record = admissions.get(admission).record
  if (record.role !== "main" || caseRegistry !== registry() || record.collectionAttempted) fail("not_admitted")
  record.collectionAttempted = true
  const def = getPrivateRoleRegistry().find((d) => d.key === "controller-report")
  let bytes
  try {
    bytes = readNativeRole(s, record, def)
    const report = immutable(validateController(core.parseJSON(bytes, 1048576), s))
    record.roles.push(roleRow(def, "present", "none", bytes))
    const classified = classifyMainRoles(report, {
      read: (d) => readNativeRole(s, record, d),
      lookup(d) {
        if (!record.admission || process.hrtime.bigint() >= s.H) fail("not_admitted")
        try { walkDeclared(record.root, d.relative, s.privateBudget); return true }
        catch (e) { if (e.code === "ENOENT") return false; throw e }
      },
    })
    record.roles.push(...classified.roles)
    const token = Object.freeze({})
    privateFacts.set(token, { ctx, admission, report, classified, cases: null, coverage: null, coverageAttempted: false })
    return token
  } catch (error) {
    latch(s, error)
    if (!record.roles.some((r) => r.role === "controller-report")) record.roles.push(
      roleRow(def, bytes ? "present" : error?.code === "ENOENT" ? "missing" : "withheld",
        error?.code === "ENOENT" ? "role_missing" : errorGap(error, "guard_failed"), bytes || null))
    throw error
  }
}
function validateController(v, s) {
  const out = object({ schema: literal("desk.owned-git-case-facts/1"), sourceRevision: literal(s.source.sourceRevision),
    allocationSha256: literal(ALLOCATION_SHA), namespaceNonce: literal(s.nonce), cases: array(projectCase, 80),
    clock: (rows) => projectClock({ samples: rows, gaps: [] }).samples, utilities: array(utilityShape, 6),
    markersExpected: literal(12), quarantine: object({ caseWorkers: literal(1), modelRoots: literal(1),
      authority: literal("retained-real-broader-job") }), gap })(v)
  if (out.cases.some((row, i) => row.id !== registry()[i].id ||
    row.actual?.generations.some((g) => g.resources.broaderRetirement !== "unproved" || g.certificateOrigin === "receipt-after-gate"))) fail()
  const generations = out.cases.flatMap((row) => row.actual?.generations || [])
  if (new Set(generations.map((g) => g.generation)).size !== generations.length ||
    new Set(generations.map((g) => g.preparationDigest)).size !== generations.length ||
    out.cases.some((row) => row.actual && (BigInt(row.actual.caseDeadlineNs) > s.H - 20000000000n ||
      BigInt(row.actual.finishedNs) >= s.H - 20000000000n ||
      row.actual.generations.some((g) => g.slot >= row.expected.generations)))) fail("case_mismatch")
  const quarantine = out.cases.find((row) => row.id === "C15-P24-R24")
  if (!quarantine?.actual || quarantine.actual.generations.reduce((n, g) => n + g.resources.modelStrandedRoot, 0) !== 1) fail("case_mismatch")
  projectCases({ cases: out.cases, utilities: out.utilities, markers: [], gap: out.gap })
  return out
}
function foldCases(ctx, admission, token) {
  nativeAdmission(ctx, admission)
  const facts = privateFacts.get(token)
  if (!facts || facts.ctx !== ctx || facts.admission !== admission) fail("not_admitted")
  if (!facts.cases) facts.cases = immutable(foldReceiptFacts(facts.report.cases, facts.classified.receipts, true))
  return facts.cases
}
function projectObservedCounts(cases, controls, utilities, roles = []) {
  const gs = cases.flatMap((c) => c.actual?.generations || [])
  const certs = gs.filter((g) => g.certificate !== null && receiptJoinEligible(g))
  return counts({ componentCases: cases.filter((c) => c.actual !== null).length,
    retentionControls: controls.length, generations: gs.length,
    parentSTART: gs.filter((g) => g.phase.parentSTARTSent).length,
    nativeSTART: gs.filter((g) => g.phase.nativeSTARTIssued === true).length,
    genuineRESULT: gs.filter((g) => g.result !== null).length, eligibleNativeCertificates: certs.length,
    certificateNotStarted: certs.filter((g) => g.certificate.commandState === "not_started").length,
    certificateReported: certs.filter((g) => g.certificate.commandState === "reported").length,
    certificateUnknown: certs.filter((g) => g.certificate.commandState === "unknown").length,
    rootCreations: gs.reduce((n, g) => n + g.resources.rootCreated, 0),
    ownerFullClose: gs.filter(ownerFullJoined).length,
    ownerFullCloseMissing: gs.filter((g) => !ownerFullJoined(g)).length,
    utilityProcesses: utilities.reduce((n, u) => n + u.fullcloseObserved, 0),
    modelRoots: gs.reduce((n, g) => n + g.resources.modelStrandedRoot, 0),
    modelRootsRetiredReal: gs.filter((g) => g.resources.modelStrandedRoot && g.resources.broaderRetirement === "real-sealed-zero").length,
    receiptAbsent: roles.filter((r) => r.role === "native-receipt" && r.presence === "expected_absent").length,
    receiptWithheld: roles.filter((r) => r.role === "native-receipt" && r.presence === "withheld").length,
  })
}
const schemaNames = Object.freeze(["report", "cases", "clock", "observer", "runtime", "build", "retention", "export"])
const schemas = Object.freeze(schemaNames.map((name) => `desk.owned-git-native-${name}/1`))
const EXPECTED_COUNTS = Object.freeze({ componentCases: 80, retentionControls: 7, generations: 75, parentSTART: 40,
  nativeSTART: 39, genuineRESULT: 26, eligibleNativeCertificates: 55, certificateNotStarted: 27,
  certificateReported: 23, certificateUnknown: 5, rootCreations: 70, ownerFullClose: 73, ownerFullCloseMissing: 2,
  utilityProcesses: 10, modelRoots: 1, modelRootsRetiredReal: 1, receiptAbsent: 18, receiptWithheld: 2 })
function privateCollectionComplete(record) {
  return getPrivateRoleRegistry().filter((d) => d.producer === "main").every((def) => {
    const row = record.roles.find((r) => r.role === def.role && r.case === def.case && r.slot === def.slot)
    if (!row) return false
    if (def.role === "native-receipt" && def.policy.startsWith("withheld_")) return row.presence === "withheld"
    if ((def.role === "native-receipt" && def.policy === "expected_absent") ||
      def.role === "unexpected-bootstrap-marker") return row.presence === "expected_absent" && row.gap === "none"
    return row.presence === "present" && row.gap === "none"
  })
}
function coverageSeedsComplete(report) {
  const u = report.utilities.find((u) => u.id === "C19-P24-Rnone")
  const c = report.cases.find((c) => c.id === "C19-P24-Rnone")
  return !!(u && u.processes === 2 && u.fullcloseObserved === 2 && u.checksExpected === 4 && u.checksPassed === 0 &&
    u.denominator === null && u.gap === "denominator_missing" && c?.gap === "none" && c.actual?.matched === true &&
    c.actual.disposition === "utility-only" && c.actual.utilityId === u.id && c.actual.generations.length === 0)
}
function utilityObservations(facts) {
  return facts.report.utilities.map((u) => {
    if (u.id !== "C19-P24-Rnone" || facts.coverage === null || !coverageSeedsComplete(facts.report)) return u
    const checksPassed = ["regions", "branches", "functions", "lines"].filter((key) =>
      facts.coverage.production[key] > 0 && facts.coverage.production[key] === facts.coverage.fault[key]).length
    return utilityShape({ ...u, checksPassed, denominator: facts.coverage, gap: checksPassed === 4 ? "none" : "denominator_mismatch" })
  })
}
function clockObservationComplete(cases, samples, utilities) {
  const clocks = utilities.filter((u) => u.id.startsWith("C02-"))
  if (clocks.length !== 3 || clocks.some((u) => u.gap !== "none" || u.checksPassed !== 136 ||
    u.fullcloseObserved !== 2 || u.companionFullcloseObserved !== true || u.clockRows.length !== 136 ||
    new Set(u.clockRows).size !== 136 || u.clockRows.some((i) => samples[i]?.case !== u.id ||
      samples[i]?.role !== u.id.slice(5, 7)))) return false
  for (const u of clocks) for (const [originValue, number] of [["parent-companion", 64], ["root-companion", 64], ["fixed-vector", 8]]) {
    if (u.clockRows.filter((i) => samples[i].origin === originValue).length !== number) return false
  }
  for (const row of samples) if (row.origin !== "fixed-vector") {
    try {
      if (row.modeled || !row.accepted || row.beforeNs === null || row.afterNs === null ||
        BigInt(row.beforeNs) > BigInt(row.afterNs) || BigInt(row.afterNs) >= BigInt(row.deadlineNs) ||
        core.mirrorWindowsHrtime(row.q, row.f).toString() !== row.converted) return false
      const q = BigInt(row.q)
      if (!q || core.mirrorWindowsHrtime((q - 1n).toString(), row.f) > BigInt(row.afterNs) ||
        core.mirrorWindowsHrtime((q + 1n).toString(), row.f) < BigInt(row.beforeNs)) return false
    } catch { return false }
  }
  return cases.every((c) => (c.actual?.generations || []).every((g) => {
    if (!g.phase.clockAccepted) return true
    const sample = samples[g.clockRow]
    return g.clockRow !== null && sample?.case === c.id && sample.generationSlot === g.slot &&
      sample.origin === "owner" && sample.role === c.parent && sample.deadlineNs === g.deadlineNs && sample.accepted
  }))
}
function unavailableLeaf(id, code = "not_admitted") {
  return validateLeaf({ id, path: PUBLIC_LEAVES[id - 1], presence: "not_attempted", bytes: null, sha256: null,
    origin: "unobserved", mandatory: true, gap: code }, id)
}
function allPrivateRows(s) {
  return ["main", ...Array.from({ length: 7 }, (_, i) => `RET0${i + 1}`)].flatMap((id) => {
    const record = s.producers.get(id), actual = record?.roles || []
    const defs = getPrivateRoleRegistry().filter((d) => d.producer === id)
    // If collection was never admitted, report only declared, unattempted roles.
    if (!actual.length) return defs.map((d) => roleRow(d, "not_attempted", record?.bootstrapGap || "not_admitted"))
    const remaining = [...actual]
    return defs.map((d) => {
      const index = remaining.findIndex((r) => r.role === d.role && r.case === d.case && r.slot === d.slot)
      return index < 0 ? roleRow(d, "not_attempted", "not_admitted") : remaining.splice(index, 1)[0]
    })
  })
}
function infrastructureObservation(s, roleName) {
  if (s.infrastructure.has(roleName)) return s.infrastructure.get(roleName)
  const record = s.infrastructureAttempts?.get(roleName), obs = record?.observation
  return infrastructureShape({ role: roleName, producerExitObserved: obs?.exitObserved === true,
    producerFullcloseObserved: !!obs && joined(obs, record.end), workerRetired: false, realJobSealed: false,
    realActiveProcesses: null, controlReaped: false, criticalHandlesClosed: false,
    deadlineNs: (roleName === "build" ? s.H - 90000000000n : s.H).toString(),
    finishedNs: obs?.closedAtNs || null, gap: record?.fault || "not_admitted" })
}
function projectControllerFacts(value, { sourceRevision, namespaceNonce, Hns }) {
  G40(sourceRevision); H(namespaceNonce); D(Hns)
  return validateController(value, { source: { sourceRevision }, nonce: namespaceNonce, H: BigInt(Hns) })
}
function emitNativeHeader(ctx, schema) {
  const s = state(ctx, true)
  nativeAuthority(s)
  if (!schemas.includes(schema)) fail("not_admitted")
  s.audit.nativeHeaders++
  return { schema, sourceRevision: s.source.sourceRevision, sourceTree: s.source.sourceTree,
    productContentBase: PRODUCT_BASE, allocationSha256: ALLOCATION_SHA, namespaceNonce: s.nonce,
    execution: "native-windows", claim: "observed-not-adjudicated" }
}
function emitNativeLeaf(ctx, schema, payload, writerPermit) {
  const s = state(ctx, true)
  nativeAuthority(s)
  if (!writerPermit || s.writerPermit !== writerPermit || s.manifestAttempted) fail("not_admitted")
  const index = schemas.indexOf(schema)
  if (index < 0 || index === 7 || s.leaves.has(index + 27)) fail()
  const projections = [projectReport, projectCases, projectClock, projectObserver, projectRuntime, projectBuild, projectRetention]
  const out = projections[index](payload)
  if (index === 0 && s.reportAttempted) fail()
  if (index === 0) s.reportAttempted = true
  const header = emitNativeHeader(ctx, schema)
  const bytes = Buffer.from(JSON.stringify({ ...header, ...out }) + "\n")
  const limits = [65536, 1048576, 262144, 65536, 65536, 65536, 65536]
  if (bytes.length > limits[index]) fail("quota")
  const row = writeLeaf(s, index + 27, bytes)
  if (index === 0) { s.reportFinal = true; s.reportPayload = out }
  return row
}
function writeLeaf(s, id, bytes) {
  nativeAuthority(s)
  s.leafAttempts ||= new Set()
  if (s.leafAttempts.has(id) || s.leaves.has(id) || s.manifestAttempted ||
    (s.exportBytes = (s.exportBytes || 0) + bytes.length) > 33554432) fail("quota")
  s.leafAttempts.add(id)
  const file = path.join(s.root, PUBLIC_LEAVES[id - 1])
  walkDeclared(s.root, "safe-evidence")
  const fd = fs.openSync(file, "wx")
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { closeOwnedFile(fd) }
  const exact = guardedFile(s.root, PUBLIC_LEAVES[id - 1], 1048576)
  if (!exact.equals(bytes)) fail("artifact_digest")
  const row = validateLeaf({ id, path: PUBLIC_LEAVES[id - 1], presence: "present", bytes: exact.length,
    sha256: sha(exact), origin: "ci_host_rehashed", mandatory: true, gap: "none" }, id)
  s.leaves.set(id, row); s.audit.nativeWrites++
  return Object.freeze(row)
}
function emitManifest(ctx, payload, writerPermit) {
  const s = state(ctx, true)
  nativeAuthority(s)
  if (!writerPermit || s.writerPermit !== writerPermit || s.manifestAttempted) fail("not_admitted")
  s.manifestAttempted = true
  const projected = projectManifest(payload)
  for (let id = 1; id <= 33; id++) {
    const actual = s.leaves.get(id)
    if (actual ? JSON.stringify(actual) !== JSON.stringify(projected.leaves[id - 1])
      : projected.leaves[id - 1].presence === "present") fail("artifact_digest")
  }
  if (projected.leafSetSha256 !== null && (!s.reportFinal || s.reportPayload.status !== "complete-observation" ||
    s.reportPayload.gap !== "none" || !s.reportPayload.privateExportComplete)) fail("artifact_missing")
  const bytes = Buffer.from(JSON.stringify({ ...emitNativeHeader(ctx, schemas[7]), ...projected }) + "\n")
  if (bytes.length > 65536) fail("quota")
  // The manifest self row is never passed to the 33-row digest function.
  const file = path.join(s.root, PUBLIC_LEAVES[33]), fd = fs.openSync(file, "wx")
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { closeOwnedFile(fd) }
  if (!guardedFile(s.root, PUBLIC_LEAVES[33], 65536).equals(bytes)) fail("artifact_digest")
  s.manifestFinal = true; s.audit.nativeWrites++
  return MANIFEST_SELF_ROW
}
function exportSafeEvidence(ctx, { admission = null, facts: token = null, controls: controlToken = null } = {}) {
  const s = state(ctx, true)
  nativeAuthority(s)
  if (s.exportAttempted) fail("not_admitted")
  s.exportAttempted = true; s.writerPermit = Object.freeze({})
  const main = s.producers.get("main"), facts = privateFacts.get(token), retained = retentionResults.get(controlToken)
  if (main.fault) latch(s, { code: main.fault })
  const completionGap=mainProducerGap(main.observation)
  if (completionGap!=="none") latch(s,{code:completionGap})
  if (admission !== null) {
    nativeAdmission(ctx, admission)
    try { inspectHostGit(s,s.H) } catch(error) { latch(s,error,"guard_failed") }
  }
  if ((facts && (facts.ctx !== ctx || facts.admission !== admission)) ||
    (retained && (retained.ctx !== ctx || retained.admission !== admission))) fail("not_admitted")
  let cases = registry().map((plan) => ({ ...plan, actual: null, gap: "not_admitted" })), utilities = [], clock = [],
    markers = [], controls = retained?.controls || [], coverage = facts?.coverage || null
  if (facts) {
    try { cases = foldCases(ctx, admission, token); utilities = utilityObservations(facts);
      clock = facts.report.clock; markers = facts.classified.markers }
    catch (error) { latch(s, error) }
  }
  try {
    const current = verifyPublicBundle({ publicMcpRoot: s.layout.publicMcpRoot, expectedSource: s.source })
    for (const row of current.rows) {
      if (JSON.stringify(row) !== JSON.stringify(s.bundle.rows[row.id - 1])) fail("artifact_digest")
      s.leaves.set(row.id, Object.freeze(row))
    }
    s.exportBytes = current.rows.reduce((n, row) => n + row.bytes, 0)
  } catch (error) { latch(s, error, "artifact_digest") }
  const rows = allPrivateRows(s), privateComplete = !!facts && !!main.admission && privateCollectionComplete(main)
  const clockQualified = !!facts && clockObservationComplete(cases, clock, utilities)
  const allUtilities = utilities.length === 6 && utilities.every((u) => u.gap === "none" &&
    u.fullcloseObserved === u.processes && u.checksPassed === u.checksExpected &&
    (!u.id.startsWith("C02-") || u.companionFullcloseObserved === true))
  const observed = facts ? projectObservedCounts(cases, controls, utilities, rows) : null
  const matched = cases.filter((c) => c.actual?.matched).length, retentionMatched = controls.filter((c) => c.matched).length
  if (!main.admission) latch(s, { code: main.bootstrapGap || "bootstrap_missing" })
  if (facts?.report.gap && facts.report.gap !== "none") latch(s, { code: facts.report.gap })
  if (!privateComplete) latch(s, { code: "guard_failed" })
  if (!clockQualified) latch(s, { code: "clock_mismatch" })
  if (!coverage) latch(s, { code: "denominator_missing" })
  if (!allUtilities || matched !== 80 || retentionMatched !== 7 ||
    (observed && countKeys.some((key) => observed[key] !== EXPECTED_COUNTS[key]))) latch(s, { code: "case_mismatch" })
  const attempt = (id, value) => {
    try { emitNativeLeaf(ctx, schemas[id - 27], value, s.writerPermit) }
    catch (error) { latch(s, error, "artifact_missing"); s.unavailable ||= new Map(); s.unavailable.set(id, errorGap(error, "artifact_missing")) }
  }
  // Adopt the builder's immutable 26 files. Only these six closed projections
  // precede report; neither the report nor any other earlier file names a digest.
  attempt(28, { cases, utilities, markers, gap: facts ? facts.report.gap : "not_admitted" })
  attempt(29, { samples: clock, gaps: cases.filter((c) => c.gap !== "none").map((c) => ({ case: c.id, code: c.gap })) })
  if ([...s.producers.values()].length === 8 && [...s.producers.values()].every((p) => p.observation)) {
    attempt(30, { producers: ["main", "RET01", "RET02", "RET03", "RET04", "RET05", "RET06", "RET07"]
      .map((id) => s.producers.get(id).observation), guard: {
        freshNamespace: true, standardToken: !!main.controllerPid, longNamesOnly: true,
        identityStable: !main.roles.some((r) => r.gap === "identity_changed"), depthPeak: s.privateBudget.depthPeak,
        entries: s.privateBudget.entriesSeen.size, filesRead: s.privateBudget.filesRead, bytesRead: s.privateBudget.bytesRead,
        realBroaderZero: !!main.admission, earlyPrivateReads: 0 }, privateReads: rows, gap: main.bootstrapGap || "none" })
  } else latch(s, { code: "producer_unjoined" })
  attempt(31, { runtimes: s.runtimes, selectedGit: { sha256: s.git.sha256, version: s.git.version,
    shellSha256: s.git.shellSha256, envSha256: s.git.envSha256, msysRuntimeSha256: s.git.msysRuntimeSha256,
    mountConfigSha256:s.git.mountConfigSha256,fixturePolicy: "closed-native-git-empty-exec-v1", origin: "ci_host_rehashed" },
    sourceReferences: { runtimeIdentities: "4b70be0b6344a1c001109f7fa9f1265d12b68b90cd78ca12a348ee030a382dce",
      sourceFingerprints: "b1f38dbe37825acec443d6ea2aa180eda54715a839e6431baf44121c272b450c",
      hostFsSourceIdentities: "ea2155078fd25dd43925bd4875c8e06feb9a9277a6c800a814e6c2faac32fd04", origin: "retained_reference" } })
  attempt(32, { compiler: s.bundle.fixture.compiler, binaries: s.bundle.fixture.binaries, sources: s.bundle.source.sources,
    profileSupport: s.bundle.fixture.profileSupport, syntheticBaseline: s.bundle.fixture.syntheticBaseline,
    fixtureVariants: s.bundle.fixture.roots, infrastructure: ["build", "coverage-tools"].map((name) => infrastructureObservation(s, name)),
    coverage, gap: coverage ? "none" : "denominator_missing" })
  attempt(33, { controls })
  const code = [...s.gaps][0] || "none", complete = code === "none"
  attempt(27, { status: complete ? "complete-observation" : facts ? "incomplete" : "STOP", gap: code,
    expected: EXPECTED_COUNTS, observed, casesMatched: matched, retentionMatched, bootstrapEligible: !!main.admission,
    privateExportComplete: privateComplete, clockQualifiedObservation: clockQualified, denominatorCompared: coverage !== null,
    producerFailed: !main.observation || main.observation.code !== 0 || main.observation.signal !== null,
    claims: Object.fromEntries(["nativeQualified", "exact100Qualified", "original38Qualified", "full49Qualified",
      "recordsQualified", "integrationQualified", "releaseQualified"].map((key) => [key, false])) })
  // Independent whole-byte readback after report finalization. A late gap does
  // not rewrite report or repair a failed/partial leaf into a later success.
  for (const [id, row] of s.leaves) {
    try {
      const exact = guardedFile(s.root, row.path, id <= 17 ? 2097152 : id <= 22 ? 4194304 : id === 23 ? 2097152 : 1048576)
      if (exact.length !== row.bytes || sha(exact) !== row.sha256) fail("artifact_digest")
    } catch (error) { latch(s, error, "artifact_digest"); s.leaves.delete(id) }
  }
  const metadata = Array.from({ length: 33 }, (_, i) => s.leaves.get(i + 1) ||
    unavailableLeaf(i + 1, s.unavailable?.get(i + 1) || "artifact_missing"))
  if (metadata.some((r) => r.presence !== "present")) latch(s, { code: "artifact_missing" })
  const payload = finalizeManifestPayload({ rows33: metadata, report: s.reportFinal ? s.reportPayload : null,
    privateRoles: rows, gaps: [...s.gaps] })
  emitManifest(ctx, payload, s.writerPermit)
  s.writerPermit = null
  return Object.freeze({ completeArtifact: payload.leafSetSha256 !== null, manifestFinalized: s.manifestFinal,
    reportFinalized: s.reportFinal, gap: payload.gaps[0] || "none" })
}
module.exports = { ALLOCATION_SHA, PRODUCT_BASE, SOURCE_PATHS, PUBLIC_LEAVES, EXCLUSIONS, MANIFEST_SELF_ROW,
  syntheticBaselineRecipe, validateSyntheticInput,
  fixtureLayout, projectFixtureManifest, projectPublicManifests, verifyPublicBundle,
  finalizeManifestPayload, createSupervisorEventReader, createProducerTracker, getPrivateRoleRegistry, modelCollectPrivateRoles,
  GAPS, binaryKeys, variants, canonicalLeafMetadata, computeLeafSetSha256, projectManifest, projectReport,
  projectCases, projectCase, projectClock, projectObserver, projectRuntime, runtimeIdentity, projectBuild, projectRetention, projectCoverage,
  projectUtility: utilityShape, coverageSeedsComplete, externalGitComponents,
  gitExecutionLayout, gitArguments, gitMountConfig, gitMsysPath, gitLookupCandidates, inspectGitExecution, projectGitBinding,
  projectGeneration: generationShape,
  foldCases, foldReceiptFacts, projectObservedCounts, projectControllerFacts, clockObservationComplete,
  validateBootstrap, guardedRoleRead, createModelContext, modelAudit, modelBootstrapDecision, mapPlanningProducer,
  createRetentionContext, buildPublicFixtures, launchProducer, observeProducer, admitBootstrap, collectPrivateRoles,
  runRetentionControls, runRetentionControlGroup, recordPrivateReadDelta, mainProducerGap, launchCoverageTools, exportSafeEvidence,
  emitNativeHeader, emitNativeLeaf, emitManifest }
