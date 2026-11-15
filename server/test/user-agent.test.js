// A single outgoing User-Agent, "vigie/<version>" (server/package.json), for the HTTP
// probes, the services probe of the network module and the upstream version sources.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { USER_AGENT } from '../lib/user-agent.js'
import { createUpstream } from '../lib/updates/upstream.js'
import { tmpStore } from './tmpdir.js'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const src = f => fs.readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')

test('User-Agent: vigie/<package.json version>; no other User-Agent hardcoded in lib', () => {
  assert.equal(USER_AGENT, `vigie/${pkg.version}`)
  assert.match(USER_AGENT, /^vigie\/\d+\.\d+\.\d+/)
  for (const f of ['checks.js', 'network/probe.js', 'updates/upstream.js']) {
    assert.match(src(f), /USER_AGENT/, f)
    assert.doesNotMatch(src(f), /'User-Agent': '/, f)
    assert.doesNotMatch(src(f), /infra-control-center|dev-dashboard/, f)
  }
})

test('User-Agent: the upstream version sources send it', async t => {
  const seen = []
  const fetch = async (url, opts) => {
    seen.push(opts.headers['User-Agent'])
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const up = createUpstream({ store: tmpStore('dash-ua-', t), env: {}, fetch, log: { error() {}, warn() {} } })
  await up.httpJson('https://releases.example.net/latest.json')
  assert.deepEqual(seen, [USER_AGENT])
})
