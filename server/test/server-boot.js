// Starts the REAL server/index.js for the tests, on a fake config (CONFIG_PATH), without any
// .env (ENV_FILE=none), database in a temporary directory, port 0, listening on 127.0.0.1 only
// (LISTEN_HOST).
// The child process environment is built from scratch (nothing inherited, no secret);
// it opens no connection outside 127.0.0.1 unless the config declares one.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './tmpdir.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const TRACE_ENV = path.join(SERVER, 'test/fixtures/boot/trace-env.mjs')

// minimal valid v2 config; over: replaced fields. French instance ("locale": "fr", like
// production): the texts the tests expect are in French; the default (en) has its own test
export function bootConfig(over = {}) {
  return {
    version: 2, title: 'Banc de test (données factices)', locale: 'fr', proxmox: [], gitea: { owner: 'factice' },
    groups: [{ id: 'g', name: 'Groupe' }],
    hosts: [{ id: 'web', name: 'web-factice', kind: 'appliance', env: 'prod', ip: '127.0.0.1' }],
    services: [],
    alerts: { startupGraceSec: 0 },
    ...over,
  }
}

// → { base, port, logs(), stop() }; env: added variables (ENV_FILE=none by default)
// cwd: server/ folder launched (default: the repository's; a copy, for a root without config.json)
export async function bootServer(t, { config = bootConfig(), env = {}, preload = [], timeoutMs = 15_000, cwd = SERVER } = {}) {
  const dir = tmpDir('dash-boot-', t)
  const cfgPath = path.join(dir, 'config.json')
  fs.writeFileSync(cfgPath, JSON.stringify(config))
  fs.mkdirSync(path.join(dir, 'state'))
  const childEnv = {
    PATH: process.env.PATH, TZ: 'Europe/Paris', NODE_ENV: 'production',
    CONFIG_PATH: cfgPath, ENV_FILE: 'none', STATE_DIRECTORY: path.join(dir, 'state'), PORT: '0', LISTEN_HOST: '127.0.0.1',
    ...env,
  }
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k]
  const args = ['--disable-warning=ExperimentalWarning', ...preload.flatMap(p => ['--import', p]), 'index.js']
  const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })))
  let stopped = null
  const stop = async () => {
    if (!stopped) {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM')
      stopped = exited
    }
    return stopped
  }
  t.after(async () => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000)
    await stop()
    clearTimeout(kill)
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serveur non prêt en ${timeoutMs} ms :\n${out}`)), timeoutMs)
    const onData = () => {
      const m = /vigie listening on :(\d+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    exited.then(({ code, signal }) => {
      clearTimeout(timer)
      reject(new Error(`serveur arrêté au démarrage (${code ?? signal}) :\n${out}`))
    })
  })
  return { base: `http://127.0.0.1:${port}`, port, logs: () => out, stop, exited, dir, stateDir: path.join(dir, 'state') }
}

// node:http request (free Host header, unlike fetch) → { status, headers, body, json }
export function request(port, p, { method = 'GET', headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers }
    if (body != null && !h['content-type']) h['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port, path: p, method, setHost: host !== null, headers: host ? { ...h, host } : h }, res => {
      let d = ''
      res.setEncoding('utf8')
      res.on('data', c => { d += c })
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(d)
        } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: d, json })
      })
    })
    r.on('error', reject)
    r.end(body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}

// waits for a condition (asynchronous), without a fixed delay: → true, or false after ms
export async function until(fn, ms = 10_000, step = 25) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, step))
  }
  return false
}
