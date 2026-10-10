import { test } from "node:test";
import assert from "node:assert/strict";
import { createRedirectPolicy } from "../src/auth/redirects.js";

const CLAUDE_AI = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_COM = "https://claude.com/api/mcp/auth_callback";

test("unset, the policy allows Claude's two callbacks and nothing else of theirs", () => {
  const policy = createRedirectPolicy(undefined);
  assert.equal(policy.allows(CLAUDE_AI), true);
  assert.equal(policy.allows(CLAUDE_COM), true);
  assert.equal(policy.allows("https://claude.ai/api/mcp/other"), false);
  assert.equal(policy.allows("http://claude.ai/api/mcp/auth_callback"), false);
  assert.equal(policy.allows("https://evil.example/cb"), false);
});

test("a blank DESK_REDIRECTS is treated as unset", () => {
  for (const value of ["", " ", " , "]) assert.equal(createRedirectPolicy(value).allows(CLAUDE_AI), true, JSON.stringify(value));
});

test("configured URLs are allowed exactly, and replace the defaults", () => {
  const policy = createRedirectPolicy(` https://vscode.dev/redirect , ${CLAUDE_AI}`);
  assert.equal(policy.allows("https://vscode.dev/redirect"), true);
  assert.equal(policy.allows(CLAUDE_AI), true);
  assert.equal(policy.allows(CLAUDE_COM), false, "a default left out of the list is no longer allowed");
  for (const near of [
    "https://vscode.dev/redirect/",
    `${CLAUDE_AI}/`,
    "https://vscode.dev/redirect?x=1",
    "https://vscode.dev/redirect#f",
    "https://VSCODE.dev/redirect",
    "https://vscode.dev:443/redirect",
  ]) {
    assert.equal(policy.allows(near), false, near);
  }
});

test("a configured entry that is not an absolute URL stops the gateway at start", () => {
  assert.throws(() => createRedirectPolicy(`${CLAUDE_AI},not a url`), /DESK_REDIRECTS.*not a url/);
});

test("loopback over http is allowed on any port and path", () => {
  const policy = createRedirectPolicy(undefined);
  for (const uri of [
    "http://localhost/",
    "http://localhost:6274/oauth/callback",
    "http://127.0.0.1:33418/callback",
    "http://127.0.0.1/any/path?q=1",
  ]) {
    assert.equal(policy.allows(uri), true, uri);
  }
});

test("loopback is refused over https, with user info, or by another name", () => {
  const policy = createRedirectPolicy(undefined);
  for (const uri of [
    "https://localhost/",
    "https://127.0.0.1:8080/cb",
    "http://user@localhost/",
    "http://user:pass@127.0.0.1:9/cb",
    "http://localhost.evil.example/cb",
    "http://127.0.0.2/cb",
  ]) {
    assert.equal(policy.allows(uri), false, uri);
  }
});

test("ChatGPT's per-connector callback is allowed with exactly one plain segment", () => {
  const policy = createRedirectPolicy(undefined);
  assert.equal(policy.allows("https://chatgpt.com/connector/oauth/abc_DEF-123"), true);
  for (const uri of [
    "https://chatgpt.com/connector/oauth/a/b",
    "https://chatgpt.com/connector/oauth/",
    "https://chatgpt.com/connector/oauth",
    "https://chatgpt.com/connector/oauth/a?x=1",
    "https://chatgpt.com/connector/oauth/a#f",
    "https://chatgpt.com/connector/oauth/%2e%2e",
    "https://chatgpt.com/connector/oauth/a.b",
    "http://chatgpt.com/connector/oauth/abc",
    "https://chatgpt.com.evil.example/connector/oauth/abc",
    "https://user@chatgpt.com/connector/oauth/abc",
    "https://chatgpt.com:443/connector/oauth/abc",
    "https://chatgpt.com/connector/oauth/abc\n",
  ]) {
    assert.equal(policy.allows(uri), false, JSON.stringify(uri));
  }
});

test("an unparseable or non-string redirect is refused", () => {
  const policy = createRedirectPolicy(undefined);
  for (const uri of ["not a url", "", "http://", undefined, null, 42]) assert.equal(policy.allows(uri), false, String(uri));
});
