import { t } from '../i18n/index.js'
// Should the login screen be shown instead of the application? PURE decision on the
// /api/session response, tested without a browser.
//   'pending'      : session not read yet (minimal loading state, at most SESSION_WAIT_MS; past that,
//                    the caller passes error: true and the application is shown, as on failure);
//   'unconfigured' : no config file: "to be configured" page, before anything else;
//   'login'        : API reads require a session (no anonymous read) and there is no session;
//   'open'         : admin session, or anonymous read (no visible change), or /api/session
//                    failed (the application is shown with its errors).
export const SESSION_WAIT_MS = 3000

export function accessState(session, { error = false } = {}) {
  if (!session) return error ? 'open' : 'pending'
  if (session.unconfigured) return 'unconfigured'
  if (session.admin || session.anonymousRead !== false) return 'open'
  return 'login'
}

// what prevents logging in from here, in the order the server would refuse → message, or null
export function loginBlocker(session) {
  if (!session?.configured) return t('access.not_configured')
  if (!session.networkAllowed) return t('access.network')
  if (session.httpRefused) return t('access.http')
  return null
}
