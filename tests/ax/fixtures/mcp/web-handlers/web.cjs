// Shaped like desk-web: codes written in upper snake case, served lowercased (structuredContent.code).
var FAILURES = { AUTH_TIMEOUT: { thing: "browser command" } };
function fail(code) { return Object.assign(new Error(code + ": desk-web"), { code: code }); }
function answer(error) { return { structuredContent: { code: (error.code || "browser_failure").toLowerCase() }, isError: true }; }
function unknown() { return { structuredContent: { code: "unknown_door" }, isError: true }; }
module.exports = { FAILURES: FAILURES, fail: fail, answer: answer, unknown: unknown, refused: function () { return fail("COPY_SOURCE_POLICY"); } };
