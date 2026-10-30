import { isIP } from 'node:net'
import { resolve } from 'node:path'

export interface BackendConfig {
  host: string
  port: number
  databasePath: string
  providerApiKey: string
  sessionHmacSecret: string
  allowedOrigins: string[]
  trustedProxyIps: string[]
  operationTimeoutMs: number
  /** SSE comment interval; keeps Cloudflare (~125 s idle cutoff) from closing quiet streams. */
  heartbeatMs?: number
}

export interface BackendDependencies {
  now?: () => number
  log?: (entry: Record<string, unknown>) => void
  providerBaseUrl?: string
}

export function loadBackendConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const providerApiKey = env.OPENROUTER_API_KEY?.trim()
  if (!providerApiKey) throw new Error('OPENROUTER_API_KEY is required')
  const sessionHmacSecret = env.SESSION_HMAC_SECRET ?? ''
  if (Buffer.byteLength(sessionHmacSecret, 'utf8') < 32) {
    throw new Error('SESSION_HMAC_SECRET must contain at least 32 bytes')
  }
  const port = env.PORT === undefined ? 8787 : Number(env.PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer from 1 to 65535')
  const databasePath = resolve(env.DATABASE_PATH?.trim() || './data/study-buddy.sqlite')
  const allowedOrigins = list(env.ALLOWED_ORIGINS).map(normalizeAllowedOrigin)
  const trustedProxyIps = list(env.TRUSTED_PROXY_IPS).map(normalizeIp)
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    databasePath,
    providerApiKey,
    sessionHmacSecret,
    allowedOrigins,
    trustedProxyIps,
    operationTimeoutMs: 180_000,
  }
}

export function normalizeAllowedOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') {
    if (!url.hostname || !['', '/'].includes(url.pathname) || url.search || url.hash || url.username || url.password) {
      throw new Error('ALLOWED_ORIGINS contains an invalid extension origin')
    }
    return url.protocol + '//' + url.hostname
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.replace(/\/$/, '') ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('ALLOWED_ORIGINS must contain exact origins')
  }
  return url.origin
}

export function normalizeIp(value: string): string {
  const trimmed = value.trim().replace(/^\[|\]$/g, '')
  if (!isIP(trimmed)) throw new Error('TRUSTED_PROXY_IPS contains an invalid IP')
  return trimmed.toLowerCase()
}

function list(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
}