import { Component } from 'react'
import { RotateCw } from 'lucide-react'
import { chunkDecision } from '../lib/chunkError.js'
import { t } from '../i18n/index.js'

// Error boundary around the views' Suspense. A chunk load failure → one full reload (at most
// one per build, lib/chunkError.js), otherwise a plain box with a Reload button; any other
// render error goes in the same box, with a neutral label, without reloading. The Shell and the
// navigation stay; the boundary resets when the route changes (resetKey).
export function ViewErrorPanel({ kind, message = null, onReload = () => window.location.reload() }) {
  const chunk = kind === 'message'
  return (
    <div role="alert" className="mx-auto max-w-lg rounded-[var(--radius-card)] border border-line bg-surface px-5 py-6 text-center">
      <p className="text-sm font-semibold text-fg">{chunk ? t('ui.new_dashboard_version_available') : t('ui.view_ran_into_error')}</p>
      <p className="mt-1 text-xs text-muted">{chunk ? t('ui.view_could_not_load') : message || t('ui.unknown_error')}</p>
      <button type="button" onClick={onReload} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:brightness-90">
        <RotateCw size={14} aria-hidden />{t('ui.reload')}
      </button>
    </div>
  )
}

// build id: the URL of this module, in the main bundle (hashed name, changes with every build)
const BUILD = import.meta.url

const sessionStore = () => {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export default class ViewBoundary extends Component {
  state = { error: null, kind: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    const kind = chunkDecision(error, { storage: sessionStore(), build: BUILD })
    if (kind === 'reload') {
      window.location.reload()
      return
    }
    this.setState({ kind })
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null, kind: null })
  }

  render() {
    const { error, kind } = this.state
    if (!error) return this.props.children
    // reload in progress (or decision pending): nothing, so the box never flashes for a split second
    if (!kind) return null
    return <ViewErrorPanel kind={kind} message={kind === 'error' ? String(error?.message ?? error).slice(0, 300) : null} />
  }
}
