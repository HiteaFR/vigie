import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Lock, LogOut, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useSource, useJson } from './api.js'
import { localeTag, t } from './i18n/index.js'

// Writes behind an admin session (HttpOnly cookie set by the server). This context holds the
// session, the login window, the sending of actions and a confirmation message. No sensitive
// data client side.
const Ctx = createContext(null)
export const useAdmin = () => useContext(Ctx)

export async function post(url, body = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status })
  return j
}

// native modal window (<dialog>): focus, Escape and inert background handled by the browser
export function Modal({ open, onClose, title, children }) {
  const ref = useRef(null)
  // close requested by the code (open → false): do not report it as a cancellation
  const closingByCode = useRef(false)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) {
      closingByCode.current = true
      d.close()
    }
  }, [open])
  const onDialogClose = () => {
    if (closingByCode.current) {
      closingByCode.current = false
      return
    }
    onClose()
  }
  return (
    <dialog ref={ref} onClose={onDialogClose} aria-label={title}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-[var(--radius-card)] border border-line bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/50">
      {open && (
        <div className="p-4">
          <div className="mb-3 flex items-start gap-2">
            <h2 className="flex-1 text-sm font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-3 hover:text-fg" aria-label={t('admin.close')}><X size={16} aria-hidden /></button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  )
}

export const field = 'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none'
const btn = 'rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50'
// hover with brightness-90 (the text stays ≥ 4.5:1); opacity-90 lightened the background (4.48:1 in light mode)
export const btnPrimary = `${btn} bg-accent text-accent-fg hover:brightness-90`
export const btnGhost = `${btn} border border-line text-muted hover:text-fg hover:border-line-strong`

function LoginDialog({ open, onClose, onDone }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post('/api/login', { password })
      setPassword('')
      onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={t('admin.admin_login')}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-muted">{t('admin.needed_acknowledge_set_silence')}</p>
        <input type="password" autoComplete="current-password" required autoFocus value={password} onChange={e => setPassword(e.target.value)}
          className={field} placeholder={t('admin.password')} aria-label={t('admin.password')} />
        {error && <p className="text-xs text-crit" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btnGhost}>{t('admin.cancel')}</button>
          <button type="submit" disabled={busy || !password} className={btnPrimary}>{t('admin.log_in')}</button>
        </div>
      </form>
    </Modal>
  )
}

export function AdminProvider({ children }) {
  const session = useSource('session')
  const qc = useQueryClient()
  const [loginOpen, setLoginOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const pendingAfterLogin = useRef(null)
  const s = session.data

  const notify = useCallback((text, tone = 'ok') => {
    setToast({ text, tone, id: Date.now() })
  }, [])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(id)
  }, [toast])

  const requireLogin = useCallback(then => {
    pendingAfterLogin.current = then ?? null
    setLoginOpen(true)
  }, [])

  // write action: 401 → login, then nothing automatic (the user retries)
  const act = useCallback(async (url, body, { invalidate = [], success } = {}) => {
    try {
      const r = await post(url, body)
      for (const k of invalidate) qc.invalidateQueries({ queryKey: [k] })
      if (success) notify(success)
      return r
    } catch (e) {
      if (e.status === 401) {
        session.refetch()
        requireLogin()
      }
      notify(e.message, 'crit')
      throw e
    }
  }, [qc, notify, requireLogin, session])

  const logout = useCallback(async () => {
    await post('/api/logout').catch(() => {})
    await session.refetch()
    notify(t('admin.logged_out'))
  }, [session, notify])

  // sessionError: /api/session failed, the application is shown anyway (lib/access.js)
  const value = { session: s, sessionError: !!session.error, isAdmin: !!s?.admin, configured: !!s?.configured, requireLogin, act, notify, logout }
  return (
    <Ctx.Provider value={value}>
      {children}
      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} onDone={async () => {
        setLoginOpen(false)
        await session.refetch()
        notify(t('admin.logged_in_12h'))
        pendingAfterLogin.current?.()
        pendingAfterLogin.current = null
      }} />
      <div role="status" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 md:bottom-6">
        {toast && (
          <div key={toast.id} className={`pointer-events-auto max-w-md rounded-lg border px-3 py-2 text-xs shadow-lg ${toast.tone === 'crit' ? 'border-crit bg-crit-bg text-crit' : 'border-line bg-surface text-fg'}`}>
            {toast.text}
          </div>
        )}
      </div>
    </Ctx.Provider>
  )
}

// header: session state (login / admin)
export function AdminButton() {
  const { session, isAdmin, configured, requireLogin, logout } = useAdmin()
  if (!session || !configured || !session.networkAllowed) return null
  return isAdmin
    ? (
      <button type="button" onClick={logout} title={t('admin.session_until', { time: new Date(session.expiresAt).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) })}
        className="flex items-center gap-1 rounded-lg border border-accent/50 bg-surface px-2 py-1.5 text-xs text-accent hover:border-accent">
        <ShieldCheck size={14} aria-hidden /><span className="hidden lg:inline">admin</span><LogOut size={12} aria-hidden className="hidden lg:inline" />
      </button>
    )
    : (
      <button type="button" onClick={() => requireLogin()} aria-label={t('admin.admin_login')} title={t('admin.admin_login')}
        className="rounded-lg border border-line bg-surface p-1.5 text-muted hover:text-fg">
        <Lock size={15} aria-hidden />
      </button>
    )
}

// header: "Refresh" (agent, probes, Proxmox, versions), admin only
export function RefreshButton() {
  const { isAdmin, configured, requireLogin, act, notify, session } = useAdmin()
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const status = useJson(running ? '/api/refresh' : null, 2000)
  useEffect(() => {
    if (running && status.data && !status.data.running && status.data.last) {
      setRunning(false)
      qc.invalidateQueries()
      const l = status.data.last
      notify(`${t('admin.refresh_done', { s: Math.round((l.finishedAt - l.startedAt) / 1000) })}${l.errors?.length ? t('admin.refresh_errors', { count: l.errors.length }) : ''}`)
    }
  }, [running, status.data, qc, notify])
  if (!session || !configured || !session.networkAllowed) return null
  async function click() {
    if (!isAdmin) return requireLogin(click)
    try {
      await act('/api/refresh', {})
      setRunning(true)
      notify(t('admin.refresh_started'))
    } catch { /* message already shown */ }
  }
  return (
    <button type="button" onClick={click} disabled={running} aria-label={t('admin.refresh_all_data')} title={t('admin.refresh_all_data_agents')}
      className="rounded-lg border border-line bg-surface p-1.5 text-muted hover:text-fg disabled:text-accent">
      <RefreshCw size={15} aria-hidden className={running ? 'animate-spin' : ''} />
    </button>
  )
}

// action form: reason required (3 to 200 characters) + action-specific fields
// canSubmit: false while the form has no effective choice (button disabled)
export function ReasonForm({ onSubmit, onCancel, submitLabel, children, placeholder = t('admin.reason_required'), canSubmit = true }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = reason.trim().length >= 3
  return (
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault()
      setBusy(true)
      try {
        await onSubmit(reason.trim())
      } catch { /* message already shown */ } finally {
        setBusy(false)
      }
    }}>
      {children}
      <label className="block text-xs text-muted">
        {t('admin.reason')}
        <textarea required minLength={3} maxLength={200} rows={2} value={reason} onChange={e => setReason(e.target.value)} className={`${field} mt-1`} placeholder={placeholder} autoFocus />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnGhost}>{t('admin.cancel')}</button>
        <button type="submit" disabled={busy || !ok || !canSubmit} className={btnPrimary}>{submitLabel}</button>
      </div>
    </form>
  )
}
