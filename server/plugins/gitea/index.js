// Gitea, the first plugin (lib/plugins/host.js). Repository activity (last commit, open PRs,
// last run of the default branch) and Gitea Actions runners: collection, alerts (ci_failed,
// runner_offline, source_error:gitea and source_error:runners), "⚙️ CI" digest line (ci slot),
// ci block of /api/summary, /api/gitea and /api/runners routes, "Repository" items of the
// Updates page (deploy:<repo>).
//
// Config: plugins.gitea { owner, repos }; the legacy root "gitea" block is accepted (with a
// warning at startup) until the public release; both at once are refused. Secrets: GITEA_URL
// and GITEA_TOKEN (environment variables). Gitea is "configured" only with a block AND a
// non-empty GITEA_URL; otherwise nothing is read: snapshots { configured: false }, no alert,
// digest and summary say "not configured", routes answer { configured: false }. The plugin
// therefore stays active; "not configured" is a state of its own. The token goes through
// ctx.http (secret enforced by the Authorization header).
import { z } from 'zod'
import { definePlugin, pluginLocales } from '../../lib/plugins/host.js'

const configSchema = z.object({ owner: z.string(), repos: z.array(z.string()).default([]) }).strict()

export default definePlugin({
  id: 'gitea', apiVersion: 0, label: 'Gitea',
  configSchema,
  configKeys: ['plugins.gitea', 'gitea'],
  secrets: ['GITEA_URL', 'GITEA_TOKEN'],
  configured: () => true,
  // texts through the plugin catalog (locales/fr.json, locales/en.json), ctx.t
  locales: pluginLocales(import.meta.url),
  setup(ctx) {
    const cfg = ctx.config ?? null
    const GITEA_URL = ctx.secret('GITEA_URL')
    const GITEA_TOKEN = ctx.secret('GITEA_TOKEN')
    const configured = !!cfg && typeof GITEA_URL === 'string' && GITEA_URL.trim() !== ''
    if (ctx.configKey === 'gitea') ctx.log.warn('config.json: old "gitea" block, replace it with "plugins.gitea" (accepted until publication)')

    // cache per source (repositories 60 s, runners 15 s), cleared by "Refresh"
    const cache = new Map()
    function cached(key, ttlMs, fn) {
      const hit = cache.get(key)
      if (hit && ctx.now() - hit.t < ttlMs) return hit.v
      const entry = { t: ctx.now(), v: fn() }
      cache.set(key, entry)
      entry.v.catch(() => {
        if (cache.get(key) === entry) cache.delete(key)
      })
      return entry.v
    }

    async function gitea(pathname) {
      if (!configured) throw new Error(ctx.t('not_configured'))
      const r = await ctx.http(`${GITEA_URL}/api/v1${pathname}`, { headers: { Authorization: `token ${GITEA_TOKEN}` } })
      if (!r.ok) throw new Error(`Gitea ${r.status}`)
      return r.json()
    }

    // Gitea activity: last commit + open PRs + last run of the default branch
    const repos = () => cached('gitea', 60000, async () => {
      if (!configured) throw new Error(ctx.t('not_configured'))
      const owner = cfg.owner
      let names = cfg.repos
      if (!names || !names.length) {
        const list = await gitea(`/users/${owner}/repos?limit=50`)
        names = list.map(r => r.name)
      }
      names = names.slice(0, 12)
      return Promise.all(names.map(async name => {
        try {
          const [commits, pulls, repo, runs] = await Promise.all([
            gitea(`/repos/${owner}/${name}/commits?limit=1&stat=false&verification=false`).catch(() => []),
            gitea(`/repos/${owner}/${name}/pulls?state=open&limit=50`).catch(() => []),
            gitea(`/repos/${owner}/${name}`).catch(() => ({})),
            gitea(`/repos/${owner}/${name}/actions/tasks?limit=10`).catch(() => ({})),
          ])
          const c = Array.isArray(commits) ? commits[0] : null
          const list = runs?.workflow_runs || []
          const run = list[0]
          const branch = repo.default_branch || 'main'
          const mainRun = list.find(r => r.head_branch === branch)
          // last successful run of the default branch (deployment drift)
          const lastSuccess = list.find(r => r.head_branch === branch && r.status === 'success')
          const runView = r => ({
            status: r.status,
            number: r.run_number,
            sha: r.head_sha ? String(r.head_sha).slice(0, 7) : null,
            title: r.display_title || r.name,
            branch: r.head_branch ?? null,
            date: r.updated || r.updated_at || r.created || r.created_at,
            url: `${GITEA_URL}/${owner}/${name}/actions/runs/${r.run_number}`,
          })
          return {
            name,
            htmlUrl: repo.html_url || `${GITEA_URL}/${owner}/${name}`,
            openPRs: Array.isArray(pulls) ? pulls.length : 0,
            lastCommit: c ? {
              message: String(c.commit?.message || '').split('\n')[0],
              author: c.commit?.author?.name || c.author?.login || '?',
              date: c.commit?.author?.date,
              sha: String(c.sha || '').slice(0, 7),
              url: c.html_url,
            } : null,
            lastRun: run ? runView(run) : null,
            defaultBranch: branch,
            mainRun: mainRun ? runView(mainRun) : null,
            lastSuccess: lastSuccess ? runView(lastSuccess) : null,
          }
        } catch {
          return { name, error: true }
        }
      }))
    })

    // Gitea Actions runners (online/offline) — requires a token with the read:admin scope
    const runners = () => cached('runners', 15000, async () => {
      const r = await gitea('/admin/actions/runners')
      const list = r?.runners || (Array.isArray(r) ? r : [])
      return list.map(x => ({
        id: x.id,
        name: x.name,
        status: x.status,
        busy: x.busy ?? false,
        labels: (x.labels || []).map(l => l.name),
      })).sort((a, b) => a.id - b.id)
    })

    // repositories of the collector's last successful read ("Repository" items of the Updates page)
    let lastRepos = null

    return {
      // runners every 60 s, repositories every 120 s
      collect: {
        runners: { periodSec: 60, configured, fn: () => runners() },
        gitea: { periodSec: 120, configured, fn: async () => (lastRepos = await repos()) },
      },

      rules: ['ci_failed', 'runner_offline', 'source_error'],
      labels: { ci_failed: ctx.tAll('label.ci_failed'), runner_offline: ctx.tAll('label.runner_offline') },
      // right before the agent rules
      signalsAt: 'ci',
      signals(snap) {
        const out = []
        // source not configured ({ configured: false }): no alert, not even pending
        const sourceErr = (name, title, s) => s?.configured === false ? null : out.push({
          key: `source_error:${name}`, rule: 'source_error', entity: name, title, env: 'prod',
          cond: s ? !!s.error : null, forSec: 600, severity: 'warning', detail: s?.error || null,
          link: '/ci', parents: [],
        })
        sourceErr('gitea', ctx.t('source.gitea'), snap.gitea)
        sourceErr('runners', ctx.t('source.runners'), snap.runners)

        for (const r of snap.gitea?.error ? [] : snap.gitea?.data || []) {
          if (r.error) continue
          const run = r.mainRun
          const st = run?.status
          out.push({
            key: `ci_failed:${r.name}`, rule: 'ci_failed', entity: r.name, title: `CI ${r.name}`, env: 'prod',
            cond: st === 'failure' ? true : st === 'success' ? false : null,
            severity: 'warning', detail: run ? `${r.defaultBranch} #${run.number} ${run.title}` : null,
            link: '/ci', parents: [],
          })
        }
        for (const x of snap.runners?.error ? [] : snap.runners?.data || []) {
          out.push({
            key: `runner_offline:${x.name}`, rule: 'runner_offline', entity: x.name, title: `Runner ${x.name}`,
            env: 'prod', cond: x.status !== 'online', forSec: 600, severity: 'warning',
            detail: ctx.t('runner.state', { status: x.status }), link: '/ci', parents: [],
          })
        }
        return out
      },

      // "⚙️ CI" digest line (plain text: the host escapes it)
      digest: {
        slot: 'ci',
        lines({ snap }) {
          const failing = (snap.gitea?.data || []).filter(r => r.mainRun?.status === 'failure').map(r => r.name)
          const run = snap.runners?.data
          const ci = []
          // Gitea not configured: a line that says so, never "no failure"
          if (snap.gitea?.configured === false) ci.push(ctx.t('digest.not_configured'))
          else if (run) ci.push(ctx.t('digest.runners', { online: run.filter(r => r.status === 'online').length, total: run.length }))
          if (snap.gitea?.configured !== false) ci.push(failing.length ? ctx.t('digest.failing', { list: failing.join(', ') }) : ctx.t('digest.no_failure'))
          return [ctx.t('digest.line', { parts: ci.join(' · ') })]
        },
      },

      // ci block of /api/summary (not filtered by environment: repositories are neither prod nor dev)
      summary: {
        key: 'ci',
        value({ snap }) {
          const run = snap.runners?.data
          const list = snap.gitea?.data || []
          return {
            // Gitea not configured (no gitea block or no GITEA_URL): the CI tile says so
            configured: snap.gitea?.configured !== false,
            runnersOnline: run ? run.filter(r => r.status === 'online').length : null,
            runnersTotal: run ? run.length : null,
            failing: list.filter(r => r.mainRun?.status === 'failure').map(r => ({ name: r.name, number: r.mainRun.number, date: r.mainRun.date })),
            running: list.filter(r => ['running', 'waiting'].includes(r.lastRun?.status)).length,
            error: snap.runners?.error || snap.gitea?.error || null,
          }
        },
      },

      // stable paths and answers (contract read by the tools: an array with mainRun;
      // { configured: false } without Gitea), with the read routes of the sources
      routesAt: 'sources',
      routes(router, { wrap }) {
        const read = fn => wrap(async (req, res) => {
          if (!configured) return res.json({ configured: false })
          try {
            res.json(await fn())
          } catch (e) {
            res.status(502).json({ error: String(e.message || e) })
          }
        })
        router.get('/api/gitea', read(repos))
        router.get('/api/runners', read(runners))
      },

      // repositories: HEAD of the default branch without a successful run
      components() {
        const out = []
        for (const r of lastRepos || []) {
          if (r.error || !r.lastCommit?.sha || !r.lastSuccess) continue
          const head = r.lastCommit.sha
          const ok = r.lastSuccess
          if (['running', 'waiting'].includes(r.mainRun?.status)) continue
          const drift = ok.sha && ok.sha !== head
          out.push({
            id: `deploy:${r.name}`, name: r.name, kind: 'deploy', where: 'Gitea', env: 'prod',
            current: ok.sha, latest: head, gap: drift ? 'deploy' : 'same',
            url: r.mainRun?.url ?? r.htmlUrl, publishedAt: r.lastCommit.date,
            detail: drift ? (r.mainRun?.status === 'failure' ? ctx.t('deploy.failed', { branch: r.defaultBranch }) : ctx.t('deploy.ahead', { branch: r.defaultBranch })) : null,
          })
        }
        return out
      },

      invalidate: () => cache.clear(),
      // Integrations page: "not configured" without a block or without GITEA_URL
      status: () => ({ configured }),
    }
  },
})
