import { defineAction, field } from "../lib/ouro-actions/ouro-actions.mts";

const SCOPE = field.enum({
  label: "Scope",
  description: "Which documents to search: live work, archived work, or both.",
  values: ["active", "archived", "all"],
  optional: true,
});

const oneOrMany = (label: string, description: string) => field.oneOf({
  label,
  description,
  combinator: "anyOf",
  optional: true,
  options: [
    field.string({ label, description }),
    field.list({ label, description, of: field.string({ label, description }) }),
  ],
});

export const deskSearch = defineAction({
  id: "desk_search",
  consent: "read",
  label: "Search the desk",
  description: "Find documents on the desk by their exact words.",
  agent: "Use when you cannot tell which file holds something, or what changed in a time window. Exact-word search across the desk. Filters: track, status, kind, since, until. `scope`: 'active' (default), 'archived' or 'all'. With no `query`, or `newest: true`, it lists documents by when they were updated, newest first, inside the since/until window (`scope` then defaults to 'all').",
  input: {
    query: field.string({ label: "Query", description: "The search query. Omit it to list documents by update time.", optional: true }),
    newest: field.boolean({ label: "Newest first", description: "Pass true to order by update time, newest first, instead of by match.", optional: true }),
    limit: field.integer({ label: "Limit", description: "Maximum number of results.", optional: true, min: 1 }),
    scope: SCOPE,
    filters: field.group({
      label: "Filters",
      description: "Filters, as a JSON object (not a string).",
      optional: true,
      protocolOnly: true,
      fields: {
        track: oneOrMany("Track", "Track name or names."),
        status: oneOrMany("Status", "Task status or statuses."),
        kind: oneOrMany("Kind", "Document kind or kinds."),
        since: field.string({ label: "Since", description: "Only documents updated at or after this time (ISO 8601).", optional: true }),
        until: field.string({ label: "Until", description: "Only documents updated at or before this time (ISO 8601).", optional: true }),
      },
    }),
  },
  output: {},
});

export const deskRecall = defineAction({
  id: "desk_recall",
  consent: "read",
  label: "Recall",
  description: "Recall what the desk says about a topic.",
  agent: "Use for loose recall, as in `do I remember anything about X`. Ranks every desk Markdown file by meaning and exact words together. `scope`: 'active', 'archived' or 'all' (default; this is the historical lookback).",
  input: {
    topic: field.string({ label: "Topic", description: "What to recall." }),
    limit: field.integer({ label: "Limit", description: "Maximum number of results.", optional: true, min: 1 }),
    scope: SCOPE,
  },
  output: {},
});

export const deskSkill = defineAction({
  id: "desk_skill",
  consent: "read",
  label: "Read a skill",
  description: "Read one of Desk's skills, or list them.",
  agent: "Use when your client cannot load Desk's skills itself (claude.ai, ChatGPT): read one of Desk's skills, the working procedures its instructions point to. With no `name`, lists every skill with its description; with `name`, returns that skill's text to follow. Read-only and needs no desk.",
  input: {
    name: field.string({ label: "Skill", description: "The skill to read, such as task-lifecycle; omit it to list every skill.", optional: true }),
  },
  output: {},
});
