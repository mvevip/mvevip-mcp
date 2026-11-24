import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { likePattern } from './asistenciaTool';

/**
 * encontrar_cliente: busca clientes de mve.mve_clientes por documento, nombres y apellidos, teléfono (celular, teléfono 1 y 2) o correo.
 * Solo lectura con mcp_ro y valores enlazados; los % y _ escritos se tratan como texto.
 * No se leen la clave, el login, el token, el estado, la dirección, la fecha de nacimiento ni el ingreso promedio del cliente.
 */
export const CLIENTE_CAMPOS = ['todos', 'documento', 'nombres', 'telefono', 'correo'] as const;
export type ClienteCampo = (typeof CLIENTE_CAMPOS)[number];

export const CLIENTE_MIN_CARACTERES = 3;
export const CLIENTE_MAX_CARACTERES = 80;
export const CLIENTE_LIMITE_DEFECTO = 50;
export const CLIENTE_LIMITE_MAXIMO = 200;
const MIN_DIGITOS_TELEFONO = 3;
const MAX_OUTPUT_CHARS = 100_000;

export interface ClienteParams {
  texto: string;
  campo?: ClienteCampo;
  limite?: number;
}

/**
 * Un documento repetido (otro cliente con el mismo documento) se marca en clientes_con_mismo_documento.
 * La fecha sale como texto (CAST) para no depender del tipo de columna ni de la zona horaria del servidor.
 */
export const CLIENTE_SELECT = `
SELECT
  C.cli_codigo AS id_cliente,
  C.cli_nombre AS nombres,
  C.cli_apellido AS apellidos,
  CASE C.cli_tipo_id WHEN 1 THEN 'CEDULA' WHEN 2 THEN 'RUC' WHEN 3 THEN 'PASAPORTE' ELSE 'OTRO' END AS tipo_documento,
  C.cli_cedula AS documento,
  C.cli_email AS correo,
  C.cli_celular AS celular,
  C.cli_telefono1 AS telefono1,
  C.cli_telefono2 AS telefono2,
  G.nombre AS ciudad,
  C.cli_vendedor AS id_vendedor,
  NULLIF(TRIM(CONCAT(U.usu_apellido, ' ', U.usu_nombre)), '') AS vendedor,
  CAST(C.cli_fecha_ingreso AS CHAR) AS fecha_ingreso,
  D.veces AS clientes_con_mismo_documento
FROM mve.mve_clientes C
LEFT JOIN mve.mve_geo_ciudades G ON G.id = C.cli_ciudad
LEFT JOIN mve.mve_usuarios U ON U.usu_codigo = C.cli_vendedor
LEFT JOIN (
  SELECT cli_cedula, COUNT(*) AS veces FROM mve.mve_clientes
  WHERE cli_cedula NOT IN ('SD', '0', '') GROUP BY cli_cedula HAVING COUNT(*) > 1
) D ON D.cli_cedula = C.cli_cedula`;

/**
 * Dígitos de un teléfono sin código de país ni ceros iniciales: "0969 816-358", "969816358" y "+593 969 816 358"
 * dan lo mismo. Los celulares se guardan con y sin el 0 inicial, con espacios y con símbolos.
 */
export const nucleoTelefono = (texto: string): string => {
  let d = texto.replace(/\D/g, '').replace(/^0+/, '');
  if (d.startsWith('593') && d.length >= 11) d = d.slice(3).replace(/^0+/, '');
  return d;
};

const DIGITOS = (col: string) => `REGEXP_REPLACE(${col}, '[^0-9]', '')`;
const COLUMNAS_TELEFONO = ['C.cli_celular', 'C.cli_telefono1', 'C.cli_telefono2'] as const;

export interface ClienteQuery {
  sql: string;
  values: string[];
  texto: string;
  campo: ClienteCampo;
  limite: number;
}

const condicionDocumento = (texto: string, values: string[]): string => {
  values.push(likePattern(texto));
  return 'C.cli_cedula LIKE ?';
};

/** Cada palabra debe aparecer, en cualquier orden, entre el nombre y el apellido. */
const condicionNombres = (texto: string, values: string[]): string => {
  const partes = texto.split(/\s+/).filter(Boolean).map((p) => {
    values.push(likePattern(p));
    return "CONCAT_WS(' ', C.cli_nombre, C.cli_apellido) LIKE ?";
  });
  return partes.length > 1 ? `(${partes.join(' AND ')})` : partes[0];
};

const condicionTelefono = (nucleo: string, values: string[]): string => {
  const partes = COLUMNAS_TELEFONO.map((col) => {
    values.push(likePattern(nucleo));
    return `${DIGITOS(col)} LIKE ?`;
  });
  return `(${partes.join(' OR ')})`;
};

const condicionCorreo = (texto: string, values: string[]): string => {
  values.push(likePattern(texto));
  return 'C.cli_email LIKE ?';
};

export const buildClienteQuery = (params: ClienteParams): ClienteQuery => {
  const texto = String(params.texto ?? '').trim().replace(/\s+/g, ' ');
  if (texto.length < CLIENTE_MIN_CARACTERES) {
    throw new Error(`Escriba al menos ${CLIENTE_MIN_CARACTERES} caracteres para buscar (documento, nombre, teléfono o correo).`);
  }
  if (texto.length > CLIENTE_MAX_CARACTERES) throw new Error(`El texto es demasiado largo (máximo ${CLIENTE_MAX_CARACTERES} caracteres).`);

  const campo = params.campo ?? 'todos';
  if (!(CLIENTE_CAMPOS as readonly string[]).includes(campo)) throw new Error(`campo inválido. Opciones: ${CLIENTE_CAMPOS.join(', ')}`);
  const limite = Math.floor(params.limite ?? CLIENTE_LIMITE_DEFECTO);
  if (!Number.isFinite(limite) || limite < 1 || limite > CLIENTE_LIMITE_MAXIMO) {
    throw new Error(`limite debe estar entre 1 y ${CLIENTE_LIMITE_MAXIMO}.`);
  }

  const nucleo = nucleoTelefono(texto);
  if (campo === 'telefono' && nucleo.length < MIN_DIGITOS_TELEFONO) {
    throw new Error(`Para buscar por teléfono escriba al menos ${MIN_DIGITOS_TELEFONO} dígitos.`);
  }

  const values: string[] = [];
  const condiciones: string[] = [];
  if (campo === 'todos' || campo === 'documento') condiciones.push(condicionDocumento(texto, values));
  if (campo === 'todos' || campo === 'nombres') condiciones.push(condicionNombres(texto, values));
  // Con "todos" la parte de teléfono solo aplica si el texto trae dígitos suficientes (un nombre no la activa).
  if (campo === 'telefono' || (campo === 'todos' && nucleo.length >= MIN_DIGITOS_TELEFONO)) condiciones.push(condicionTelefono(nucleo, values));
  if (campo === 'todos' || campo === 'correo') condiciones.push(condicionCorreo(texto, values));

  const sql = `${CLIENTE_SELECT}\nWHERE ${condiciones.join(' OR ')}\nORDER BY C.cli_codigo DESC`;
  return { sql, values, texto, campo, limite };
};

/** El valor vacío del CRM es el texto 'SD': se devuelve como null para que no parezca un dato. */
const sinSD = (v: unknown): unknown => (typeof v === 'string' && (v.trim() === '' || v.trim().toUpperCase() === 'SD') ? null : v);

export const formatearCliente = (r: any) => ({
  id_cliente: r.id_cliente,
  nombres: sinSD(r.nombres),
  apellidos: sinSD(r.apellidos),
  tipo_documento: r.tipo_documento,
  documento: sinSD(r.documento),
  correo: sinSD(r.correo),
  celular: sinSD(r.celular),
  telefono1: sinSD(r.telefono1),
  telefono2: sinSD(r.telefono2),
  ciudad: r.ciudad ?? null,
  vendedor: r.vendedor ?? null,
  id_vendedor: Number(r.id_vendedor) || null,
  fecha_ingreso: r.fecha_ingreso ?? null,
  clientes_con_mismo_documento: r.clientes_con_mismo_documento ? Number(r.clientes_con_mismo_documento) : null
});

export const handleEncontrarCliente = async (params: ClienteParams): Promise<ToolResult> => {
  try {
    const q = buildClienteQuery(params);
    const res = await dbService.executeReadOnlyQuery(q.sql, q.limite, q.values, CLIENTE_LIMITE_MAXIMO);
    const clientes = res.rows.map(formatearCliente);
    const repetidos = clientes.filter((c) => c.clientes_con_mismo_documento).length;
    const avisos: string[] = [];
    if (res.truncated) avisos.push(`Hay más de ${q.limite} coincidencias (se muestran las ${q.limite} más recientes). Afine la búsqueda con más texto o indique el campo.`);
    if (res.rowCount === 0) avisos.push('Sin coincidencias. Pruebe con menos texto, otro campo o campo "todos".');
    if (repetidos > 0) {
      avisos.push(`${repetidos} cliente(s) del resultado comparten su documento con otro cliente (posible duplicado): vea clientes_con_mismo_documento. Cada uno tiene su propio id_cliente.`);
    }
    const payload = {
      busqueda: {
        texto: q.texto,
        campo: q.campo,
        criterio: 'contiene (sin distinguir mayúsculas); nombres: todas las palabras en cualquier orden entre nombre y apellido; teléfono: solo dígitos, en celular, teléfono 1 y teléfono 2, sin importar el 0 inicial'
      },
      clientes_devueltos: res.rowCount,
      hay_mas_resultados: res.truncated,
      ...(avisos.length ? { avisos } : {}),
      clientes
    };
    let json = JSON.stringify(payload);
    if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}... (salida recortada; use un limite menor)`;
    return { content: [{ type: 'text', text: `🔎 [MVEVIP MCP] Clientes encontrados:\n\n\`\`\`json\n${json}\n\`\`\`` }] };
  } catch (error: any) {
    return { content: [{ type: 'text', text: `❌ Error al buscar el cliente: ${error?.message || String(error)}` }], isError: true };
  }
};
