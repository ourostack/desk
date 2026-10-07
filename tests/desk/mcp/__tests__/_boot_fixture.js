import { fileURLToPath } from "node:url"

const PRELOAD = fileURLToPath(new URL("./_boot_fixture_preload.cjs", import.meta.url))

/** `env` for a spawned session-start hook that loads `_boot_fixture_preload.cjs` with the fixture module at `fixture` (see that file). */
export function bootFixtureEnv(env, fixture) {
  const options = `${env.NODE_OPTIONS ?? ""} --require=${PRELOAD}`.trim()
  return { ...env, DESK_TEST_BOOT_FIXTURE: fixture, NODE_OPTIONS: options }
}
