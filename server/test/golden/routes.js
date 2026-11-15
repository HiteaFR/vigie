// Route table of the real server (index.js), walked by routes-preload.mjs (nested routers
// included), then MEASURED guard of each API route:
//   - read (GET): without a session, then with a test admin session;
//   - write: without session or origin, with a same-host Origin without a session (401 expected
//     from an admin route), then with the admin session and the Origin (neither 401 nor 403 expected).
// The displayed guard is derived from these statuses, never from function names. Minimal neutral config,
// no env file (the hash of the test password goes through the environment), state in a
// throwaway folder, listening on 127.0.0.1 on a free port; the server is stopped at the end, and stops
// by itself after 60 s if the test is killed.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashPassword } from '../../lib/auth.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '..', '..')
const PRELOAD = pathToFileURL(path.join(HERE, 'routes-preload.mjs')).href
const PASSWORD = 'mot-de-passe-de-banc-golden'

export async function routeTable(dir) {
  const config = path.join(dir, 'config.json')
  // network block (without any active source): its write routes only exist with it
  fs.writeFileSync(config, JSON.stringify({
    version: 2, title: 'Banc', proxmox: [], hosts: [], groups: [], services: [], alerts: {},
    network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: { pve: false }, probe: { enabled: false, exclude: [] }, mdns: { enabled: false } },
  }))
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'index.js'], {
    cwd: SERVER,
    env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC', CONFIG_PATH: config, ENV_FILE: 'none', STATE_DIRECTORY: path.join(dir, 'state'), PORT: '0', ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD), GOLDEN_DEADLINE_MS: '60000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const info = await new Promise((resolve, reject) => {
      let out = ''
      let err = ''
      const timer = setTimeout(() => reject(new Error(`serveur muet après 20 s : ${err.slice(-500)}`)), 20_000)
      child.stdout.on('data', d => {
        out += d
        const m = out.match(/^GOLDEN-ROUTES (.+)$/m)
        if (m) { clearTimeout(timer); resolve(JSON.parse(m[1])) }
      })
      child.stderr.on('data', d => { err += d })
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`serveur arrêté (code ${code}) : ${err.slice(-500)}`)) })
    })
    const base = `http://127.0.0.1:${info.port}`
    const call = async (method, p, { origin = false, cookie = null } = {}) => {
      const headers = {}
      if (origin) headers.origin = base
      if (cookie) headers.cookie = cookie
      if (method !== 'GET') headers['content-type'] = 'application/json'
      const res = await fetch(base + p, { method, headers, ...(method === 'GET' ? {} : { body: method === 'POST' && p === '/api/login' ? JSON.stringify({ password: PASSWORD }) : '{}' }) })
      await res.arrayBuffer()
      return res
    }
    const login = await call('POST', '/api/login', { origin: true })
    if (login.status !== 200) throw new Error(`connexion admin de banc refusée (${login.status})`)
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
    // logout last: it would close the session for the following probes
    const order = [...info.routes.keys()].sort((a, b) => (info.routes[a].path === '/api/logout') - (info.routes[b].path === '/api/logout'))
    // an API route registered AFTER the "/api/*" catch-all is never served: unreachable
    const catchAll = info.routes.findIndex(r => r.method === 'ALL' && r.path === '/api/*')
    const rows = []
    for (const i of order) {
      const r = info.routes[i]
      const row = { method: r.method, path: r.path }
      if (catchAll >= 0 && i > catchAll && r.path.startsWith('/api/')) {
        row.guard = 'injoignable (après /api/*)'
        rows[i] = row
        continue
      }
      const probe = r.path.startsWith('/api/') && r.method !== 'ALL' ? r.path.replace(/:[A-Za-z]+/g, 'x') : null
      if (probe && r.method === 'GET') {
        const anon = (await call('GET', probe)).status
        const admin = (await call('GET', probe, { cookie })).status
        row.guard = anon === 401 ? (admin !== 401 && admin !== 403 ? 'session' : 'refusée-même-en-session') : 'publique'
        row.probes = `sans-session=${anon} session=${admin}`
      } else if (probe && r.path === '/api/login') {
        row.guard = 'publique'
        row.probes = `sans-origine=${(await call(r.method, probe)).status}`
      } else if (probe) {
        const bare = (await call(r.method, probe)).status
        const origin = (await call(r.method, probe, { origin: true })).status
        const admin = (await call(r.method, probe, { origin: true, cookie })).status
        row.guard = origin === 401 ? (admin !== 401 && admin !== 403 ? 'admin' : 'refusée-même-en-admin') : origin === 403 ? 'origine' : 'aucune'
        row.probes = `sans-session=${bare} origine=${origin} admin=${admin}`
      } else row.guard = '-'
      rows[i] = row
    }
    return rows
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => (child.exitCode != null ? resolve() : child.once('exit', resolve)))
  }
}

// one line per route, in Express registration order (order matters: first served)
export const routesText = rows => `${rows.map(r => [r.method.padEnd(4), r.path, `garde=${r.guard}`, r.probes ?? ''].filter(Boolean).join('  ')).join('\n')}\n`
