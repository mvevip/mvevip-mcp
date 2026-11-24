import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { likePattern } from './asistenciaTool';
import { ItemLote, LoteCampo, armarLote, marcas, prepararLote, repartirLote } from './loteUtils';

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
  /** Búsqueda «contiene» de un solo texto. */
  texto?: string;
  /** Búsqueda por lista (hasta 100 valores) con coincidencia exacta. Excluye a texto. */
  valores?: string[];
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

// ---------------------------------------------------------------------------
// Búsqueda por lista (hasta 100 valores en una sola llamada, coincidencia exacta)
// ---------------------------------------------------------------------------
export interface ContactoLoteQuery {
  sql: string | null;
  values: string[];
  items: ItemLote[];
}

/**
 * Trae el conjunto de contactos que podrían coincidir: teléfono por su índice (con y sin el 0 inicial), documento y correo
 * exactos (sin mayúsculas) y nombres con todas las palabras. La coincidencia exacta se confirma después en repartirLote.
 */
export const buildContactoLoteQuery = (items: ItemLote[]): ContactoLoteQuery => {
  const condiciones: string[] = [];
  const values: string[] = [];
  const telefonos = [...new Set(items.filter((i) => i.telefono).flatMap((i) => [`0${i.telefono}`, i.telefono as string]))];
  if (telefonos.length) {
    condiciones.push(`R.telefono IN (${marcas(telefonos.length)})`);
    values.push(...telefonos);
  }
  const docs = items.filter((i) => i.documento).map((i) => i.documento as string);
  if (docs.length) {
    condiciones.push(`LOWER(TRIM(R.documento)) IN (${marcas(docs.length)})`);
    values.push(...docs);
  }
  const correos = items.filter((i) => i.correo).map((i) => i.correo as string);
  if (correos.length) {
    condiciones.push(`LOWER(TRIM(R.correo)) IN (${marcas(correos.length)})`);
    values.push(...correos);
  }
  for (const i of items) if (i.palabras?.length) condiciones.push(condicion('nombres', i.palabras.join(' '), values));
  if (!condiciones.length) return { sql: null, values, items };
  return { sql: `${CONTACTO_SELECT}\nWHERE ${condiciones.join(' OR ')}\nORDER BY R.id_lista DESC`, values, items };
};

const MAX_FILAS_LOTE = 500;

const aFilaContacto = (r: any) => ({
  documento: r.documento,
  correo: r.correo,
  nombres: r.nombres,
  telefonos: [{ etiqueta: 'telefono', valor: r.telefono }]
});

const handleLoteContacto = async (params: ContactoParams): Promise<ToolResult> => {
  const campo = (params.campo ?? 'todos') as ContactoCampo;
  if (campo === 'asesor') throw new Error('En una lista no se puede buscar por asesor. Opciones: todos, documento, telefono, correo, nombres.');
  const prep = prepararLote(params.valores, campo as LoteCampo);
  const q = buildContactoLoteQuery(prep.items);
  const res = q.sql ? await dbService.executeReadOnlyQuery(q.sql, MAX_FILAS_LOTE, q.values, MAX_FILAS_LOTE) : { rows: [] as any[], truncated: false };
  const reparto = repartirLote(prep.items, res.rows, aFilaContacto);
  const cuerpo = armarLote(prep, reparto, 'contactos', (r: any) => ({ ...r }), (r: any) => r.id_lista);
  const avisos: string[] = [];
  if (res.truncated) avisos.push(`Se alcanzó el máximo de ${MAX_FILAS_LOTE} filas: puede faltar algún contacto. Divida la lista en partes más pequeñas.`);
  if (cuerpo.resumen.con_varios_resultados > 0) avisos.push(`${cuerpo.resumen.con_varios_resultados} valor(es) están en más de un contacto (el mismo teléfono puede estar en varias bases); cada uno trae su id_lista.`);
  if (prep.repetidos > 0) avisos.push(`${prep.repetidos} valor(es) repetido(s) en la lista se buscaron una sola vez.`);
  if (prep.invalidos.length > 0) avisos.push(`${prep.invalidos.length} valor(es) no se pudieron buscar (ver valores_invalidos).`);
  const payload = {
    busqueda: {
      modo: 'lista',
      campo,
      criterio: 'coincidencia exacta: documento y correo iguales (sin distinguir mayúsculas); teléfono igual por dígitos (sin importar 0 inicial, +593, espacios ni símbolos); nombres: todas las palabras en cualquier orden'
    },
    ...cuerpo,
    ...(avisos.length ? { avisos } : {})
  };
  let json = JSON.stringify(payload);
  if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}... (salida recortada; use menos valores)`;
  return { content: [{ type: 'text', text: `🔎 [MVEVIP MCP] Contactos encontrados por lista (${prep.items.length} valores):\n\n\`\`\`json\n${json}\n\`\`\`` }] };
};

export const handleEncontrarContacto = async (params: ContactoParams): Promise<ToolResult> => {
  try {
    const hayTexto = params.texto !== undefined && String(params.texto).trim() !== '';
    const hayValores = params.valores !== undefined;
    if (hayTexto && hayValores) throw new Error('Indique texto (un solo dato) o valores (una lista), no ambos.');
    if (hayValores) return await handleLoteContacto(params);
    if (!hayTexto) throw new Error('Indique texto (un solo dato) o valores (una lista de hasta 100).');
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
