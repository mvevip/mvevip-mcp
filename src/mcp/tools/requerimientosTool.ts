import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { REPORT_TIMEZONE, addDays, currentMonthInTimezone, monthRange, parseIso } from './dates';

const MAX_OUTPUT_CHARS = 100_000;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => Number(v ?? 0) || 0;
const pad = (n: number) => String(n).padStart(2, '0');

export const REQ_DETAIL_ORDER_COLUMNS = [
  'fecha_alta', 'fecha_requerimiento', 'fecha_venta', 'valor', 'nombre_cliente', 'asesor'
] as const;
export const REQ_GROUP_ORDER_COLUMNS = ['grupo', 'cantidad', 'valor'] as const;
/** Columnas que solo existen en el reporte de ventas agrupado por asesor con requerimientos incluidos. */
export const REQ_MERGED_ORDER_COLUMNS = ['requerimientos_cantidad', 'requerimientos_valor', 'comision_neta'] as const;

export interface RequerimientosParams {
  mes?: number;
  anio?: number;
  fecha_desde?: string;
  fecha_hasta?: string;
  agrupar_por?: 'ninguno' | 'asesor';
  ordenar_por?: string;
  direccion?: 'asc' | 'desc';
}

/** Período por fecha de ingreso del requerimiento (fecha_requerimiento): rango explícito o mes completo. */
export const resolveRequerimientosRange = (
  p: Pick<RequerimientosParams, 'mes' | 'anio' | 'fecha_desde' | 'fecha_hasta'>,
  now: Date = new Date()
): { desde: string; hastaExclusivo: string } => {
  if (p.fecha_desde || p.fecha_hasta) {
    const desde = (p.fecha_desde ?? p.fecha_hasta)!;
    const hasta = (p.fecha_hasta ?? p.fecha_desde)!;
    parseIso(desde);
    parseIso(hasta);
    if (desde > hasta) throw new Error('fecha_desde no puede ser posterior a fecha_hasta.');
    return { desde, hastaExclusivo: addDays(hasta, 1) };
  }
  const current = currentMonthInTimezone(now);
  const mes = p.mes ?? current.mes;
  const anio = p.anio ?? current.anio;
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw new Error('El mes debe estar entre 1 y 12.');
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw new Error('El año no es válido.');
  return monthRange(`${anio}-${pad(mes)}-01`);
};

/**
 * Requerimientos (devoluciones y reclamos de ventas) ingresados en el período. El asesor se resuelve con el mismo
 * nombre que usan los reportes de ventas (mve_usuarios), o con usuarios.usuario_crm si no tiene registro.
 */
export const requerimientosBaseSql = (desde: string, hastaExclusivo: string): string => `
SELECT
  R.id_requerimiento,
  R.fecha_requerimiento,
  R.fecha_alta,
  R.fecha_venta,
  R.id_registro,
  R.id_cliente,
  CONCAT(C.cli_apellido, ' ', C.cli_nombre) AS nombre_cliente,
  ROUND(R.valor, 2) AS valor,
  LEFT(R.observaciones, 500) AS observaciones,
  COALESCE(NULLIF(TRIM(CONCAT(UU.usu_apellido, ' ', UU.usu_nombre)), ''), NULLIF(TRIM(U.usuario_crm), ''), 'SIN ASIGNAR') AS asesor
FROM requerimientos R
LEFT JOIN usuarios U ON U.id_usuario = R.id_asesor
LEFT JOIN mve.mve_usuarios UU ON UU.usu_codigo = U.id_usuario_crm
LEFT JOIN mve.mve_clientes C ON C.cli_codigo = R.id_cliente
WHERE R.fecha_requerimiento >= '${desde}' AND R.fecha_requerimiento < '${hastaExclusivo}'`;

export const requerimientosTotalsSql = (desde: string, hastaExclusivo: string): string =>
  `SELECT COUNT(*) AS cantidad, ROUND(COALESCE(SUM(valor), 0), 2) AS valor FROM (${requerimientosBaseSql(desde, hastaExclusivo)}) v`;

export const requerimientosByAsesorSql = (desde: string, hastaExclusivo: string): string =>
  `SELECT asesor AS grupo, COUNT(*) AS cantidad, ROUND(SUM(valor), 2) AS valor
FROM (${requerimientosBaseSql(desde, hastaExclusivo)}) v
GROUP BY asesor
ORDER BY grupo ASC`;

export interface RequerimientosQueries {
  detailSql: string;
  totalsSql: string;
  desde: string;
  hastaExclusivo: string;
}

export const buildRequerimientosQueries = (params: RequerimientosParams, now: Date = new Date()): RequerimientosQueries => {
  const { desde, hastaExclusivo } = resolveRequerimientosRange(params, now);
  const base = requerimientosBaseSql(desde, hastaExclusivo);
  const direccion = params.direccion === 'asc' ? 'ASC' : 'DESC';
  const totalsSql = requerimientosTotalsSql(desde, hastaExclusivo);

  if ((params.agrupar_por ?? 'ninguno') === 'asesor') {
    const orden = params.ordenar_por ?? 'valor';
    if (!(REQ_GROUP_ORDER_COLUMNS as readonly string[]).includes(orden)) {
      throw new Error(`ordenar_por inválido al agrupar. Opciones: ${REQ_GROUP_ORDER_COLUMNS.join(', ')}`);
    }
    const detailSql = `SELECT asesor AS grupo, COUNT(*) AS cantidad, ROUND(SUM(valor), 2) AS valor
FROM (${base}) v
GROUP BY asesor
ORDER BY \`${orden}\` ${direccion}, grupo ASC`;
    return { detailSql, totalsSql, desde, hastaExclusivo };
  }

  const orden = params.ordenar_por ?? 'fecha_alta';
  if (!(REQ_DETAIL_ORDER_COLUMNS as readonly string[]).includes(orden)) {
    throw new Error(`ordenar_por inválido para el detalle. Opciones: ${REQ_DETAIL_ORDER_COLUMNS.join(', ')}`);
  }
  return {
    detailSql: `SELECT * FROM (${base}) v ORDER BY \`${orden}\` ${direccion}, id_requerimiento DESC`,
    totalsSql,
    desde,
    hastaExclusivo
  };
};

/**
 * Suma los requerimientos a las ventas agrupadas por asesor. Los requerimientos se descuentan de la comisión:
 * comision_neta = comision_asesor - requerimientos_valor. Los asesores con requerimientos y sin ventas en el período también aparecen.
 */
export const mergeRequerimientosByAsesor = (
  salesRows: Array<Record<string, any>>,
  reqRows: Array<Record<string, any>>,
  orden: string,
  direccion: 'asc' | 'desc'
) => {
  const req = new Map(reqRows.map((r) => [String(r.grupo), r]));
  const seen = new Set<string>();
  const merged: Array<Record<string, any>> = salesRows.map((s) => {
    const key = String(s.grupo);
    seen.add(key);
    const r = req.get(key);
    const reqValor = num(r?.valor);
    return {
      ...s,
      requerimientos_cantidad: num(r?.cantidad),
      requerimientos_valor: r2(reqValor),
      comision_neta: r2(num(s.comision_asesor) - reqValor)
    };
  });
  for (const r of reqRows) {
    if (seen.has(String(r.grupo))) continue;
    merged.push({
      grupo: r.grupo, ventas: 0, valor_total: 0, abono_pagado: 0, valor_pendiente: 0, comision_asesor: 0,
      requerimientos_cantidad: num(r.cantidad),
      requerimientos_valor: r2(num(r.valor)),
      comision_neta: r2(-num(r.valor))
    });
  }
  const sign = direccion === 'asc' ? 1 : -1;
  return merged.sort((a: any, b: any) => {
    const x = a[orden];
    const y = b[orden];
    const cmp = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : num(x) - num(y);
    return cmp !== 0 ? sign * cmp : String(a.grupo).localeCompare(String(b.grupo));
  });
};

export const withRequerimientosTotals = (totals: Record<string, any>, reqTotals: Record<string, any>) => ({
  ...totals,
  requerimientos_cantidad: num(reqTotals?.cantidad),
  requerimientos_valor: r2(num(reqTotals?.valor)),
  comision_neta: r2(num(totals?.comision_asesor) - num(reqTotals?.valor))
});

export const handleRequerimientos = async (params: RequerimientosParams): Promise<ToolResult> => {
  try {
    const q = buildRequerimientosQueries(params);
    const [detail, totals] = await Promise.all([
      dbService.executeReadOnlyQuery(q.detailSql, 500),
      dbService.executeReadOnlyQuery(q.totalsSql, 1)
    ]);
    const payload = {
      periodo: { desde: q.desde, hasta_exclusivo: q.hastaExclusivo, criterio: 'fecha de ingreso del requerimiento', zona_horaria: REPORT_TIMEZONE },
      agrupado_por: params.agrupar_por ?? 'ninguno',
      nota: 'Los valores de los requerimientos se descuentan de la comisión del asesor.',
      totales_del_periodo: totals.rows[0],
      filas_devueltas: detail.rowCount,
      filas_recortadas: detail.truncated,
      filas: detail.rows
    };
    let json = JSON.stringify(payload, null, 2);
    if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}\n... (salida recortada; agrupe o acorte el rango)`;
    return {
      content: [{ type: 'text', text: `📋 [MVEVIP MCP] Requerimientos ingresados ${q.desde} a ${q.hastaExclusivo} (exclusivo):\n\n\`\`\`json\n${json}\n\`\`\`` }]
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `❌ Error al consultar requerimientos: ${error?.message || String(error)}` }],
      isError: true
    };
  }
};
