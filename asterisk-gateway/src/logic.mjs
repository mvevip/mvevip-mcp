// Lógica pura del servicio de Asterisk (sin red ni base de datos), probada en tests/asteriskGateway.test.ts.
import { timingSafeEqual } from 'node:crypto';

export const MAX_TELEFONOS = 5000;
export const TAMANO_LOTE = 500;
export const MAX_DIAS = 1100;

export class ErrorHttp extends Error {
  constructor(status, codigo, mensaje) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
  }
}

export function leerConfig(env) {
  const token = env.GATEWAY_TOKEN || '';
  if (token.length < 32) throw new Error('GATEWAY_TOKEN debe tener al menos 32 caracteres');
  const cdrDb = env.CDR_DB || 'asteriskcdrdb';
  if (!/^[A-Za-z0-9_]+$/.test(cdrDb)) throw new Error('CDR_DB inválido');
  for (const k of ['DB_HOST', 'DB_USER', 'DB_PASSWORD']) {
    if (!env[k]) throw new Error(`Falta ${k}`);
  }
  return {
    token,
    cdrDb,
    port: Number(env.PORT) || 8080,
    db: { host: env.DB_HOST, port: Number(env.DB_PORT) || 3306, user: env.DB_USER, password: env.DB_PASSWORD }
  };
}

export function tokenValido(cabecera, token) {
  const m = /^Bearer (.+)$/.exec(cabecera || '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fechaEstricta(valor, campo) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw new ErrorHttp(400, 'solicitud_invalida', `${campo} debe tener formato AAAA-MM-DD`);
  }
  const d = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    throw new ErrorHttp(400, 'solicitud_invalida', `${campo} no es una fecha válida`);
  }
  return d;
}

/** Valida el cuerpo. `hasta` es inclusivo; devuelve `hastaExcl` (día siguiente) para el rango semiabierto. */
export function validarSolicitud(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
    throw new ErrorHttp(400, 'solicitud_invalida', 'El cuerpo debe ser un objeto JSON');
  }
  const { telefonos, desde, hasta } = cuerpo;
  if (!Array.isArray(telefonos) || telefonos.length === 0 || telefonos.length > MAX_TELEFONOS) {
    throw new ErrorHttp(400, 'solicitud_invalida', `telefonos debe ser una lista de 1 a ${MAX_TELEFONOS}`);
  }
  for (const t of telefonos) {
    if (typeof t !== 'string' || !/^0\d{9}$/.test(t)) {
      throw new ErrorHttp(400, 'solicitud_invalida', 'Cada teléfono debe ser texto de 10 dígitos que empieza en 0');
    }
  }
  const d = fechaEstricta(desde, 'desde');
  const h = fechaEstricta(hasta, 'hasta');
  const dias = (h.getTime() - d.getTime()) / 86400000;
  if (dias < 0) throw new ErrorHttp(400, 'solicitud_invalida', 'hasta no puede ser anterior a desde');
  if (dias > MAX_DIAS) throw new ErrorHttp(400, 'solicitud_invalida', `El rango no puede superar ${MAX_DIAS} días`);
  const excl = new Date(h.getTime() + 86400000).toISOString().slice(0, 10);
  return { telefonos: [...new Set(telefonos)], desde, hasta, hastaExcl: excl };
}

export function lotes(lista, tamano = TAMANO_LOTE) {
  const salida = [];
  for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
  return salida;
}

/** Consulta con valores enlazados; usa el índice (dst, calldate) y un rango de fechas semiabierto. */
export function construirConsulta(cdrDb, telefonos, desde, hastaExcl) {
  if (!/^[A-Za-z0-9_]+$/.test(cdrDb)) throw new Error('CDR_DB inválido');
  const marcas = telefonos.map(() => '?').join(',');
  const sql =
    'SELECT dst, COUNT(*) AS llamadas, CAST(SUM(duration) AS SIGNED) AS duracion, ' +
    'CAST(SUM(billsec) AS SIGNED) AS billsec, DATE_FORMAT(MAX(calldate), \'%Y-%m-%d %H:%i:%s\') AS ultima_llamada ' +
    `FROM \`${cdrDb}\`.\`cdr\` WHERE calldate >= ? AND calldate < ? AND dst IN (${marcas}) GROUP BY dst`;
  return { sql, params: [`${desde} 00:00:00`, `${hastaExcl} 00:00:00`, ...telefonos] };
}

export function crearLimitador(max, ventanaMs, ahora = () => Date.now()) {
  const cubos = new Map();
  return function permitir(clave) {
    const t = ahora();
    const c = cubos.get(clave);
    if (!c || t - c.inicio >= ventanaMs) {
      cubos.set(clave, { inicio: t, n: 1 });
      if (cubos.size > 5000) for (const [k, v] of cubos) if (t - v.inicio >= ventanaMs) cubos.delete(k);
      return true;
    }
    c.n += 1;
    return c.n <= max;
  };
}
