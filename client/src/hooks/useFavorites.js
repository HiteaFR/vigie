import { useState } from 'react'
import { load, save } from '../lib/storage.js'

// favorites (star): list of service ids, browser side only
export function useFavorites() {
  const [favs, setFavs] = useState(() => new Set(load('vigie.favs', [])))
  const toggle = id => setFavs(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    save('vigie.favs', [...next])
    return next
  })
  return [favs, toggle]
}
