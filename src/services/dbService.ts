import mysql, { Pool, RowDataPacket } from 'mysql2/promise';
import { validateReadOnlySql } from './sqlGuard';

const MAX_ROWS_CAP = 500;
const QUERY_TIMEOUT_MS = 15000;

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  connectionLimit: number;
  connectTimeout: number;
}

class DatabaseService {
  private pool: Pool | null = null;
  private config: DbConfig;

  constructor() {
    this.config = {
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'mvevip_db',
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
      connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT) || 10000,
    };
  }

  private getSslOption(): any {
    const mode = (process.env.DB_SSL || '').toLowerCase();
    if (mode === 'rds') return 'Amazon RDS';
    if (mode === 'true') return { rejectUnauthorized: true };
    return undefined;
  }

  public getPool(): Pool {
    if (!this.pool) {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        waitForConnections: true,
        connectionLimit: this.config.connectionLimit,
        queueLimit: 0,
        connectTimeout: this.config.connectTimeout,
        charset: 'utf8mb4',
        ssl: this.getSslOption(),
      });
    }
    return this.pool;
  }

  /**
   * Ejecución segura de consultas de lectura: validación SQL, transacción READ ONLY,
   * tiempo máximo de ejecución y tope de filas devueltas.
   */
  public async executeReadOnlyQuery(
    rawQuery: string,
    maxRows = 50,
    values: Array<string | number> = []
  ): Promise<{ rowCount: number; rows: any[]; truncated: boolean }> {
    const { sql, firstWord, hasLimit } = validateReadOnlySql(rawQuery);
    const cap = Math.min(maxRows, MAX_ROWS_CAP);

    // El LIMIT va en línea nueva por si la consulta termina en un comentario "-- ..."
    const safeQuery =
      (firstWord === 'SELECT' || firstWord === 'WITH') && !hasLimit ? `${sql}\nLIMIT ${cap + 1}` : sql;

    const connection = await this.getPool().getConnection();
    try {
      try {
        await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${QUERY_TIMEOUT_MS}`);
      } catch {
        // Motores sin MAX_EXECUTION_TIME (p. ej. MariaDB): se mantiene el timeout del cliente.
      }
      await connection.query('START TRANSACTION READ ONLY');
      try {
        const [result] = await connection.query<RowDataPacket[]>({ sql: safeQuery, values, timeout: QUERY_TIMEOUT_MS });
        const all = Array.isArray(result) ? result : [];
        return { rowCount: Math.min(all.length, cap), rows: all.slice(0, cap), truncated: all.length > cap };
      } finally {
        await connection.query('ROLLBACK').catch(() => undefined);
      }
    } finally {
      connection.release();
    }
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

export const dbService = new DatabaseService();
