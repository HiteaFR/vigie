// Docker image, compose, ARP companion and proof script, WITHOUT Docker. Static
// checks of the files, plus the entry point (docker/entrypoint.sh) and the companion loop
// (docker/net-scan/loop.sh) run in a shell outside a container, with fake paths and a fake node.
// No docker command is run here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CI_FILES, GITHUB_CI, readCi } from './workflows.js'
import { changelogs } from './changelog.js'
import { tmpDir, sharedTmpDir } from './tmpdir.js'
import { resolvePaths } from '../lib/setup.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const DOCKERFILE = read('Dockerfile')
const NS_DOCKERFILE = read('docker/net-scan/Dockerfile')
const COMPOSE = read('docker-compose.yml')
const BRIDGE = read('docker-compose.bridge.yml')
const IGNORE = read('.dockerignore')
const ENTRY = path.join(ROOT, 'docker/entrypoint.sh')
const LOOP = path.join(ROOT, 'docker/net-scan/loop.sh')
const PROOF = read('scripts/docker-proof.sh')
// instructions of a Dockerfile: continuation lines joined, comments removed
const instructions = text => text.replace(/\\\n/g, ' ').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
const code = text => text.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')

// --- Dockerfile ------------------------------------------------------------------------------------

// image of a FROM line (options such as --platform skipped)
const fromImage = l => l.split(/\s+/).slice(1).find(w => !w.startsWith('--'))

test('Dockerfile: each FROM pinned by exact version AND sha256 digest; Node 22, the same image in all three stages; only the client stage on $BUILDPLATFORM', () => {
  const fromLines = instructions(DOCKERFILE).filter(l => /^FROM\s/i.test(l))
  const froms = fromLines.map(fromImage)
  assert.equal(froms.length, 3)
  // the client stage (static files) runs on the build machine; server dependencies and runtime on the target platform
  assert.deepEqual(fromLines.map(l => (l.match(/--platform=(\S+)/) ?? [])[1] ?? null), ['$BUILDPLATFORM', null, null])
  assert.match(fromLines[0], / AS client$/)
  for (const f of [...froms, ...instructions(NS_DOCKERFILE).filter(l => /^FROM\s/i.test(l)).map(fromImage)]) {
    assert.match(f, /^[a-z0-9.-]+:[A-Za-z0-9._-]*\d[A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$/, `FROM not pinned: ${f}`)
    assert.doesNotMatch(f, /:(latest|lts|current|22|22-[a-z-]+|bookworm(-slim)?|stable(-slim)?)@/, `floating tag: ${f}`)
  }
  assert.equal(new Set(froms).size, 1, 'same base image everywhere')
  assert.match(froms[0], /^node:22\.\d+\.\d+-bookworm-slim@sha256:/)
  assert.doesNotMatch(DOCKERFILE, /^ARG [^\n]*(IMAGE|BASE)/m, 'no base image as a build argument (it would bypass the pinning)')
})

test('Dockerfile: npm ci only (client then vite build; server --omit=dev), never npm install; lockfiles copied before the code', () => {
  const run = instructions(DOCKERFILE).filter(l => /^RUN\s/.test(l)).join('\n')
  for (const f of [DOCKERFILE, NS_DOCKERFILE, COMPOSE, BRIDGE, PROOF, read('docker/entrypoint.sh')]) {
    assert.doesNotMatch(code(f), /npm\s+(install|i|add)\b|\byarn\b|\bpnpm\b|\bnpx\b/)
  }
  assert.match(run, /npm ci --no-audit --no-fund\n/)
  assert.match(run, /npm run build/)
  assert.equal(JSON.parse(read('client/package.json')).scripts.build, 'vite build')
  assert.match(run, /npm ci --omit=dev/)
  const lines = instructions(DOCKERFILE)
  const at = s => lines.findIndex(l => l.includes(s))
  assert.ok(at('COPY client/package.json client/package-lock.json') < at('npm ci --no-audit'))
  assert.ok(at('npm ci --no-audit') < at('COPY client/ ./'))
  assert.ok(at('COPY server/package.json server/package-lock.json') < at('npm ci --omit=dev'))
})

test('Dockerfile: limited COPY (never the whole context), REVISION as a validated argument, USER node, port 8088, HEALTHCHECK node -e on /api/healthz', () => {
  const lines = instructions(DOCKERFILE)
  const copies = lines.filter(l => /^COPY\s/.test(l)).map(l => l.replace(/^COPY\s+(--from=\S+\s+)?/, '').split(/\s+/).slice(0, -1).join(' '))
  assert.deepEqual(copies, ['client/package.json client/package-lock.json', 'client/', 'server/package.json server/package-lock.json',
    '/app/server/node_modules', 'server/', '/src/client/dist', 'scripts/vendor-icons.mjs', 'docker/entrypoint.sh'])
  for (const l of lines.filter(x => /^(COPY|ADD)\s/.test(x))) assert.doesNotMatch(l, /^ADD\s|\s\.\s|\s\.\/?\s+\S+$/, `copy too broad: ${l}`)
  assert.match(DOCKERFILE, /^ARG REVISION=$/m)
  assert.match(DOCKERFILE, /\*\[!0-9a-f\]\*\)/, 'REVISION refused unless it is a git hash')
  assert.match(DOCKERFILE, /printf '%s\\n' "\$REVISION" > \/app\/REVISION/)
  const users = lines.filter(l => /^USER\s/.test(l))
  assert.deepEqual(users, ['USER node'], 'a single USER, not root')
  assert.ok(lines.indexOf('USER node') > lines.findLastIndex(l => /^FROM\s/.test(l)), 'USER in the runtime stage')
  assert.match(DOCKERFILE, /^EXPOSE 8088$/m)
  const hc = lines.find(l => /^HEALTHCHECK\s/.test(l))
  assert.ok(hc)
  assert.match(hc, /CMD \["node", "-e", "fetch\('http:\/\/127\.0\.0\.1:'\+\(process\.env\.PORT\|\|8088\)\+'\/api\/healthz'/)
  assert.match(hc, /r\.status===200\?0:1/)
  assert.doesNotMatch(code(DOCKERFILE), /\bcurl\b|\bwget\b/)
  assert.match(DOCKERFILE, /^ENTRYPOINT \["\/usr\/local\/bin\/vigie-entrypoint"\]$/m)
  assert.match(DOCKERFILE, /^CMD \["serve"\]$/m)
})

test('Dockerfile: packages openssh-client, iproute2, ca-certificates only; env of the example unit, without LISTEN_HOST', () => {
  const installs = [...DOCKERFILE.replace(/\\\n/g, ' ').matchAll(/apt-get install -y --no-install-recommends ([^&\n]+)/g)].map(m => m[1].trim())
  assert.deepEqual(installs, ['openssh-client iproute2 ca-certificates'])
  assert.match(DOCKERFILE, /rm -rf \/var\/lib\/apt\/lists\/\*/)
  const env = DOCKERFILE.replace(/\\\n/g, ' ').match(/^ENV (.+)$/m)[1]
  const vars = Object.fromEntries(env.trim().split(/\s+/).map(kv => kv.split('=')))
  assert.deepEqual(vars, { NODE_ENV: 'production', CONFIG_PATH: '/etc/vigie/config.json', PKI_DIR: '/etc/vigie/pki', STATE_DIRECTORY: '/var/lib/vigie', ENV_FILE: '/etc/vigie/vigie.env', PORT: '8088' })
  // same paths as the example systemd unit
  const unit = read('deploy/vigie.service.example')
  for (const l of ['Environment=CONFIG_PATH=/etc/vigie/config.json', 'Environment=PKI_DIR=/etc/vigie/pki', 'EnvironmentFile=-/etc/vigie/vigie.env', '--disable-warning=ExperimentalWarning index.js']) assert.ok(unit.includes(l), l)
  for (const f of [DOCKERFILE, COMPOSE, BRIDGE, read('docker/entrypoint.sh'), NS_DOCKERFILE]) assert.doesNotMatch(code(f), /LISTEN_HOST/)
  assert.match(read('docker/entrypoint.sh'), /^NODE_OPTS=--disable-warning=ExperimentalWarning$/m)
})

// --- .dockerignore ---------------------------------------------------------------------------------

// .dockerignore patterns (Docker form: relative to the context root, ** for several folders, an
// excluded folder excludes its content, "!" re-includes, the last pattern wins)
function ignoreRules(text) {
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const neg = l.startsWith('!')
    const p = (neg ? l.slice(1) : l).replace(/^\/+/, '').replace(/\/+$/, '')
    const re = p.split('/').map(seg => seg === '**' ? '\u0000' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('/')
      .replace(/\u0000\//g, '(?:.*/)?').replace(/\/\u0000/g, '(?:/.*)?').replace(/\u0000/g, '.*')
    return { neg, re: new RegExp(`^${re}$`) }
  })
}
function ignored(rules, file) {
  const parts = file.split('/')
  let out = false
  for (const r of rules) {
    for (let i = 1; i <= parts.length; i++) {
      if (r.re.test(parts.slice(0, i).join('/'))) { out = !r.neg; break }
    }
  }
  return out
}

// repository files: git ls-files, otherwise (copy without .git) walk of the folder, modules and .git excluded
function repoFiles(t) {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.split('\n').filter(Boolean)
  t.diagnostic('no git repository (copy without .git): file list by walking the folder')
  const out = []
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!['node_modules', '.git', 'dist'].includes(e.name)) walk(p) } else out.push(p)
    }
  }
  walk('')
  return out
}

test('.dockerignore: secrets, config, data, modules, .git and drafts out of the context; the code needed for the build stays in it', t => {
  const rules = ignoreRules(IGNORE)
  for (const f of ['.env', '.env.local', '.env.production', 'server/.env', 'client/.env.local', 'deploy/vigie.env', 'config.json', 'config.json.bak',
    'data/dashboard.db', 'server/data/x', 'node_modules/a/index.js', 'client/node_modules/vite/x.js', 'server/node_modules/express/index.js',
    '.git/HEAD', '.git/config', 'server/pki/pve.pem', 'id_ed25519', 'data/ssh/id_ed25519', 'x.pem', 'REVISION', 'client/dist/index.html',
    'scratch/notes.md', 'net-scan.conf', 'server/test/x.test.js', 'dashboard.db', 'docs/x.md']) {
    assert.ok(ignored(rules, f), `should be outside the context: ${f}`)
  }
  const needed = ['client/package.json', 'client/package-lock.json', 'client/src/main.jsx', 'client/index.html', 'client/vite.config.js',
    'server/package.json', 'server/package-lock.json', 'server/index.js', 'server/lib/config.js', 'server/lib/network/oui.tsv', 'server/scripts/init.js',
    'scripts/vendor-icons.mjs', 'docker/entrypoint.sh', 'docker/net-scan/loop.sh', 'agent/net-scan/net-scan']
  for (const f of needed) assert.ok(!ignored(rules, f), `needed by the build: ${f}`)
  // every COPY source (except --from) of both Dockerfiles stays in the context
  for (const df of [DOCKERFILE, NS_DOCKERFILE]) {
    for (const l of instructions(df).filter(x => /^COPY\s/.test(x) && !/--from=/.test(x))) {
      for (const src of l.split(/\s+/).slice(1, -1)) assert.ok(!ignored(rules, src.replace(/\/$/, '')), `COPY source excluded: ${src}`)
    }
  }
  // no repository file looks like a secret in the context (git, or walk without .git)
  const files = repoFiles(t)
  assert.ok(files.includes('server/index.js'), 'list of the repository files')
  for (const f of files.filter(x => !ignored(rules, x))) assert.doesNotMatch(f, /(^|\/)\.env($|\.)|\.pem$|id_ed25519|(^|\/)config\.json$/, f)
})

// --- compose ---------------------------------------------------------------------------------------

// block of a service (lines indented by more than 2 spaces under "<name>:")
function service(text, name) {
  const lines = text.split('\n')
  const i = lines.indexOf(`  ${name}:`)
  assert.ok(i > 0, `service ${name}`)
  const out = []
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && !l.startsWith('   ')) break
    out.push(l)
  }
  return out.join('\n')
}
const anchor = (text, name) => {
  const m = text.match(new RegExp(`^x-[a-z-]+: &${name}\\n((?: {2}.*\\n)+)`, 'm'))
  assert.ok(m, `anchor ${name}`)
  return m[1]
}

test('compose: network_mode host by default; /etc/vigie read-only for the service, writable for init only; hardening; no privileged', () => {
  const c = code(COMPOSE)
  const hard = anchor(c, 'vigie-hardening')
  for (const l of ['init: true', 'read_only: true', 'cap_drop: [ALL]', 'security_opt: [no-new-privileges:true]', 'tmpfs: [/tmp]']) assert.ok(hard.includes(l), l)
  const vigie = service(c, 'vigie')
  assert.match(vigie, /^ {4}network_mode: host$/m)
  assert.match(vigie, /^ {4}<<: \*vigie-hardening$/m)
  assert.match(vigie, /^ {4}restart: unless-stopped$/m)
  assert.match(vigie, /^ {6}- vigie-state:\/var\/lib\/vigie$/m)
  assert.match(vigie, /^ {6}- vigie-config:\/etc\/vigie:ro$/m)
  assert.match(vigie, /^ {6}- net-scan:\/run\/net-scan:ro$/m)
  assert.doesNotMatch(vigie, /cap_add|ports:/)
  const init = service(c, 'init')
  assert.match(init, /^ {4}profiles: \[init\]$/m, 'init never started by up')
  assert.match(init, /^ {4}<<: \*vigie-hardening$/m)
  assert.match(init, /^ {4}entrypoint: \[\/usr\/local\/bin\/vigie-entrypoint, init\]$/m)
  assert.doesNotMatch(init, /^ {4}command:/m, 'a command would be replaced by the run options')
  assert.match(init, /^ {6}- vigie-config:\/etc\/vigie$/m)
  assert.match(init, /^ {6}- vigie-state:\/var\/lib\/vigie$/m)
  assert.equal(service(c, 'vigie').match(/image: (.+)/)[1], init.match(/image: (.+)/)[1], 'init and the service: same image')
  assert.doesNotMatch(c, /privileged|pid: host|ipc: host|userns_mode|devices:|docker\.sock|SYS_ADMIN|NET_ADMIN/)
  assert.doesNotMatch(c, /^ {4}user:/m, 'user of the image (node), never replaced')
  assert.match(c, /^volumes:\n {2}vigie-state:\n {2}vigie-config:\n {2}net-scan:\n?$/m)
})

test('compose: ARP companion in host, cap_add NET_RAW alone after cap_drop ALL, without privileged, arp profile, read-only conf without creation', () => {
  const ns = service(code(COMPOSE), 'net-scan')
  assert.match(ns, /^ {4}network_mode: host$/m)
  assert.match(ns, /^ {4}cap_drop: \[ALL\]$/m)
  assert.match(ns, /^ {4}cap_add: \[NET_RAW\]$/m)
  assert.equal((code(COMPOSE).match(/cap_add/g) ?? []).length, 1, 'a single added capability in the whole file')
  assert.match(ns, /^ {4}security_opt: \[no-new-privileges:true\]$/m)
  assert.match(ns, /^ {4}read_only: true$/m)
  assert.match(ns, /^ {4}profiles: \[arp\]$/m)
  assert.match(ns, /^ {6}- net-scan:\/run\/net-scan$/m)
  assert.match(ns, /source: \.\/net-scan\.conf\n {8}target: \/etc\/net-scan\.conf\n {8}read_only: true\n {8}bind:\n {10}create_host_path: false/)
  assert.match(ns, /dockerfile: docker\/net-scan\/Dockerfile/)
  // companion image: root without other capability, arp-scan only, net-scan from agent/, no published image
  const lines = instructions(NS_DOCKERFILE)
  assert.deepEqual([...NS_DOCKERFILE.replace(/\\\n/g, ' ').matchAll(/apt-get install -y --no-install-recommends ([^&\n]+)/g)].map(m => m[1].trim()), ['arp-scan'])
  assert.ok(lines.includes('COPY agent/net-scan/net-scan /usr/local/sbin/net-scan'))
  assert.doesNotMatch(NS_DOCKERFILE, /setcap|^USER\s/m)
  assert.match(NS_DOCKERFILE, /GPL/)
})

test('compose bridge: published on 127.0.0.1 only, network_mode reset, fixed gateway documented for adminCidrs', () => {
  const c = code(BRIDGE)
  assert.match(c, /^ {6}- "127\.0\.0\.1:\$\{VIGIE_PORT:-8088\}:\$\{VIGIE_PORT:-8088\}"$/m)
  assert.equal((c.match(/^ {6}- "/gm) ?? []).length, 1, 'a single published port')
  assert.match(service(c, 'vigie'), /network_mode: !reset null/)
  assert.match(service(c, 'init'), /network_mode: !reset null/)
  assert.match(c, /subnet: 172\.31\.88\.0\/24\n {10}gateway: 172\.31\.88\.1/)
  assert.match(BRIDGE, /--listen 0\.0\.0\.0 --admin-cidrs 172\.31\.88\.1\/32 --http-login/)
})

// --- entry point (shell, outside a container) ------------------------------------------------------

// Under root (CI and infra deployment), the entry point refuses to run: so it is run as nobody
// (setpriv, like the agent benches), from a copy readable by all (sharedTmpDir, explicit
// permissions, independent of the umask of the clone); the folders it writes belong to nobody.
// AGENT_BENCH_COPY=1 forces the copy outside root. Never skipped.
const AS_ROOT = process.getuid?.() === 0
const COPY = AS_ROOT || process.env.AGENT_BENCH_COPY === '1'
const NOBODY = 65534
// setpriv looked up in the PATH of the test process (not in the reduced one given to the entry point)
const which = cmd => (process.env.PATH || '').split(':').map(d => path.join(d, cmd)).find(f => { try { fs.accessSync(f, fs.constants.X_OK); return true } catch { return false } })
const SETPRIV = which('setpriv')
// folder written by the entry point: owned by nobody under root (fallback 0777 if chown is
// impossible, user namespace without nobody)
function forNobody(d) {
  if (!AS_ROOT) return
  try { fs.chownSync(d, NOBODY, NOBODY) } catch { fs.chmodSync(d, 0o777) }
}
// copy from src to dst, without symbolic links, explicit permissions (folders 0755, files 0644 or 0755)
function readableCopy(src, dst, skip = () => false) {
  fs.cpSync(src, dst, { recursive: true, filter: f => !fs.lstatSync(f).isSymbolicLink() && !skip(path.relative(src, f)) })
  const fix = d => {
    fs.chmodSync(d, 0o755)
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) fix(p)
      else fs.chmodSync(p, fs.statSync(p).mode & 0o100 ? 0o755 : 0o644)
    }
  }
  fix(dst)
}
// runs a shell script; under root as nobody, except direct (refusal of root checked as is)
function runSh(file, args, opts, { direct = false } = {}) {
  if (AS_ROOT && !direct) {
    assert.ok(SETPRIV, 'as root, setpriv (util-linux) is required to run the entrypoint as nobody (deliberate failure, never a skip)')
    return spawnSync(SETPRIV, [`--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', '--', 'sh', file, ...args], opts)
  }
  return spawnSync('sh', [file, ...args], opts)
}
// bench folder: readable copy (root or AGENT_BENCH_COPY=1) or ordinary temporary folder;
// entry point copied into it in the first case
function benchDir(prefix, t) {
  if (!COPY) return { dir: tmpDir(prefix, t), entry: ENTRY }
  const dir = sharedTmpDir(prefix, t)
  const entry = path.join(dir, 'entrypoint.sh')
  fs.copyFileSync(ENTRY, entry)
  fs.chmodSync(entry, 0o755)
  return { dir, entry }
}

// fake node: logs its arguments, the current folder and CONFIG_PATH (set or not); exit code FAKE_RC
function bench(t) {
  const { dir, entry } = benchDir('vigie-entry-', t)
  const bin = path.join(dir, 'bin')
  const app = path.join(dir, 'app')
  const etc = path.join(dir, 'etc')
  const out = path.join(dir, 'out')
  for (const d of [bin, app, path.join(app, 'server'), etc, out]) {
    fs.mkdirSync(d, { recursive: true })
    fs.chmodSync(d, 0o755)
  }
  forNobody(etc)
  forNobody(out)
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
{ printf 'args:'; printf ' %s' "$@"; printf '\\n'; printf 'pwd: %s\\n' "$(pwd)"
  if [ "\${CONFIG_PATH+x}" = x ]; then printf 'CONFIG_PATH=[%s]\\n' "$CONFIG_PATH"; else echo 'CONFIG_PATH absent'; fi; } >>"$FAKE_LOG"
exit "\${FAKE_RC:-0}"
`, { mode: 0o755 })
  fs.chmodSync(path.join(bin, 'node'), 0o755)
  const log = path.join(out, 'node.log')
  const run = (args, env = {}, how = {}) => {
    try { fs.unlinkSync(log) } catch {}
    const r = runSh(entry, args, {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, VIGIE_APP: app, FAKE_LOG: log, CONFIG_PATH: path.join(etc, 'config.json'), ENV_FILE: path.join(etc, 'vigie.env'),
        PKI_DIR: path.join(etc, 'pki'), STATE_DIRECTORY: path.join(dir, 'state'), ...env },
    }, how)
    return { ...r, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' }
  }
  return { dir, bin, app, etc, run }
}

test('entry point: missing config → message "docker compose run --rm init", CONFIG_PATH removed ("to configure" mode), no file created', t => {
  const b = bench(t)
  const r = b.run([])
  assert.equal(r.status, 0)
  // entry point messages in English
  assert.match(r.stderr, /^vigie: no config \(.*\/etc\/config\.json\): run "docker compose run --rm init"/m)
  assert.match(r.stderr, /no password is created/)
  assert.match(r.log, /^args: --disable-warning=ExperimentalWarning index\.js$/m)
  assert.match(r.log, new RegExp(`^pwd: ${b.app}/server$`, 'm'))
  assert.match(r.log, /^CONFIG_PATH absent$/m)
  assert.deepEqual(fs.readdirSync(b.etc), [], 'nothing written in the config directory')
  assert.ok(!fs.existsSync(path.join(b.dir, 'state')), 'nothing written in the state directory')
  // explicit serve: same thing
  assert.match(b.run(['serve']).log, /^CONFIG_PATH absent$/m)
})

test('entry point: config present, link (even broken) or empty CONFIG_PATH → CONFIG_PATH kept, the server decides; config.json in the image refused', t => {
  const b = bench(t)
  fs.writeFileSync(path.join(b.etc, 'config.json'), '{}')
  let r = b.run([])
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
  assert.match(r.log, new RegExp(`^CONFIG_PATH=\\[${b.etc}/config\\.json\\]$`, 'm'))
  fs.unlinkSync(path.join(b.etc, 'config.json'))
  fs.symlinkSync(path.join(b.etc, 'absent.json'), path.join(b.etc, 'config.json'))
  assert.match(b.run([]).log, /^CONFIG_PATH=\[.*config\.json\]$/m, 'broken link: kept (read error from the server)')
  assert.match(b.run([], { CONFIG_PATH: '' }).log, /^CONFIG_PATH=\[\]$/m, 'empty: kept (error from the server)')
  fs.unlinkSync(path.join(b.etc, 'config.json'))
  fs.writeFileSync(path.join(b.app, 'config.json'), '{}')
  r = b.run([])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /config\.json found in the image: refused/)
  assert.equal(r.log, '', 'server not started')
})

test('entry point: init with the image paths as explicit options, user options afterwards, exit code returned; empty variable refused', t => {
  const b = bench(t)
  let r = b.run(['init', '--non-interactive', '--title', 'x'])
  assert.equal(r.status, 0)
  assert.match(r.log, new RegExp(`^args: --disable-warning=ExperimentalWarning scripts/init\\.js --config ${b.etc}/config\\.json --env ${b.etc}/vigie\\.env --pki ${b.etc}/pki --state ${b.dir}/state --non-interactive --title x$`, 'm'))
  assert.match(r.stderr, /docker compose up -d/)
  r = b.run(['init', '--help'])
  assert.doesNotMatch(r.stderr, /docker compose up -d/)
  r = b.run(['init'], { FAKE_RC: '3' })
  assert.equal(r.status, 3)
  assert.doesNotMatch(r.stderr, /docker compose up -d/)
  for (const v of ['CONFIG_PATH', 'ENV_FILE', 'PKI_DIR', 'STATE_DIRECTORY']) {
    r = b.run(['init'], { [v]: '' })
    assert.equal(r.status, 2, v)
    assert.match(r.stderr, new RegExp(`${v} empty`))
    assert.equal(r.log, '')
  }
})

test('entry point: check-config, icons, help; unknown command or extra arguments refused; never as root', t => {
  const b = bench(t)
  assert.match(b.run(['check-config']).log, new RegExp(`^args: --disable-warning=ExperimentalWarning scripts/check-config\\.js ${b.etc}/config\\.json$`, 'm'))
  assert.equal(b.run(['check-config', 'x']).status, 2)
  assert.match(b.run(['icons', '--force']).log, new RegExp(`^args: --disable-warning=ExperimentalWarning ${b.app}/scripts/vendor-icons\\.mjs --force$`, 'm'))
  const h = b.run(['help'])
  assert.equal(h.status, 0)
  assert.match(h.stderr, /serve +\(default\)/)
  assert.doesNotMatch(h.stderr, /[àâéèêîôûç«»]/, 'help in English')
  for (const a of [['sh'], ['serve', 'x'], ['npm']]) {
    const r = b.run(a)
    assert.equal(r.status, 2, a.join(' '))
    assert.equal(r.log, '')
  }
  // refusal of root: under root, run as is (without setpriv); outside root, fake id that answers 0
  let r
  if (AS_ROOT) r = b.run([], {}, { direct: true })
  else {
    fs.writeFileSync(path.join(b.bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 })
    r = b.run([])
  }
  assert.equal(r.status, 1)
  assert.match(r.stderr, /refusing to run as root/)
  assert.equal(r.log, '')
})

test('entry point: generates no secret (no password, no randomness, no hash, no file write)', () => {
  const c = code(read('docker/entrypoint.sh'))
  assert.doesNotMatch(c, /urandom|\/dev\/random|openssl|pwgen|mkpasswd|\$RANDOM|ADMIN_PASSWORD|admin-password|hashPassword|VIGIE_INIT_|--secrets-stdin/)
  assert.doesNotMatch(c, /(^|[^2&])>\s*[^&/\s]|tee |install -|mkdir|touch|cp |mv /, 'no file written')
})

test('entry point + real init, non-interactive, outside a container: writes config and environment file at the image paths; a --config option from the user wins', t => {
  const { dir, entry } = benchDir('vigie-entry-init-', t)
  // server code: the repository, or (root, AGENT_BENCH_COPY=1) a copy readable by nobody
  let app = ROOT
  let PATH = process.env.PATH
  if (COPY) {
    app = path.join(dir, 'app')
    fs.mkdirSync(app)
    readableCopy(path.join(ROOT, 'server'), path.join(app, 'server'), rel => /^(test|data|pki)(\/|$)|(^|\/)node_modules\/\.bin(\/|$)/.test(rel))
    fs.chmodSync(app, 0o755)
    // node executable by nobody? otherwise (tool installed under /root…), readable copy of the binary
    const nodeOk = AS_ROOT ? spawnSync(SETPRIV, [`--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', '--', process.execPath, '-e', '0'], { env: { PATH } }).status === 0 : true
    if (!nodeOk) {
      const nbin = path.join(dir, 'node-bin')
      fs.mkdirSync(nbin)
      fs.chmodSync(nbin, 0o755)
      fs.copyFileSync(process.execPath, path.join(nbin, 'node'))
      fs.chmodSync(path.join(nbin, 'node'), 0o755)
      PATH = `${nbin}:${PATH}`
      t.diagnostic('node not reachable by nobody: readable copy of the binary')
    }
  }
  const w = path.join(dir, 'w')
  const etc = path.join(w, 'etc-vigie')
  for (const d of [w, etc, path.join(etc, 'pki')]) {
    fs.mkdirSync(d, { recursive: true })
    fs.chmodSync(d, 0o755)
    forNobody(d)
  }
  const env = { PATH, VIGIE_APP: app, CONFIG_PATH: path.join(etc, 'config.json'), ENV_FILE: path.join(etc, 'vigie.env'), PKI_DIR: path.join(etc, 'pki'),
    STATE_DIRECTORY: path.join(w, 'state'), VIGIE_INIT_ADMIN_PASSWORD: 'mot-de-passe-de-banc' }
  let r = runSh(entry, ['init', '--non-interactive', '--skip-tests', '--title', 'Banc'], { encoding: 'utf8', env, input: '' })
  assert.equal(r.status, 0, r.stderr)
  const cfg = JSON.parse(fs.readFileSync(env.CONFIG_PATH, 'utf8'))
  assert.equal(cfg.title, 'Banc')
  assert.equal(fs.statSync(env.ENV_FILE).mode & 0o777, 0o600)
  assert.doesNotMatch(r.stdout + r.stderr, /mot-de-passe-de-banc/)
  const other = path.join(w, 'autre.json')
  r = runSh(entry, ['init', '--non-interactive', '--skip-tests', '--config', other, '--env', path.join(w, 'autre.env')], { encoding: 'utf8', env, input: '' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(fs.existsSync(other), 'the user --config, passed after, wins')
})

test('init in the container: the init guards refuse /etc and /var/lib coming from variables, and accept them as explicit options (what the entry point does)', () => {
  const env = { CONFIG_PATH: '/etc/vigie/config.json', ENV_FILE: '/etc/vigie/vigie.env', PKI_DIR: '/etc/vigie/pki', STATE_DIRECTORY: '/var/lib/vigie' }
  assert.throws(() => resolvePaths({}, env), /system path/)
  const explicit = { config: env.CONFIG_PATH, env: env.ENV_FILE, pki: env.PKI_DIR, state: env.STATE_DIRECTORY }
  assert.deepEqual(resolvePaths(explicit, env), { config: '/etc/vigie/config.json', env: '/etc/vigie/vigie.env', pki: '/etc/vigie/pki', state: '/var/lib/vigie' })
  // a single forgotten option is enough for the refusal (the entry point gives them all)
  assert.throws(() => resolvePaths({ ...explicit, state: undefined }, env), /state: \/var\/lib\/vigie/)
  assert.match(read('docker/entrypoint.sh'), /scripts\/init\.js --config "\$CONFIG_PATH" --env "\$ENV_FILE" --pki "\$PKI_DIR" --state "\$STATE_DIRECTORY" "\$@"/)
})

// --- compose semantics for run and exec ------------------------------------------------------------

// minimal shell split of a command (single quotes, double quotes), up to a redirection or || / &&
function words(line) {
  const out = []
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(line))) {
    const w = m[1] ?? m[2] ?? m[3]
    if (m[3] && /^(>|2>|\|\||&&|\||<)/.test(m[3])) break
    out.push(w)
  }
  return out
}
// inline YAML list "[a, b]" of a service field
const flowList = (block, key) => {
  const m = block.match(new RegExp(`^ {4}${key}: \\[(.*)\\]$`, 'm'))
  return m ? m[1].split(',').map(x => x.trim().replace(/^["']|["']$/g, '')) : null
}
// ENTRYPOINT and CMD of the image (JSON form)
const image = {
  entrypoint: JSON.parse(DOCKERFILE.match(/^ENTRYPOINT (\[.*\])$/m)[1]),
  cmd: JSON.parse(DOCKERFILE.match(/^CMD (\[.*\])$/m)[1]),
}
// compose rules: entrypoint of the service, otherwise that of the image; run arguments if any,
// otherwise the service command, otherwise the image CMD UNLESS the service redefines entrypoint (CMD emptied)
function composeArgv(svc, runArgs) {
  const block = service(code(COMPOSE), svc)
  const ep = flowList(block, 'entrypoint')
  const cmd = flowList(block, 'command')
  return [...(ep ?? image.entrypoint), ...(runArgs.length ? runArgs : cmd ?? (ep ? [] : image.cmd))]
}
// "[docker compose|dc] run [options] <service> [args]" → { svc, args }
function parseRun(w) {
  const i = w.indexOf('run')
  let j = i + 1
  while (j < w.length && w[j].startsWith('-')) j += ['-e', '--env', '-v', '--volume', '-w', '--workdir', '-u', '--user', '--name', '--entrypoint'].includes(w[j]) ? 2 : 1
  return { svc: w[j], args: w.slice(j + 1) }
}

test('compose: "run --rm init <options>" gives "init <options>" to the entry point (entrypoint of the service, options added); without option, init alone', t => {
  assert.equal(image.entrypoint[0], '/usr/local/bin/vigie-entrypoint')
  assert.ok(instructions(DOCKERFILE).includes('COPY docker/entrypoint.sh /usr/local/bin/vigie-entrypoint'))
  assert.deepEqual(composeArgv('init', ['--non-interactive', '--title', 'x']), ['/usr/local/bin/vigie-entrypoint', 'init', '--non-interactive', '--title', 'x'])
  assert.deepEqual(composeArgv('init', []), ['/usr/local/bin/vigie-entrypoint', 'init'])
  assert.deepEqual(composeArgv('vigie', []), ['/usr/local/bin/vigie-entrypoint', 'serve'])
  assert.deepEqual(composeArgv('vigie', ['check-config']), ['/usr/local/bin/vigie-entrypoint', 'check-config'])
  // played in the real entry point (fake node)
  const b = bench(t)
  const r = b.run(composeArgv('init', ['--non-interactive', '--skip-tests']).slice(1))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.log, /scripts\/init\.js --config \S+ --env \S+ --pki \S+ --state \S+ --non-interactive --skip-tests$/m)
})

test('each "run" of the proof script and of the Docker doc (docs/docker.md) reaches a command known to the entry point; each "exec" targets a base tool', t => {
  const docker = read('docs/docker.md')
  const runs = [
    ...code(PROOF).split('\n').filter(l => /\bdc run\b/.test(l)).map(l => ({ from: 'preuve', w: words(l.slice(l.indexOf('dc run'))) })),
    ...docker.split('\n').filter(l => /^docker compose (-f \S+ )*run\b/.test(l.trim())).map(l => ({ from: 'docs/docker.md', w: words(l.trim().replace(/\s+#.*$/, '')) })),
    ...[...docker.matchAll(/`(docker compose (?:-f \S+ )*run [^`]+)`/g)].map(m => ({ from: 'docs/docker.md (texte)', w: words(m[1]) })),
  ]
  assert.ok(runs.length >= 5, `runs found: ${runs.length}`)
  const b = bench(t)
  for (const { from, w } of runs) {
    const { svc, args } = parseRun(w)
    assert.ok(['init', 'vigie'].includes(svc), `${from}: service ${svc}`)
    const argv = composeArgv(svc, args)
    const r = b.run(argv.slice(1))
    assert.equal(r.status, 0, `${from}: ${w.join(' ')} → ${argv.slice(1).join(' ')}: ${r.stderr}`)
    assert.doesNotMatch(r.stderr, /unknown command/, from)
    assert.match(r.log, /^args: --disable-warning=ExperimentalWarning /m, `${from}: node started`)
  }
  // exec: no entry point; only Debian slim tools (coreutils, sh)
  const execs = code(PROOF).split('\n').filter(l => /\bdc exec\b/.test(l)).map(l => parseRun(words(l.slice(l.indexOf('dc exec'))).map(x => (x === 'exec' ? 'run' : x))))
  assert.ok(execs.length >= 4)
  for (const { svc, args } of execs) {
    assert.equal(svc, 'vigie')
    assert.ok(['ls', 'sh', 'id', 'test', 'stat', 'uname'].includes(args[0]), `exec ${args[0]}`)
  }
})

// --- ARP companion loop ----------------------------------------------------------------------------

test('companion: loop (one pass) writes arp.json by renaming; net-scan failure without a half-written file; interval and folder validated', t => {
  const dir = tmpDir('vigie-ns-loop-', t)
  const out = path.join(dir, 'run')
  fs.mkdirSync(out)
  const ok = path.join(dir, 'ok')
  const ko = path.join(dir, 'ko')
  fs.writeFileSync(ok, '#!/bin/sh\necho \'{"v":1,"ok":true,"hosts":[]}\'\n', { mode: 0o755 })
  fs.writeFileSync(ko, '#!/bin/sh\necho \'{"v":1,"ok":tr\'\nexit 4\n', { mode: 0o755 })
  const run = env => spawnSync('sh', [LOOP], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', NET_SCAN_ONCE: '1', NET_SCAN_DIR: out, NET_SCAN_BIN: ok, ...env } })
  let r = run({})
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.readFileSync(path.join(out, 'arp.json'), 'utf8'), '{"v":1,"ok":true,"hosts":[]}\n')
  assert.deepEqual(fs.readdirSync(out), ['arp.json'])
  assert.equal(fs.statSync(path.join(out, 'arp.json')).mode & 0o777, 0o644)
  r = run({ NET_SCAN_BIN: ko })
  assert.equal(r.status, 0)
  assert.match(r.stderr, /net-scan: failed \(code 4\)/)
  assert.equal(fs.readFileSync(path.join(out, 'arp.json'), 'utf8'), '{"v":1,"ok":true,"hosts":[]}\n', 'old file kept')
  assert.deepEqual(fs.readdirSync(out), ['arp.json'], 'no temporary file left')
  for (const v of ['0', '10', '3601', 'abc', '060', ' 60']) assert.equal(run({ NET_SCAN_INTERVAL: v }).status, 2, `interval ${v}`)
  fs.symlinkSync(out, path.join(dir, 'lien'))
  assert.equal(run({ NET_SCAN_DIR: path.join(dir, 'lien') }).status, 1)
  assert.equal(run({ NET_SCAN_DIR: path.join(dir, 'absent') }).status, 1)
  // the example conf is accepted by net-scan (without scan: empty recorded output)
  const demo = spawnSync('sh', [path.join(ROOT, 'agent/net-scan/net-scan')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', NET_SCAN_CONF: path.join(ROOT, 'docker/net-scan.conf.example'), NET_SCAN_DEMO: '/dev/null' } })
  assert.match(demo.stdout, /"ok":true/)
})

// --- CI, deployment, proof, doc --------------------------------------------------------------------

test('no docker command in ci.yml nor in the repository deployment (deploy/), nor in the example unit', () => {
  // Gitea CI (while it is in the tree): no docker command. The GitHub CI builds the image (docker
  // build, never pushed: see publication.test.js) and has no other docker command.
  for (const f of CI_FILES) {
    const ci = code(readCi(f)).replace(/^ {4}runs-on: .*$/gm, '') // runner labels (CI host), not a command
    const lines = ci.split('\n').filter(l => /docker/i.test(l)).map(l => l.trim())
    assert.deepEqual(lines, f === GITHUB_CI ? ['- name: Build the Docker image', 'run: docker build --pull --build-arg REVISION="$GITHUB_SHA" -t vigie:ci .'] : [], f)
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'deploy'))) assert.doesNotMatch(code(read(`deploy/${f}`)), /\bdocker\b|compose/i, f)
})

test('proof script: project and image with a unique name, refusal of anything existing, cleanup of the project only, no prune nor removal outside the project, secret never as an argument', () => {
  const c = code(PROOF)
  assert.match(c, /^PROJECT=vigie-proof-\$\(date \+%Y%m%d%H%M%S\)-\$\$$/m)
  assert.match(c, /^IMAGE=\$PROJECT:local$/m)
  for (const k of ['docker ps -aq', 'docker volume ls -q', 'docker network ls -q']) assert.match(c, new RegExp(`${k.replace(/ /g, ' ')} --filter "label=com\\.docker\\.compose\\.project=\\$PROJECT"`), k)
  assert.match(c, /! docker image inspect "\$IMAGE"/)
  assert.match(c, /ss -Hltn "sport = :\$PORT"/)
  assert.match(c, /^trap cleanup EXIT$/m)
  assert.match(c, /docker compose -f "\$WORK\/src\/docker-compose\.yml" -p "\$PROJECT" --profile init --profile arp down -v --rmi all --remove-orphans/)
  // commands only (messages and patterns between single quotes removed)
  const cmds = c.replace(/'[^'\n]*'/g, "''").replace(/\b(ok|ko) "[^"\n]*"/g, '$1 ""')
  assert.doesNotMatch(cmds, /prune|docker (rm|rmi|volume rm|network rm|kill|stop)\b|docker compose (?!-f "\$WORK\/src\/docker-compose\.yml" -p "\$PROJECT"|version)/)
  assert.match(c, /^dc\(\) \{ docker compose -f "\$WORK\/src\/docker-compose\.yml" -p "\$PROJECT" "\$@"; \}$/m)
  assert.match(c, /^unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME$/m)
  assert.ok(c.indexOf('unset COMPOSE_FILE') < c.indexOf('docker compose version'))
  assert.match(c, /git -C "\$SRC" archive HEAD \| tar -x -C "\$WORK\/src"/, 'build context: tracked files only')
  assert.match(c, /VIGIE_INIT_ADMIN_PASSWORD=\$pw dc run --rm -T -e VIGIE_INIT_ADMIN_PASSWORD init/)
  assert.doesNotMatch(c, /--password|-p "\$pw"|\$pw"? +[^|]*curl/)
  assert.match(c, /--data-binary @-/)
  // unique names exported before the extraction; down guarded by equality with the unique tags; cache announced
  const at = s => c.indexOf(s)
  assert.ok(at('export VIGIE_IMAGE="$IMAGE" VIGIE_NET_SCAN_IMAGE="$NS_IMAGE"') > 0 && at('export VIGIE_IMAGE') < at('git -C "$SRC" archive'))
  assert.match(c, /\[ "\$\{VIGIE_IMAGE:-\}" = "\$IMAGE" \] && \[ "\$\{VIGIE_NET_SCAN_IMAGE:-\}" = "\$NS_IMAGE" \]; then\n {4}\(cd "\$WORK\/src" && docker compose -f "\$WORK\/src\/docker-compose\.yml" -p "\$PROJECT" --profile init --profile arp down/)
  assert.match(c, /docker system df --format/)
  const sc = spawnSync('shellcheck', ['-s', 'sh', '-S', 'warning', path.join(ROOT, 'scripts/docker-proof.sh'), ENTRY, LOOP], { encoding: 'utf8' })
  if (sc.error?.code === 'ENOENT') return
  assert.equal(sc.status, 0, sc.stdout)
})

// fake docker, git, tar, ss and curl: no real call; docker logs its arguments and the image names
// seen in its environment
function proofBench(t, tarScript, { env = {}, docker = '' } = {}) {
  const dir = tmpDir('vigie-proof-', t)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const log = path.join(dir, 'docker.log')
  const w = (n, body) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  w('docker', `printf '%s | VIGIE_IMAGE=%s VIGIE_NET_SCAN_IMAGE=%s\\n' "$*" "\${VIGIE_IMAGE-<non posé>}" "\${VIGIE_NET_SCAN_IMAGE-<non posé>}" >>"${log}"
printf 'env COMPOSE_FILE=%s COMPOSE_PROFILES=%s COMPOSE_PROJECT_NAME=%s\\n' "\${COMPOSE_FILE-<non posé>}" "\${COMPOSE_PROFILES-<non posé>}" "\${COMPOSE_PROJECT_NAME-<non posé>}" >>"${log}"
${docker}
case "$1 $2" in 'image inspect') exit 1 ;; 'system df') echo 'Build Cache: 1.2GB (1.2GB reclaimable)' ;; esac
exit 0`)
  w('git', `case "$*" in *rev-parse*) echo 0123456789abcdef0123456789abcdef01234567 ;; *archive*) : ;; esac`)
  w('tar', tarScript)
  w('ss', ':')
  w('curl', 'exit 1')
  const r = spawnSync('sh', [path.join(ROOT, 'scripts/docker-proof.sh')], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: dir, ...env } })
  return { ...r, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' }
}

test('proof script (fake docker): extraction failing after the compose → cleanup of the project only, with the unique tags, never vigie:local; build cache announced, not purged', t => {
  // tar that writes the compose then fails (full disk, truncated archive)
  const r = proofBench(t, `cat >/dev/null; while [ $# -gt 0 ]; do [ "$1" = -C ] && d=$2; shift; done; echo 'services: {}' >"$d/docker-compose.yml"; exit 2`)
  assert.notEqual(r.status, 0)
  const downs = r.log.split('\n').filter(l => / down /.test(l))
  assert.equal(downs.length, 1, r.log)
  assert.match(downs[0], /^compose -f \/\S+\/src\/docker-compose\.yml -p vigie-proof-\d{14}-\d+ --profile init --profile arp down -v --rmi all --remove-orphans \| VIGIE_IMAGE=vigie-proof-\d{14}-\d+:local VIGIE_NET_SCAN_IMAGE=vigie-proof-\d{14}-\d+-net-scan:local$/)
  assert.doesNotMatch(r.log, /=vigie:local|=vigie-net-scan:local/)
  assert.doesNotMatch(r.log, /prune|\brm\b|rmi (?!all)/)
  assert.match(r.stdout, /build cache kept, not pruned: Build Cache: 1\.2GB/)
  // extraction failing BEFORE the compose: no down (nothing to undo)
  const r2 = proofBench(t, 'cat >/dev/null; exit 2')
  assert.notEqual(r2.status, 0)
  assert.doesNotMatch(r2.log, / down /)
})

test('proof script (fake docker): COMPOSE_FILE, COMPOSE_PROFILES and COMPOSE_PROJECT_NAME of the operator ignored; explicit -f and -p everywhere', t => {
  // successful extraction (compose written), failing build: one call per dc, then the cleanup down
  const r = proofBench(t, `cat >/dev/null; while [ $# -gt 0 ]; do [ "$1" = -C ] && d=$2; shift; done; echo 'services: {}' >"$d/docker-compose.yml"`, {
    env: { COMPOSE_FILE: '/ailleurs/docker-compose.yml', COMPOSE_PROFILES: 'arp', COMPOSE_PROJECT_NAME: 'vigie' },
    docker: 'case "$*" in *" build "*) exit 1 ;; esac',
  })
  assert.notEqual(r.status, 0)
  const calls = r.log.split('\n').filter(l => l.startsWith('compose ') && !l.startsWith('compose version'))
  assert.ok(calls.some(l => / build vigie /.test(l)) && calls.some(l => / down /.test(l)), r.log)
  for (const l of calls) assert.match(l, /^compose -f \/\S+\/src\/docker-compose\.yml -p vigie-proof-\d{14}-\d+ /, l)
  assert.doesNotMatch(r.log, /\/ailleurs\/|COMPOSE_(FILE|PROFILES|PROJECT_NAME)=(?!<non posé>)/)
})

test('doc (docs/docker.md, in English): Docker and network under Docker, same paths and commands as the compose and the entry point; warning about the scan; GPL of arp-scan', () => {
  const docker = read('docs/docker.md')
  assert.match(docker, /^# Docker/m)
  assert.match(docker, /^## Network under Docker$/m)
  assert.match(read('README.md'), /\(docs\/docker\.md\)/)
  for (const s of ['docker compose build', 'docker compose pull', 'VIGIE_IMAGE=vigie:local', 'ghcr.io/hiteafr/vigie', 'linux/arm64', 'gh attestation verify', 'docker compose run --rm init', 'docker compose up -d', 'docker compose --profile arp up -d', 'docker-compose.bridge.yml',
    '/etc/vigie', '/var/lib/vigie', '/run/net-scan', 'net-scan.conf', 'NET_RAW', '--listen 0.0.0.0 --admin-cidrs 172.31.88.1/32 --http-login', 'GPL',
    'network.probe.enabled', 'docker compose run --rm vigie icons', 'Backup', 'git pull']) {
    assert.ok(docker.includes(s), s)
  }
  assert.match(docker, /scanning a network that is not yours may be forbidden/)
  // dated proof, and what is not dated yet, said as is (README and CHANGELOG)
  assert.match(docker, /\*\*Proven on 2026-11-11\*\* on a test Docker machine \(amd64, Docker 29\.9, Compose v5\.7\)/)
  const pending = docker.slice(docker.indexOf('**Not proven yet**'))
  assert.ok(docker.includes('**Not proven yet**'))
  for (const s of ['bridge variant', 'ARP companion', 'arp.json', '`ssh` to a host', '`icons`', 'arm64 image on real arm64 hardware', '`read_only`', '`cap_drop: [ALL]`', 'mDNS']) assert.ok(pending.includes(s), s)
  // each release: proof of the pushed digest, per platform, before the tags
  assert.match(docker, /pushes the image by digest only, pulls that digest\s+back for each platform and runs the same `scripts\/docker-proof\.sh`/)
  assert.match(docker, /The companion image is never published/)
  // Gitea changelog (French) while it is in the tree, public changelog (English) and its template
  for (const log of changelogs()) {
    if (log.isPublic) {
      assert.match(log.text, /\*\*Docker\*\*: image and Compose file, see \[docs\/docker\.md\]\(docs\/docker\.md\)\. Proven on 2026-11-11/, log.file)
      assert.match(log.text, /Not proven yet: the bridge variant, the ARP companion\s+running and `arp\.json` read, the agent over `ssh` to a host, `icons`, arm64 on real hardware/, log.file)
    } else {
      assert.match(log.text, /\*\*Docker \(P3d\)\.\*\* Prouvé le 2026-11-11/)
      assert.match(log.text, /Pas encore prouvé : variante pont, compagnon ARP lancé et `arp\.json` lu, agent\s+`ssh` vers un hôte, `icons`, arm64/)
    }
  }
  assert.match(docker, /a network you are responsible for,\s+or with the agreement\s+of its owner/)
  assert.ok(read('docker/entrypoint.sh').includes('run \\"docker compose run --rm init\\"'))
  // the installation doc points to the Docker doc
  assert.match(read('docs/installation.md'), /\(docker\.md\)/)
})
