import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';

const MAX_OUTPUT_CHARS = 100_000;
const REPORT_TIMEZONE = 'America/Guayaquil';

export const GROUP_BY_COLUMN = {
  asesor: 'nombre_del_asesor',
  lider: 'grupos',
  lider_asistente: 'lider_asistente',
  ciudad: 'ciudad',
  contrato: 'contrato',
  tipo_contrato: 'tipoContrato'
} as const;

export const DETAIL_ORDER_COLUMNS = [
  'fecha_venta', 'grupos', 'lider_asistente', 'id_cliente', 'nombre_del_cliente', 'ciudad',
  'abono_pagado', 'valor_total', 'valor_pendiente', 'comision_asesor', 'contrato', 'tipoContrato',
  'fecha_ingreso_cliente', 'nombre_del_asesor'
] as const;

export const GROUP_ORDER_COLUMNS = [
  'grupo', 'ventas', 'valor_total', 'abono_pagado', 'valor_pendiente', 'comision_asesor'
] as const;

export interface SalesReportParams {
  mes?: number;
  anio?: number;
  agrupar_por?: keyof typeof GROUP_BY_COLUMN | 'ninguno';
  ordenar_por?: string;
  direccion?: 'asc' | 'desc';
}

export interface SalesReportQueries {
  detailSql: string;
  totalsSql: string;
  desde: string;
  hasta: string;
}

/** Mes y año vigentes en la zona horaria del negocio (no en la del servidor, que es UTC). */
export const currentMonthInTimezone = (now: Date = new Date()): { mes: number; anio: number } => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit' })
    .formatToParts(now);
  return {
    anio: Number(parts.find((p) => p.type === 'year')!.value),
    mes: Number(parts.find((p) => p.type === 'month')!.value)
  };
};

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Detalle de ventas del período. Mismas columnas y reglas que la consulta de referencia del negocio:
 * se excluyen los estados anulados (9, 13) y solo cuentan ventas de líderes activos y visibles.
 * Las fechas y los nombres de columna del ORDER BY nunca vienen de texto libre del usuario.
 */
const baseSql = (desde: string, hasta: string): string => `
SELECT
  R.fecha_venta,
  UPPER(L.lider) AS grupos,
  UPPER(LL.lider) AS lider_asistente,
  R.id_cliente,
  CONCAT(C.cli_apellido, ' ', C.cli_nombre) AS nombre_del_cliente,
  D.nombre AS ciudad,
  ROUND(COALESCE(P.abono, 0), 2) AS abono_pagado,
  ROUND(R.valor_total, 2) AS valor_total,
  ROUND(R.valor_total - COALESCE(P.abono, 0), 2) AS valor_pendiente,
  ROUND(COALESCE(P.comision, 0), 2) AS comision_asesor,
  UPPER(T.nombre_comercial) AS contrato,
  UPPER(G.nombre) AS tipoContrato,
  C.cli_fecha_ingreso AS fecha_ingreso_cliente,
  CONCAT(UU.usu_apellido, ' ', UU.usu_nombre) AS nombre_del_asesor
FROM registros R
JOIN lideres L ON R.id_lider = L.id_lider AND L.estado = 1 AND L.visual = 1
LEFT JOIN (
  SELECT id_registro, SUM(valor_voucher) AS abono, SUM(comision) AS comision
  FROM registros_pagos
  WHERE id_registro IN (
    SELECT id_registro FROM registros
    WHERE fecha_venta >= '${desde}' AND fecha_venta < '${hasta}' AND estado NOT IN (9, 13)
  )
  GROUP BY id_registro
) P ON R.id_registro = P.id_registro
LEFT JOIN lideres LL ON R.id_lider_asistente = LL.id_lider
LEFT JOIN mve.mve_clientes C ON R.id_cliente = C.cli_codigo
LEFT JOIN mve.mve_geo_ciudades D ON C.cli_ciudad = D.id
LEFT JOIN (
  SELECT id_referencia, MIN(id_usuario_crm) AS id_usuario_crm
  FROM usuarios
  WHERE id_referencia IS NOT NULL
  GROUP BY id_referencia
) U ON R.id_vendedor = U.id_referencia
LEFT JOIN mve.mve_usuarios UU ON U.id_usuario_crm = UU.usu_codigo
LEFT JOIN registros_tipos T ON R.tipo_venta = T.id_tipo
LEFT JOIN registros_tipo_categorias G ON R.tipo = G.id_categoria
WHERE R.fecha_venta >= '${desde}' AND R.fecha_venta < '${hasta}'
  AND R.estado NOT IN (9, 13)`;

export const buildSalesReportQueries = (params: SalesReportParams, now: Date = new Date()): SalesReportQueries => {
  const current = currentMonthInTimezone(now);
  const mes = params.mes ?? current.mes;
  const anio = params.anio ?? current.anio;
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw new Error('El mes debe estar entre 1 y 12.');
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw new Error('El año no es válido.');

  const desde = `${anio}-${pad(mes)}-01`;
  const hasta = mes === 12 ? `${anio + 1}-01-01` : `${anio}-${pad(mes + 1)}-01`;
  const base = baseSql(desde, hasta);
  const direccion = params.direccion === 'asc' ? 'ASC' : 'DESC';
  const agrupar = params.agrupar_por ?? 'ninguno';

  const totalsSql = `SELECT COUNT(*) AS ventas, ROUND(COALESCE(SUM(valor_total), 0), 2) AS valor_total,
  ROUND(COALESCE(SUM(abono_pagado), 0), 2) AS abono_pagado, ROUND(COALESCE(SUM(valor_pendiente), 0), 2) AS valor_pendiente,
  ROUND(COALESCE(SUM(comision_asesor), 0), 2) AS comision_asesor
FROM (${base}) v`;

  if (agrupar === 'ninguno') {
    const orden = params.ordenar_por ?? 'valor_total';
    if (!(DETAIL_ORDER_COLUMNS as readonly string[]).includes(orden)) {
      throw new Error(`ordenar_por inválido para el detalle. Opciones: ${DETAIL_ORDER_COLUMNS.join(', ')}`);
    }
    return { detailSql: `SELECT * FROM (${base}) v ORDER BY \`${orden}\` ${direccion}`, totalsSql, desde, hasta };
  }

  const groupColumn = GROUP_BY_COLUMN[agrupar];
  if (!groupColumn) throw new Error(`agrupar_por inválido. Opciones: ninguno, ${Object.keys(GROUP_BY_COLUMN).join(', ')}`);
  const orden = params.ordenar_por ?? 'valor_total';
  if (!(GROUP_ORDER_COLUMNS as readonly string[]).includes(orden)) {
    throw new Error(`ordenar_por inválido al agrupar. Opciones: ${GROUP_ORDER_COLUMNS.join(', ')}`);
  }
  const detailSql = `SELECT COALESCE(NULLIF(TRIM(\`${groupColumn}\`), ''), 'SIN ASIGNAR') AS grupo, COUNT(*) AS ventas,
  ROUND(SUM(valor_total), 2) AS valor_total, ROUND(SUM(abono_pagado), 2) AS abono_pagado,
  ROUND(SUM(valor_pendiente), 2) AS valor_pendiente, ROUND(SUM(comision_asesor), 2) AS comision_asesor
FROM (${base}) v
GROUP BY grupo
ORDER BY \`${orden}\` ${direccion}, grupo ASC`;
  return { detailSql, totalsSql, desde, hasta };
};

export const handleSalesReport = async (params: SalesReportParams): Promise<ToolResult> => {
  try {
    const q = buildSalesReportQueries(params);
    const [detail, totals] = await Promise.all([
      dbService.executeReadOnlyQuery(q.detailSql, 500),
      dbService.executeReadOnlyQuery(q.totalsSql, 1)
    ]);

    const payload = {
      periodo: { desde: q.desde, hasta_exclusivo: q.hasta, zona_horaria: REPORT_TIMEZONE },
      agrupado_por: params.agrupar_por ?? 'ninguno',
      totales_del_periodo: totals.rows[0],
      filas_devueltas: detail.rowCount,
      filas_recortadas: detail.truncated,
      filas: detail.rows
    };
    let json = JSON.stringify(payload, null, 2);
    const cut = json.length > MAX_OUTPUT_CHARS;
    if (cut) json = `${json.slice(0, MAX_OUTPUT_CHARS)}\n... (salida recortada; agrupe o ordene para ver lo principal)`;

    return { content: [{ type: 'text', text: `📊 [MVEVIP MCP] Reporte de ventas ${q.desde} a ${q.hasta} (exclusivo):\n\n\`\`\`json\n${json}\n\`\`\`` }] };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `❌ Error al generar el reporte de ventas: ${error?.message || String(error)}` }],
      isError: true
    };
  }
};
