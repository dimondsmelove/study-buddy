export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787'

/** The extension uses one backend origin and fixed API paths below it. */
export function normalizeGatewayUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) }
  catch { throw new Error('Gateway URL must be an http(s) origin.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Gateway URL must be an http(s) origin without credentials, path, query or fragment.')
  }
  return url.origin
}

export function gatewayHostPermission(value: string): string {
  const url = new URL(normalizeGatewayUrl(value))
  return `${url.protocol}//${url.host}/*`
}
