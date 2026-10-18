// Import-only helpers: never launch a process or touch the filesystem.
export const PRODUCT_SELECTOR = "^runtime/windows_owned_git\\.test\\.js$"
export const PRODUCT_TEST_FILE = "runtime/windows_owned_git.test.js"
export const NATIVE_TEST_NAME = "native Windows owned-Git product admission"
const LIMIT = 1048576
export function captureProductEnvelope(startedNs) {
  if (typeof startedNs !== "bigint" || startedNs < 0n || startedNs > 18446743953709551615n) throw new Error("deadline")
  return Object.freeze({ startedNs, Hns: startedNs + 120000000000n })
}
export function productEnvelopeRemaining(envelope, nowNs) {
  if (typeof nowNs !== "bigint" || nowNs < envelope.startedNs) throw new Error("deadline")
  const remaining = envelope.Hns - nowNs
  return remaining > 0n ? Number((remaining + 999999n) / 1000000n) : 0
}
export function isOwnedGitProductSelection(only, mode) {
  return only === PRODUCT_SELECTOR && mode === "standard"
}
export function createProductTapCounter() {
  const streams = { stdout: { bytes: [], overflow: false }, stderr: { bytes: [], overflow: false } }
  let total = 0, invalid = false, ended = false, selected = 0, passed = 0, failed = 0, skipped = 0, plan = null
  const summary = new Map()
  function line(bytes, stream) {
    if (stream !== "stdout") return
    const text = Buffer.from(bytes).toString("utf8").replace(/\r$/, "")
    const result = /^(not )?ok ([1-9][0-9]*) - native Windows owned-Git product admission(.*)$/.exec(text)
    if (result) {
      selected++
      if (result[3] !== "" && !/^ # SKIP(?: .*)?$/.test(result[3])) invalid = true
      if (result[3] !== "") skipped++
      else if (result[1]) failed++
      else passed++
      return
    }
    const counts = /^# (tests|pass|fail|skipped) ([0-9]+)$/.exec(text)
    if (counts) {
      const value = Number(counts[2])
      if (!Number.isSafeInteger(value) || value > 15 || summary.has(counts[1])) invalid = true
      summary.set(counts[1], value)
      return
    }
    const planned = /^1\.\.([0-9]+)$/.exec(text)
    if (planned) { if (plan !== null) invalid = true; plan = Number(planned[1]); return }
    // All free-text diagnostics are discarded; no raw text leaves this closure.
    if (/^(?:not )?ok [0-9]+ - /.test(text) && !/^ok [0-9]+ - portable [^\r\n]+ # SKIP(?: .*)?$/.test(text)) invalid = true
  }
  return {
    push(chunk, stream = "stdout") {
      if (ended || !Buffer.isBuffer(chunk) || !Object.hasOwn(streams, stream)) { invalid = true; return }
      total += chunk.length
      if (!Number.isSafeInteger(total) || total > LIMIT) { invalid = true; return }
      const s = streams[stream]
      for (const byte of chunk) {
        if (byte === 10) {
          if (!s.overflow) line(s.bytes, stream)
          s.bytes = []; s.overflow = false
        } else if (!s.overflow) {
          if (s.bytes.length === 256) { s.bytes = []; s.overflow = true; invalid = true }
          else s.bytes.push(byte)
        }
      }
    },
    end() {
      if (ended) invalid = true
      ended = true
      if (Object.values(streams).some((s) => s.bytes.length || s.overflow)) invalid = true
      const filteredSummary = summary.get("tests") === 15 && summary.get("skipped") === 14
      const nativeSummary = summary.get("tests") === 1 && summary.get("skipped") === 0
      const valid = !invalid && selected === 1 && passed === 1 && failed === 0 && skipped === 0 &&
        (plan === 1 || plan === 15) && (filteredSummary || nativeSummary) &&
        summary.size === 4 && summary.get("pass") === 1 && summary.get("fail") === 0
      return Object.freeze({ valid, pass: passed, fail: failed, skipped, selected })
    },
  }
}
export function makeProductResult({ counts, exitCode, timedOut, bytes, ms, code }) {
  const numeric = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max
  const envelope = counts && numeric(counts.pass, 1) && numeric(counts.fail, 1) && numeric(counts.skipped, 1) &&
    numeric(bytes?.stdout) && numeric(bytes?.stderr) && numeric(ms, 120000) && typeof timedOut === "boolean"
  const ok = envelope && counts.valid === true && exitCode === 0 && !timedOut && code === "none"
  return {
    file: PRODUCT_TEST_FILE, exitCode: ok ? 0 : 1, timedOut: timedOut === true,
    ms: numeric(ms, 120000) ? ms : 120000,
    pass: envelope ? counts.pass : 0, fail: envelope ? counts.fail : 0, skipped: envelope ? counts.skipped : 0,
    failedTests: ok ? [] : [NATIVE_TEST_NAME], failures: [], stuck: "", tail: "", outputTail: "", firstFailures: "",
    product: { selected: 1, filtered: 14, code: ok ? "none" : timedOut ? "deadline" : "ci_envelope",
      stdoutBytes: numeric(bytes?.stdout) ? bytes.stdout : 0, stderrBytes: numeric(bytes?.stderr) ? bytes.stderr : 0 },
  }
}
