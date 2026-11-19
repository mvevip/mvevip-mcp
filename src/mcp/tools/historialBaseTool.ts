import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { REPORT_TIMEZONE, resolveDateRange } from './dates';

/**
 * historial_base (solo lectura): historial de liberaciones hechas con aplicar_base.
 * Tablas mcp_base_lotes (una fila por liberación) y mcp_base_historial (una fila por contacto y liberación,
 * con el estado ANTERIOR del contacto). Las liberaciones hechas a mano (UPDATE directo) no quedan registradas.
 */
export interface HistorialParams {
  id_lista?: number;
  telefono?: string;
  documento?: string;
  id_lote?: number;
  mes?: number;
  anio?: number;
  fecha_desde?: string;
  fecha_hasta?: string;
  banco?: number;
  limite?: number;
}

export interface HistorialDeps {
  consultar(sql: string, values: Array<string | number>, maxRows: number): Promise<{ rows: any[]; truncated: boolean }>;
}

export const defaultHistorialDeps: HistorialDeps = {
  consultar: async (sql, values, maxRows) => {
    const r = await dbService.executeReadOnlyQuery(sql, maxRows, values);
    return { rows: r.rows, truncated: r.truncated };
  }
};

const FECHA = (col: string) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s')`;
const marcas = (n: number) => Array(n).fill('?').join(',');

/** Filas del historial con nombres: asesor anterior, estado anterior y datos del lote. */
const SELECT_HISTORIAL =
  `SELECT H.id_historial, H.id_lote, ${FECHA('H.fecha_hora')} AS fecha_liberacion, H.id_lista, ` +
  'H.asignado_anterior, UA.nombres AS asesor_anterior, E.descripcion AS estado_anterior, H.identificador_anterior, ' +
  `H.observaciones_anterior, ${FECHA('H.fecha_asignacion_anterior')} AS fecha_asignacion_anterior, ` +
  'L.identificador_nuevo, L.accion, L.usuario_mcp, L.id_banco ' +
  'FROM mcp_base_historial H ' +
  'LEFT JOIN mcp_base_lotes L ON L.id_lote = H.id_lote ' +
  'LEFT JOIN usuarios UA ON UA.id_usuario = H.asignado_anterior ' +
  'LEFT JOIN notas_registros_estados E ON E.id_estados = H.estado_anterior ';

export const buildContactosQuery = (p: HistorialParams): { sql: string; values: Array<string | number> } => {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (p.id_lista !== undefined) { where.push('R.id_lista = ?'); values.push(p.id_lista); }
  if (p.telefono) { where.push('R.telefono = ?'); values.push(p.telefono.trim()); }
  if (p.documento) { where.push('R.documento = ?'); values.push(p.documento.trim()); }
  const sql =
    'SELECT R.id_lista, R.nombres, R.telefono, R.documento, R.banco, R.identificador AS identificador_actual, ' +
    'E.descripcion AS estado_actual, R.asignado AS asignado_actual, UC.nombres AS asesor_actual ' +
    'FROM notas_registros R ' +
    'LEFT JOIN notas_registros_estados E ON E.id_estados = R.estado ' +
    'LEFT JOIN usuarios UC ON UC.id_usuario = R.asignado ' +
    `WHERE ${where.join(' AND ')} ORDER BY R.id_lista LIMIT 20`;
  return { sql, values };
};

export const buildHistorialPorContactos = (ids: number[], limite: number): { sql: string; values: Array<string | number> } => ({
  sql: `${SELECT_HISTORIAL}WHERE H.id_lista IN (${marcas(ids.length)}) ORDER BY H.id_lista, H.fecha_hora DESC, H.id_historial DESC LIMIT ${limite}`,
  values: ids
});

export const buildHistorialPorLote = (idLote: number, limite: number): { sql: string; values: Array<string | number> } => ({
  sql: `${SELECT_HISTORIAL}WHERE H.id_lote = ? ORDER BY H.id_lista LIMIT ${limite}`,
  values: [idLote]
});

export const buildLotesQuery = (p: HistorialParams, limite: number, now: Date = new Date()): { sql: string; values: Array<string | number> } => {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (p.id_lote !== undefined) { where.push('L.id_lote = ?'); values.push(p.id_lote); }
  if (p.mes !== undefined || p.fecha_desde || p.fecha_hasta) {
    const { desde, hastaExclusivo } = resolveDateRange(p, now);
    where.push('L.fecha_hora >= ? AND L.fecha_hora < ?');
    values.push(`${desde} 00:00:00`, `${hastaExclusivo} 00:00:00`);
  }
  if (p.banco !== undefined) { where.push('L.id_banco = ?'); values.push(p.banco); }
  const sql =
    `SELECT L.id_lote, ${FECHA('L.fecha_hora')} AS fecha_liberacion, L.usuario_mcp, L.accion, L.id_banco, B.banco AS banco, ` +
    'L.identificador_nuevo, L.cantidad, L.cupos_creados, L.predictivos_desmarcados, L.filtros ' +
    'FROM mcp_base_lotes L LEFT JOIN notas_registros_bancos B ON B.id_banco = L.id_banco ' +
    `${where.length ? `WHERE ${where.join(' AND ')} ` : ''}ORDER BY L.id_lote DESC LIMIT ${limite}`;
  return { sql, values };
};

const MAX_LIMITE = 300;

const formatear = (h: any) => ({
  fecha_liberacion: h.fecha_liberacion,
  id_lote: h.id_lote,
  id_lista: h.id_lista,
  asesor_anterior: Number(h.asignado_anterior) ? (h.asesor_anterior ?? `usuario ${h.asignado_anterior}`) : 'sin asignar',
  estado_anterior: h.estado_anterior ?? null,
  identificador_anterior: h.identificador_anterior ?? null,
  fecha_asignacion_anterior: h.fecha_asignacion_anterior ?? null,
  observaciones_anterior: h.observaciones_anterior || undefined,
  identificador_nuevo: h.identificador_nuevo ?? null,
  accion: h.accion ?? null,
  liberado_por: h.usuario_mcp ?? null
});

const texto = (titulo: string, payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: `${titulo}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` }]
});

export const handleHistorialBase = async (params: HistorialParams, deps: HistorialDeps = defaultHistorialDeps, now: Date = new Date()): Promise<ToolResult> => {
  try {
    const limite = Math.min(Math.max(Math.trunc(params.limite ?? 50), 1), MAX_LIMITE);

    // 1) Por contacto (id_lista, teléfono o documento): su historial completo, del más reciente al más antiguo.
    if (params.id_lista !== undefined || params.telefono || params.documento) {
      const c = buildContactosQuery(params);
      const contactos = (await deps.consultar(c.sql, c.values, 20)).rows;
      if (!contactos.length) {
        return texto('📜 [MVEVIP MCP] Historial de liberaciones:', { contactos: [], mensaje: 'No se encontró ningún contacto con esos datos.' });
      }
      const h = buildHistorialPorContactos(contactos.map((r) => Number(r.id_lista)), limite);
      const historial = await deps.consultar(h.sql, h.values, limite);
      const porContacto = contactos.map((r) => ({
        id_lista: r.id_lista,
        nombres: r.nombres,
        telefono: r.telefono,
        documento: r.documento,
        banco: r.banco,
        situacion_actual: { identificador: r.identificador_actual, estado: r.estado_actual, asesor: Number(r.asignado_actual) ? (r.asesor_actual ?? `usuario ${r.asignado_actual}`) : 'sin asignar' },
        liberaciones: historial.rows.filter((x) => Number(x.id_lista) === Number(r.id_lista)).map(formatear)
      }));
      return texto('📜 [MVEVIP MCP] Historial de liberaciones por contacto:', {
        nota: 'Cada liberación muestra cómo estaba el contacto ANTES (asesor, estado, base, fecha de asignación) y a qué base pasó. Solo incluye liberaciones hechas con aplicar_base desde que existe el historial.',
        advertencia: historial.truncated ? `Hay más de ${limite} filas; se muestran las más recientes.` : undefined,
        contactos: porContacto
      });
    }

    // 2) Lotes (liberaciones): lista, o el detalle de uno con sus contactos.
    const l = buildLotesQuery(params, params.id_lote !== undefined ? 1 : Math.min(limite, 100), now);
    const lotes = await deps.consultar(l.sql, l.values, 100);
    if (params.id_lote !== undefined) {
      if (!lotes.rows.length) return texto('📜 [MVEVIP MCP] Historial de liberaciones:', { mensaje: `No existe el lote ${params.id_lote}.` });
      const d = buildHistorialPorLote(params.id_lote, limite);
      const filas = await deps.consultar(d.sql, d.values, limite);
      return texto('📜 [MVEVIP MCP] Detalle de una liberación:', {
        lote: lotes.rows[0],
        contactos_mostrados: filas.rows.length,
        advertencia: filas.truncated ? `El lote tiene más de ${limite} contactos; se muestran los primeros ${limite} (use limite para ver más, máx. ${MAX_LIMITE}).` : undefined,
        contactos: filas.rows.map(formatear)
      });
    }
    return texto('📜 [MVEVIP MCP] Liberaciones (más recientes primero):', {
      zona_horaria: REPORT_TIMEZONE,
      total_mostrado: lotes.rows.length,
      lotes: lotes.rows
    });
  } catch (error: any) {
    return { content: [{ type: 'text', text: `❌ Error al consultar el historial: ${error?.message || String(error)}` }], isError: true };
  }
};
