#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

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

function hostedImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !/^(?:www\.)?example\.(?:com|org|net)$/iu.test(url.hostname) &&
      !/[<>{}]/u.test(value);
  } catch {
    return false;
  }
}

function checkVisualProof(body, visualChange = "unknown") {
  if (typeof body !== "string") throw new TypeError("PR body must be a string");
  if (!["yes", "no", "unknown"].includes(visualChange)) throw new Error("--visual-change must be yes, no or unknown");
  const visible = visibleBody(body);
  const reasons = [...visible.matchAll(/^No visual change:[ \t]*(.+)$/gmu)].map((match) => match[1].trim());
  if (visualChange === "yes" && reasons.length) {
    return { ok: false, message: "A visible change cannot use No visual change; capture the changed surface with safe data." };
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
  return { ok: false, message: "Add a real rendered capture as an inline image, or No visual change: <specific accurate reason> for nonvisual work. Links, comments and code examples do not count." };
}

function main(argv) {
  let source;
  let sourcePath;
  let visualChange = "unknown";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--stdin", "--body", "--event"].includes(arg)) {
      if (source) throw new Error("Choose exactly one of --stdin, --body <file> or --event <file>");
      source = arg;
      if (arg !== "--stdin") {
        sourcePath = argv[++index];
        if (!sourcePath || sourcePath.startsWith("--")) throw new Error(`${arg} requires a file`);
      }
    } else if (arg === "--visual-change") {
      visualChange = argv[++index];
      if (!["yes", "no", "unknown"].includes(visualChange)) throw new Error("--visual-change must be yes, no or unknown");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!source) throw new Error("Usage: node check-visual-proof.cjs (--stdin | --body <file> | --event <file>) [--visual-change yes|no|unknown]");
  let body = fs.readFileSync(source === "--stdin" ? 0 : sourcePath, "utf8");
  if (source === "--event") {
    const event = JSON.parse(body);
    if (!event.pull_request || !Object.hasOwn(event.pull_request, "body")) throw new Error("Event must contain pull_request.body");
    body = event.pull_request.body ?? "";
  }
  const result = checkVisualProof(body, visualChange);
  (result.ok ? console.log : console.error)(result.message);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`Visual-proof check failed: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { checkVisualProof, main };
