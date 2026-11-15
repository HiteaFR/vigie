import { Settings } from 'lucide-react'
import { t } from './i18n/index.js'

// "To be configured" mode (no config file): what to do, without any instance data.
// The init wizard first; by hand next. Details: docs/installation.md.
export default function Unconfigured() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 text-fg">
      <div className="w-[min(32rem,100%)] rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-lg">
        <div className="mb-4 flex items-center gap-2">
          <Settings size={18} className="text-muted" aria-hidden />
          <h1 className="text-base font-semibold">{t('unconf.vigie_setup_needed')}</h1>
        </div>
        <p className="mb-3 text-sm">{t('unconf.no_configuration_file_found')}</p>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
          <li>{t('unconf.run_wizard')} <code>cd server && npm run init</code> {t('unconf.config_admin_password_proxmox')}</li>
          <li>{t('unconf.restart_service')}</li>
        </ol>
        <p className="mt-2 text-xs text-muted">{t('unconf.by_hand_copy')} <code>config.example.json</code> {t('unconf.to')} <code>config.json</code> {t('unconf.generate_password')} <code>node server/scripts/admin-password.js</code>.</p>
        <p className="mt-3 text-xs text-subtle">{t('unconf.details_docs_installation_md')}</p>
      </div>
    </main>
  )
}
