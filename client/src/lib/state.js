import { t } from '../i18n/index.js'
// Single reference for states: color + shape + label
export const STATES = {
  ok: { get label() { return t('state.ok') }, text: 'text-ok', bg: 'bg-ok-bg', border: 'border-l-ok' },
  warn: { get label() { return t('state.warn') }, text: 'text-warn', bg: 'bg-warn-bg', border: 'border-l-warn' },
  crit: { get label() { return t('state.crit') }, text: 'text-crit', bg: 'bg-crit-bg', border: 'border-l-crit' },
  unknown: { get label() { return t('state.unknown') }, text: 'text-unknown', bg: 'bg-unknown-bg', border: 'border-l-unknown' },
  maint: { get label() { return t('state.maint') }, text: 'text-maint', bg: 'bg-maint-bg', border: 'border-l-maint' },
  info: { get label() { return t('state.info') }, text: 'text-info', bg: 'bg-info-bg', border: 'border-l-info' },
  none: { get label() { return t('state.none') }, text: 'text-subtle', bg: 'bg-surface-3', border: 'border-l-line' },
}

export const stateOf = s => STATES[s] || STATES.unknown

// severity for sorting: crit first
export const RANK = { crit: 0, warn: 1, unknown: 2, maint: 3, ok: 4, none: 5 }
