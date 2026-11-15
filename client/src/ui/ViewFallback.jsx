import { t } from '../i18n/index.js'
// Fallback while a view loads on demand (Suspense). Plain and accessible: a busy area
// (aria-busy) the height of a view, to avoid a layout jump, and a text for screen
// readers.
export default function ViewFallback() {
  return (
    <div aria-busy="true" aria-live="polite" className="min-h-[60vh]">
      <span className="sr-only">{t('ui.loading_view')}</span>
    </div>
  )
}
