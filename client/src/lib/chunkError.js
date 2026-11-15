// View not found after a deployment (old chunks are deleted, while an open tab or the wall
// display still points at their names). PURE decision, tested without a browser.
export const RELOAD_KEY = 'vigie.chunkReload'

// chunk load failure (rejected dynamic import): Chrome, Firefox, Safari, Vite
const CHUNK_RE = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css|loading (?:css )?chunk \S+ failed/i
export function isChunkError(err) {
  if (!err) return false
  if (err.name === 'ChunkLoadError') return true
  return CHUNK_RE.test(String(err.message ?? err))
}

// → 'reload': ONE full reload per build (the current build is noted in storage; after the
// reload, a new build has another id); 'message': this build already reloaded once, or
// storage is unavailable (never reload without a guard: no loop possible);
// 'error': any other render error, never reload
export function chunkDecision(err, { storage, build }) {
  if (!isChunkError(err)) return 'error'
  try {
    if (storage.getItem(RELOAD_KEY) === build) return 'message'
    storage.setItem(RELOAD_KEY, build)
    return 'reload'
  } catch {
    return 'message'
  }
}
