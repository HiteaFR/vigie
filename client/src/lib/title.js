// Tab title: config.title as soon as it is known, "Vigie" otherwise (index.html default, and
// title when config.title is missing or empty). Pure, tested without a browser.
export const DEFAULT_TITLE = 'Vigie'
export const titleOf = config => (typeof config?.title === 'string' && config.title.trim() ? config.title.trim() : DEFAULT_TITLE)
