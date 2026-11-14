// The operator's answer about contributing to the factory store, recorded by `desk_doctor`'s `factory_consent` and `factory_told` inputs.
//
// The agent passes only the answer. Desk picks the store the boot named and, for a yes, the signed-in GitHub account that can open the intake pull
// requests there (`chooseAccount`), so no agent runs a script or looks an account up. The answer lands in the same files `factory.js consent` writes
// (`consent.json` and the mentioned record), which stays for people who prefer a shell.
//
// Only an undecided store takes an answer: a recorded yes or no is the operator's decision and an agent never overwrites it.

import { chooseAccount, ghRunner } from "./flush.js"
import { setConsent } from "./outbox.js"
import { factoryStatus } from "../tools/factory-context.js"
import { noteConsentMentioned } from "../runtime/consent-mentioned.js"
import { resolveDeskStateDir } from "../runtime/last-start.js"

export const FACTORY_CONSENT_ANSWERS = Object.freeze(["yes", "no"])

const NO_ACCOUNT_FIX = (store) => `Do not record it. Tell the operator in one line that no signed-in GitHub account can open pull requests on ${store}, giving each account's reason from \`accounts\`, and that signing in a personal account with \`gh auth login\` lets a later session ask.`

/**
 * Records the answer and returns a JSON-ready result: `{ status: "recorded", store, ... }`, `{ status: "not_recorded", ... }` for a yes with no account that
 * can deliver, or `{ status: "refused", code, ... }`. Throws only when a file cannot be written.
 *
 * `answer` is "yes" or "no"; `told` records that the operator was told about the store and is a separate call. `runner` asks gh, for tests.
 */
export async function answerFactoryConsent({ env, deskRoot = null, answer, told = false, runner = undefined }) {
  if (answer !== undefined && !FACTORY_CONSENT_ANSWERS.includes(answer)) return { status: "refused", code: "factory_consent_not_yes_or_no", fix: "Pass factory_consent as yes or no." }
  if (answer !== undefined && told) return { status: "refused", code: "factory_consent_one_answer_per_call", fix: "Pass factory_consent or factory_told, not both." }
  const { store, consent } = factoryStatus({ env, deskRoot, signoff: false })
  if (store === null) return { status: "refused", code: "factory_no_store", fix: "This session resolves no factory store, so there is nothing to answer. Do not ask the operator." }
  if (consent !== "undecided") return { status: "refused", code: "factory_already_decided", store, consent, fix: "This store's decision is already recorded. Do not ask the operator again." }
  if (told) return recordTold(env, store)
  if (answer === "no") return recorded(store, await setConsent(env, { store, contribute: false }))
  const found = await chooseAccount({ store, runner: runner ?? ghRunner({ env }) })
  if (found.result !== "account_found") return { status: "not_recorded", store, result: found.result, ...(Array.isArray(found.accounts) ? { accounts: found.accounts } : {}), fix: NO_ACCOUNT_FIX(store) }
  return recorded(store, await setConsent(env, { store, contribute: true, account: found.account }), found.account)
}

function recordTold(env, store) {
  noteConsentMentioned(resolveDeskStateDir({ env }), store)
  return { status: "recorded", store, told: true }
}

function recorded(store, consent, account) {
  const entry = consent.stores[store]
  return { status: "recorded", store, contribute: entry.contribute, ...(account === undefined ? {} : { account }) }
}
