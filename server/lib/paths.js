// Persistent folders, outside the deployed tree (/opt, overwritten by deploy/sync.sh --delete).
// State folder: STATE_DIRECTORY (provided by systemd, StateDirectory=vigie → /var/lib/vigie in
// deploy/vigie.service.example), else <root>/data (local development, ignored by git). Icons:
// ICONS_DIR, otherwise <state folder>/icons. Pinned CAs: PKI_DIR, otherwise <server>/pki;
// proxmox[].ca keeps the form "pki/<name>.pem" and designates <PKI_DIR>/<name>.pem. Pure: shared by
// the server, server/scripts/check-config.js, scripts/vendor-icons.mjs and ops/.
import path from 'node:path'

export const stateDir = (env, root) => env.STATE_DIRECTORY || path.join(root, 'data')
export const iconsDir = (env, root) => (env.ICONS_DIR ? path.resolve(env.ICONS_DIR) : path.join(stateDir(env, root), 'icons'))
export const pkiDir = (env, serverDir) => (env.PKI_DIR ? path.resolve(env.PKI_DIR) : path.join(serverDir, 'pki'))
