import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.jsx'
import { AdminProvider } from './admin.jsx'
import { loadLocale, loadedLocales, locale } from './i18n/index.js'
import { boot, showFatal } from './boot.js'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    // refetchInterval does not run while the tab is hidden (refetchIntervalInBackground: false)
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5000 },
  },
})

// instance locale BEFORE the first render (no screen in the wrong language): /api/config (public
// read, bounded delay), then the locale's catalog, otherwise the default locale's, otherwise a
// readable message instead of a blank page (boot.js, run by the tests)
const root = document.getElementById('root')
boot({
  fetchImpl: (url, opts) => fetch(url, opts),
  i18n: { loadLocale, loadedLocales },
  onConfig: config => queryClient.setQueryData(['config'], config),
  // document language = instance locale (index.html says "en", the product locale)
  render: () => (document.documentElement.lang = locale(), createRoot(root).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <AdminProvider>
          <App />
        </AdminProvider>
      </QueryClientProvider>
    </React.StrictMode>,
  )),
  fail: () => showFatal(root),
})
