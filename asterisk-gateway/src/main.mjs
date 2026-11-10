import mysql from 'mysql2/promise';
import { crearApp } from './app.mjs';
import { leerConfig } from './logic.mjs';

const config = leerConfig(process.env);
const pool = mysql.createPool({
  ...config.db,
  connectionLimit: 3,
  connectTimeout: 5000,
  waitForConnections: true
});

const app = crearApp({
  config,
  consultar: async (sql, params) => (await pool.query({ sql, values: params, timeout: 30000 }))[0],
  log: (l) => console.log(`${new Date().toISOString()} ${l}`)
});
app.listen(config.port, () => console.log(`asterisk-gateway escuchando en :${config.port}`));
