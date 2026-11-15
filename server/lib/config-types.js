// Config types shared by config.js and by registry entries (lib/registry.js: checks.js
// probes, widget authentications, update sources), with no dependency on config.js.
import { z } from 'zod'

export const duration = z.string().regex(/^\d+(s|m|h)$/, 'duration: 30s, 5m, 6h')
export const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'environment variable name')
export const jsonPath = z.union([z.string(), z.array(z.string()).min(1)])
