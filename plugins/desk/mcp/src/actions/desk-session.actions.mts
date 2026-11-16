import { defineAction, defineActions, field } from "../lib/ouro-actions/ouro-actions.mts";

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

export default defineActions("desk-session", [improvementNext], { tool: "desk" });
