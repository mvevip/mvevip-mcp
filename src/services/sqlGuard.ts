/**
 * Validación defensiva de SQL de solo lectura. Es una segunda barrera: la primera debe ser
 * un usuario MySQL con únicamente privilegio SELECT.
 */

const ALLOWED_FIRST_WORDS = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];

const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ['INSERT', /\binsert\b(?!\s*\()/i],
  ['REPLACE', /\breplace\b(?!\s*\()/i],
  ['UPDATE', /\bupdate\b/i],
  ['DELETE', /\bdelete\b/i],
  ['DROP', /\bdrop\b/i],
  ['ALTER', /\balter\b/i],
  ['TRUNCATE', /\btruncate\b/i],
  ['CREATE', /\bcreate\b/i],
  ['RENAME', /\brename\b/i],
  ['GRANT', /\bgrant\b/i],
  ['REVOKE', /\brevoke\b/i],
  ['LOCK', /\block\b/i],
  ['UNLOCK', /\bunlock\b/i],
  ['CALL', /\bcall\b/i],
  ['DO', /\bdo\b/i],
  ['HANDLER', /\bhandler\b/i],
  ['LOAD', /\bload\b/i],
  ['SET', /\bset\b/i],
  ['PREPARE', /\bprepare\b/i],
  ['EXECUTE', /\bexecute\b/i],
  ['INTO', /\binto\b/i],
  ['SLEEP', /\bsleep\s*\(/i],
  ['BENCHMARK', /\bbenchmark\s*\(/i],
  ['LOAD_FILE', /\bload_file\s*\(/i],
  ['GET_LOCK', /\b(?:get_lock|release_lock|is_free_lock|is_used_lock|release_all_locks)\s*\(/i],
  ['asignación de variables (:=)', /:=/],
  ['esquemas del sistema', /\b(?:mysql|performance_schema|sys)\s*\.\s*[a-z_`]/i]
];

/**
 * Sustituye literales, identificadores entrecomillados y comentarios por espacios para que
 * las palabras clave dentro de textos no den falsos positivos ni se puedan esconder en ellos.
 */
const scrub = (sql: string): string => {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === '\\' && c !== '`') { j += 2; continue; }
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) throw new Error('Consulta inválida: literal sin cerrar.');
      out += ' ';
      i = j + 1;
    } else if (c === '/' && next === '*') {
      if (sql[i + 2] === '!' || sql[i + 2] === '+') {
        throw new Error('Operación denegada. No se permiten comentarios ejecutables (/*! ... */) ni hints.');
      }
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Consulta inválida: comentario sin cerrar.');
      out += ' ';
      i = end + 2;
    } else if ((c === '-' && next === '-') || c === '#') {
      const end = sql.indexOf('\n', i);
      out += ' ';
      i = end === -1 ? sql.length : end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
};

export interface ValidatedSql {
  sql: string;
  firstWord: string;
  hasLimit: boolean;
}

export const validateReadOnlySql = (rawQuery: string): ValidatedSql => {
  const sql = rawQuery.trim().replace(/;+\s*$/, '').trim();
  if (!sql) throw new Error('La consulta está vacía.');

  const scrubbed = scrub(sql);

  if (scrubbed.includes(';')) {
    throw new Error('Operación denegada. Solo se permite una sentencia por consulta.');
  }

  const firstWord = scrubbed.trim().split(/\s+/)[0]?.toUpperCase() || '';
  if (!ALLOWED_FIRST_WORDS.includes(firstWord)) {
    throw new Error(`Operación denegada. Solo se permiten consultas de lectura (${ALLOWED_FIRST_WORDS.join(', ')}).`);
  }

  for (const [label, pattern] of FORBIDDEN_PATTERNS) {
    if (pattern.test(scrubbed)) {
      throw new Error(`Operación denegada. '${label}' no está permitido por seguridad.`);
    }
  }

  return { sql, firstWord, hasLimit: /\blimit\b/i.test(scrubbed) };
};
