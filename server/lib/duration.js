// "30s", "5m", "6h" → seconds (format validated by the config schema)
export const seconds = d => {
  const m = /^(\d+)(s|m|h)$/.exec(d)
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]]
}
