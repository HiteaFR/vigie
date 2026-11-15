// Escape: a single key press never closes two elements.
// - the bell, when its panel is open, listens in the CAPTURE phase (before any bubbling listener,
//   whatever the registration order), marks the event (preventDefault) and closes;
// - a drawer ignores an Escape already handled (defaultPrevented), or meant for a <dialog> modal
//   (a modal open in the document, or a target inside a dialog): the browser closes the
//   modal, the drawer stays open.
// Pure code, no React: win and doc are injected (tests with a fake window).

// → unsubscribe function
export function listenBellEscape(win, { close }) {
  const onKey = e => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    close()
  }
  win.addEventListener('keydown', onKey, { capture: true })
  return () => win.removeEventListener('keydown', onKey, { capture: true })
}

// → unsubscribe function
export function listenDrawerEscape(win, close, doc) {
  const onKey = e => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    if (doc?.querySelector?.('dialog[open]')) return
    if (e.target?.closest?.('dialog')) return
    close()
  }
  win.addEventListener('keydown', onKey)
  return () => win.removeEventListener('keydown', onKey)
}
