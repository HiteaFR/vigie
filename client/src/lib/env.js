// Environment filter (prod, dev, all), pure: shared by the views, the badges and lib/updates.js
export const matchEnv = (env, value) => env === 'all' || value === env
