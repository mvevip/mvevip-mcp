import mysql, { Pool, RowDataPacket } from 'mysql2/promise';

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
   * Ejecución segura de consultas de lectura con límite de registros
   */
  public async executeReadOnlyQuery(
    rawQuery: string,
    maxRows = 100
  ): Promise<{ rowCount: number; rows: any[] }> {
    const cleanQuery = rawQuery.trim();

    // Verificación de solo lectura
    const forbiddenKeywords = [
      'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
      'CREATE', 'RENAME', 'REPLACE', 'GRANT', 'REVOKE', 'LOCK'
    ];

    const firstWord = cleanQuery.split(/\s+/)[0]?.toUpperCase() || '';
    const allowedFirstWords = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];

    if (!allowedFirstWords.includes(firstWord)) {
      throw new Error(`Operación denegada. Solo se permiten consultas de lectura (${allowedFirstWords.join(', ')}).`);
    }

    for (const kw of forbiddenKeywords) {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      if (regex.test(cleanQuery)) {
        throw new Error(`Operación denegada. La palabra clave '${kw}' no está permitida por seguridad.`);
      }
    }

    // Asegurar LIMIT si es SELECT y no tiene uno establecido
    let safeQuery = cleanQuery;
    if (firstWord === 'SELECT' && !/\bLIMIT\b/i.test(cleanQuery)) {
      safeQuery = `${cleanQuery} LIMIT ${Math.min(maxRows, 500)}`;
    }

    const pool = this.getPool();
    const [result] = await pool.query<RowDataPacket[]>(safeQuery);

    const rows = Array.isArray(result) ? result : [];
    return {
      rowCount: rows.length,
      rows,
    };
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

export const dbService = new DatabaseService();
