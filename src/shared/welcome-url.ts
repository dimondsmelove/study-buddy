export const DEFAULT_WELCOME_URL = 'https://studybuddyai.one/welcome/'

export function normalizeWelcomeUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) }
  catch { throw new Error('Welcome URL must be an http(s) URL ending in /welcome/.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/welcome/' || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Welcome URL must use HTTPS and end in /welcome/ (HTTP is allowed on localhost).')
  }
  return url.href
}

export function welcomeOriginMatch(value: string): string {
  const url = new URL(normalizeWelcomeUrl(value))
  return `${url.protocol}//${url.host}/*`
}
