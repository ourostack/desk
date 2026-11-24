#!/usr/bin/env node
// ax: read-only. It reads the PR body from stdin or a file and prints a verdict; it changes nothing.
"use strict";
const fs = require("node:fs");

// An Error carrying the stable `code` printed before its message.
const coded = (code, message, ErrorType = Error) => Object.assign(new ErrorType(message), { code });

function visibleBody(body) {
  let fence = null;
  return body.replace(/<!--[\s\S]*?(?:-->|$)/gu, "").split(/\r?\n/u).filter((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return false;
    }
    return !fence && !/^(?: {4}|\t)/u.test(line);
  }).join("\n").replace(/(`+)[\s\S]*?\1/gu, "");
}

// Temporary signed renderer URLs (private-user-images, jwt/token) expire in minutes; the canonical github.com/user-attachments/assets URL is the stored reference. GitHub blob/raw and tokenised URLs need the viewer's repository session, which mobile and chat clients often lack.
function authGatedGitHubUrl(url) {
  const host = url.hostname.toLowerCase();
  return host === "raw.githubusercontent.com" ||
    host.endsWith(".githubusercontent.com") && (url.searchParams.has("token") || url.searchParams.has("jwt")) ||
    host === "private-user-images.githubusercontent.com" ||
    (host === "github.com" || host === "www.github.com") && /^\/[^/]+\/[^/]+\/(?:blob|raw)\//iu.test(url.pathname);
}

function hostedImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !authGatedGitHubUrl(url) &&
      !/^(?:www\.)?example\.(?:com|org|net)$/iu.test(url.hostname) &&
      !/[<>{}]/u.test(value);
  } catch {
    return false;
  }
}

function checkVisualProof(body, visualChange = "unknown") {
  if (typeof body !== "string") throw coded("usage", "PR body must be a string", TypeError);
  if (!["yes", "no", "unknown"].includes(visualChange)) throw coded("usage", "--visual-change must be yes, no or unknown");
  const visible = visibleBody(body);
  const reasons = [...visible.matchAll(/^No visual change:[ \t]*(.+)$/gmu)].map((match) => match[1].trim());
  if (visualChange === "yes" && reasons.length) {
    return { ok: false, code: "visual-change-contradicts-reason", message: "A visible change cannot use No visual change; capture the changed surface with safe data." };
  }

  const inlineImage = [...visible.matchAll(/(?<!\\)!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:[ \t]+["'][^"\n]*["'])?\s*\)/gu)]
    .some((match) => hostedImage(match[1] ?? match[2]));
  const htmlImage = [...visible.matchAll(/(?<!\\)<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu)]
    .some(([tag]) => [...tag.slice(4, -1).matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu)]
      .some((attribute) => attribute[1].toLowerCase() === "src" && hostedImage(attribute[2] ?? attribute[3])));
  const references = new Map([...visible.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*<?(https:\/\/[^\s>]+)>?(?:[ \t]+.*)?$/gmu)]
    .map((match) => [match[1].trim().toLowerCase(), match[2]]));
  const referenceImage = [...visible.matchAll(/(?<!\\)!\[([^\]\n]+)\]\[([^\]\n]*)\]/gu)]
    .some((match) => hostedImage(references.get((match[2] || match[1]).trim().toLowerCase())));
  if (inlineImage || htmlImage || referenceImage) {
    return { ok: true, message: "Inline image present; review its rendered content, privacy and relevance before publication." };
  }
  const reason = reasons.find((value) => !/^(?:<|\[|todo\b|tbd\b|n\/a\b|none\b|reason\b)/iu.test(value) && value.split(/\s+/u).length >= 3);
  if (reason && visualChange !== "yes") {
    return { ok: true, message: "No visual change reason present; review its accuracy against the full diff before publication." };
  }
  return { ok: false, code: "no-visual-proof", message: "Add a real rendered capture as an inline image, or No visual change: <specific accurate reason> for nonvisual work. Links, comments and code examples do not count." };
}

function main(argv) {
  let source;
  let sourcePath;
  let visualChange = "unknown";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--stdin", "--body", "--event"].includes(arg)) {
      if (source) throw coded("usage", "Choose exactly one of --stdin, --body <file> or --event <file>");
      source = arg;
      if (arg !== "--stdin") {
        sourcePath = argv[++index];
        if (!sourcePath || sourcePath.startsWith("--")) throw coded("usage", `${arg} requires a file`);
      }
    } else if (arg === "--visual-change") {
      visualChange = argv[++index];
      if (!["yes", "no", "unknown"].includes(visualChange)) throw coded("usage", "--visual-change must be yes, no or unknown");
    } else {
      throw coded("usage", `Unknown argument: ${arg}`);
    }
  }
  if (!source) throw coded("usage", "Usage: node check-visual-proof.cjs (--stdin | --body <file> | --event <file>) [--visual-change yes|no|unknown]");
  let body = fs.readFileSync(source === "--stdin" ? 0 : sourcePath, "utf8");
  if (source === "--event") {
    const event = JSON.parse(body);
    if (!event.pull_request || !Object.hasOwn(event.pull_request, "body")) throw coded("bad-event", "Event must contain pull_request.body");
    body = event.pull_request.body ?? "";
  }
  const result = checkVisualProof(body, visualChange);
  if (result.ok) console.log(result.message);
  else console.error(`${result.code}: ${result.message}`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`${/^[a-z-]+$/u.test(error.code) ? error.code : "unreadable-input"}: Visual-proof check failed: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { checkVisualProof, main };
