import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { GATEWAY_LIMITS } from '../shared/gateway-protocol'

const HOUR_MS = 60 * 60 * 1_000

export interface Session {
  id: string
  expiresAt: number
  lastStartedAt: number | null
}

export type Admission =
  | { accepted: true }
  | { accepted: false; status: number; code: string; retryAfter?: number }

export class OperationalStore {
  private readonly db: DatabaseSync

  constructor(
    path: string,
    private readonly hmacSecret: string,
    now: number,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS sessions (',
      '  id TEXT PRIMARY KEY,',
      '  token_hash TEXT NOT NULL UNIQUE,',
      '  created_at INTEGER NOT NULL,',
      '  expires_at INTEGER NOT NULL,',
      '  last_started_at INTEGER',
      ');',
      'CREATE TABLE IF NOT EXISTS issuance_buckets (ip_hash TEXT NOT NULL, issued_at INTEGER NOT NULL);',
      'CREATE INDEX IF NOT EXISTS issuance_buckets_issued_at ON issuance_buckets(issued_at);',
      "CREATE TABLE IF NOT EXISTS operations (",
      '  session_id TEXT NOT NULL,',
      '  request_id TEXT NOT NULL,',
      '  fingerprint TEXT NOT NULL,',
      "  status TEXT NOT NULL CHECK(status IN ('active','complete','failed','cancelled','interrupted')),",
      '  started_at INTEGER NOT NULL,',
      '  finished_at INTEGER,',
      '  PRIMARY KEY(session_id, request_id)',
      ');',
      'CREATE INDEX IF NOT EXISTS operations_status_started ON operations(status, started_at);',
      'CREATE INDEX IF NOT EXISTS operations_session_status ON operations(session_id, status);',
    ].join('\n'))
    this.transaction(() => {
      this.db.prepare("UPDATE operations SET status = 'interrupted', finished_at = ? WHERE status = 'active'").run(now)
      this.prune(now)
    })
  }

  issueSession(ip: string, now: number): { token: string; session: Session } | { retryAfter: number } {
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashToken(token)
    const id = randomUUID()
    const currentHour = Math.floor(now / HOUR_MS)
    const hashes = [this.ipHash(ip, currentHour), this.ipHash(ip, currentHour - 1)]
    return this.transaction(() => {
      this.prune(now)
      const rows = this.db.prepare(
        'SELECT issued_at FROM issuance_buckets WHERE ip_hash IN (?, ?) AND issued_at > ? ORDER BY issued_at',
      ).all(hashes[0], hashes[1], now - HOUR_MS) as Array<{ issued_at: number }>
      if (rows.length >= 20) {
        const oldest = Number(rows[0].issued_at)
        return { retryAfter: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1_000)) }
      }
      const expiresAt = now + GATEWAY_LIMITS.sessionTtlMs
      this.db.prepare('INSERT INTO sessions(id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(id, tokenHash, now, expiresAt)
      this.db.prepare('INSERT INTO issuance_buckets(ip_hash, issued_at) VALUES (?, ?)')
        .run(hashes[0], now)
      return { token, session: { id, expiresAt, lastStartedAt: null } }
    })
  }

  authenticate(token: string, now: number): Session | undefined {
    const row = this.db.prepare(
      'SELECT id, expires_at, last_started_at FROM sessions WHERE token_hash = ?',
    ).get(hashToken(token)) as { id: string; expires_at: number; last_started_at: number | null } | undefined
    if (!row || Number(row.expires_at) <= now) return undefined
    return {
      id: row.id,
      expiresAt: Number(row.expires_at),
      lastStartedAt: row.last_started_at === null ? null : Number(row.last_started_at),
    }
  }

  renew(token: string, now: number): Session | undefined {
    const tokenHash = hashToken(token)
    return this.transaction(() => {
      const row = this.db.prepare(
        'SELECT id, expires_at, last_started_at FROM sessions WHERE token_hash = ?',
      ).get(tokenHash) as { id: string; expires_at: number; last_started_at: number | null } | undefined
      if (!row || Number(row.expires_at) <= now) return undefined
      const expiresAt = now + GATEWAY_LIMITS.sessionTtlMs
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, row.id)
      return {
        id: row.id,
        expiresAt,
        lastStartedAt: row.last_started_at === null ? null : Number(row.last_started_at),
      }
    })
  }

  admit(sessionId: string, requestId: string, fingerprint: string, now: number): Admission {
    return this.transaction(() => {
      this.prune(now)
      const session = this.db.prepare(
        'SELECT expires_at, last_started_at FROM sessions WHERE id = ?',
      ).get(sessionId) as { expires_at: number; last_started_at: number | null } | undefined
      if (!session || Number(session.expires_at) <= now) {
        return { accepted: false, status: 401, code: 'session.expired' }
      }

      const existing = this.db.prepare(
        'SELECT fingerprint FROM operations WHERE session_id = ? AND request_id = ?',
      ).get(sessionId, requestId) as { fingerprint: string } | undefined
      if (existing) {
        return existing.fingerprint === fingerprint
          ? { accepted: false, status: 409, code: 'generation.already_started' }
          : { accepted: false, status: 409, code: 'generation.request_id_conflict' }
      }

      const activeForSession = this.db.prepare(
        "SELECT 1 FROM operations WHERE session_id = ? AND status = 'active' LIMIT 1",
      ).get(sessionId)
      if (activeForSession) return { accepted: false, status: 409, code: 'generation.in_progress' }

      if (session.last_started_at !== null) {
        const remaining = GATEWAY_LIMITS.cooldownMs - (now - Number(session.last_started_at))
        if (remaining > 0) {
          return { accepted: false, status: 429, code: 'generation.cooldown', retryAfter: Math.max(1, Math.ceil(remaining / 1_000)) }
        }
      }

      const active = this.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE status = 'active'")
        .get() as { count: number }
      if (Number(active.count) >= GATEWAY_LIMITS.maxConcurrentGenerations) {
        return { accepted: false, status: 429, code: 'generation.capacity', retryAfter: 5 }
      }

      this.db.prepare('UPDATE sessions SET last_started_at = ? WHERE id = ?').run(now, sessionId)
      this.db.prepare(
        "INSERT INTO operations(session_id, request_id, fingerprint, status, started_at) VALUES (?, ?, ?, 'active', ?)",
      ).run(sessionId, requestId, fingerprint, now)
      return { accepted: true }
    })
  }

  finish(sessionId: string, requestId: string, status: 'complete' | 'failed' | 'cancelled' | 'interrupted', now: number): void {
    this.db.prepare(
      'UPDATE operations SET status = ?, finished_at = ? WHERE session_id = ? AND request_id = ? AND status = ?',
    ).run(status, now, sessionId, requestId, 'active')
  }

  close(): void {
    this.db.close()
  }

  private prune(now: number): void {
    this.db.prepare('DELETE FROM issuance_buckets WHERE issued_at <= ?').run(now - HOUR_MS)
    this.db.prepare(
      "DELETE FROM operations WHERE started_at <= ? AND status != 'active'",
    ).run(now - GATEWAY_LIMITS.idempotencyWindowMs)
    this.db.prepare([
      'DELETE FROM sessions',
      'WHERE expires_at <= ?',
      "  AND id NOT IN (SELECT session_id FROM operations WHERE status = 'active')",
    ].join('\n')).run(now)
  }

  private ipHash(ip: string, hour: number): string {
    return createHmac('sha256', this.hmacSecret).update(hour + ':' + ip).digest('hex')
  }

  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}