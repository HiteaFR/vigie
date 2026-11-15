// Preloaded by npm test in each test file (--import). English is the product's default
// language; the tests, however, run as a French instance ("locale": "fr" in the config, the
// production case), which their expected texts have assumed since translations were added. The
// default itself (English) is checked by default-locale.test.js, in a process without this preload.
import { setLocale } from '../lib/i18n.js'

setLocale('fr')
