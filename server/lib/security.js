// Secure defaults: effective values of the security settings, with their source. A single
// function resolves them (index.js, and createAuth for the admin networks); a log line at
// startup shows them, never a secret (it is the only way to see what an instance does
// without reading its environment file).
//
// Secure defaults for a new installation:
//   listenHost     127.0.0.1
//   anonymousRead  false               (no API read without a session)
//   httpLogin      false               (admin login over plain HTTP refused, except from loopback)
//   adminCidrs     127.0.0.1/32 only
//
// Priority: NON-EMPTY environment variable > config > default. Instance options go
// in the config, not in Environment= lines of the systemd unit. Reason: LISTEN_HOST and
// ADMIN_ALLOWED_CIDRS used to be read with `env.X ? … : default` and `env.X || default`; an empty
// value therefore meant the old default. For an environment file that is not read, three states
// are possible:
//   - non-empty variable: it wins here as before (and would win over an Environment=);
//   - missing variable: the config gives back the intended value;
//   - EMPTY variable (`X=`): systemd puts it before any Environment= of the unit, which
//     would make the instance fall back to the new default; here, the empty value is ignored and
//     the config applies. The config covers the three cases, the unit only two.
// anonymousRead and httpLogin only exist in the config: no environment variable.
export const SECURITY_DEFAULTS = Object.freeze({
  listenHost: '127.0.0.1',
  anonymousRead: false,
  httpLogin: false,
  adminCidrs: Object.freeze(['127.0.0.1/32']),
})

const nonEmpty = v => typeof v === 'string' && v.trim() !== ''

// admin networks only (createAuth, tests): → { value: ['a.b.c.d/nn', …], source }
// source of a setting taken by default: display only, in the "security:" log line
// (no route exposes it, no code reads it back); in English like the log
export const SOURCE_DEFAULT = 'default'

export function resolveAdminCidrs(env = {}, adminCidrs) {
  if (nonEmpty(env.ADMIN_ALLOWED_CIDRS)) {
    const value = env.ADMIN_ALLOWED_CIDRS.split(',').map(s => s.trim()).filter(Boolean)
    return { value, source: 'env' }
  }
  if (Array.isArray(adminCidrs) && adminCidrs.length) return { value: [...adminCidrs], source: 'config' }
  return { value: [...SECURITY_DEFAULTS.adminCidrs], source: SOURCE_DEFAULT }
}

// → { listenHost, anonymousRead, httpLogin, adminCidrs }, each { value, source };
// source: 'env', 'config' or 'default'. Networks are checked by createAuth (parseCidrs), the
// config by its schema.
export function resolveSecurity(cfg = {}, env = {}) {
  const sec = cfg.security ?? {}
  const pick = (key, envName) => {
    if (envName && nonEmpty(env[envName])) return { value: env[envName].trim(), source: 'env' }
    if (cfg[key] !== undefined) return { value: cfg[key], source: 'config' }
    return { value: SECURITY_DEFAULTS[key], source: SOURCE_DEFAULT }
  }
  const flag = key => (sec[key] !== undefined ? { value: sec[key] === true, source: 'config' } : { value: SECURITY_DEFAULTS[key], source: SOURCE_DEFAULT })
  const adminCidrs = resolveAdminCidrs(env, sec.adminCidrs)
  return {
    listenHost: pick('listenHost', 'LISTEN_HOST'),
    anonymousRead: flag('anonymousRead'),
    httpLogin: flag('httpLogin'),
    adminCidrs,
  }
}

// single log line: values and sources, nothing else (no secret, no path)
export function securityLogLine(r) {
  const f = (k, v) => `${k}=${v} (${r[k].source})`
  return `security: ${[
    f('listenHost', r.listenHost.value),
    f('anonymousRead', r.anonymousRead.value),
    f('httpLogin', r.httpLogin.value),
    f('adminCidrs', r.adminCidrs.value.join(',')),
  ].join(' ; ')}`
}
