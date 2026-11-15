import { useEffect, useState } from 'react'
import { tLabels } from '../i18n/index.js'

const media = () => window.matchMedia('(prefers-color-scheme: dark)')

function apply(pref) {
  const dark = pref === 'dark' || (pref !== 'light' && media().matches)
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}

// preference stored as plain text (also read by the inline script of index.html)
function readPref() {
  try { return localStorage.getItem('vigie.theme') || 'auto' } catch { return 'auto' }
}

export function useTheme() {
  const [pref, setPref] = useState(readPref)
  useEffect(() => {
    apply(pref)
    try { localStorage.setItem('vigie.theme', pref) } catch { /* ignore */ }
    if (pref !== 'auto') return
    const m = media()
    const on = () => apply('auto')
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [pref])
  return [pref, setPref]
}

// labels read at render time (catalog theme.<preference>)
export const THEME_LABEL = tLabels('theme', ['auto', 'light', 'dark'])
export const nextTheme = p => (p === 'auto' ? 'light' : p === 'light' ? 'dark' : 'auto')
