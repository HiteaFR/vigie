import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { X } from 'lucide-react'
import Cockpit from './Cockpit.jsx'
import ServiceDrawer from '../ServiceDrawer.jsx'
import { startMinuteTicks } from '../lib/minuteTick.js'
import { useEnv } from '../hooks/useUrlState.js'
import { withEnv } from '../nav.js'
import { localeTag, t } from '../i18n/index.js'

// Wall display mode: cockpit only, full screen, for a dedicated screen. Cursor hidden after
// 3 s of inactivity; full reload every 6 h (new front-end version, memory leaks). If the server
// stops answering, the banner switches to "disconnected": a frozen screen showing green is the
// worst case.

// time and date in their own component, one tick per minute aligned on the minute change; the
// Cockpit is no longer re-rendered every second
export function MuralClock({ initial = null }) {
  const [now, setNow] = useState(() => initial ?? new Date())
  useEffect(() => startMinuteTicks(() => setNow(new Date())), [])
  return (
    <>
      <time className="ml-auto font-mono text-2xl tabular-nums text-fg">
        {now.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })}
      </time>
      <span className="hidden md:block text-sm text-muted">{now.toLocaleDateString(localeTag(), { weekday: 'long', day: 'numeric', month: 'long' })}</span>
    </>
  )
}

export default function Mural({ config }) {
  const [idle, setIdle] = useState(false)
  const [env] = useEnv()

  useEffect(() => {
    let t
    const wake = () => {
      setIdle(false)
      clearTimeout(t)
      t = setTimeout(() => setIdle(true), 3000)
    }
    wake()
    window.addEventListener('mousemove', wake)
    window.addEventListener('keydown', wake)
    const reload = setTimeout(() => window.location.reload(), 6 * 3600_000)
    return () => {
      clearTimeout(t)
      clearTimeout(reload)
      window.removeEventListener('mousemove', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [])

  return (
    <div className={`min-h-full bg-bg px-4 py-4 md:px-8 md:py-6 ${idle ? 'cursor-none' : ''}`}>
      <header className="mb-4 flex items-center gap-4">
        <h1 className="text-lg font-bold text-fg">{config?.title || 'Vigie'}</h1>
        <MuralClock />
        <Link href={withEnv('/', env)} className={`rounded-lg border border-line bg-surface p-1.5 text-muted hover:text-fg transition-opacity ${idle ? 'opacity-0' : ''}`} aria-label={t('wall.exit_wall_mode')}>
          <X size={16} aria-hidden />
        </Link>
      </header>
      <Cockpit mural />
      <ServiceDrawer />
    </div>
  )
}
