import { useCallback } from 'react'
import { useLocation, useSearch } from 'wouter'
import { load, save } from '../lib/storage.js'

// One URL parameter (?key=…) read and written without pushing history entries
export function useUrlParam(key, fallback = '') {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const value = new URLSearchParams(search).get(key) ?? fallback
  const setValue = useCallback(v => {
    const p = new URLSearchParams(window.location.search)
    if (v === '' || v == null || v === fallback) p.delete(key)
    else p.set(key, v)
    const qs = p.toString()
    navigate(`${location}${qs ? `?${qs}` : ''}`, { replace: true })
  }, [key, fallback, location, navigate])
  return [value, setValue]
}

// Global environment filter: URL first, otherwise the last remembered choice
export function useEnv() {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const fromUrl = new URLSearchParams(search).get('env')
  const env = ['all', 'prod', 'dev'].includes(fromUrl) ? fromUrl : load('vigie.env', 'all')
  const setEnv = useCallback(v => {
    save('vigie.env', v)
    const p = new URLSearchParams(window.location.search)
    if (v === 'all') p.delete('env')
    else p.set('env', v)
    const qs = p.toString()
    navigate(`${location}${qs ? `?${qs}` : ''}`, { replace: true })
  }, [location, navigate])
  return [env, setEnv]
}

// pure filter, in lib/env.js (usable by code without React)
export { matchEnv } from '../lib/env.js'
