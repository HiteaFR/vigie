// Dependency-free version comparison: the numeric sequence is extracted
// ("v6.4.2", "1.30.5-1~bookworm", "DSM 7.4.1-90080", "4.0.20.3014",
// HA calver "2026.10.1") and compared component by component.
// The gap is classified major / minor / patch by the first component that
// differs; a calendar version (2026.10 → 2026.11) is never "major".

const PRE = /(?:^|[.\-_+~])(rc|beta|alpha|dev|pre|preview|nightly|canary|b\d|a\d)/i

export function parseVersion(v) {
  if (v == null) return null
  const str = String(v).replace(/^\d+:/, '') // Debian epoch (5:29.8.1-1)
  const m = str.match(/(\d+(?:\.\d+)*)/)
  if (!m) return null
  const nums = m[1].split('.').map(Number)
  const rest = str.slice(m.index + m[1].length)
  return { nums, prerelease: PRE.test(rest), calver: nums[0] >= 2000 && nums.length >= 2 }
}

export function compareVersions(a, b) {
  const x = typeof a === 'string' || a == null ? parseVersion(a) : a
  const y = typeof b === 'string' || b == null ? parseVersion(b) : b
  if (!x || !y) return null
  const len = Math.max(x.nums.length, y.nums.length)
  for (let i = 0; i < len; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

// installed → latest: 'same' | 'ahead' | 'major' | 'minor' | 'patch' | 'unknown'
export function versionGap(current, latest) {
  if (current == null || latest == null) return null
  const x = parseVersion(current)
  const y = parseVersion(latest)
  if (!x || !y) return String(current).trim() === String(latest).trim() ? 'same' : 'unknown'
  const c = compareVersions(x, y)
  if (c === 0) return 'same'
  if (c > 0) return 'ahead'
  const len = Math.max(x.nums.length, y.nums.length)
  let i = 0
  while (i < len && (x.nums[i] ?? 0) === (y.nums[i] ?? 0)) i++
  if (x.calver || y.calver) return i <= 1 ? 'minor' : 'patch'
  return i === 0 ? 'major' : i === 1 ? 'minor' : 'patch'
}

export const majorOf = v => parseVersion(v)?.nums[0] ?? null

// shape of a Docker tag: "16-alpine" → "#-alpine", "v1.21" → "v#.#"
export const tagShape = tag => String(tag).replace(/\d+/g, '#')

// highest version of a list (prereleases skipped unless requested)
export function newest(list, { pick = x => x, prerelease = false } = {}) {
  let best = null
  for (const item of list) {
    const p = parseVersion(pick(item))
    if (!p || (p.prerelease && !prerelease)) continue
    if (!best || compareVersions(p, best.p) > 0) best = { item, p }
  }
  return best?.item ?? null
}

// display order: security / EOL first, then major, minor, patch
export const GAP_RANK = { security: 0, eol: 0, major: 1, minor: 2, digest: 3, deploy: 3, patch: 4, unknown: 5, ahead: 6, same: 7 }
