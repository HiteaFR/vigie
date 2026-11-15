// Error from a non-ok response, in the format of post() (admin.jsx): the "error" field of the
// JSON body, otherwise "HTTP <code>" (empty body, not JSON, or no error field); status kept.
// Pure: reads the body of a Response (or of a { status, text() } object).
export async function httpError(r) {
  let body
  try {
    body = JSON.parse(await r.text())
  } catch {
    body = null
  }
  const msg = body && typeof body.error === 'string' && body.error ? body.error : `HTTP ${r.status}`
  return Object.assign(new Error(msg), { status: r.status })
}
