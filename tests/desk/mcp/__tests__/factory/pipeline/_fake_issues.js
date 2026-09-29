// An in-memory store for the issue steps (kaizen check, andon): implements
// the `issuesClient` interface from `src/factory/store-issues.js` over a
// small model of issues and comments. Nothing here reaches the network.

import "../../_isolated_env.mjs"

export const BOT = "github-actions[bot]"

export function fakeIssues({ issues = [], comments = {}, author = BOT } = {}) {
  const model = issues.map((issue) => ({ state: "open", author, pull_request: false, ...issue, labels: [...issue.labels] }))
  const threads = new Map(Object.entries(comments).map(([number, list]) => [Number(number), list.map((comment, index) => ({ id: Number(number) * 1000 + index, author: comment.user, body: comment.body }))]))
  let nextComment = 1
  let writes = 0
  const find = (number) => model.find((issue) => issue.number === number)
  const view = (issue) => ({ number: issue.number, title: issue.title, body: issue.body, labels: [...issue.labels], state: issue.state, ...(issue.state_reason === undefined ? {} : { state_reason: issue.state_reason }), author: issue.author, pull_request: issue.pull_request })

  const client = {
    async listIssues({ label, state }) {
      return model.filter((issue) => issue.labels.includes(label) && (state === "all" || issue.state === state)).map(view)
    },
    async listComments(number) {
      return (threads.get(number) ?? []).map((comment) => ({ ...comment }))
    },
    async createComment(number, body) {
      writes += 1
      if (!threads.has(number)) threads.set(number, [])
      threads.get(number).push({ id: nextComment++, author: BOT, body })
    },
    async updateComment(id, body) {
      writes += 1
      for (const list of threads.values()) for (const comment of list) if (comment.id === id) comment.body = body
    },
    async addLabels(number, labels) {
      writes += 1
      const issue = find(number)
      for (const label of labels) if (!issue.labels.includes(label)) issue.labels.push(label)
    },
    async removeLabel(number, label) {
      writes += 1
      const issue = find(number)
      issue.labels = issue.labels.filter((name) => name !== label)
    },
    async createIssue({ title, body, labels }) {
      writes += 1
      const number = model.reduce((max, issue) => Math.max(max, issue.number), 0) + 1
      model.push({ number, title, body, labels: [...labels], state: "open", author: BOT, pull_request: false })
      return { number }
    },
    async updateIssue(number, patch) {
      writes += 1
      Object.assign(find(number), patch)
    },
  }

  return {
    client,
    issue: (number) => view(find(number)),
    issues: () => model.map(view),
    comments: (number) => threads.get(number) ?? [],
    botComments: (number) => (threads.get(number) ?? []).filter((comment) => comment.author === BOT),
    writes: () => writes,
  }
}
