import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { post, field, btnPrimary } from './admin.jsx'
import { loginBlocker } from './lib/access.js'
import { titleOf } from './lib/title.js'
import { t } from './i18n/index.js'

// Full login screen, when reading the API requires a session (no anonymous read) and there is
// none: SPA and wall display. After logging in, every request is retried (session included:
// the application is shown).
export default function LoginScreen({ session, config }) {
  const qc = useQueryClient()
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const blocker = loginBlocker(session)
  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post('/api/login', { password })
      setPassword('')
      await qc.invalidateQueries()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 text-fg">
      <div className="w-[min(24rem,100%)] rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-lg">
        <div className="mb-4 flex items-center gap-2">
          <Lock size={18} className="text-muted" aria-hidden />
          <h1 className="text-base font-semibold">{titleOf(config)}</h1>
        </div>
        <p className="mb-4 text-xs text-muted">{t('login.login_required_view_dashboard')}</p>
        {blocker
          ? <p className="text-xs text-crit" role="alert">{blocker}</p>
          : (
            <form onSubmit={submit} className="space-y-3">
              <input type="password" autoComplete="current-password" required autoFocus value={password} onChange={e => setPassword(e.target.value)}
                className={field} placeholder={t('login.password')} aria-label={t('login.password')} />
              {error && <p className="text-xs text-crit" role="alert">{error}</p>}
              <div className="flex justify-end">
                <button type="submit" disabled={busy || !password} className={btnPrimary}>{t('login.submit')}</button>
              </div>
            </form>
          )}
      </div>
    </main>
  )
}
