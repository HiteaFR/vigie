import { useEffect, useState } from 'react'
import { ago } from '../lib/format.js'
import { localeTag } from '../i18n/index.js'

// relative age that refreshes itself; title = absolute date
export default function TimeAgo({ date, className = '' }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick(x => x + 1), 5000)
    return () => clearInterval(id)
  }, [])
  if (!date) return null
  const ts = typeof date === 'number' ? date : new Date(date).getTime()
  return <time className={className} dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString(localeTag())}>{ago(ts, { seconds: true })}</time>
}
