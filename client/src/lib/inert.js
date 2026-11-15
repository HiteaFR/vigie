// Inert background while a drawer is open. The Shell container (id APP_SHELL_ID: sidebar,
// header, main, mobile nav) gets the inert attribute: no click or focus behind, and Tab no
// longer leaves the drawer. Drawers, the login modal (AdminProvider), the toast and the
// palette are OUTSIDE this container: they are never made inert. Counter: two holds do not
// release each other. doc is injected (tests with a fake document).
export const APP_SHELL_ID = 'app-shell'
let held = 0
// → release function (idempotent)
export function holdInert(doc) {
  held++
  doc.getElementById(APP_SHELL_ID)?.setAttribute('inert', '')
  let done = false
  return () => {
    if (done) return
    done = true
    held = Math.max(0, held - 1)
    if (held === 0) doc.getElementById(APP_SHELL_ID)?.removeAttribute('inert')
  }
}
