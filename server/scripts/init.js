#!/usr/bin/env node
// Vigie setup wizard (lib/setup.js). Interactive by default (a terminal is required);
// --non-interactive (or --yes) for Docker and scripts, secrets through VIGIE_INIT_* or
// --secrets-stdin, never as arguments. --help for the options.
//   npm run init                                   (from server/)
//   npm run init -- --config /tmp/x/config.json --env /tmp/x/vigie.env
import { runInit } from '../lib/setup.js'

process.exitCode = await runInit({ argv: process.argv.slice(2) })
