import { defineAction, defineActions, field } from "../lib/ouro-actions/ouro-actions.mts";

export const deskStatus = defineAction({
  id: "desk_status",
  consent: "write",
  label: "Desk status",
  description: "Check that Desk is ready for this session.",
  agent: "Session-start health check for the resolved desk root. The compact answer has `state` (ready, degraded, admitting or setup_required), `degraded` (why), `fix` (what to do in this session), `search`, `notes` and where the desk is. Retries admission when Desk is not ready. `detail: true` returns the full payload. A hosted Desk (claude.ai, ChatGPT) also returns its instructions, unless `has_instructions: true`; follow them and read the skills they name with desk_skill.",
  input: {
    detail: field.boolean({ label: "Full payload", description: "Pass true for the full payload (tens of KB). Omit it for the compact answer.", optional: true }),
    hasInstructions: field.boolean({ label: "Has instructions", description: "Hosted Desk only: pass true when an earlier desk_status answer in this conversation already gave you Desk's instructions.", optional: true, wire: "has_instructions" }),
  },
  output: {},
});

export const deskDoctor = defineAction({
  id: "desk_doctor",
  consent: "write",
  label: "Desk doctor",
  description: "Check Desk's runtime, and repair or reindex it when asked.",
  agent: "Use when Desk misbehaves or its runtime needs checking: report whether Desk MCP started in healthy runtime mode; in diagnostic mode, the precise startup failure and offline remediation. `format: \"preview\"` returns only the local package/process snapshot. `repair: \"switch_state_branch\"` switches the desk checkout back to its state branch when that is safe. `reindex: true` re-reads the desk into the search engine when search misses what you just wrote. `factory_consent` records the operator's factory contribution answer and returns only that record.",
  input: {
    format: field.enum({ label: "Format", description: "preview returns only the local package/process snapshot.", values: ["full", "preview"], optional: true }),
    repair: field.enum({ label: "Repair", description: "A named repair to run.", values: ["switch_state_branch"], optional: true }),
    reindex: field.boolean({ label: "Reindex", description: "Pass true to re-read the desk into this session's search engine and wait until exact-word search is current.", optional: true }),
    factoryConsent: field.enum({ label: "Factory consent", description: "The operator's answer to the factory contribution question; Desk resolves the store and, for yes, the GitHub account.", values: ["yes", "no"], optional: true, wire: "factory_consent" }),
  },
  output: {},
});

export const improvementNext = defineAction({
  id: "improvement_next",
  consent: "write",
  label: "Next improvement",
  description: "Take the next improvement card to work on.",
  agent: "Use when you take on improvement work: take the next improvement card, the open card that waited longest. It claims the card for a limited time and returns it with the `claim_id` and the authority statement. A refusal comes back as `status` (claim_held, cap_reached, none_open, too_many_cards, machine_key_unavailable or noninteractive) with a one-line `meaning`. Optional `session` is the session's UUID.",
  input: {
    session: field.string({ label: "Session", description: "The session's UUID, when known.", optional: true }),
  },
  output: {},
});

export default defineActions("desk-session", [deskStatus, deskDoctor, improvementNext], { tool: "desk" });
