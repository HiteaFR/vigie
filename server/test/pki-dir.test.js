// Configurable folder of pinned CAs (PKI_DIR, otherwise server/pki), "pki/<name>.pem" form
// unchanged. PKI_DIR missing or unreadable: the CA error stays visible (cluster in error,
// pve_unreachable alert, log), without crash or request; check-config reports it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pkiDir } from '../lib/paths.js'
import { inspectCa, SERVER_DIR } from '../lib/tls.js'
import { createSources } from '../lib/sources.js'
import { bootServer, bootConfig, request, until } from './server-boot.js'
import { tlsFixtures } from './tls-fixtures.js'
import { tmpDir } from './tmpdir.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHECK = path.join(HERE, '../scripts/check-config.js')
const FIX = tlsFixtures()
const PVE = { id: 'prod', label: 'P', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve-prod.pem' }
const ENV = { PVE_PROD_TOKEN_ID: 'id', PVE_PROD_TOKEN_SECRET: 'jeton-factice' }
// test CA folder: CA A of tlsFixtures under the name expected by the config
function caDir(t) {
  const d = tmpDir('dash-pki-', t)
  fs.copyFileSync(path.join(FIX, 'pki/ca-a.pem'), path.join(d, 'pve-prod.pem'))
  return d
}

test('pkiDir: PKI_DIR, otherwise <server>/pki; inspectCa reads <folder>/<name>.pem, only the pki/<name>.pem form allowed', t => {
  assert.equal(pkiDir({}, '/opt/x/server'), '/opt/x/server/pki')
  assert.equal(pkiDir({ PKI_DIR: '/etc/vigie/pki' }, '/opt/x/server'), '/etc/vigie/pki')
  assert.equal(pkiDir({ PKI_DIR: 'rel' }, '/s'), path.resolve('rel'))
  const d = caDir(t)
  const ok = inspectCa('pki/pve-prod.pem', { dir: d })
  assert.equal(ok.error, undefined)
  assert.match(ok.subject, /Test CA A/)
  for (const bad of ['pve-prod.pem', '/etc/passwd', 'pki/../pve-prod.pem', 'pki/sous/x.pem', 'pki/.cache.pem', 'pki/x.crt', '']) {
    assert.match(inspectCa(bad, { dir: d }).error, /^CA invalide/, bad)
  }
  // default: the repository's server/pki (the production CAs, unchanged)
  assert.equal(inspectCa('pki/absente.pem').error, 'CA absente (pki/absente.pem)')
  assert.equal(path.join(SERVER_DIR, 'pki'), pkiDir({}, SERVER_DIR))
})

test('createSources: valid PKI_DIR → CA read there; missing → missing CA; unreadable (file instead of a folder) → unreadable CA; cluster in error, no request', async t => {
  const good = createSources({ proxmox: [PVE] }, { ...ENV, PKI_DIR: caDir(t) }, { fetch: async () => new Response('{"data":[]}') })
  assert.equal(good.clusters[0].caError, null)
  assert.match(good.clusters[0].caInfo.subject, /Test CA A/)
  const asFile = path.join(tmpDir('dash-pki-file-', t), 'pas-un-dossier')
  fs.writeFileSync(asFile, 'x')
  for (const [dir, msg] of [[path.join(tmpDir('dash-pki-none-', t), 'absent'), 'CA absente (pki/pve-prod.pem)'], [asFile, 'CA illisible (pki/pve-prod.pem)']]) {
    let calls = 0
    const s = createSources({ proxmox: [PVE] }, { ...ENV, PKI_DIR: dir }, { fetch: async () => { calls++; return new Response('{"data":[]}') } })
    assert.equal(s.clusters[0].caError, msg, dir)
    const [c] = await s.cluster()
    assert.equal(c.error, `certificat non vérifié : ${msg}`)
    assert.equal(calls, 0, 'no request without a verifiable CA')
  }
})

test('check-config: CA not found or unreadable under PKI_DIR → exit 1 and message; valid PKI_DIR → exit 0', t => {
  const dir = tmpDir('dash-pki-check-', t)
  const cfg = path.join(dir, 'config.json')
  fs.writeFileSync(cfg, JSON.stringify(bootConfig({ proxmox: [PVE] })))
  const run = PKI_DIR => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHECK, cfg], { encoding: 'utf8', env: { PATH: process.env.PATH, PKI_DIR } })
  const ok = run(caDir(t))
  assert.equal(ok.status, 0, ok.stderr)
  const absent = run(path.join(dir, 'absent'))
  assert.equal(absent.status, 1)
  assert.match(absent.stderr, /proxmox prod: CA missing \(pki\/pve-prod\.pem\)/)
  const empty = tmpDir('dash-pki-vide-', t)
  assert.match(run(empty).stderr, /proxmox prod: CA missing/)
  fs.writeFileSync(path.join(dir, 'fichier'), 'x')
  const unreadable = run(path.join(dir, 'fichier'))
  assert.equal(unreadable.status, 1)
  assert.match(unreadable.stderr, /proxmox prod: CA unreadable \(pki\/pve-prod\.pem\)/)
})

test('real startup, missing PKI_DIR: the server starts, the CA error is in the log and in a pve_unreachable alert (no crash)', { timeout: 40_000 }, async t => {
  const s = await bootServer(t, {
    // anonymous read: /api/alerts read without a session, the CA error is the subject
    config: bootConfig({ security: { anonymousRead: true }, proxmox: [PVE], hosts: [{ id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', env: 'prod' }] }),
    env: { ...ENV, PKI_DIR: path.join(tmpDir('dash-pki-boot-', t), 'absent') },
  })
  assert.equal((await request(s.port, '/api/healthz')).status, 200)
  assert.match(s.logs(), /proxmox prod: certificate not verified: CA absente \(pki\/pve-prod\.pem\)/)
  let alert = null
  assert.ok(await until(async () => {
    alert = (await request(s.port, '/api/alerts')).json?.active?.find(a => a.key === 'pve_unreachable:prod')
    return !!alert
  }, 30_000, 250), s.logs())
  assert.match(alert.detail ?? '', /certificat non vérifié : CA absente/)
})
