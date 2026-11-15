// vendored icon, otherwise a tinted monogram (stable: derived from the name)
function hue(s) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

function initials(name) {
  const words = name.replace(/[()]/g, ' ').split(/[\s\-_.]+/).filter(Boolean)
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export default function ServiceIcon({ name, iconUrl, iconUrlDark, size = 32 }) {
  if (iconUrl) {
    const img = (src, cls) => (
      <img src={src} alt="" width={size} height={size} loading="lazy" className={`shrink-0 object-contain ${cls}`} style={{ width: size, height: size }} />
    )
    // monochrome icons (GitHub, X…): light variant in the dark theme, through CSS
    if (!iconUrlDark) return img(iconUrl, '')
    return <>{img(iconUrl, 'dark:hidden')}{img(iconUrlDark, 'hidden dark:block')}</>
  }
  const h = hue(name)
  return (
    <span
      aria-hidden
      className="shrink-0 grid place-items-center rounded-md font-semibold"
      style={{
        width: size, height: size, fontSize: size * 0.4,
        background: `hsl(${h} 60% 50% / 0.16)`, color: `hsl(${h} 55% 45%)`,
      }}
    >
      {initials(name)}
    </span>
  )
}
