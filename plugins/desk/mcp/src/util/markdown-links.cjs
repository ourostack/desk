"use strict";

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const URI_AUTOLINK = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\u0000-\u0020\u007f]*>/u;
const BLOCK_HTML_TAGS = new Set(
  ("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt " +
   "fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li " +
   "link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot " +
   "th thead title tr track ul").split(" "),
);

function htmlTag(text, at) {
  if (text[at] !== "<") return null;
  let cursor = at + 1;
  const closing = text[cursor] === "/";
  if (closing) cursor++;
  if (!/[A-Za-z]/u.test(text[cursor] ?? "")) return null;
  cursor++;
  while (/[A-Za-z0-9-]/u.test(text[cursor] ?? "")) cursor++;
  for (;;) {
    const previous = cursor;
    while (/[ \t\r\n]/u.test(text[cursor] ?? "")) cursor++;
    if (text[cursor] === ">") return cursor + 1;
    if (!closing && text[cursor] === "/" && text[cursor + 1] === ">") return cursor + 2;
    if (closing || cursor === previous || !/[A-Za-z_:]/u.test(text[cursor] ?? "")) return null;
    cursor++;
    while (/[A-Za-z0-9_.:-]/u.test(text[cursor] ?? "")) cursor++;
    const nameEnd = cursor;
    while (/[ \t\r\n]/u.test(text[cursor] ?? "")) cursor++;
    if (text[cursor] !== "=") { cursor = nameEnd; continue; }
    cursor++;
    while (/[ \t\r\n]/u.test(text[cursor] ?? "")) cursor++;
    const quote = text[cursor];
    if (quote === "'" || quote === '"') {
      cursor++;
      while (cursor < text.length && text[cursor] !== quote) cursor++;
      if (cursor === text.length) return null;
      cursor++;
    } else {
      const valueStart = cursor;
      while (cursor < text.length && !/[ \t\r\n"'=<>`]/u.test(text[cursor])) cursor++;
      if (cursor === valueStart) return null;
    }
  }
}

function decodeDestination(raw) {
  let value = "";
  const offsets = [];
  const issues = [];
  for (let index = 0; index < raw.length;) {
    if (raw[index] === "\\" && PUNCTUATION.test(raw[index + 1] ?? "")) {
      offsets.push(index);
      value += raw[index + 1];
      index += 2;
      continue;
    }
    if (raw[index] === "&") {
      const match = /^&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[a-zA-Z][a-zA-Z0-9]+);/u.exec(raw.slice(index));
      if (match) {
        let decoded;
        if (match[1].startsWith("#")) {
          const hex = /^#[xX]/u.test(match[1]);
          const number = Number.parseInt(match[1].slice(hex ? 2 : 1), hex ? 16 : 10);
          decoded = number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
            ? String.fromCodePoint(number) : "\ufffd";
        } else if (Object.hasOwn(ENTITIES, match[1])) decoded = ENTITIES[match[1]];
        if (decoded !== undefined) {
          for (let unit = 0; unit < decoded.length; unit++) offsets.push(index);
          value += decoded;
          index += match[0].length;
          continue;
        }
        issues.push({ code: "unsupported_entity", offset: index });
      }
    }
    offsets.push(index);
    value += raw[index++];
  }
  offsets.push(raw.length);
  return { value, offsets, issues };
}

/**
 * Spans index the original UTF-16 string. The default fold preserves the legacy
 * checker policy; consumers needing full Unicode folding supply their pure policy.
 */
function extractMarkdownLinks(text, { foldLabel = value => value.toLowerCase() } = {}) {
  if (typeof text !== "string") throw Object.assign(new TypeError("Pass a string to the Markdown extraction: Markdown extraction requires a string"), { code: "markdown_links.cjs_pass_a_string_to_the" });
  if (typeof foldLabel !== "function") throw Object.assign(new TypeError("Pass a function for the label folding: Markdown label folding requires a function"), { code: "markdown_links.cjs_pass_a_function_for_the" });
  const normalizeReferenceLabel = label => foldLabel(label.trim().replace(/\s+/gu, " "));
  const hidden = new Uint8Array(text.length);
  const escaped = new Uint8Array(text.length);
  let slashRun = 0;
  for (let index = 0; index < text.length; index++) {
    escaped[index] = slashRun % 2;
    slashRun = text[index] === "\\" ? slashRun + 1 : 0;
  }
  const lines = [];
  let offset = 0;
  for (const raw of text.split(/(?<=\n)/u)) {
    lines.push({ start: offset, end: offset + raw.length, text: raw.replace(/\r?\n$/u, "") });
    offset += raw.length;
  }
  const hide = (start, end) => hidden.fill(1, start, end);
  const diagnostics = [];
  const definitions = new Map();
  const inline = [];
  const inlineBlocks = [];
  let work = Math.max(256, text.length * 16);
  const limit = Object.assign(new Error("Use a smaller Markdown file: Markdown extraction work budget exceeded"), { code: "parse_budget_exceeded" });
  const tick = () => { if (--work < 0) throw limit; };
  const location = at => {
    let lo = 0, hi = lines.length;
    while (lo + 1 < hi) {
      const middle = (lo + hi) >> 1;
      if (lines[middle].start <= at) lo = middle; else hi = middle;
    }
    return { line: lo + 1, column: at - (lines[lo]?.start ?? 0) + 1 };
  };
  const beginning = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (beginning.startsWith("---\n") || beginning.startsWith("---\r\n")) {
    const close = lines.findIndex((line, index) => index > 0 && line.text === "---");
    if (close > 0 && /^\s*[A-Za-z_][\w-]*:/mu.test(text.slice(lines[1].start, lines[close].start)))
      hide(0, lines[close].end);
  }
  let fence = null;
  let html = null;
  let containers = [];
  let containerSequence = 0;
  let indented = false;
  let paragraph = false;
  let previousContainerKey = "";
  const thematic = content => /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u.test(content);
  const atx = content => /^ {0,3}#{1,6}(?:[ \t]|$)/u.test(content);
  const setext = content => /^ {0,3}(?:=+|-+)[ \t]*$/u.test(content);
  const fenceMarker = content => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(content);
    return match && !(match[1][0] === "`" && match[2].includes("`")) ? match : null;
  };
  function htmlBlock(content, contentStart, inParagraph) {
    const indent = /^ {0,3}/u.exec(content)[0].length;
    const body = content.slice(indent);
    if (/^<(?:pre|script|style|textarea)(?=[ \t>]|$)/iu.test(body))
      return /<\/(?:pre|script|style|textarea)>/iu;
    if (body.startsWith("<!--")) return /-->/u;
    if (body.startsWith("<?")) return /\?>/u;
    if (/^<![A-Za-z]/u.test(body)) return />/u;
    if (body.startsWith("<![CDATA[")) return /\]\]>/u;
    const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/u.exec(body)?.[1];
    if (name && BLOCK_HTML_TAGS.has(name.toLowerCase())) return null;
    if (!inParagraph) {
      const end = htmlTag(text, contentStart + indent);
      const newline = end === null ? -1 : text.indexOf("\n", end);
      if (end !== null && text.slice(end, newline === -1 ? text.length : newline).trim() === "") return null;
    }
    return undefined;
  }
  function listMarker(content, inParagraph) {
    if (thematic(content)) return null;
    const match = /^( {0,3})([-+*]|\d{1,9}[.)])( +|$)/u.exec(content);
    if (inParagraph && match && (/^\d/u.test(match[2]) && Number.parseInt(match[2], 10) !== 1 ||
        content.slice(match[0].length).trim() === "")) return null;
    return match;
  }
  function interrupts(content, start, inParagraph, pendingParagraph) {
    return thematic(content) || atx(content) || fenceMarker(content) !== null ||
      /^ {0,3}>/u.test(content) || listMarker(content, inParagraph) !== null ||
      htmlBlock(content, start, inParagraph || pendingParagraph) !== undefined;
  }
  function matchContainers(line, stack) {
    let cursor = 0;
    let matched = 0;
    for (const container of stack) {
      const rest = line.text.slice(cursor);
      if (container.kind === "quote") {
        const quote = /^ {0,3}>[ \t]?/u.exec(rest);
        if (!quote) break;
        cursor += quote[0].length;
      } else {
        const spaces = /^ */u.exec(rest)[0].length;
        if (spaces < container.indent && rest.trim() !== "") break;
        cursor += Math.min(spaces, container.indent);
      }
      matched++;
    }
    return { cursor, matched };
  }
  function containerPrefix(line, blockActive) {
    let { cursor, matched } = matchContainers(line, containers);
    const rest = line.text.slice(cursor);
    let inParagraph = paragraph && matched === containers.length;
    const lazy = matched < containers.length && paragraph && rest.trim() !== "" &&
      !interrupts(rest, line.start + cursor, inParagraph, paragraph);
    const current = lazy ? containers.slice() : containers.slice(0, matched);
    if (lazy) return { contentStart: line.start + cursor, content: rest,
      containerKey: current.map(container => container.id).join("/"), lazy };
    if (!blockActive || current.length !== containers.length) {
      for (;;) {
        const rest = line.text.slice(cursor);
        const quote = /^ {0,3}>[ \t]?/u.exec(rest);
        if (quote) {
          cursor += quote[0].length;
          current.push({ kind: "quote", id: ++containerSequence });
          inParagraph = false;
          continue;
        }
        const list = listMarker(rest, inParagraph);
        if (!list) break;
        const padding = list[3].length > 4 ? 1 : Math.max(1, list[3].length);
        const indent = list[1].length + list[2].length + padding;
        cursor += Math.min(indent, rest.length);
        current.push({ kind: "list", indent, id: ++containerSequence });
        inParagraph = false;
      }
    }
    containers = current;
    return { contentStart: line.start + cursor, content: line.text.slice(cursor),
      containerKey: current.map(container => container.id).join("/"), lazy };
  }
  function referenceDefinition(lineIndex, contentStart) {
    const origin = lines[lineIndex].start;
    const state = { origin, incomplete: false, contentStarts: new Map() };
    let input = "";
    let parsed = null;
    for (let index = lineIndex; index < lines.length; index++) {
      const line = lines[index];
      let start = contentStart;
      if (index !== lineIndex) {
        const { cursor, matched } = matchContainers(line, containers);
        start = line.start + cursor;
        const content = line.text.slice(cursor);
        if (hidden[line.start] || content.trim() === "" ||
            interrupts(content, start, matched === containers.length, true) ||
            setext(content)) break;
      }
      // Padded prefixes keep shared-reader spans losslessly translatable to the source.
      state.contentStarts.set(line.start - origin, start - origin);
      input += " ".repeat(start - line.start) + text.slice(start, line.end);
      state.incomplete = false;
      const leading = /^ {0,3}/u.exec(input.slice(contentStart - origin))[0].length;
      const name = label(contentStart - origin + leading, input, state);
      if (name && input[name.after] === ":" && normalizeReferenceLabel(name.raw) !== "") {
        const token = destination(name.after + 1, input, state);
        const end = token && (token.angle || token.end > token.start)
          ? finishDefinition(token.after, input, state) : null;
        parsed = end === null ? null : { key: normalizeReferenceLabel(name.raw),
          token: { ...token, start: token.start + origin, end: token.end + origin,
            after: token.after + origin }, end: end + origin };
      } else parsed = null;
      if (!state.incomplete) break;
    }
    return parsed;
  }
  function blocksAndMasks() {
    let currentInline = null;
    const recordInline = (line, contentStart) => {
      if (currentInline === null) {
        currentInline = { start: line.start, lines: [] };
        inlineBlocks.push(currentInline);
      }
      currentInline.lines.push({ ...line, contentStart });
    };
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (hidden[line.start]) continue;
      const { contentStart, content, containerKey, lazy } = containerPrefix(line, fence !== null || html !== null);
      const empty = content.trim() === "";
      const ended = block => block.containerKey !== containerKey;
      if (containerKey !== previousContainerKey) {
        paragraph = false;
        currentInline = null;
        indented = false;
      }
      previousContainerKey = containerKey;
      if (html && ended(html)) html = null;
      if (html) {
        if (html.end === null && empty) html = null;
        else {
          hide(line.start, line.end);
          if (html.end?.test(content)) html = null;
          paragraph = false;
          currentInline = null;
          continue;
        }
      }
      if (fence && ended(fence)) fence = null;
      if (fence !== null) {
        hide(line.start, line.end);
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(content);
        if (closing && closing[1][0] === fence.delimiter[0] &&
            closing[1].length >= fence.delimiter.length) fence = null;
        paragraph = false;
        currentInline = null;
        continue;
      }
      const marker = fenceMarker(content);
      if (marker) {
        fence = { delimiter: marker[1], containerKey };
        hide(line.start, line.end);
        paragraph = false;
        currentInline = null;
        continue;
      }
      const end = htmlBlock(content, contentStart, paragraph);
      if (end !== undefined) {
        hide(line.start, line.end);
        html = { end, containerKey };
        if (end?.test(content)) html = null;
        paragraph = false;
        currentInline = null;
        continue;
      }
      if (/^(?: {4}|\t)/u.test(content) && !paragraph) {
        hide(line.start, line.end);
        indented = true;
      } else if (empty && indented) hide(line.start, line.end);
      else indented = false;
      if (hidden[line.start] || empty) {
        paragraph = false;
        currentInline = null;
        continue;
      }
      if (atx(content)) {
        currentInline = null;
        recordInline(line, contentStart);
        paragraph = false;
        currentInline = null;
        continue;
      }
      if (thematic(content) || currentInline !== null && !lazy && setext(content)) {
        paragraph = false;
        currentInline = null;
        continue;
      }
      const leading = (paragraph ? /^[ \t]*/u : /^ {0,3}/u).exec(content)[0].length;
      const definitionStart = contentStart + leading;
      const definition = currentInline === null && text[definitionStart] === "["
        ? referenceDefinition(lineIndex, definitionStart) : null;
      if (definition) {
        hide(line.start, definition.end);
        while (lines[lineIndex + 1]?.start < definition.end) lineIndex++;
        if (!definitions.has(definition.key)) definitions.set(definition.key, { token: definition.token, uses: [] });
        // Consumed definitions leave the block paragraph pending without inline prose.
        paragraph = true;
        currentInline = null;
        continue;
      }
      recordInline(line, contentStart);
      paragraph = true;
    }
  }
  function inlineOpaqueEnd(input, index, origin) {
    if (input.startsWith("<!--", index)) {
      if (input.startsWith("<!-->", index)) return index + 5;
      if (input.startsWith("<!--->", index)) return index + 6;
      const close = input.indexOf("-->", index + 4);
      return close === -1 ? null : close + 3;
    }
    if (input[index] === "<") {
      const autolink = URI_AUTOLINK.exec(input.slice(index));
      if (autolink !== null) return index + autolink[0].length;
      return htmlTag(input, index);
    }
    if (input[index] !== "`") return null;
    let end = index + 1;
    while (input[end] === "`") end++;
    const delimiter = input.slice(index, end);
    let close = input.indexOf(delimiter, end);
    while (close !== -1 && (hidden[close + origin] || input[close - 1] === "`" ||
      input[close + delimiter.length] === "`")) close = input.indexOf(delimiter, close + delimiter.length);
    // An unmatched run is literal, not a new opener at each shorter suffix.
    return close !== -1 && !/\r?\n[ \t]*\r?\n/u.test(input.slice(end, close))
      ? close + delimiter.length : end;
  }

  function label(at, input = text, state = null) {
    const origin = state?.origin ?? 0;
    if (input[at] !== "[" || escaped[at + origin]) return null;
    for (let cursor = at + 1; cursor < input.length; cursor++) {
      tick();
      if (!escaped[cursor + origin] && input[cursor] === "[") return null;
      if (!escaped[cursor + origin] && input[cursor] === "]") {
        const raw = input.slice(at + 1, cursor);
        return raw.length <= 999 ? { raw, after: cursor + 1 } : null;
      }
    }
    if (state) state.incomplete = true;
    return null;
  }
  function whitespace(at, input = text, state = null) {
    let newlines = 0;
    while (at < input.length && /[ \t\r\n]/u.test(input[at])) {
      tick();
      if (input[at] === "\n" && ++newlines > 1) return null;
      at++;
    }
    if (state && at === input.length) state.incomplete = true;
    return at;
  }
  function destination(at, input = text, state = null) {
    const origin = state?.origin ?? 0;
    at = whitespace(at, input, state);
    if (at === null) return null;
    if (input[at] === "<") {
      const start = at + 1;
      for (let cursor = start; cursor < input.length; cursor++) {
        tick();
        if (!escaped[cursor + origin] && input[cursor] === ">")
          return { start, end: cursor, after: cursor + 1, angle: true };
        if (/[\r\n]/u.test(input[cursor]) || !escaped[cursor + origin] && input[cursor] === "<") return null;
      }
      if (state) state.incomplete = true;
      return null;
    }
    const start = at;
    let depth = 0;
    for (; at < input.length; at++) {
      tick();
      const char = input[at];
      if (escaped[at + origin] && PUNCTUATION.test(char)) continue;
      if (char === "(") depth++;
      else if (char === ")") { if (depth === 0) break; depth--; }
      else if (/[\u0000-\u0020]/u.test(char)) break;
    }
    if (state && at === input.length && depth > 0) state.incomplete = true;
    return depth === 0 ? { start, end: at, after: at, angle: false } : null;
  }
  function title(at, input = text, state = null) {
    const origin = state?.origin ?? 0;
    const opening = input[at];
    if (!['"', "'", "("].includes(opening)) return null;
    const closing = opening === "(" ? ")" : opening;
    for (let cursor = at + 1; cursor < input.length; cursor++) {
      tick();
      if (escaped[cursor + origin]) continue;
      if (input[cursor] === closing) return cursor + 1;
      if (opening === "(" && input[cursor] === "(" ||
          input[cursor] === "\n" && /^[ \t]*\r?\n/u.test(input.slice(cursor + 1))) return null;
    }
    if (state) state.incomplete = true;
    return null;
  }
  function node(token, form, uses) {
    const raw = text.slice(token.start, token.end);
    const decoded = decodeDestination(raw);
    for (const issue of decoded.issues)
      diagnostics.push({ code: issue.code, start: token.start + issue.offset, end: token.end,
        ...location(token.start + issue.offset) });
    return { start: token.start, end: token.end, raw, destination: decoded.value,
      decodedOffsets: decoded.offsets, form, angle: token.angle, ...location(token.start), uses };
  }
  function lineEnd(at, input = text) {
    const newline = input.indexOf("\n", at);
    return newline === -1 ? input.length : newline + 1;
  }
  function finishDefinition(at, input = text, state = null) {
    const afterDestination = at;
    while (input[at] === " " || input[at] === "\t") { tick(); at++; }
    if (input[at] === "\r") at++;
    let fallback = null;
    if (input[at] === "\n" || at === input.length) {
      fallback = lineEnd(at, input);
      if (fallback >= input.length) {
        if (state) state.incomplete = true;
        return fallback;
      }
      at = state?.contentStarts.get(fallback) ?? fallback;
      while (input[at] === " " || input[at] === "\t") { tick(); at++; }
      if (!['"', "'", "("].includes(input[at])) return fallback;
    }
    if (at === afterDestination) return null;
    const end = title(at, input, state);
    if (end === null) return fallback;
    at = end;
    while (input[at] === " " || input[at] === "\t") { tick(); at++; }
    if (input[at] === "\r") at++;
    return input[at] === "\n" || at === input.length ? lineEnd(at, input) : fallback;
  }
  function inlineDestination(at, input, state) {
    const token = destination(at + 1, input, state);
    if (!token) return null;
    let close = whitespace(token.after, input, state);
    if (close === null) return null;
    if (input[close] !== ")" && close > token.after) {
      const afterTitle = title(close, input, state);
      if (afterTitle === null) return null;
      close = whitespace(afterTitle, input, state);
    }
    return close !== null && input[close] === ")" ? { token, after: close + 1 } : null;
  }
  try {
    blocksAndMasks();
    for (const block of inlineBlocks) {
      const origin = block.start;
      const state = { origin };
      const input = block.lines.map(line => " ".repeat(line.contentStart - line.start) +
        text.slice(line.contentStart, line.end)).join("");
      const stack = [];
      for (let index = 0; index < input.length; index++) {
        tick();
        if (hidden[index + origin] || escaped[index + origin]) continue;
        const opaqueEnd = inlineOpaqueEnd(input, index, origin);
        if (opaqueEnd !== null) {
          hide(index + origin, opaqueEnd + origin);
          index = opaqueEnd - 1;
          continue;
        }
        if (input[index] === "[") {
          const image = index > 0 && input[index - 1] === "!" && !escaped[index - 1 + origin];
          stack.push({ start: index, image, containsLink: false });
          continue;
        }
        if (input[index] !== "]" || stack.length === 0) continue;
        const open = stack.pop();
        if (open.containsLink) continue;
        const kind = open.image ? "image" : "link";
        const useStart = open.start - (open.image ? 1 : 0) + origin;
        const inner = input.slice(open.start + 1, index);
        const parsed = input[index + 1] === "(" ? inlineDestination(index + 1, input, state) : null;
        if (parsed) {
          const token = { ...parsed.token, start: parsed.token.start + origin,
            end: parsed.token.end + origin, after: parsed.token.after + origin };
          inline.push(node(token, "inline", [{ kind, syntax: "inline", start: useStart, end: parsed.after + origin }]));
          if (!open.image) for (const ancestor of stack) ancestor.containsLink = true;
          index = parsed.after - 1;
          continue;
        }
        const explicit = label(index + 1, input, state);
        const key = explicit ? normalizeReferenceLabel(explicit.raw || inner) : normalizeReferenceLabel(inner);
        const definition = definitions.get(key);
        if (!definition) {
          if (explicit) {
            const fallback = definitions.get(normalizeReferenceLabel(inner));
            if (fallback) fallback.uses.push({ kind, syntax: "shortcut", start: useStart, end: index + 1 + origin });
          }
          continue;
        }
        definition.uses.push({ kind, syntax: explicit ? explicit.raw === "" ? "collapsed" : "full" : "shortcut",
          start: useStart, end: (explicit ? explicit.after : index + 1) + origin });
        if (!open.image) for (const ancestor of stack) ancestor.containsLink = true;
        if (explicit) index = explicit.after - 1;
      }
    }
  } catch (error) {
    if (error !== limit) throw error;
    diagnostics.push({ code: error.code, start: 0, end: text.length, line: 1, column: 1 });
  }
  const references = [...definitions.values()].filter(value => value.uses.length > 0)
    .map(value => node(value.token, "definition", value.uses));
  return { links: [...inline, ...references].sort((left, right) => left.start - right.start), diagnostics };
}

module.exports = { extractMarkdownLinks };
