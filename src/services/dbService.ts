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

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  database?: string;
  serverVersion?: string;
  serverTime?: string;
  host?: string;
  error?: string;
}

export interface TableSummary {
  tableName: string;
  tableType: string;
  engine: string;
  estimatedRows: number;
  dataSizeKb: number;
  comment?: string;
}

export interface ColumnDetail {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  columnKey: string;
  columnDefault: string | null;
  comment: string;
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
   * Función de prueba inicial para validar conectividad con la base de datos
   */
  public async testConnection(): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    try {
      const pool = this.getPool();
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT 1 AS ping, VERSION() AS version, DATABASE() AS current_db, NOW() AS server_time'
      );

      const latencyMs = Date.now() - startTime;
      const firstRow = rows[0] || {};

      return {
        ok: true,
        message: 'Conexión a la base de datos establecida exitosamente.',
        latencyMs,
        database: firstRow.current_db || this.config.database,
        serverVersion: firstRow.version,
        serverTime: firstRow.server_time ? String(firstRow.server_time) : undefined,
        host: `${this.config.host}:${this.config.port}`,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      return {
        ok: false,
        message: 'No fue posible conectar con la base de datos.',
        latencyMs,
        host: `${this.config.host}:${this.config.port}`,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Entrega un resumen de las tablas existentes en la base de datos
   */
  public async getDatabaseOverview(): Promise<{ totalTables: number; tables: TableSummary[] }> {
    const pool = this.getPool();
    const query = `
      SELECT 
        TABLE_NAME AS tableName,
        TABLE_TYPE AS tableType,
        COALESCE(ENGINE, 'N/A') AS engine,
        COALESCE(TABLE_ROWS, 0) AS estimatedRows,
        ROUND(COALESCE(DATA_LENGTH, 0) / 1024, 2) AS dataSizeKb,
        TABLE_COMMENT AS comment
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME ASC
    `;

    const [rows] = await pool.query<RowDataPacket[]>(query, [this.config.database]);
    const tables: TableSummary[] = rows.map((r) => ({
      tableName: r.tableName,
      tableType: r.tableType,
      engine: r.engine,
      estimatedRows: Number(r.estimatedRows),
      dataSizeKb: Number(r.dataSizeKb),
      comment: r.comment || undefined,
    }));

    return {
      totalTables: tables.length,
      tables,
    };
  }

  /**
   * Obtiene la estructura detallada de columnas de una tabla dada
   */
  public async getTableSchema(tableName: string): Promise<ColumnDetail[]> {
    const pool = this.getPool();
    const query = `
      SELECT 
        COLUMN_NAME AS columnName,
        COLUMN_TYPE AS dataType,
        IS_NULLABLE AS isNullable,
        COLUMN_KEY AS columnKey,
        COLUMN_DEFAULT AS columnDefault,
        COLUMN_COMMENT AS comment
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION ASC
    `;

    const [rows] = await pool.query<RowDataPacket[]>(query, [this.config.database, tableName]);
    return rows.map((r) => ({
      columnName: r.columnName,
      dataType: r.dataType,
      isNullable: r.isNullable === 'YES',
      columnKey: r.columnKey || '',
      columnDefault: r.columnDefault,
      comment: r.comment || '',
    }));
  }

  /**
   * Ejecución segura de consultas de lectura: validación SQL, transacción READ ONLY,
   * tiempo máximo de ejecución y tope de filas devueltas.
   */
  public async executeReadOnlyQuery(
    rawQuery: string,
    maxRows = 50
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
        const [result] = await connection.query<RowDataPacket[]>({ sql: safeQuery, timeout: QUERY_TIMEOUT_MS });
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
