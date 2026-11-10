import mysql, { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';

/** Conexión de la transacción de escritura (solo las operaciones que las herramientas necesitan). */
export interface WriteTx {
  ejecutar(sql: string, values?: Array<string | number>): Promise<{ affectedRows: number }>;
  consultar(sql: string, values?: Array<string | number>): Promise<any[]>;
}

/**
 * Pool de escritura con el usuario `mcp_base` (permisos por columna, ver MEMORIA.md sección 3).
 * Solo lo usan las herramientas aplicar_base y encerar_cupos, siempre dentro de una transacción.
 */
class WriteDatabase {
  private pool: Pool | null = null;

  public isConfigured(): boolean {
    return Boolean(process.env.DB_WRITE_USER && process.env.DB_WRITE_PASSWORD);
  }

  private getPool(): Pool {
    if (!this.isConfigured()) {
      throw new Error('La escritura en la base no está configurada (faltan DB_WRITE_USER y DB_WRITE_PASSWORD).');
    }
    if (!this.pool) {
      const mode = (process.env.DB_SSL || '').toLowerCase();
      this.pool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_WRITE_USER,
        password: process.env.DB_WRITE_PASSWORD,
        database: process.env.DB_NAME || 'mvevip_db',
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0,
        connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT) || 10000,
        charset: 'utf8mb4',
        ssl: mode === 'rds' ? 'Amazon RDS' : mode === 'true' ? { rejectUnauthorized: true } : undefined
      });
    }
    return this.pool;
  }

  /** Ejecuta `fn` en una transacción: confirma si termina bien y revierte todo si falla. */
  public async transaction<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T> {
    const connection: PoolConnection = await this.getPool().getConnection();
    const tx: WriteTx = {
      ejecutar: async (sql, values = []) => {
        const [header] = await connection.query<ResultSetHeader>({ sql, values, timeout: 25000 });
        return { affectedRows: header.affectedRows };
      },
      consultar: async (sql, values = []) => {
        const [rows] = await connection.query({ sql, values, timeout: 25000 });
        return Array.isArray(rows) ? (rows as any[]) : [];
      }
    };
    try {
      await connection.beginTransaction();
      const result = await fn(tx);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
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

export const writeDb = new WriteDatabase();
