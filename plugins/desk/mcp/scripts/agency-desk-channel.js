#!/usr/bin/env node
// Move an explicit Agency entry for Desk on `main` to Desk's release channel. The `03-desk-release-channel` migration runs
// this straight from the installed plugin, so it imports nothing outside Node's built-ins and Desk's own dependency-free
// modules. See src/runtime/agency-desk-channel.js.
import { runAgencyDeskChannelCli } from "../src/runtime/agency-desk-channel.js"

process.exitCode = await runAgencyDeskChannelCli({ argv: process.argv.slice(2), env: process.env, io: process })
