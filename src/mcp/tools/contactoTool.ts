import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { likePattern } from './asistenciaTool';

/**
 * encontrar_contacto: busca contactos de notas_registros por documento, nombres, teléfono, correo o nombre del asesor
 * (consulta del usuario). Solo lectura con mcp_ro y valores enlazados; los % y _ escritos se tratan como texto.
 */
export const CONTACTO_CAMPOS = ['todos', 'documento', 'nombres', 'telefono', 'correo', 'asesor'] as const;
export type ContactoCampo = (typeof CONTACTO_CAMPOS)[number];

export const CONTACTO_MIN_CARACTERES = 3;
export const CONTACTO_MAX_CARACTERES = 80;
export const CONTACTO_LIMITE_DEFECTO = 50;
export const CONTACTO_LIMITE_MAXIMO = 200;
const MAX_OUTPUT_CHARS = 100_000;

export interface ContactoParams {
  texto: string;
  campo?: ContactoCampo;
  limite?: number;
}

/** Fechas como texto (CAST) para no depender del tipo de columna ni de la zona horaria del servidor. */
export const CONTACTO_SELECT = `
SELECT
  R.id_lista,
  B.banco,
  R.identificador,
  R.identificadorOriginal,
  R.documento,
  R.nombres,
  R.telefono,
  R.correo,
  U.nombres AS asesor,
  CAST(R.fecha_alta AS CHAR) AS fecha_alta,
  CAST(R.fecha_ultima_contacto AS CHAR) AS fecha_ultima_contacto,
  CAST(R.fecha_asignacion AS CHAR) AS fecha_asignacion,
  E.descripcion AS estado
FROM notas_registros R
LEFT JOIN usuarios U ON R.asignado = U.id_usuario
LEFT JOIN notas_registros_bancos B ON R.banco = B.id_banco
LEFT JOIN notas_registros_estados E ON R.estado = E.id_estados`;

const COLUMNAS: Record<Exclude<ContactoCampo, 'todos'>, { sql: string; palabras: boolean }> = {
  documento: { sql: 'R.documento', palabras: false },
  nombres: { sql: 'R.nombres', palabras: true },
  telefono: { sql: 'R.telefono', palabras: false },
  correo: { sql: 'R.correo', palabras: false },
  asesor: { sql: 'U.nombres', palabras: true }
};

export interface ContactoQuery {
  sql: string;
  values: string[];
  texto: string;
  campo: ContactoCampo;
  limite: number;
}

/**
 * Nombres y asesor: cada palabra debe aparecer (en cualquier orden). Documento, teléfono y correo: el texto completo.
 * Con campo "todos" se prueban los cinco campos con OR, como la consulta original.
 */
const condicion = (campo: Exclude<ContactoCampo, 'todos'>, texto: string, values: string[]): string => {
  const col = COLUMNAS[campo];
  if (!col.palabras) {
    values.push(likePattern(texto));
    return `${col.sql} LIKE ?`;
  }
  const palabras = texto.split(/\s+/).filter(Boolean);
  const partes = palabras.map((p) => {
    values.push(likePattern(p));
    return `${col.sql} LIKE ?`;
  });
  return partes.length > 1 ? `(${partes.join(' AND ')})` : partes[0];
};

export const buildContactoQuery = (params: ContactoParams): ContactoQuery => {
  const texto = String(params.texto ?? '').trim().replace(/\s+/g, ' ');
  if (texto.length < CONTACTO_MIN_CARACTERES) {
    throw new Error(`Escriba al menos ${CONTACTO_MIN_CARACTERES} caracteres para buscar (documento, nombre, teléfono, correo o asesor).`);
  }
  if (texto.length > CONTACTO_MAX_CARACTERES) throw new Error(`El texto es demasiado largo (máximo ${CONTACTO_MAX_CARACTERES} caracteres).`);

  const campo = params.campo ?? 'todos';
  if (!(CONTACTO_CAMPOS as readonly string[]).includes(campo)) {
    throw new Error(`campo inválido. Opciones: ${CONTACTO_CAMPOS.join(', ')}`);
  }
  const limite = Math.floor(params.limite ?? CONTACTO_LIMITE_DEFECTO);
  if (!Number.isFinite(limite) || limite < 1 || limite > CONTACTO_LIMITE_MAXIMO) {
    throw new Error(`limite debe estar entre 1 y ${CONTACTO_LIMITE_MAXIMO}.`);
  }

  const values: string[] = [];
  const campos = campo === 'todos' ? (Object.keys(COLUMNAS) as Array<Exclude<ContactoCampo, 'todos'>>) : [campo];
  const where = campos.map((c) => condicion(c, texto, values)).join(' OR ');
  const sql = `${CONTACTO_SELECT}\nWHERE ${where}\nORDER BY R.id_lista DESC`;
  return { sql, values, texto, campo, limite };
};

export const handleEncontrarContacto = async (params: ContactoParams): Promise<ToolResult> => {
  try {
    const q = buildContactoQuery(params);
    const res = await dbService.executeReadOnlyQuery(q.sql, q.limite, q.values, CONTACTO_LIMITE_MAXIMO);
    const payload = {
      busqueda: { texto: q.texto, campo: q.campo, criterio: 'contiene (sin distinguir mayúsculas); nombres y asesor: todas las palabras en cualquier orden' },
      contactos_devueltos: res.rowCount,
      hay_mas_resultados: res.truncated,
      ...(res.truncated ? { aviso: `Hay más de ${q.limite} coincidencias (se muestran las ${q.limite} más recientes). Afine la búsqueda con más texto o indique el campo.` } : {}),
      ...(res.rowCount === 0 ? { aviso: 'Sin coincidencias. Pruebe con menos texto, otro campo o campo "todos".' } : {}),
      contactos: res.rows
    };
    let json = JSON.stringify(payload);
    if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}... (salida recortada; use un limite menor)`;
    return { content: [{ type: 'text', text: `🔎 [MVEVIP MCP] Contactos encontrados:\n\n\`\`\`json\n${json}\n\`\`\`` }] };
  } catch (error: any) {
    return { content: [{ type: 'text', text: `❌ Error al buscar el contacto: ${error?.message || String(error)}` }], isError: true };
  }
};
