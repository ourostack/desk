// Test setup: binds `job` to the outbox file `name` in the local jobs index without disturbing the file's other jobs.
import { readJobsIndex, setJobsForFile } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"

export async function indexJob(env, job, name) {
  const index = await readJobsIndex(env)
  const jobs = Object.keys(index).filter((other) => index[other].includes(name))
  return setJobsForFile(env, name, jobs.includes(job) ? jobs : [...jobs, job])
}
