// Cache keys (react-query) of the network views to invalidate after a write
export const netKeys = id => ['network', ...(id ? [`/api/network/devices/${encodeURIComponent(id)}`] : [])]
