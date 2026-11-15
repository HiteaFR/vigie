// Verified TLS for calls that carry a secret. The only module that creates undici agents.
// agentFor(url, { secret, ca, tls }) chooses:
//   1. ca given (PEM) → pinned agent: only this CA is accepted (it replaces the store);
//   2. otherwise, host as a private LITERAL IPv4 (10/8, 172.16/12, 192.168/16, 127/8) and no secret
//      → permissive agent (LAN probes and sources without a secret, self-signed certificates);
//   3. otherwise, a check without a secret that carries the explicit exception tls: 'insecure' → permissive;
//   4. everything else → strict agent: any host name (even on the LAN), any public IP, any call
//      with a secret and no ca. No config option relaxes it.
// Strict = Node bundled CA store, default undici behavior; identity
// verified by Node, without a custom servername or checkServerIdentity.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Agent } from 'undici'
import { t as tr } from './i18n.js'

// server/ directory: the `ca` paths of config.json (pki/…) are relative to it
export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const strictAgent = new Agent()
export const permissiveAgent = new Agent({ connect: { rejectUnauthorized: false } })
const pinnedAgents = new Map() // PEM → agent
export function pinnedAgent(caPem) {
  if (!pinnedAgents.has(caPem)) pinnedAgents.set(caPem, new Agent({ connect: { ca: caPem } }))
  return pinnedAgents.get(caPem)
}

// RFC 1918 and 127/8, as a literal IPv4 ONLY (no name, no IPv6, no network.subnets)
const PRIVATE_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8]]
const v4 = ip => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0)
export function isPrivateIpv4Literal(hostname) {
  if (net.isIPv4(hostname) !== true) return false
  const n = v4(hostname)
  return PRIVATE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits)))
}

// category (for tests and the log) then agent
export function tlsCategory(url, { secret = false, ca = null, tls = null } = {}) {
  if (ca) return 'pinned'
  const host = new URL(url).hostname
  if (!secret && isPrivateIpv4Literal(host)) return 'private'
  if (!secret && tls === 'insecure') return 'exception'
  return 'strict'
}
export function agentFor(url, opts = {}) {
  const c = tlsCategory(url, opts)
  return c === 'pinned' ? pinnedAgent(opts.ca) : c === 'strict' ? strictAgent : permissiveAgent
}

// TLS verification error (OpenSSL or Node code), for an explicit message
export const tlsErrorCode = e => {
  const code = String(e?.cause?.code || e?.code || '')
  return /CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|LEAF_SIGNATURE/.test(code) ? code : null
}

// pinned CA of a cluster: "pki/<name>.pem" (validated form, no free path), read from the
// CA folder (PKI_DIR, otherwise server/pki; lib/paths.js) under the name <name>.pem.
// → { pem, subject, validTo, daysLeft } or { error }: missing (missing folder included), unreadable,
// not a CA, expired. No permissive fallback in the caller.
export const CA_REF = /^pki\/([\w.-]+\.pem)$/
export function inspectCa(rel, { dir = path.join(SERVER_DIR, 'pki'), now = Date.now() } = {}) {
  const m = CA_REF.exec(rel ?? '')
  if (!m || m[1].startsWith('.')) return { error: tr('errors.tls.ca_invalid', { file: rel }) }
  let pem
  try {
    pem = fs.readFileSync(path.join(dir, m[1]), 'utf8')
  } catch (e) {
    return { error: e.code === 'ENOENT' ? tr('errors.tls.ca_missing', { file: rel }) : tr('errors.tls.ca_unreadable', { file: rel }) }
  }
  let cert
  try {
    cert = new X509Certificate(pem)
  } catch {
    return { error: tr('errors.tls.ca_unreadable', { file: rel }) }
  }
  if (!cert.ca) return { error: tr('errors.tls.not_ca', { file: rel }) }
  const validTo = new Date(cert.validTo).getTime()
  if (!(validTo > now)) return { error: tr('errors.tls.ca_expired', { file: rel }) }
  return { pem, subject: cert.subject.replace(/\n/g, ', '), validTo, daysLeft: Math.floor((validTo - now) / 86400_000), fingerprint256: cert.fingerprint256 }
}
