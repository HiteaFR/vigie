// withEnv merges env into an existing query; applied to alert links (bell,
// Alerts view) and to drawer links; Telegram links (dashboardUrl + link) stay without env.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withEnv } from '../../client/src/nav.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalogue loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = f => fs.readFileSync(path.join(ROOT, f), 'utf8')

test('withEnv: empty query, existing query, env already present, #; all and missing unchanged', () => {
  const cases = [
    // [path, env, expected]
    ['/alertes', 'prod', '/alertes?env=prod'],
    ['/alertes', 'dev', '/alertes?env=dev'],
    ['/reseau?d=12', 'prod', '/reseau?d=12&env=prod'],
    ['/infra?h=docker-a&tab=x', 'dev', '/infra?h=docker-a&tab=x&env=dev'],
    ['/reseau?env=dev&d=12', 'prod', '/reseau?d=12&env=prod'],
    ['/reseau?d=12&env=prod', 'prod', '/reseau?d=12&env=prod'],
    ['/reseau?env', 'prod', '/reseau?env=prod'],
    ['/reseau?environment=x', 'prod', '/reseau?environment=x&env=prod'],
    ['/reseau?', 'prod', '/reseau?env=prod'],
    ['/reseau?d=12#carte', 'prod', '/reseau?d=12&env=prod#carte'],
    ['/infra#x', 'dev', '/infra?env=dev#x'],
    ['/infra?h=a#x', 'dev', '/infra?h=a&env=dev#x'],
    ['/infra?env=prod#x', 'dev', '/infra?env=dev#x'],
    ['/infra#', 'prod', '/infra?env=prod#'],
    ['/infra#x', 'all', '/infra#x'],
    ['/reseau#a?b=1', 'prod', '/reseau?env=prod#a?b=1'],
    ['/services?q=Home%20Assistant', 'prod', '/services?q=Home%20Assistant&env=prod'],
    ['/reseau?d=12', 'all', '/reseau?d=12'],
    ['/reseau?d=12&env=dev', 'all', '/reseau?d=12&env=dev'],
    ['/reseau?d=12', null, '/reseau?d=12'],
    ['/reseau?d=12', undefined, '/reseau?d=12'],
    ['/reseau?d=12', '', '/reseau?d=12'],
  ]
  for (const [p, env, want] of cases) assert.equal(withEnv(p, env), want, `${p} + ${env}`)
  // the faulty forms from before the fix (`/reseau?d=12?env=prod`, `/infra#x?env=dev`) never come out
  for (const [p, env] of cases) {
    const out = withEnv(p, env)
    assert.ok((out.split('#')[0].match(/\?/g) ?? []).length <= 1, `a single ? before the #: ${out}`)
    if (env && env !== 'all') assert.ok(!out.split('#').slice(1).join('#').includes(`env=${env}`), `env never in the #: ${out}`)
  }
  // never two env
  for (const [p, env] of cases) assert.ok((withEnv(p, env).match(/[?&]env=/g) ?? []).length <= 1, p)
})

test('static: alert and drawer links go through withEnv; Telegram without env', () => {
  assert.match(SRC('client/src/AlertBell.jsx'), /<Link href=\{withEnv\(a\.link \|\| '\/alerts', env\)\}/)
  const alerts = SRC('client/src/views/Alerts.jsx')
  assert.match(alerts, /<Link href=\{withEnv\(a\.link, env\)\}/)
  // the row also receives select (admin checkbox)
  assert.match(alerts, /<AlertRow key=\{a\.key\} a=\{a\} env=\{env\}\s/)
  assert.doesNotMatch(alerts, /href=\{a\.link\}/)
  assert.match(SRC('client/src/DeviceDrawer.jsx'), /navigate\(withEnv\(`\/network\?tab=carte&n=/)
  assert.match(SRC('client/src/PortsSection.jsx'), /href=\{withEnv\(`\/services\?s=/)
  // no other rendering of a.link outside withEnv in the client
  for (const f of ['client/src/AlertBell.jsx', 'client/src/views/Alerts.jsx', 'client/src/views/Cockpit.jsx']) {
    assert.doesNotMatch(SRC(f), /href=\{a\.link/, f)
  }
  // Telegram: dashboardUrl + link, without env (no current environment outside the browser)
  const fmt = SRC('server/lib/notify/format.js')
  assert.doesNotMatch(fmt, /withEnv|env=/)
})

// The last internal links go through withEnv, without concatenation
test('shapes of the fixed links (palette, menu, Cockpit, wall display)', () => {
  const forms = [
    ['/services?q=Home%20Assistant', 'prod', '/services?q=Home%20Assistant&env=prod'],
    ['/services?state=crit,warn', 'dev', '/services?state=crit,warn&env=dev'],
    ['/services?state=crit,warn', 'all', '/services?state=crit,warn'],
    ['/reseau?d=12', 'prod', '/reseau?d=12&env=prod'],
    ['/reseau?state=new', 'prod', '/reseau?state=new&env=prod'],
    ['/sauvegardes', 'dev', '/sauvegardes?env=dev'],
    ['/ci', 'prod', '/ci?env=prod'],
    ['/mural', 'prod', '/mural?env=prod'],
    ['/', 'dev', '/?env=dev'],
    ['/', 'all', '/'],
  ]
  for (const [p, env, want] of forms) assert.equal(withEnv(p, env), want, `${p} + ${env}`)
})

test('static: every use goes through withEnv; no more concatenation or hard-coded internal route', () => {
  const pal = SRC('client/src/CommandPalette.jsx')
  assert.match(pal, /navigate\(withEnv\(`\/services\?q=\$\{encodeURIComponent\(s\.name\)\}`, env\)\)/)
  assert.match(pal, /navigate\(withEnv\(`\/network\?d=\$\{d\.id\}`, env\)\)/)
  assert.match(SRC('client/src/Shell.jsx'), /href=\{withEnv\(c\.crit \|\| c\.warn \? '\/services\?state=crit,warn' : '\/services', env\)\}/)
  const ck = SRC('client/src/views/Cockpit.jsx')
  assert.match(ck, /href=\{withEnv\(sv\.crit \|\| sv\.warn \? '\/services\?state=crit,warn' : '\/services', env\)\}/)
  // CI tile of the gitea plugin
  assert.match(SRC('client/src/plugins/gitea/tiles.jsx'), /href=\{withEnv\('\/ci', env\)\}/)
  assert.match(ck, /href=\{withEnv\(net\.new \? '\/network\?state=new' : '\/network', env\)\}/)
  assert.match(ck, /<Link href=\{withEnv\('\/wall', env\)\}/)
  assert.match(ck, /<Banner q=\{summary\} mural=\{mural\} env=\{env\} \/>/)
  assert.match(ck, /<Link href=\{withEnv\('\/backups', env\)\}[^>]*>\{t\('cockpit\.details_per_guest'\)\}/) // label from the catalogue
  assert.match(ck, /<BackupsCard s=\{s\} env=\{env\} \/>/)
  assert.match(SRC('client/src/views/Mural.jsx'), /<Link href=\{withEnv\('\/', env\)\}/)
  // in all of client/src: neither "? '&' : '?'", nor href or navigate to a hard-coded internal route
  const files = fs.readdirSync(path.join(ROOT, 'client/src'), { recursive: true }).filter(f => /\.jsx?$/.test(f))
  for (const f of files) {
    const src = SRC(path.join('client/src', f))
    assert.doesNotMatch(src, /\? '&' : '\?'/, f)
    for (const m of src.matchAll(/(?:href=\{?["'`]|navigate\(["'`])(\/[^"'`]*)/g)) {
      // only exceptions: an API download, and the App redirect that keeps the received query
      assert.ok(m[1].startsWith('/api/') || (f === 'App.jsx' && m[1].startsWith('/services?${search}')), `${f}: ${m[0]}`)
    }
  }
})
