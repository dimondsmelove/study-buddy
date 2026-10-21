import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { GATEWAY_LIMITS } from '../shared/gateway-protocol'

const HOUR_MS = 60 * 60 * 1_000
const MONTHLY_BUDGET_NANO = 5_000_000_000
const SERVICE_MONTHLY_BUDGET_NANO = 100_000_000_000
// Retained at the approved $0.275 wallet reserve after the model and output cap
// changed. The provider byte/token estimate is not a monetary bound.
const GENERATION_RESERVE_NANO = 275_000_000
const LEGACY_MODEL = 'openai/gpt-6-luna'

export interface Session {
  id: string
  expiresAt: number
  lastStartedAt: number | null
  installationId: string | null
}

export interface InstallationCredential {
  installationId: string
  installationSecret: string
}

export type Admission =
  | { accepted: true }
  | { accepted: false; status: number; code: string; retryAfter?: number; resetAt?: number }

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
      '  last_started_at INTEGER,',
      '  installation_id TEXT',
      ');',
      'CREATE TABLE IF NOT EXISTS installations (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, last_started_at INTEGER);',
      'CREATE TABLE IF NOT EXISTS monthly_budgets (installation_id TEXT NOT NULL, month_key TEXT NOT NULL, spent_nano INTEGER NOT NULL, reserved_nano INTEGER NOT NULL, PRIMARY KEY(installation_id, month_key));',
      'CREATE INDEX IF NOT EXISTS monthly_budgets_month ON monthly_budgets(month_key);',
      "CREATE TABLE IF NOT EXISTS budget_charges (installation_id TEXT NOT NULL, request_id TEXT NOT NULL, month_key TEXT NOT NULL, reserved_nano INTEGER NOT NULL, charged_nano INTEGER, status TEXT NOT NULL CHECK(status IN ('reserved','held','settled','released')), provider_generation_id TEXT, updated_at INTEGER NOT NULL, next_reconcile_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(installation_id, request_id));",
      'CREATE INDEX IF NOT EXISTS budget_charges_pending ON budget_charges(status, provider_generation_id);',
      'CREATE TABLE IF NOT EXISTS issuance_buckets (ip_hash TEXT NOT NULL, issued_at INTEGER NOT NULL);',
      'CREATE INDEX IF NOT EXISTS issuance_buckets_issued_at ON issuance_buckets(issued_at);',
      "CREATE TABLE IF NOT EXISTS operations (",
      '  session_id TEXT NOT NULL,',
      '  request_id TEXT NOT NULL,',
      '  fingerprint TEXT NOT NULL,',
      "  status TEXT NOT NULL CHECK(status IN ('active','complete','failed','cancelled','interrupted')),",
      '  started_at INTEGER NOT NULL,',
      '  finished_at INTEGER,',
      '  installation_id TEXT,',
      '  PRIMARY KEY(session_id, request_id)',
      ');',
      'CREATE INDEX IF NOT EXISTS operations_status_started ON operations(status, started_at);',
      'CREATE INDEX IF NOT EXISTS operations_session_status ON operations(session_id, status);',
    ].join('\n'))
    this.ensureColumn('sessions', 'installation_id', 'TEXT')
    this.ensureColumn('operations', 'installation_id', 'TEXT')
    this.ensureColumn('budget_charges', 'next_reconcile_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('budget_charges', 'expected_model', 'TEXT')
    this.db.exec('CREATE INDEX IF NOT EXISTS operations_installation_status ON operations(installation_id, status)')
    this.transaction(() => {
      this.db.prepare("UPDATE operations SET status = 'interrupted', finished_at = ? WHERE status = 'active'").run(now)
      this.db.prepare("UPDATE budget_charges SET status = 'held', updated_at = ? WHERE status = 'reserved'").run(now)
      this.prune(now)
    })
  }

  issueInstallation(ip: string, now: number): ({ token: string; session: Session } & InstallationCredential) | { retryAfter: number } {
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashToken(token)
    const id = randomUUID()
    const installationId = randomUUID()
    const installationSecret = randomBytes(32).toString('base64url')
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
      this.db.prepare('INSERT INTO installations(id, secret_hash) VALUES (?, ?)').run(installationId, hashToken(installationSecret))
      this.db.prepare('INSERT INTO sessions(id, token_hash, created_at, expires_at, installation_id) VALUES (?, ?, ?, ?, ?)')
        .run(id, tokenHash, now, expiresAt, installationId)
      this.db.prepare('INSERT INTO issuance_buckets(ip_hash, issued_at) VALUES (?, ?)')
        .run(hashes[0], now)
      return { token, session: { id, expiresAt, lastStartedAt: null, installationId }, installationId, installationSecret }
    })
  }

  recoverInstallation(installationId: string, installationSecret: string, now: number): { token: string; session: Session } | undefined {
    const token = randomBytes(32).toString('base64url')
    const id = randomUUID()
    return this.transaction(() => {
      this.prune(now)
      const installation = this.db.prepare('SELECT id FROM installations WHERE id = ? AND secret_hash = ?')
        .get(installationId, hashToken(installationSecret)) as { id: string } | undefined
      if (!installation) return undefined
      const sessions = this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE installation_id = ? AND expires_at > ?')
        .get(installationId, now) as { count: number }
      if (Number(sessions.count) >= 20) {
        this.db.prepare([
          'DELETE FROM sessions WHERE id = (',
          '  SELECT id FROM sessions',
          '  WHERE installation_id = ?',
          "    AND id NOT IN (SELECT session_id FROM operations WHERE status = 'active')",
          '  ORDER BY created_at LIMIT 1',
          ')',
        ].join('\n')).run(installationId)
      }
      const expiresAt = now + GATEWAY_LIMITS.sessionTtlMs
      this.db.prepare('INSERT INTO sessions(id, token_hash, created_at, expires_at, installation_id) VALUES (?, ?, ?, ?, ?)')
        .run(id, hashToken(token), now, expiresAt, installationId)
      return { token, session: { id, expiresAt, lastStartedAt: this.installationLastStartedAt(installationId), installationId } }
    })
  }

  claimInstallation(token: string, now: number): ({ session: Session } & InstallationCredential) | undefined {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT id, expires_at, last_started_at, installation_id FROM sessions WHERE token_hash = ?')
        .get(hashToken(token)) as { id: string; expires_at: number; last_started_at: number | null; installation_id: string | null } | undefined
      if (!row || Number(row.expires_at) <= now) return undefined
      const installationId = row.installation_id ?? randomUUID()
      const installationSecret = randomBytes(32).toString('base64url')
      if (row.installation_id) {
        this.db.prepare('UPDATE installations SET secret_hash = ? WHERE id = ?').run(hashToken(installationSecret), installationId)
      } else {
        this.db.prepare('INSERT INTO installations(id, secret_hash, last_started_at) VALUES (?, ?, ?)')
          .run(installationId, hashToken(installationSecret), row.last_started_at)
        this.db.prepare('UPDATE sessions SET installation_id = ? WHERE id = ?').run(installationId, row.id)
      }
      this.db.prepare('UPDATE operations SET installation_id = ? WHERE session_id = ?').run(installationId, row.id)
      return {
        session: { id: row.id, expiresAt: Number(row.expires_at), lastStartedAt: row.last_started_at === null ? null : Number(row.last_started_at), installationId },
        installationId,
        installationSecret,
      }
    })
  }

  authenticate(token: string, now: number): Session | undefined {
    const row = this.db.prepare(
      'SELECT id, expires_at, last_started_at, installation_id FROM sessions WHERE token_hash = ?',
    ).get(hashToken(token)) as { id: string; expires_at: number; last_started_at: number | null; installation_id: string | null } | undefined
    if (!row || Number(row.expires_at) <= now) return undefined
    return {
      id: row.id,
      expiresAt: Number(row.expires_at),
      lastStartedAt: row.last_started_at === null ? null : Number(row.last_started_at),
      installationId: row.installation_id,
    }
  }

  renew(token: string, now: number): Session | undefined {
    const tokenHash = hashToken(token)
    return this.transaction(() => {
      const row = this.db.prepare(
        'SELECT id, expires_at, last_started_at, installation_id FROM sessions WHERE token_hash = ?',
      ).get(tokenHash) as { id: string; expires_at: number; last_started_at: number | null; installation_id: string | null } | undefined
      if (!row || Number(row.expires_at) <= now) return undefined
      const expiresAt = now + GATEWAY_LIMITS.sessionTtlMs
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, row.id)
      return {
        id: row.id,
        expiresAt,
        lastStartedAt: row.last_started_at === null ? null : Number(row.last_started_at),
        installationId: row.installation_id,
      }
    })
  }

  admit(sessionId: string, requestId: string, fingerprint: string, now: number, expectedModel = LEGACY_MODEL): Admission {
    return this.transaction(() => {
      this.prune(now)
      const session = this.db.prepare(
        'SELECT expires_at, last_started_at, installation_id FROM sessions WHERE id = ?',
      ).get(sessionId) as { expires_at: number; last_started_at: number | null; installation_id: string | null } | undefined
      if (!session || Number(session.expires_at) <= now) {
        return { accepted: false, status: 401, code: 'session.expired' }
      }

      if (!session.installation_id) return { accepted: false, status: 401, code: 'installation.required' }

      const existing = this.db.prepare(
        'SELECT fingerprint FROM operations WHERE request_id = ? AND (session_id = ? OR installation_id = ?)',
      ).get(requestId, sessionId, session.installation_id) as { fingerprint: string } | undefined
      if (existing) {
        return existing.fingerprint === fingerprint
          ? { accepted: false, status: 409, code: 'generation.already_started' }
          : { accepted: false, status: 409, code: 'generation.request_id_conflict' }
      }

      const existingCharge = this.db.prepare(
        'SELECT 1 FROM budget_charges WHERE installation_id = ? AND request_id = ?',
      ).get(session.installation_id, requestId)
      if (existingCharge) return { accepted: false, status: 409, code: 'generation.already_started' }
      const reserveOverrun = this.db.prepare([
        "SELECT 1 FROM budget_charges WHERE installation_id = ? AND status = 'settled'",
        'AND charged_nano > reserved_nano LIMIT 1',
      ].join(' ')).get(session.installation_id)
      if (reserveOverrun) return { accepted: false, status: 503, code: 'budget.accounting_review' }
      const activeForSession = this.db.prepare(
        "SELECT 1 FROM operations WHERE status = 'active' AND (session_id = ? OR installation_id = ?) LIMIT 1",
      ).get(sessionId, session.installation_id)
      if (activeForSession) return { accepted: false, status: 409, code: 'generation.in_progress' }

      const lastStartedAt = session.installation_id ? this.installationLastStartedAt(session.installation_id) : session.last_started_at
      if (lastStartedAt !== null) {
        const remaining = GATEWAY_LIMITS.cooldownMs - (now - Number(lastStartedAt))
        if (remaining > 0) {
          return { accepted: false, status: 429, code: 'generation.cooldown', retryAfter: Math.max(1, Math.ceil(remaining / 1_000)) }
        }
      }

      const active = this.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE status = 'active'")
        .get() as { count: number }
      if (Number(active.count) >= GATEWAY_LIMITS.maxConcurrentGenerations) {
        return { accepted: false, status: 429, code: 'generation.capacity', retryAfter: 5 }
      }

      const monthKey = new Date(now).toISOString().slice(0, 7)
      const resetAt = nextMonthStart(now)
      const serviceBudget = this.db.prepare(
        'SELECT COALESCE(SUM(spent_nano + reserved_nano), 0) AS total_nano FROM monthly_budgets WHERE month_key = ?',
      ).get(monthKey) as { total_nano: number }
      if (Number(serviceBudget.total_nano) + GENERATION_RESERVE_NANO > SERVICE_MONTHLY_BUDGET_NANO) {
        return { accepted: false, status: 429, code: 'budget.service_exhausted', resetAt }
      }
      const budget = this.db.prepare('SELECT spent_nano, reserved_nano FROM monthly_budgets WHERE installation_id = ? AND month_key = ?')
        .get(session.installation_id, monthKey) as { spent_nano: number; reserved_nano: number } | undefined
      const spentNano = Number(budget?.spent_nano ?? 0)
      const reservedNano = Number(budget?.reserved_nano ?? 0)
      if (spentNano + reservedNano + GENERATION_RESERVE_NANO > MONTHLY_BUDGET_NANO) {
        return { accepted: false, status: 429, code: 'budget.exhausted', resetAt }
      }
      this.db.prepare([
        'INSERT INTO monthly_budgets(installation_id, month_key, spent_nano, reserved_nano) VALUES (?, ?, 0, ?)',
        'ON CONFLICT(installation_id, month_key) DO UPDATE SET reserved_nano = reserved_nano + excluded.reserved_nano',
      ].join(' ')).run(session.installation_id, monthKey, GENERATION_RESERVE_NANO)
      this.db.prepare([
        "INSERT INTO budget_charges(installation_id, request_id, month_key, reserved_nano, status, updated_at, expected_model)",
        "VALUES (?, ?, ?, ?, 'reserved', ?, ?)",
      ].join(' ')).run(session.installation_id, requestId, monthKey, GENERATION_RESERVE_NANO, now, expectedModel)

      this.db.prepare('UPDATE sessions SET last_started_at = ? WHERE id = ?').run(now, sessionId)
      if (session.installation_id) this.db.prepare('UPDATE installations SET last_started_at = ? WHERE id = ?').run(now, session.installation_id)
      this.db.prepare(
        "INSERT INTO operations(session_id, request_id, fingerprint, status, started_at, installation_id) VALUES (?, ?, ?, 'active', ?, ?)",
      ).run(sessionId, requestId, fingerprint, now, session.installation_id)
      return { accepted: true }
    })
  }

  finish(sessionId: string, requestId: string, status: 'complete' | 'failed' | 'cancelled' | 'interrupted', now: number): void {
    this.db.prepare(
      'UPDATE operations SET status = ?, finished_at = ? WHERE session_id = ? AND request_id = ? AND status = ?',
    ).run(status, now, sessionId, requestId, 'active')
  }

  recordProviderGeneration(installationId: string, requestId: string, generationId: string, now: number): void {
    this.db.prepare([
      "UPDATE budget_charges SET provider_generation_id = COALESCE(provider_generation_id, ?), updated_at = ?, next_reconcile_at = 0",
      "WHERE installation_id = ? AND request_id = ? AND status IN ('reserved','held')",
    ].join(' ')).run(generationId, now, installationId, requestId)
  }

  settleBudgetAndFinish(
    sessionId: string,
    installationId: string,
    requestId: string,
    status: 'complete' | 'failed' | 'cancelled' | 'interrupted',
    chargedNano: number | undefined,
    now: number,
  ): { exceededReserve: boolean } | undefined {
    return this.transaction(() => {
      let result: { exceededReserve: boolean } | undefined
      if (chargedNano === undefined) {
        this.db.prepare([
          "UPDATE budget_charges SET status = 'held', updated_at = ?",
          "WHERE installation_id = ? AND request_id = ? AND status = 'reserved'",
        ].join(' ')).run(now, installationId, requestId)
      } else {
        result = this.settleBudgetInTransaction(installationId, requestId, chargedNano, now)
      }
      this.db.prepare([
        'UPDATE operations SET status = ?, finished_at = ?',
        "WHERE session_id = ? AND request_id = ? AND status = 'active'",
      ].join(' ')).run(status, now, sessionId, requestId)
      return result
    })
  }

  holdBudget(installationId: string, requestId: string, now: number): void {
    this.db.prepare([
      "UPDATE budget_charges SET status = 'held', updated_at = ?",
      "WHERE installation_id = ? AND request_id = ? AND status = 'reserved'",
    ].join(' ')).run(now, installationId, requestId)
  }

  releaseBudget(installationId: string, requestId: string, now: number): void {
    this.transaction(() => {
      const charge = this.budgetCharge(installationId, requestId)
      if (!charge || charge.status !== 'reserved') return
      this.db.prepare('UPDATE monthly_budgets SET reserved_nano = reserved_nano - ? WHERE installation_id = ? AND month_key = ?')
        .run(Number(charge.reserved_nano), installationId, charge.month_key)
      this.db.prepare("UPDATE budget_charges SET status = 'released', updated_at = ? WHERE installation_id = ? AND request_id = ?")
        .run(now, installationId, requestId)
    })
  }

  settleBudget(installationId: string, requestId: string, chargedNano: number, now: number): { exceededReserve: boolean } | undefined {
    return this.transaction(() => this.settleBudgetInTransaction(installationId, requestId, chargedNano, now))
  }

  pendingBudgetReconciliation(now: number, limit = 20): Array<{ installationId: string; requestId: string; monthKey: string; generationId: string; expectedModel: string }> {
    return this.db.prepare([
      "SELECT installation_id AS installationId, request_id AS requestId, month_key AS monthKey, provider_generation_id AS generationId, COALESCE(expected_model, 'openai/gpt-6-luna') AS expectedModel",
      "FROM budget_charges WHERE status = 'held' AND provider_generation_id IS NOT NULL AND next_reconcile_at <= ?",
      'ORDER BY next_reconcile_at, updated_at LIMIT ?',
    ].join(' ')).all(now, Math.max(1, Math.min(100, limit))) as Array<{
      installationId: string; requestId: string; monthKey: string; generationId: string; expectedModel: string
    }>
  }

  markBudgetReconciliationAttempt(installationId: string, requestId: string, now: number): void {
    this.db.prepare([
      'UPDATE budget_charges SET next_reconcile_at = ?, updated_at = ?',
      "WHERE installation_id = ? AND request_id = ? AND status = 'held'",
    ].join(' ')).run(now + 30_000, now, installationId, requestId)
  }

  private settleBudgetInTransaction(installationId: string, requestId: string, chargedNano: number, now: number): { exceededReserve: boolean } | undefined {
    const charge = this.budgetCharge(installationId, requestId)
    if (!charge) return undefined
    if (charge.status === 'settled') return { exceededReserve: Number(charge.charged_nano) > Number(charge.reserved_nano) }
    if (charge.status === 'released') return undefined
    this.db.prepare([
      'UPDATE monthly_budgets SET reserved_nano = reserved_nano - ?, spent_nano = spent_nano + ?',
      'WHERE installation_id = ? AND month_key = ?',
    ].join(' ')).run(Number(charge.reserved_nano), chargedNano, installationId, charge.month_key)
    this.db.prepare("UPDATE budget_charges SET status = 'settled', charged_nano = ?, updated_at = ? WHERE installation_id = ? AND request_id = ?")
      .run(chargedNano, now, installationId, requestId)
    return { exceededReserve: chargedNano > Number(charge.reserved_nano) }
  }

  private budgetCharge(installationId: string, requestId: string): {
    month_key: string; reserved_nano: number; charged_nano: number | null; status: string
  } | undefined {
    return this.db.prepare('SELECT month_key, reserved_nano, charged_nano, status FROM budget_charges WHERE installation_id = ? AND request_id = ?')
      .get(installationId, requestId) as {
        month_key: string; reserved_nano: number; charged_nano: number | null; status: string
      } | undefined
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

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>
    if (!columns.some((item) => item.name === column)) this.db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition)
  }

  private installationLastStartedAt(id: string): number | null {
    const row = this.db.prepare('SELECT last_started_at FROM installations WHERE id = ?').get(id) as { last_started_at: number | null } | undefined
    return row?.last_started_at === null || row?.last_started_at === undefined ? null : Number(row.last_started_at)
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

function nextMonthStart(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}