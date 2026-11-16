"use strict";

// The refusal for a tool name that a server does not serve. It names the tools the server does serve, and the one served
// name that is a near match, so an agent that misremembers a name can retry without listing tools again.

const NEAR_DISTANCE = 3;

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

// A name within three edits, or one that contains a served name (or sits inside one) once it is at least three characters long.
function isNear(requested, served) {
  if (editDistance(requested, served) <= NEAR_DISTANCE) return true;
  return requested.length >= 3 && (requested.includes(served) || served.includes(requested));
}

function unknownToolMessage(name, served, toolsLabel) {
  const requested = String(name);
  const near = served
    .filter((tool) => isNear(requested, tool))
    .sort((a, b) => editDistance(requested, a) - editDistance(requested, b))[0];
  const hint = near ? ` Did you mean ${near}?` : "";
  return `unknown tool: ${requested}. ${toolsLabel} tools: ${served.join(", ")}.${hint}`;
}

module.exports = { unknownToolMessage };
