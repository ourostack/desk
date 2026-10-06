// The store-wide human attention figures: the headline (estimated attention over accepted outcomes), the raw turn count over the same denominator, where the estimate was placed, how many sessions are in the period, and the permission decisions beside it. Pure functions of published sessions.
//
// The period is the sessions whose facts carry `human_turns` or flag it. A session from before the record (no list, no flag) is outside it and never makes a figure partial. A session in the period that flags the field makes the figures partial, with the reason the host gave. Every figure carries `state` and `reasons`, and `value` is absent when it is unavailable: a zero never stands for no data.

import { estimatePermission, methodRecord, placeTurns } from "./attention.js"

const DESK_PLUGIN = "desk"

const compareText = (left, right) => Number(left > right) - Number(left < right)
const sortedUnique = (list) => [...new Set(list)].sort(compareText)
const flagsOn = (session, field) => (session.unavailable ?? []).filter((entry) => entry.field === field).map((entry) => entry.reason)

/**
 * `sessionVersion(session) -> version`: the desk plugin version a session reports, `mixed` when it reports several and `unknown` when it reports none. For a job of one session this is the job rollups' `plugin_version` (`rollups.js` `pluginVersion`); a test holds the two together.
 */
export function sessionVersion(session) {
  const versions = new Set(session.plugins.filter((plugin) => plugin.name === DESK_PLUGIN).map((plugin) => plugin.version))
  if (versions.size === 0) return "unknown"
  return versions.size === 1 ? [...versions][0] : "mixed"
}

// A session is in the period when it records the list or says why it does not.
const inPeriod = (session) => Array.isArray(session.human_turns) || flagsOn(session, "human_turns").length > 0

// The reasons a session gives the figures: a list cut to a size limit is `turns_capped` alone; any other flag is passed through as the host gave it, beside `turns_not_recorded` (the list is missing or not proven whole).
function turnReasons(placed, flags) {
  const named = flags.map((flag) => (flag === "capped" ? "turns_capped" : flag))
  return placed.recorded && flags.every((flag) => flag === "capped") ? named : ["turns_not_recorded", ...named]
}

const blank = () => ({ turns: 0, estimated: 0, unestimated: 0, est: { attributed: 0, unattributed: 0, unplaced: 0 }, countReasons: new Set(), timeReasons: new Set(), touched: 0, listed: 0 })

function add(group, part) {
  group.turns += part.turns
  group.unestimated += part.unestimated
  group.estimated += part.estimated
  for (const key of Object.keys(group.est)) group.est[key] += part.est[key]
}

const partOf = (bucket, place) => ({ turns: bucket.turns, unestimated: bucket.unestimated, estimated: bucket.est_ms, est: { attributed: 0, unattributed: 0, unplaced: 0, [place]: bucket.est_ms } })

// What a group can say about the human turns. With no list in the period there is no time and no count, and they are left out, never published as zeros. Reasons say why: the host's flags and what was not recorded or not estimable, beside `no_accepted_outcomes` when that also holds. Time is also unknown when every turn is broken.
function knownOf(group) {
  return { counted: group.listed > 0, timed: group.listed > 0 && !(group.turns > 0 && group.unestimated === group.turns) }
}
const whyOf = (group, reasons) => (group.touched === 0 ? ["no_turn_records"] : reasons)

// The headline over `accepted` acceptances. A numerator that is only a lower bound keeps its reasons even when there is nothing to divide it by.
function headlineOf(group, accepted) {
  const { timed } = knownOf(group)
  const noAccepted = accepted === 0 ? ["no_accepted_outcomes"] : []
  const reasons = sortedUnique([...noAccepted, ...whyOf(group, [...group.countReasons, ...group.timeReasons])])
  const numerator = timed ? { numerator_ms: group.estimated } : {}
  const counts = { n: accepted, N: accepted }
  if (accepted === 0 || !timed) return { state: "unavailable", reasons, ...counts, ...numerator, accepted_outcomes: accepted }
  return { state: reasons.length === 0 ? "measured" : "partial", value: group.estimated / accepted, reasons, ...counts, ...numerator, accepted_outcomes: accepted }
}

function turnsPerAcceptedOf(group, accepted) {
  const { counted } = knownOf(group)
  const noAccepted = accepted === 0 ? ["no_accepted_outcomes"] : []
  const reasons = sortedUnique([...noAccepted, ...whyOf(group, [...group.countReasons])])
  const counts = { n: accepted, N: accepted }
  if (accepted === 0 || !counted) return { state: "unavailable", reasons, ...counts }
  return { state: reasons.length === 0 ? "measured" : "partial", value: group.turns / accepted, reasons, ...counts }
}

const groupFigures = (group, accepted) => ({
  headline: headlineOf(group, accepted),
  turns_per_accepted: turnsPerAcceptedOf(group, accepted),
  ...(group.listed > 0 ? { human_turns: group.turns } : {}),
  ...(knownOf(group).timed ? { est_ms: { ...group.est } } : {}),
})

// Permission decisions, where the host records them. The estimate is `estimatePermission` of each wait and is reported beside the headline, not in it. A session whose host does not record them gives nothing, and a store where none does says so.
function permissionOf(sessions) {
  const reasons = []
  let recorded = 0
  let decisions = 0
  let estimated = 0
  for (const session of sessions) {
    const flags = flagsOn(session, "permission_waits")
    if (flags.includes("host_does_not_record") || flags.includes("field_absent")) {
      reasons.push(...flags)
      continue
    }
    recorded += 1
    reasons.push(...flags)
    for (const interval of (session.intervals ?? []).filter((entry) => entry.kind === "permission_wait")) {
      decisions += 1
      try {
        estimated += estimatePermission(interval.end_ms - interval.start_ms)
      } catch {
        reasons.push("decision_not_estimable")
      }
    }
  }
  if (sessions.length === 0) return { state: "unavailable", reasons: ["no_sessions"] }
  if (recorded === 0) return { state: "unavailable", reasons: sortedUnique(reasons) }
  const stated = sortedUnique(reasons)
  return { state: stated.length === 0 ? "measured" : "partial", decisions, est_ms: estimated, reasons: stated }
}

/**
 * `attentionRollups({ sessions, groupOfJob, groupKeys, acceptedByGroup, accepted }) -> { attention, groups }`: `attention` is the store-wide figure set of `rollups/outcomes.json`; `groups` maps each plugin version group to `{ headline, turns_per_accepted, human_turns, est_ms }`, which add up to the overall figures (the sessions and permission figures are not additive across groups, so a group has neither).
 *
 * With no list recorded in the period (or in a group), `human_turns`, `est_ms` and the headline's `numerator_ms` are left out, and the reasons say why: a zero would read as no attention where nothing was recorded.
 *
 * A job's attributed attention goes to the group of the job (`groupOfJob`, the job rollups' version key, `mixed` included; `groupKeys` lists the groups that have a job, so each has a figure even with no turn); attention on no job or on a session with unplaced jobs goes to the group of the session's own version. A session's reasons apply to every group it gives attention to or has a job in, so a group never reads whole beside a session that could not say.
 * `accepted` and `acceptedByGroup` count every acceptance (recorded by the agent on the operator's word); the caller takes both from the sign-off count, so the headline and the sign-off cannot disagree.
 */
export function attentionRollups({ sessions, groupOfJob, groupKeys, acceptedByGroup, accepted }) {
  const total = blank()
  const groups = new Map()
  const groupFor = (key) => {
    if (!groups.has(key)) groups.set(key, blank())
    return groups.get(key)
  }
  for (const key of [...groupKeys, ...acceptedByGroup.keys()]) groupFor(key)
  let period = 0
  let complete = 0
  for (const session of sessions.filter(inPeriod)) {
    const flags = flagsOn(session, "human_turns")
    const placed = placeTurns(session)
    const own = groupFor(sessionVersion(session))
    const touched = new Set([own, ...session.jobs.map((binding) => groupFor(groupOfJob(binding.job)))])
    const countReasons = turnReasons(placed, flags)
    const timeReasons = placed.unestimated > 0 ? ["turn_not_estimable"] : []
    period += 1
    if (countReasons.length === 0 && timeReasons.length === 0) complete += 1
    for (const group of [total, ...touched]) {
      group.touched += 1
      if (placed.recorded) group.listed += 1
      for (const reason of countReasons) group.countReasons.add(reason)
      for (const reason of timeReasons) group.timeReasons.add(reason)
    }
    for (const [job, bucket] of placed.byJob) {
      const part = partOf(bucket, "attributed")
      add(total, part)
      add(groupFor(groupOfJob(job)), part)
    }
    for (const [bucket, place] of [[placed.unattributed, "unattributed"], [placed.unplaced, "unplaced"]]) {
      const part = partOf(bucket, place)
      add(total, part)
      add(own, part)
    }
  }
  const figures = groupFigures(total, accepted)
  return {
    attention: {
      method: methodRecord(),
      ...figures,
      sessions: { in_period: period, complete },
      permission: permissionOf(sessions),
    },
    groups: new Map([...groups].sort(([left], [right]) => compareText(left, right)).map(([key, group]) => [key, groupFigures(group, acceptedByGroup.get(key) ?? 0)])),
  }
}
