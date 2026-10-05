// Build-time defaults (vite.config.ts `define`).
//
// For a store build the API key is baked in, so the extension works the moment
// it is installed — no onboarding, no key to paste. SECURITY: a key inside the
// bundle can be extracted; this is a stop-gap until the hosted gateway (a proxy
// that keeps the key server-side and enforces quotas) replaces it. See
// gateway.ts. Set SB_DEFAULT_API_KEY at build time; never commit it.

/** Baked provider key; empty in the repo/dev, where settings still hold it. */
export const DEFAULT_API_KEY: string = __SB_DEFAULT_API_KEY__

/** Baked endpoint; used when settings carry none. */
export const DEFAULT_BASE_URL: string = __SB_DEFAULT_BASE_URL__
