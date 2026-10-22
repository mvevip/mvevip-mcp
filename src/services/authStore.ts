import mysql, { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface UserRecord {
  id: number;
  username: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  failedAttempts: number;
  lockedUntil: number;
}

export interface ChallengeRecord {
  id: string;
  userId: number;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  consumed: boolean;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export type NewChallenge = Omit<ChallengeRecord, 'attempts' | 'consumed'>;

export const MAX_LOGIN_FAILURES = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface AuthStore {
  ensureSchema(): Promise<void>;
  findUserByUsername(username: string): Promise<UserRecord | null>;
  findUserById(id: number): Promise<UserRecord | null>;
  /** Registra un fallo de contraseña; bloquea la cuenta al llegar al máximo. */
  recordLoginFailure(userId: number): Promise<void>;
  recordLoginSuccess(userId: number): Promise<void>;
  createUser(input: { username: string; email: string; passwordHash: string }): Promise<number>;
  updatePassword(username: string, passwordHash: string): Promise<boolean>;
  setActive(username: string, active: boolean): Promise<boolean>;
  listUsers(): Promise<Array<Omit<UserRecord, 'passwordHash'>>>;
  countRecentChallenges(userId: number, sinceMs: number): Promise<number>;
  createChallenge(challenge: NewChallenge): Promise<void>;
  getChallenge(id: string): Promise<ChallengeRecord | null>;
  incrementChallengeAttempts(id: string): Promise<void>;
  /** Marca el desafío como usado de forma atómica. false si ya estaba consumido. */
  consumeChallenge(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Implementación MySQL (base de datos de autenticación en el RDS)
// ---------------------------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mcp_users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    email VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until BIGINT NOT NULL DEFAULT 0,
    last_login_at BIGINT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE KEY uq_mcp_users_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS mcp_login_challenges (
    id CHAR(32) PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    code_hash CHAR(64) NOT NULL,
    expires_at BIGINT NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    consumed TINYINT(1) NOT NULL DEFAULT 0,
    client_id VARCHAR(128) NOT NULL,
    redirect_uri VARCHAR(512) NOT NULL,
    state VARCHAR(2048) NOT NULL,
    code_challenge CHAR(43) NOT NULL,
    created_at BIGINT NOT NULL,
    KEY idx_challenges_user (user_id, created_at),
    KEY idx_challenges_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

const toUser = (r: RowDataPacket): UserRecord => ({
  id: r.id,
  username: r.username,
  email: r.email,
  passwordHash: r.password_hash,
  isActive: r.is_active === 1,
  failedAttempts: r.failed_attempts,
  lockedUntil: Number(r.locked_until)
});

export class MysqlAuthStore implements AuthStore {
  private pool: Pool | null = null;
  private schemaReady: Promise<void> | null = null;

  private getPool(): Pool {
    if (!this.pool) {
      const e = process.env;
      this.pool = mysql.createPool({
        host: e.AUTH_DB_HOST || e.DB_HOST || '127.0.0.1',
        port: Number(e.AUTH_DB_PORT || e.DB_PORT) || 3306,
        user: e.AUTH_DB_USER,
        password: e.AUTH_DB_PASSWORD,
        database: e.AUTH_DB_NAME || 'mvevip_mcp_auth',
        waitForConnections: true,
        connectionLimit: Number(e.AUTH_DB_CONNECTION_LIMIT) || 2,
        connectTimeout: Number(e.DB_CONNECT_TIMEOUT) || 10000,
        charset: 'utf8mb4',
        supportBigNumbers: true,
        bigNumberStrings: false,
        ssl: ((): any => {
          const mode = (e.DB_SSL || '').toLowerCase();
          if (mode === 'rds') return 'Amazon RDS';
          if (mode === 'true') return { rejectUnauthorized: true };
          return undefined;
        })()
      });
    }
    return this.pool;
  }

  /** Crea las tablas la primera vez (requiere privilegio CREATE sobre la base de autenticación). */
  ensureSchema(): Promise<void> {
    this.schemaReady ??= (async () => {
      for (const statement of SCHEMA) await this.getPool().query(statement);
    })().catch((err) => {
      this.schemaReady = null;
      throw err;
    });
    return this.schemaReady;
  }

  private async q<T extends RowDataPacket[] | ResultSetHeader>(sql: string, params: any[] = []): Promise<T> {
    await this.ensureSchema();
    const [rows] = await this.getPool().query<T>(sql, params);
    return rows;
  }

  async findUserByUsername(username: string) {
    const rows = await this.q<RowDataPacket[]>('SELECT * FROM mcp_users WHERE username = ? LIMIT 1', [username]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findUserById(id: number) {
    const rows = await this.q<RowDataPacket[]>('SELECT * FROM mcp_users WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async recordLoginFailure(userId: number) {
    const now = Date.now();
    await this.q(
      `UPDATE mcp_users
         SET locked_until = IF(failed_attempts + 1 >= ?, ?, locked_until),
             failed_attempts = IF(failed_attempts + 1 >= ?, 0, failed_attempts + 1)
       WHERE id = ?`,
      [MAX_LOGIN_FAILURES, now + LOCK_DURATION_MS, MAX_LOGIN_FAILURES, userId]
    );
  }

  async recordLoginSuccess(userId: number) {
    await this.q('UPDATE mcp_users SET failed_attempts = 0, locked_until = 0, last_login_at = ? WHERE id = ?', [Date.now(), userId]);
  }

  async createUser(input: { username: string; email: string; passwordHash: string }) {
    const res = await this.q<ResultSetHeader>(
      'INSERT INTO mcp_users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
      [input.username, input.email, input.passwordHash, Date.now()]
    );
    return res.insertId;
  }

  async updatePassword(username: string, passwordHash: string) {
    const res = await this.q<ResultSetHeader>(
      'UPDATE mcp_users SET password_hash = ?, failed_attempts = 0, locked_until = 0 WHERE username = ?',
      [passwordHash, username]
    );
    return res.affectedRows > 0;
  }

  async setActive(username: string, active: boolean) {
    const res = await this.q<ResultSetHeader>('UPDATE mcp_users SET is_active = ? WHERE username = ?', [active ? 1 : 0, username]);
    return res.affectedRows > 0;
  }

  async listUsers() {
    const rows = await this.q<RowDataPacket[]>('SELECT * FROM mcp_users ORDER BY username');
    return rows.map((r) => {
      const { passwordHash: _omit, ...rest } = toUser(r);
      return rest;
    });
  }

  async countRecentChallenges(userId: number, sinceMs: number) {
    const rows = await this.q<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM mcp_login_challenges WHERE user_id = ? AND created_at >= ?',
      [userId, sinceMs]
    );
    return Number(rows[0].n);
  }

  async createChallenge(c: NewChallenge) {
    // Limpieza oportunista de desafíos vencidos hace más de un día
    await this.q('DELETE FROM mcp_login_challenges WHERE expires_at < ?', [Date.now() - 24 * 60 * 60 * 1000]);
    await this.q(
      `INSERT INTO mcp_login_challenges
        (id, user_id, code_hash, expires_at, client_id, redirect_uri, state, code_challenge, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.userId, c.codeHash, c.expiresAt, c.clientId, c.redirectUri, c.state, c.codeChallenge, Date.now()]
    );
  }

  async getChallenge(id: string) {
    const rows = await this.q<RowDataPacket[]>('SELECT * FROM mcp_login_challenges WHERE id = ? LIMIT 1', [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      codeHash: r.code_hash,
      expiresAt: Number(r.expires_at),
      attempts: r.attempts,
      consumed: r.consumed === 1,
      clientId: r.client_id,
      redirectUri: r.redirect_uri,
      state: r.state,
      codeChallenge: r.code_challenge
    } as ChallengeRecord;
  }

  async incrementChallengeAttempts(id: string) {
    await this.q('UPDATE mcp_login_challenges SET attempts = attempts + 1 WHERE id = ?', [id]);
  }

  async consumeChallenge(id: string) {
    const res = await this.q<ResultSetHeader>('UPDATE mcp_login_challenges SET consumed = 1 WHERE id = ? AND consumed = 0', [id]);
    return res.affectedRows === 1;
  }

  async close() {
    await this.pool?.end();
    this.pool = null;
  }
}

// ---------------------------------------------------------------------------
// Implementación en memoria (pruebas)
// ---------------------------------------------------------------------------
export class MemoryAuthStore implements AuthStore {
  users: Array<UserRecord & { createdAt: number }> = [];
  challenges: Array<ChallengeRecord & { createdAt: number }> = [];

  async ensureSchema() {}

  async findUserByUsername(username: string) {
    return this.users.find((u) => u.username === username) ?? null;
  }

  async findUserById(id: number) {
    return this.users.find((u) => u.id === id) ?? null;
  }

  async recordLoginFailure(userId: number) {
    const u = this.users.find((x) => x.id === userId);
    if (!u) return;
    if (u.failedAttempts + 1 >= MAX_LOGIN_FAILURES) {
      u.lockedUntil = Date.now() + LOCK_DURATION_MS;
      u.failedAttempts = 0;
    } else {
      u.failedAttempts += 1;
    }
  }

  async recordLoginSuccess(userId: number) {
    const u = this.users.find((x) => x.id === userId);
    if (u) {
      u.failedAttempts = 0;
      u.lockedUntil = 0;
    }
  }

  async createUser(input: { username: string; email: string; passwordHash: string }) {
    if (this.users.some((u) => u.username === input.username)) throw new Error('ER_DUP_ENTRY');
    const id = this.users.length + 1;
    this.users.push({ id, ...input, isActive: true, failedAttempts: 0, lockedUntil: 0, createdAt: Date.now() });
    return id;
  }

  async updatePassword(username: string, passwordHash: string) {
    const u = this.users.find((x) => x.username === username);
    if (!u) return false;
    u.passwordHash = passwordHash;
    u.failedAttempts = 0;
    u.lockedUntil = 0;
    return true;
  }

  async setActive(username: string, active: boolean) {
    const u = this.users.find((x) => x.username === username);
    if (!u) return false;
    u.isActive = active;
    return true;
  }

  async listUsers() {
    return this.users.map(({ passwordHash: _p, ...rest }) => rest);
  }

  async countRecentChallenges(userId: number, sinceMs: number) {
    return this.challenges.filter((c) => c.userId === userId && c.createdAt >= sinceMs).length;
  }

  async createChallenge(c: NewChallenge) {
    this.challenges.push({ ...c, attempts: 0, consumed: false, createdAt: Date.now() });
  }

  async getChallenge(id: string) {
    return this.challenges.find((c) => c.id === id) ?? null;
  }

  async incrementChallengeAttempts(id: string) {
    const c = this.challenges.find((x) => x.id === id);
    if (c) c.attempts += 1;
  }

  async consumeChallenge(id: string) {
    const c = this.challenges.find((x) => x.id === id);
    if (!c || c.consumed) return false;
    c.consumed = true;
    return true;
  }
}
