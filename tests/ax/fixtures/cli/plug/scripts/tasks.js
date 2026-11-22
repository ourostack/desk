#!/usr/bin/env node
import { tasksCli } from "../src/tasks-cli.js"
process.exitCode = await tasksCli({}).run(process.argv.slice(2))
