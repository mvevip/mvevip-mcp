import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { REPORT_TIMEZONE, parseIso, resolveDateRange, toIso, todayInTimezone } from './dates';

/**
 * pagos_facturacion (solo lectura): abonos FACTURADOS (mve.mve_abonos con abo_estado 5 o 6) con su concepto contable
 * (cod_descripcion de la cotización), forma de pago, origen (ventas u otros módulos) y usuario.
 *
 * Reglas acordadas con el usuario (24-nov-2026):
 * - El valor es abo_valor, UNA vez por abono (un abono puede estar en varios registros_pagos: la comisión se divide pero la factura es una).
 * - registros_pagos.idAbonoCRM = mve_abonos.abo_codigo. Se ignoran 0, NULL y 1 (el 1 es un abono de 2017, no un enlace real).
 * - Una venta anulada (registros.estado 9 o 13) deja fuera su abono; solo si TODOS sus registros están anulados.
 * - Forma de pago = nombre del banco (abo_banco = gen_tipo_detalle.tid_codigo), tipo = gen_tipo. Si abo_forma_pago no coincide con
 *   el tipo del banco, el abono se incluye tal cual y se avisa (el usuario lo corrige en el origen).
 * - fecha_base: venta (fecha_venta del contrato; para abonos de otros módulos, abo_fecha), factura (abo_fecha_factura) o abono (abo_fecha).
 * - Concepto: cod_descripcion de las líneas de la cotización (mve_cotizaciones_det.cod_num_coti = mve_cotizaciones.cot_numero).
 *   Si una cotización tiene varias líneas, el valor del abono se reparte en proporción a cod_total_linea.
 * - vista=pendiente (separada, nunca se suma a lo facturado): abonos en estado 1 o 2 (por facturar) y pagos de ventas sin abono.
 *   Los estados 3, 4 y 7 no cuentan como pendientes (solo un contador aparte). Sin total combinado: abo_valor y valor_voucher no se suman.
 */
export type FechaBase = 'venta' | 'factura' | 'abono';
export const FECHA_BASE = ['venta', 'factura', 'abono'] as const;
export const AGRUPAR_POR = ['ninguno', 'concepto', 'forma_pago', 'tipo_pago', 'origen', 'destino', 'usuario', 'mes_factura', 'dia_factura'] as const;
export type AgruparPor = (typeof AGRUPAR_POR)[number];

export const VISTA = ['facturado', 'pendiente'] as const;
export type Vista = (typeof VISTA)[number];
export const AGRUPAR_POR_PENDIENTE = ['ninguno', 'concepto', 'forma_pago', 'tipo_pago', 'estado', 'origen', 'destino', 'usuario', 'dia', 'antiguedad'] as const;
export type AgruparPendiente = (typeof AGRUPAR_POR_PENDIENTE)[number];

export const GROUP_ORDER_COLUMNS = ['grupo', 'abonos', 'valor'] as const;
export const DETAIL_ORDER_COLUMNS = [
  'id_abono', 'factura', 'fecha_factura', 'fecha_abono', 'fecha_venta', 'origen', 'valor', 'forma_pago', 'tipo_pago', 'destino', 'usuario'
] as const;

export interface PagosFacturacionParams {
  mes?: number;
  anio?: number;
  fecha_desde?: string;
  fecha_hasta?: string;
  vista?: Vista;
  fecha_base?: FechaBase;
  agrupar_por?: AgruparPor | AgruparPendiente;
  ordenar_por?: string;
  direccion?: 'asc' | 'desc';
  comparar_anio_anterior?: boolean;
}

export interface PagosFacturacionDeps {
  consultar(sql: string, maxRows: number): Promise<{ rows: any[]; truncated: boolean }>;
}

export const defaultPagosFacturacionDeps: PagosFacturacionDeps = {
  consultar: async (sql, maxRows) => {
    const r = await dbService.executeReadOnlyQuery(sql, maxRows);
    return { rows: r.rows, truncated: r.truncated };
  }
};

const MAX_OUTPUT_CHARS = 100_000;
const MAX_FILAS = 500;

export interface PagosFacturacionQueries {
  desde: string;
  hastaExclusivo: string;
  fechaBase: FechaBase;
  agrupar: AgruparPor;
  detalleSql: string;
  totalesSql: string;
  /** Solo con fecha_base = venta: pagos de ventas del período que aún no tienen un abono facturado. */
  pendientesSql: string | null;
}

// ---------------------------------------------------------------------------
// Consultas (las fechas pasan por parseIso y las columnas de orden salen de listas cerradas)
// ---------------------------------------------------------------------------

/** Una fila por abono que viene de ventas: sus registros (ventas) vigentes y la fecha de venta más antigua. */
const ventasPorAbonoSql = `(
  SELECT P.idAbonoCRM AS abo_codigo,
         MIN(CASE WHEN R.estado NOT IN (9, 13) THEN R.fecha_venta END) AS fecha_venta,
         CAST(SUM(R.estado NOT IN (9, 13)) AS SIGNED) AS n_validas
  FROM registros_pagos P
  JOIN registros R ON R.id_registro = P.id_registro
  WHERE P.idAbonoCRM > 1
  GROUP BY P.idAbonoCRM
)`;

const fechaExpr = (base: FechaBase): string =>
  base === 'venta' ? 'COALESCE(V.fecha_venta, A.abo_fecha)' : base === 'factura' ? 'A.abo_fecha_factura' : 'A.abo_fecha';

/** Abonos facturados (estado 5 y 6) del período, uno por fila, sin las ventas anuladas. */
const abonosSql = (desde: string, hasta: string, base: FechaBase, estados = '5, 6'): string => `
SELECT A.abo_codigo, A.abo_valor, A.abo_fecha, A.abo_fecha_factura, A.abo_factura, A.abo_estado, A.abo_forma_pago, A.abo_banco,
       A.abo_cotizacion, A.abo_usuario,
       CASE WHEN V.abo_codigo IS NULL THEN 0 ELSE 1 END AS es_venta,
       V.fecha_venta AS fecha_venta
FROM mve.mve_abonos A
LEFT JOIN ${ventasPorAbonoSql} V ON V.abo_codigo = A.abo_codigo
WHERE A.abo_estado IN (${estados})
  AND (V.abo_codigo IS NULL OR V.n_validas > 0)
  AND ${fechaExpr(base)} >= '${desde}' AND ${fechaExpr(base)} < '${hasta}'`;

/** Abonos con sus nombres (forma de pago, tipo, destino, usuario) y la marca de forma de pago inconsistente. */
interface EnriquecidoOpts {
  estados?: string;
  /** Fecha de hoy (YYYY-MM-DD) para calcular los días que lleva pendiente un abono. */
  hoy?: string;
}

const enriquecidoSql = (desde: string, hasta: string, base: FechaBase, opts: EnriquecidoOpts = {}): string => `
SELECT AB.abo_codigo, AB.abo_valor, AB.abo_fecha, AB.abo_fecha_factura, AB.abo_factura, AB.abo_estado, AB.fecha_venta, AB.es_venta,
       CASE AB.abo_estado WHEN 1 THEN 'INGRESADA' WHEN 2 THEN 'AUTORIZADA' WHEN 3 THEN 'NO AUTORIZADA' WHEN 4 THEN 'ELIMINADA'
            WHEN 5 THEN 'FACTURADO' WHEN 6 THEN 'ANULADA AMERICAN EXPRESS' WHEN 7 THEN 'VENTA DE TICKET SIN FEE' ELSE 'OTRO' END AS estado,
       DATE_FORMAT(AB.abo_fecha, '%Y-%m-%d') AS dia,
       ${opts.hoy ? `DATEDIFF('${opts.hoy}', AB.abo_fecha)` : 'NULL'} AS dias_pendiente,
       C.cot_numero,
       COALESCE(NULLIF(TRIM(F.tid_nombre), ''), 'SIN FORMA DE PAGO') AS forma_pago,
       COALESCE(NULLIF(TRIM(FT.tip_nombre), ''), 'SIN TIPO') AS tipo_pago,
       CASE WHEN AB.es_venta = 1 THEN 'VENTAS' ELSE 'OTROS MODULOS' END AS origen,
       COALESCE(NULLIF(TRIM(DS.tid_nombre), ''), 'SIN DESTINO') AS destino,
       COALESCE(NULLIF(TRIM(CONCAT(U.usu_apellido, ' ', U.usu_nombre)), ''), 'SIN USUARIO') AS usuario,
       COALESCE(DATE_FORMAT(AB.abo_fecha_factura, '%Y-%m'), 'SIN FECHA DE FACTURA') AS mes_factura,
       COALESCE(DATE_FORMAT(AB.abo_fecha_factura, '%Y-%m-%d'), 'SIN FECHA DE FACTURA') AS dia_factura,
       CASE WHEN F.tid_codigo IS NOT NULL AND AB.abo_forma_pago <> F.tip_codigo THEN 1 ELSE 0 END AS forma_inconsistente
FROM (${abonosSql(desde, hasta, base, opts.estados)}) AB
LEFT JOIN mve.gen_tipo_detalle F ON F.tid_codigo = AB.abo_banco
LEFT JOIN mve.gen_tipo FT ON FT.tip_codigo = F.tip_codigo
LEFT JOIN mve.mve_cotizaciones C ON C.cot_codigo = AB.abo_cotizacion
LEFT JOIN mve.gen_tipo_detalle DS ON DS.tid_codigo = C.cot_combo
LEFT JOIN mve.mve_usuarios U ON U.usu_codigo = AB.abo_usuario`;

/** Líneas de cada cotización: cuántas, cuánto suman y sus descripciones. */
const lineasPorCotizacionSql = `(
  SELECT cod_num_coti, COUNT(*) AS n_lineas, SUM(cod_total_linea) AS suma_lineas,
         GROUP_CONCAT(DISTINCT cod_descripcion ORDER BY cod_descripcion SEPARATOR ' + ') AS conceptos
  FROM mve.mve_cotizaciones_det
  GROUP BY cod_num_coti
)`;

/** Una fila por línea de la cotización; el valor del abono se reparte en proporción a cod_total_linea. */
const agrupadoPorConceptoSql = (abonos: string, orden: string, direccion: string): string => `SELECT concepto AS grupo, COUNT(DISTINCT abo_codigo) AS abonos, ROUND(SUM(valor_linea), 2) AS valor
FROM (
  SELECT AB.abo_codigo,
         COALESCE(NULLIF(TRIM(D.cod_descripcion), ''), 'SIN CONCEPTO') AS concepto,
         CASE WHEN D.cod_num_coti IS NULL THEN AB.abo_valor
              WHEN T.suma_lineas = 0 THEN AB.abo_valor / T.n_lineas
              ELSE AB.abo_valor * D.cod_total_linea / T.suma_lineas END AS valor_linea
  FROM (${abonos}) AB
  LEFT JOIN mve.mve_cotizaciones C ON C.cot_codigo = AB.abo_cotizacion
  LEFT JOIN ${lineasPorCotizacionSql} T ON T.cod_num_coti = C.cot_numero
  LEFT JOIN mve.mve_cotizaciones_det D ON D.cod_num_coti = C.cot_numero
) L
GROUP BY concepto
ORDER BY \`${orden}\` ${direccion}, grupo ASC`;

export const buildQueriesForRange = (params: PagosFacturacionParams, desde: string, hastaExclusivo: string): PagosFacturacionQueries => {
  const fechaBase = params.fecha_base ?? 'venta';
  if (!(FECHA_BASE as readonly string[]).includes(fechaBase)) throw new Error(`fecha_base inválida. Opciones: ${FECHA_BASE.join(', ')}`);
  const agrupar = (params.agrupar_por ?? 'concepto') as AgruparPor;
  if (!(AGRUPAR_POR as readonly string[]).includes(agrupar)) throw new Error(`agrupar_por inválido para lo facturado. Opciones: ${AGRUPAR_POR.join(', ')}`);
  parseIso(desde);
  parseIso(hastaExclusivo);

  const enriquecido = enriquecidoSql(desde, hastaExclusivo, fechaBase);
  const direccionParam = params.direccion === 'asc' ? 'ASC' : params.direccion === 'desc' ? 'DESC' : null;

  // Totales exactos (abo_valor una sola vez por abono) y controles de calidad en una sola consulta.
  const totalesSql = `SELECT COUNT(*) AS abonos, ROUND(COALESCE(SUM(X.abo_valor), 0), 2) AS valor,
  CAST(COALESCE(SUM(X.es_venta), 0) AS SIGNED) AS abonos_ventas,
  ROUND(COALESCE(SUM(CASE WHEN X.es_venta = 1 THEN X.abo_valor END), 0), 2) AS valor_ventas,
  CAST(COALESCE(SUM(X.forma_inconsistente), 0) AS SIGNED) AS forma_inconsistente_abonos,
  ROUND(COALESCE(SUM(CASE WHEN X.forma_inconsistente = 1 THEN X.abo_valor END), 0), 2) AS forma_inconsistente_valor,
  CAST(COALESCE(SUM(T.cod_num_coti IS NULL), 0) AS SIGNED) AS sin_lineas,
  CAST(COALESCE(SUM(T.cod_num_coti IS NOT NULL AND ABS(T.suma_lineas - X.abo_valor) > 0.01), 0) AS SIGNED) AS cotizacion_valor_distinto,
  CAST(COALESCE(SUM(DUP.cot_numero IS NOT NULL), 0) AS SIGNED) AS cotizacion_repetida
FROM (${enriquecido}) X
LEFT JOIN ${lineasPorCotizacionSql} T ON T.cod_num_coti = X.cot_numero
LEFT JOIN (SELECT cot_numero FROM mve.mve_cotizaciones GROUP BY cot_numero HAVING COUNT(*) > 1) DUP ON DUP.cot_numero = X.cot_numero`;

  let detalleSql: string;
  if (agrupar === 'ninguno') {
    const orden = params.ordenar_por ?? 'valor';
    if (!(DETAIL_ORDER_COLUMNS as readonly string[]).includes(orden)) {
      throw new Error(`ordenar_por inválido para el detalle. Opciones: ${DETAIL_ORDER_COLUMNS.join(', ')}`);
    }
    const direccion = direccionParam ?? (orden === 'valor' ? 'DESC' : orden === 'fecha_factura' ? 'DESC' : 'ASC');
    detalleSql = `SELECT X.abo_codigo AS id_abono, X.abo_factura AS factura,
  DATE_FORMAT(X.abo_fecha_factura, '%Y-%m-%d') AS fecha_factura, DATE_FORMAT(X.abo_fecha, '%Y-%m-%d') AS fecha_abono,
  DATE_FORMAT(X.fecha_venta, '%Y-%m-%d') AS fecha_venta, X.origen, X.abo_valor AS valor,
  X.forma_pago, X.tipo_pago, X.destino, X.usuario, T.conceptos AS conceptos
FROM (${enriquecido}) X
LEFT JOIN ${lineasPorCotizacionSql} T ON T.cod_num_coti = X.cot_numero
ORDER BY \`${orden}\` ${direccion}, id_abono ASC`;
  } else {
    const orden = params.ordenar_por ?? (agrupar === 'mes_factura' || agrupar === 'dia_factura' ? 'grupo' : 'valor');
    if (!(GROUP_ORDER_COLUMNS as readonly string[]).includes(orden)) {
      throw new Error(`ordenar_por inválido al agrupar. Opciones: ${GROUP_ORDER_COLUMNS.join(', ')}`);
    }
    const direccion = direccionParam ?? (orden === 'grupo' ? 'ASC' : 'DESC');
    if (agrupar === 'concepto') {
      detalleSql = agrupadoPorConceptoSql(abonosSql(desde, hastaExclusivo, fechaBase), orden, direccion);
    } else {
      detalleSql = `SELECT X.${agrupar} AS grupo, COUNT(*) AS abonos, ROUND(SUM(X.abo_valor), 2) AS valor
FROM (${enriquecido}) X
GROUP BY grupo
ORDER BY \`${orden}\` ${direccion}, grupo ASC`;
    }
  }

  // Lo que falta por facturar de las ventas del período: solo tiene sentido al ubicar por fecha de venta.
  const pendientesSql =
    fechaBase !== 'venta'
      ? null
      : `SELECT
  CAST(COALESCE(SUM(P.idAbonoCRM IS NULL OR P.idAbonoCRM = 0), 0) AS SIGNED) AS pagos_sin_abono,
  ROUND(COALESCE(SUM(CASE WHEN P.idAbonoCRM IS NULL OR P.idAbonoCRM = 0 THEN P.valor_voucher END), 0), 2) AS valor_sin_abono,
  CAST(COALESCE(SUM(P.idAbonoCRM > 1 AND A.abo_codigo IS NOT NULL AND A.abo_estado IN (1, 2)), 0) AS SIGNED) AS pagos_abono_sin_facturar,
  ROUND(COALESCE(SUM(CASE WHEN P.idAbonoCRM > 1 AND A.abo_codigo IS NOT NULL AND A.abo_estado IN (1, 2) THEN P.valor_voucher END), 0), 2) AS valor_abono_sin_facturar,
  CAST(COALESCE(SUM(P.idAbonoCRM = 1), 0) AS SIGNED) AS pagos_enlace_invalido,
  ROUND(COALESCE(SUM(CASE WHEN P.idAbonoCRM = 1 THEN P.valor_voucher END), 0), 2) AS valor_enlace_invalido
FROM registros R
JOIN registros_pagos P ON P.id_registro = R.id_registro
LEFT JOIN mve.mve_abonos A ON A.abo_codigo = P.idAbonoCRM AND P.idAbonoCRM > 1
WHERE R.fecha_venta >= '${desde}' AND R.fecha_venta < '${hastaExclusivo}' AND R.estado NOT IN (9, 13)`;

  return { desde, hastaExclusivo, fechaBase, agrupar, detalleSql, totalesSql, pendientesSql };
};

export const buildPagosFacturacionQueries = (params: PagosFacturacionParams, now: Date = new Date()): PagosFacturacionQueries => {
  const { desde, hastaExclusivo } = resolveDateRange(params, now);
  return buildQueriesForRange(params, desde, hastaExclusivo);
};

/** Mismo día un año antes (el 29-feb pasa al 28-feb). */
export const shiftYears = (iso: string, years: number): string => {
  const d = parseIso(iso);
  const y = d.getUTCFullYear() + years;
  if (y < 2000) throw new Error('El período anterior queda antes del año 2000.');
  const m = d.getUTCMonth();
  const ultimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toIso(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), ultimo))));
};

// ---------------------------------------------------------------------------
// Armado de la respuesta (funciones puras, probadas con cifras reales)
// ---------------------------------------------------------------------------
const num = (v: unknown): number => Number(v ?? 0) || 0;
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const pct = (parte: number, todo: number): number | null => (todo > 0 ? Math.round((parte / todo) * 1000) / 10 : null);

export const armarTotales = (r: any) => {
  const abonos = num(r.abonos);
  const valor = round2(num(r.valor));
  const abonosVentas = num(r.abonos_ventas);
  const valorVentas = round2(num(r.valor_ventas));
  return {
    abonos_facturados: abonos,
    valor_facturado: valor,
    ventas: { abonos: abonosVentas, valor: valorVentas },
    otros_modulos: { abonos: abonos - abonosVentas, valor: round2(valor - valorVentas) }
  };
};

export interface FilaGrupo {
  grupo: string;
  abonos: number;
  valor: number;
}

const aFilas = (rows: any[]): FilaGrupo[] => rows.map((r) => ({ grupo: String(r.grupo ?? ''), abonos: num(r.abonos), valor: round2(num(r.valor)) }));

export const agregarPorcentajes = (filas: FilaGrupo[], valorTotal: number) =>
  filas.map((f) => ({ ...f, porcentaje_del_valor: pct(f.valor, valorTotal) }));

/** Une el período actual con el del año anterior por grupo (los grupos que solo existían antes salen con valor 0). */
export const unirComparativo = (actual: FilaGrupo[], anterior: FilaGrupo[], valorTotalActual: number) => {
  const previo = new Map(anterior.map((f) => [f.grupo, f]));
  const vistos = new Set<string>();
  const filas = actual.map((f) => {
    vistos.add(f.grupo);
    const p = previo.get(f.grupo);
    const vAnt = p?.valor ?? 0;
    return {
      grupo: f.grupo,
      abonos: f.abonos,
      valor: f.valor,
      porcentaje_del_valor: pct(f.valor, valorTotalActual),
      abonos_anio_anterior: p?.abonos ?? 0,
      valor_anio_anterior: vAnt,
      variacion_valor: round2(f.valor - vAnt),
      variacion_porcentaje: vAnt > 0 ? Math.round(((f.valor - vAnt) / vAnt) * 1000) / 10 : null
    };
  });
  const soloAntes = anterior
    .filter((f) => !vistos.has(f.grupo))
    .sort((a, b) => b.valor - a.valor)
    .map((p) => ({
      grupo: p.grupo,
      abonos: 0,
      valor: 0,
      porcentaje_del_valor: 0,
      abonos_anio_anterior: p.abonos,
      valor_anio_anterior: p.valor,
      variacion_valor: round2(-p.valor),
      variacion_porcentaje: -100
    }));
  return [...filas, ...soloAntes];
};

export const compararTotales = (actual: ReturnType<typeof armarTotales>, anterior: ReturnType<typeof armarTotales>) => ({
  abonos: { actual: actual.abonos_facturados, anio_anterior: anterior.abonos_facturados, variacion: actual.abonos_facturados - anterior.abonos_facturados, variacion_porcentaje: pct(actual.abonos_facturados - anterior.abonos_facturados, anterior.abonos_facturados) },
  valor: { actual: actual.valor_facturado, anio_anterior: anterior.valor_facturado, variacion: round2(actual.valor_facturado - anterior.valor_facturado), variacion_porcentaje: pct(actual.valor_facturado - anterior.valor_facturado, anterior.valor_facturado) }
});

const dinero = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CRITERIO_FECHA: Record<FechaBase, string> = {
  venta: 'fecha de venta del contrato (registros.fecha_venta); los abonos de otros módulos, que no tienen venta, se ubican por la fecha del abono (abo_fecha)',
  factura: 'fecha de la factura (abo_fecha_factura)',
  abono: 'fecha en que se ingresó el abono al sistema (abo_fecha)'
};

export const armarAvisos = (totalesRow: any, agrupar: AgruparPor, pendientes: any | null): string[] => {
  const avisos: string[] = [];
  const incons = num(totalesRow.forma_inconsistente_abonos);
  if (incons > 0) {
    avisos.push(
      `⚠️ ${incons} abono(s) por ${dinero(num(totalesRow.forma_inconsistente_valor))} tienen la forma de pago inconsistente (abo_forma_pago no coincide con el tipo del banco). ` +
        'Se incluyeron tal como están en el reporte; corríjalos en el origen para que el desglose por forma de pago sea exacto.'
    );
  }
  const sinLineas = num(totalesRow.sin_lineas);
  if (sinLineas > 0) avisos.push(`${sinLineas} abono(s) no tienen cotización o líneas de detalle: en el desglose por concepto aparecen como SIN CONCEPTO.`);
  const distinto = num(totalesRow.cotizacion_valor_distinto);
  if (distinto > 0) avisos.push(`${distinto} abono(s) tienen una cotización cuyas líneas suman un valor distinto al del abono; se usó siempre abo_valor (el reparto por concepto es proporcional).`);
  const repetida = num(totalesRow.cotizacion_repetida);
  if (repetida > 0) avisos.push(`${repetida} abono(s) tienen un número de cotización repetido en el sistema; su concepto puede no ser exacto.`);
  if (agrupar === 'concepto') {
    avisos.push("En el desglose por concepto, 'abonos' cuenta un abono en cada concepto que contiene; el valor se reparte en proporción a las líneas y suma el total facturado.");
  }
  if (pendientes) {
    const sinAbono = num(pendientes.pagos_sin_abono);
    const sinFacturar = num(pendientes.pagos_abono_sin_facturar);
    const invalido = num(pendientes.pagos_enlace_invalido);
    if (sinAbono > 0 || sinFacturar > 0) {
      avisos.push(`Pendiente de facturar (ventas del período no anuladas): ${sinAbono} pago(s) sin abono por ${dinero(num(pendientes.valor_sin_abono))} y ${sinFacturar} pago(s) con abono aún no facturado por ${dinero(num(pendientes.valor_abono_sin_facturar))} (valores de voucher). No están en los totales; use vista=pendiente para ver el detalle.`);
    }
    if (invalido > 0) avisos.push(`${invalido} pago(s) de ventas del período por ${dinero(num(pendientes.valor_enlace_invalido))} apuntan al abono 1 (enlace inválido de 2017); no se incluyeron.`);
  }
  return avisos;
};

const texto = (titulo: string, payload: unknown): ToolResult => {
  let json = JSON.stringify(payload, null, 2);
  if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}\n... (salida recortada; agrupe o ordene para ver lo principal)`;
  return { content: [{ type: 'text', text: `${titulo}\n\n\`\`\`json\n${json}\n\`\`\`` }] };
};

export const handlePagosFacturacion = async (
  params: PagosFacturacionParams,
  deps: PagosFacturacionDeps = defaultPagosFacturacionDeps,
  now: Date = new Date()
): Promise<ToolResult> => {
  try {
    if (params.vista === 'pendiente') return await handlePendiente(params, deps, now);
    const q = buildPagosFacturacionQueries(params, now);
    const anteriorQ = params.comparar_anio_anterior
      ? buildQueriesForRange(params, shiftYears(q.desde, -1), shiftYears(q.hastaExclusivo, -1))
      : null;

    const [detalle, totales, pendientes, detalleAnt, totalesAnt] = await Promise.all([
      deps.consultar(q.detalleSql, MAX_FILAS),
      deps.consultar(q.totalesSql, 1),
      q.pendientesSql ? deps.consultar(q.pendientesSql, 1) : null,
      anteriorQ && q.agrupar !== 'ninguno' ? deps.consultar(anteriorQ.detalleSql, MAX_FILAS) : null,
      anteriorQ ? deps.consultar(anteriorQ.totalesSql, 1) : null
    ]);

    const totalesRow = totales.rows[0] ?? {};
    const tot = armarTotales(totalesRow);
    const totAnt = totalesAnt ? armarTotales(totalesAnt.rows[0] ?? {}) : null;

    let filas: unknown[];
    if (q.agrupar === 'ninguno') {
      filas = detalle.rows.map((r) => ({ ...r, valor: round2(num(r.valor)) }));
    } else if (detalleAnt) {
      filas = unirComparativo(aFilas(detalle.rows), aFilas(detalleAnt.rows), tot.valor_facturado);
    } else {
      filas = agregarPorcentajes(aFilas(detalle.rows), tot.valor_facturado);
    }

    const payload = {
      periodo: { desde: q.desde, hasta_exclusivo: q.hastaExclusivo, zona_horaria: REPORT_TIMEZONE },
      fecha_base: q.fechaBase,
      criterio_fecha: CRITERIO_FECHA[q.fechaBase],
      reglas:
        'Solo abonos facturados (abo_estado 5 y 6). El valor es abo_valor, una sola vez por abono. Se excluyen las ventas anuladas (estados 9 y 13). Concepto = descripción de la cotización (cod_descripcion). Forma de pago = banco o tarjeta del abono; tipo = tarjeta, depósitos o efectivo.',
      agrupado_por: q.agrupar,
      totales: tot,
      ...(totAnt && anteriorQ
        ? {
            comparativo_anio_anterior: {
              periodo: { desde: anteriorQ.desde, hasta_exclusivo: anteriorQ.hastaExclusivo },
              totales_anio_anterior: totAnt,
              variacion: compararTotales(tot, totAnt)
            }
          }
        : {}),
      ...(pendientes ? { pendiente_de_facturar_ventas_del_periodo: pendientes.rows[0] } : {}),
      avisos: armarAvisos(totalesRow, q.agrupar, pendientes ? pendientes.rows[0] : null),
      filas_devueltas: filas.length,
      filas_recortadas: detalle.truncated || !!detalleAnt?.truncated,
      filas
    };
    return texto(`💳 [MVEVIP MCP] Abonos facturados ${q.desde} a ${q.hastaExclusivo} (exclusivo), por ${q.fechaBase}:`, payload);
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `❌ Error al generar el reporte de pagos y facturación: ${error?.message || String(error)}` }],
      isError: true
    };
  }
};

// ---------------------------------------------------------------------------
// Vista pendiente: lo que falta por facturar, separado de lo facturado (sin total combinado)
// ---------------------------------------------------------------------------
export const ABONOS_PEND_DETAIL_ORDER = [
  'id_abono', 'fecha_abono', 'fecha_venta', 'estado', 'dias_pendiente', 'origen', 'valor', 'forma_pago', 'tipo_pago', 'destino', 'usuario'
] as const;
export const SIN_ABONO_DETAIL_ORDER = ['id_pago', 'id_registro', 'fecha_venta', 'fecha_pago', 'dias_pendiente', 'valor', 'usuario'] as const;

export interface PendienteQueries {
  desde: string;
  hastaExclusivo: string;
  fechaBase: FechaBase;
  agrupar: AgruparPendiente;
  hoy: string;
  abonosDetalleSql: string;
  abonosTotalesSql: string;
  noConsideradosSql: string;
  sinAbonoDetalleSql: string;
  sinAbonoTotalesSql: string;
}

const bucketAntiguedad = (col: string): string =>
  `CASE WHEN ${col} <= 7 THEN '1. 0 a 7 dias' WHEN ${col} <= 15 THEN '2. 8 a 15 dias' WHEN ${col} <= 30 THEN '3. 16 a 30 dias' ELSE '4. Mas de 30 dias' END`;

/** Pagos de ventas (no anuladas) que todavía no tienen abono: idAbonoCRM en 0 o NULL. */
const sinAbonoBaseSql = (desde: string, hasta: string, base: FechaBase, hoy: string): string => {
  const fecha = base === 'abono' ? 'P.fecha_pago' : 'R.fecha_venta';
  return `
SELECT P.id_pago, P.id_registro, P.valor_voucher, P.fecha_pago, R.fecha_venta,
       DATEDIFF('${hoy}', COALESCE(P.fecha_pago, R.fecha_venta)) AS dias_pendiente,
       COALESCE(NULLIF(TRIM(CONCAT(UU.usu_apellido, ' ', UU.usu_nombre)), ''), 'SIN ASESOR') AS asesor
FROM registros R
JOIN registros_pagos P ON P.id_registro = R.id_registro
LEFT JOIN (
  SELECT id_referencia, MIN(id_usuario_crm) AS id_usuario_crm FROM usuarios WHERE id_referencia > 0 GROUP BY id_referencia
) U ON R.id_vendedor = U.id_referencia
LEFT JOIN mve.mve_usuarios UU ON U.id_usuario_crm = UU.usu_codigo
WHERE (P.idAbonoCRM IS NULL OR P.idAbonoCRM = 0) AND R.estado NOT IN (9, 13)
  AND ${fecha} >= '${desde}' AND ${fecha} < '${hasta}'`;
};

export const buildPendienteQueries = (params: PagosFacturacionParams, now: Date = new Date()): PendienteQueries => {
  const fechaBase = params.fecha_base ?? 'venta';
  if (!(FECHA_BASE as readonly string[]).includes(fechaBase)) throw new Error(`fecha_base inválida. Opciones: ${FECHA_BASE.join(', ')}`);
  if (fechaBase === 'factura') {
    throw new Error("fecha_base=factura no aplica a lo pendiente (todavía no tiene factura). Use 'venta' o 'abono'.");
  }
  const agrupar = (params.agrupar_por ?? 'ninguno') as AgruparPendiente;
  if (!(AGRUPAR_POR_PENDIENTE as readonly string[]).includes(agrupar)) {
    throw new Error(`agrupar_por inválido para lo pendiente. Opciones: ${AGRUPAR_POR_PENDIENTE.join(', ')}`);
  }
  const { desde, hastaExclusivo } = resolveDateRange(params, now);
  const hoy = todayInTimezone(now);
  parseIso(hoy);
  const direccionParam = params.direccion === 'asc' ? 'ASC' : params.direccion === 'desc' ? 'DESC' : null;

  const abonosEnriquecido = enriquecidoSql(desde, hastaExclusivo, fechaBase, { estados: '1, 2', hoy });
  const sinAbono = sinAbonoBaseSql(desde, hastaExclusivo, fechaBase, hoy);
  const abonosPorFacturar = abonosSql(desde, hastaExclusivo, fechaBase, '1, 2');

  const abonosTotalesSql = `SELECT COUNT(*) AS abonos, ROUND(COALESCE(SUM(X.abo_valor), 0), 2) AS valor,
  CAST(COALESCE(SUM(X.abo_estado = 1), 0) AS SIGNED) AS ingresadas,
  ROUND(COALESCE(SUM(CASE WHEN X.abo_estado = 1 THEN X.abo_valor END), 0), 2) AS valor_ingresadas,
  CAST(COALESCE(SUM(X.abo_estado = 2), 0) AS SIGNED) AS autorizadas,
  ROUND(COALESCE(SUM(CASE WHEN X.abo_estado = 2 THEN X.abo_valor END), 0), 2) AS valor_autorizadas,
  CAST(COALESCE(SUM(X.es_venta), 0) AS SIGNED) AS abonos_ventas,
  ROUND(COALESCE(SUM(CASE WHEN X.es_venta = 1 THEN X.abo_valor END), 0), 2) AS valor_ventas,
  CAST(COALESCE(MAX(DATEDIFF('${hoy}', X.abo_fecha)), 0) AS SIGNED) AS dias_maximo
FROM (${abonosPorFacturar}) X`;

  const noConsideradosSql = `SELECT X.abo_estado AS estado, COUNT(*) AS abonos, ROUND(COALESCE(SUM(X.abo_valor), 0), 2) AS valor
FROM (${abonosSql(desde, hastaExclusivo, fechaBase, '3, 4, 7')}) X
GROUP BY X.abo_estado`;

  const fechaB = fechaBase === 'abono' ? 'P.fecha_pago' : 'R.fecha_venta';
  const esSinAbono = '(P.idAbonoCRM IS NULL OR P.idAbonoCRM = 0)';
  const sinAbonoTotalesSql = `SELECT CAST(COALESCE(SUM(${esSinAbono}), 0) AS SIGNED) AS pagos,
  COUNT(DISTINCT CASE WHEN ${esSinAbono} THEN R.id_registro END) AS ventas,
  ROUND(COALESCE(SUM(CASE WHEN ${esSinAbono} THEN P.valor_voucher END), 0), 2) AS valor_voucher,
  CAST(COALESCE(MAX(CASE WHEN ${esSinAbono} THEN DATEDIFF('${hoy}', COALESCE(P.fecha_pago, R.fecha_venta)) END), 0) AS SIGNED) AS dias_maximo,
  CAST(COALESCE(SUM(P.idAbonoCRM = 1), 0) AS SIGNED) AS pagos_enlace_invalido,
  ROUND(COALESCE(SUM(CASE WHEN P.idAbonoCRM = 1 THEN P.valor_voucher END), 0), 2) AS valor_enlace_invalido
FROM registros R
JOIN registros_pagos P ON P.id_registro = R.id_registro
WHERE R.estado NOT IN (9, 13) AND ${fechaB} >= '${desde}' AND ${fechaB} < '${hastaExclusivo}'`;

  let abonosDetalleSql: string;
  let sinAbonoDetalleSql: string;
  if (agrupar === 'ninguno') {
    const orden = params.ordenar_por;
    const enA = !orden || (ABONOS_PEND_DETAIL_ORDER as readonly string[]).includes(orden);
    const enB = !orden || (SIN_ABONO_DETAIL_ORDER as readonly string[]).includes(orden);
    if (!enA && !enB) {
      throw new Error(`ordenar_por inválido para el detalle. Opciones: ${[...new Set([...ABONOS_PEND_DETAIL_ORDER, ...SIN_ABONO_DETAIL_ORDER])].join(', ')}`);
    }
    const ordA = orden && enA ? orden : 'dias_pendiente';
    const ordB = orden && enB ? orden : 'dias_pendiente';
    const dir = (o: string) => direccionParam ?? (o === 'dias_pendiente' || o === 'valor' ? 'DESC' : 'ASC');
    abonosDetalleSql = `SELECT X.abo_codigo AS id_abono, DATE_FORMAT(X.abo_fecha, '%Y-%m-%d') AS fecha_abono,
  DATE_FORMAT(X.fecha_venta, '%Y-%m-%d') AS fecha_venta, X.estado AS estado, X.dias_pendiente AS dias_pendiente, X.origen AS origen,
  X.abo_valor AS valor, X.forma_pago AS forma_pago, X.tipo_pago AS tipo_pago, X.destino AS destino, X.usuario AS usuario, T.conceptos AS conceptos
FROM (${abonosEnriquecido}) X
LEFT JOIN ${lineasPorCotizacionSql} T ON T.cod_num_coti = X.cot_numero
ORDER BY \`${ordA}\` ${dir(ordA)}, id_abono ASC`;
    sinAbonoDetalleSql = `SELECT X.id_pago AS id_pago, X.id_registro AS id_registro, DATE_FORMAT(X.fecha_venta, '%Y-%m-%d') AS fecha_venta,
  DATE_FORMAT(X.fecha_pago, '%Y-%m-%d') AS fecha_pago, X.dias_pendiente AS dias_pendiente, ROUND(X.valor_voucher, 2) AS valor, X.asesor AS usuario
FROM (${sinAbono}) X
ORDER BY \`${ordB}\` ${dir(ordB)}, id_pago ASC`;
  } else {
    const orden = params.ordenar_por ?? (agrupar === 'dia' || agrupar === 'antiguedad' || agrupar === 'estado' ? 'grupo' : 'valor');
    if (!(GROUP_ORDER_COLUMNS as readonly string[]).includes(orden)) {
      throw new Error(`ordenar_por inválido al agrupar. Opciones: ${GROUP_ORDER_COLUMNS.join(', ')}`);
    }
    const direccion = direccionParam ?? (orden === 'grupo' ? 'ASC' : 'DESC');
    if (agrupar === 'concepto') {
      abonosDetalleSql = agrupadoPorConceptoSql(abonosPorFacturar, orden, direccion);
    } else {
      const expr = agrupar === 'antiguedad' ? bucketAntiguedad('X.dias_pendiente') : `X.${agrupar}`;
      abonosDetalleSql = `SELECT ${expr} AS grupo, COUNT(*) AS abonos, ROUND(SUM(X.abo_valor), 2) AS valor
FROM (${abonosEnriquecido}) X
GROUP BY grupo
ORDER BY \`${orden}\` ${direccion}, grupo ASC`;
    }
    // Los pagos sin abono no tienen concepto, forma de pago ni estado: esos desgloses los agrupan en 'SIN ABONO'.
    const exprB =
      agrupar === 'usuario' ? 'X.asesor'
      : agrupar === 'dia' ? `DATE_FORMAT(${fechaBase === 'abono' ? 'X.fecha_pago' : 'X.fecha_venta'}, '%Y-%m-%d')`
      : agrupar === 'antiguedad' ? bucketAntiguedad('X.dias_pendiente')
      : agrupar === 'origen' ? "'VENTAS'"
      : "'SIN ABONO'";
    const ordenB = orden === 'abonos' ? 'pagos' : orden;
    sinAbonoDetalleSql = `SELECT ${exprB} AS grupo, COUNT(*) AS pagos, ROUND(SUM(X.valor_voucher), 2) AS valor
FROM (${sinAbono}) X
GROUP BY grupo
ORDER BY \`${ordenB}\` ${direccion}, grupo ASC`;
  }

  return { desde, hastaExclusivo, fechaBase, agrupar, hoy, abonosDetalleSql, abonosTotalesSql, noConsideradosSql, sinAbonoDetalleSql, sinAbonoTotalesSql };
};

export const armarTotalesAbonosPendientes = (r: any) => {
  const abonos = num(r.abonos);
  const valor = round2(num(r.valor));
  const abonosVentas = num(r.abonos_ventas);
  const valorVentas = round2(num(r.valor_ventas));
  return {
    abonos,
    valor,
    ingresadas: { abonos: num(r.ingresadas), valor: round2(num(r.valor_ingresadas)) },
    autorizadas: { abonos: num(r.autorizadas), valor: round2(num(r.valor_autorizadas)) },
    ventas: { abonos: abonosVentas, valor: valorVentas },
    otros_modulos: { abonos: abonos - abonosVentas, valor: round2(valor - valorVentas) },
    dias_del_mas_antiguo: num(r.dias_maximo)
  };
};

export const armarTotalesSinAbono = (r: any) => ({
  pagos: num(r.pagos),
  ventas: num(r.ventas),
  valor_voucher: round2(num(r.valor_voucher)),
  dias_del_mas_antiguo: num(r.dias_maximo)
});

const NOMBRE_ESTADO_NO_CONSIDERADO: Record<number, string> = { 3: 'no_autorizada', 4: 'eliminada', 7: 'venta_ticket_sin_fee' };

export const armarNoConsiderados = (rows: any[]) => {
  const out: Record<string, { abonos: number; valor: number }> = {
    no_autorizada: { abonos: 0, valor: 0 },
    eliminada: { abonos: 0, valor: 0 },
    venta_ticket_sin_fee: { abonos: 0, valor: 0 }
  };
  for (const r of rows) {
    const k = NOMBRE_ESTADO_NO_CONSIDERADO[num(r.estado)];
    if (k) out[k] = { abonos: num(r.abonos), valor: round2(num(r.valor)) };
  }
  return out;
};

const CRITERIO_PENDIENTE: Record<'venta' | 'abono', string> = {
  venta: 'abonos de ventas por fecha de venta (registros.fecha_venta), abonos de otros módulos por la fecha del abono (abo_fecha) y pagos sin abono por la fecha de venta',
  abono: 'abonos por la fecha en que se ingresaron (abo_fecha) y pagos sin abono por su fecha de pago (registros_pagos.fecha_pago)'
};

export const armarAvisosPendiente = (abonos: ReturnType<typeof armarTotalesAbonosPendientes>, sinAbono: ReturnType<typeof armarTotalesSinAbono>, invalido: { pagos: number; valor: number }, noConsiderados: ReturnType<typeof armarNoConsiderados>): string[] => {
  const avisos: string[] = [];
  if (abonos.abonos === 0 && sinAbono.pagos === 0) avisos.push('No hay nada pendiente de facturar en el período.');
  avisos.push('Los dos grupos no se suman: los abonos se miden por abo_valor y los pagos sin abono por el valor del voucher. Nada de esto está en los totales de lo facturado.');
  if (sinAbono.pagos > 0) {
    avisos.push('Varios pagos pueden terminar en un solo abono (se divide la comisión pero la factura es una): la cantidad de pagos sin abono no es la cantidad de facturas que faltan.');
  }
  if (invalido.pagos > 0) avisos.push(`${invalido.pagos} pago(s) de ventas del período por ${dinero(invalido.valor)} apuntan al abono 1 (enlace inválido de 2017); no se incluyeron.`);
  const noCons = noConsiderados.no_autorizada.abonos + noConsiderados.eliminada.abonos + noConsiderados.venta_ticket_sin_fee.abonos;
  if (noCons > 0) {
    avisos.push(
      `No se consideran pendientes los abonos en estado no autorizada (${noConsiderados.no_autorizada.abonos}), eliminada (${noConsiderados.eliminada.abonos}) ni venta de ticket sin fee (${noConsiderados.venta_ticket_sin_fee.abonos}); solo se cuentan aparte.`
    );
  }
  return avisos;
};

const filasPendientes = (rows: any[], clave: 'abonos' | 'pagos', valorTotal: number) =>
  rows.map((r) => {
    const valor = round2(num(r.valor));
    return { grupo: String(r.grupo ?? ''), [clave]: num(r[clave]), valor, porcentaje_del_valor: pct(valor, valorTotal) };
  });

const handlePendiente = async (params: PagosFacturacionParams, deps: PagosFacturacionDeps, now: Date): Promise<ToolResult> => {
  const q = buildPendienteQueries(params, now);
  const [aDet, aTot, noCons, bDet, bTot] = await Promise.all([
    deps.consultar(q.abonosDetalleSql, MAX_FILAS),
    deps.consultar(q.abonosTotalesSql, 1),
    deps.consultar(q.noConsideradosSql, 10),
    deps.consultar(q.sinAbonoDetalleSql, MAX_FILAS),
    deps.consultar(q.sinAbonoTotalesSql, 1)
  ]);
  const totA = armarTotalesAbonosPendientes(aTot.rows[0] ?? {});
  const totB = armarTotalesSinAbono(bTot.rows[0] ?? {});
  const bRow = bTot.rows[0] ?? {};
  const noConsiderados = armarNoConsiderados(noCons.rows);
  const agrupado = q.agrupar !== 'ninguno';

  const payload = {
    vista: 'pendiente',
    periodo: { desde: q.desde, hasta_exclusivo: q.hastaExclusivo, zona_horaria: REPORT_TIMEZONE, hoy: q.hoy },
    fecha_base: q.fechaBase,
    criterio_fecha: CRITERIO_PENDIENTE[q.fechaBase as 'venta' | 'abono'],
    reglas:
      'Pendiente de facturar = abonos en estado INGRESADA o AUTORIZADA (1 y 2) y pagos de ventas que todavía no tienen abono. Se excluyen las ventas anuladas (9 y 13). Los dos grupos van separados y no se suman entre sí ni con lo facturado.',
    agrupado_por: q.agrupar,
    abonos_por_facturar: {
      descripcion: 'Abonos ya registrados en el CRM que todavía no se facturan (valor = abo_valor).',
      totales: totA,
      filas_devueltas: aDet.rows.length,
      filas_recortadas: aDet.truncated,
      filas: agrupado ? filasPendientes(aDet.rows, 'abonos', totA.valor) : aDet.rows.map((r) => ({ ...r, valor: round2(num(r.valor)) }))
    },
    ventas_sin_abono: {
      descripcion: 'Pagos de ventas que todavía no tienen abono en el CRM (valor = valor del voucher).',
      totales: totB,
      filas_devueltas: bDet.rows.length,
      filas_recortadas: bDet.truncated,
      filas: agrupado ? filasPendientes(bDet.rows, 'pagos', totB.valor_voucher) : bDet.rows.map((r) => ({ ...r, valor: round2(num(r.valor)) }))
    },
    abonos_no_considerados: noConsiderados,
    avisos: armarAvisosPendiente(totA, totB, { pagos: num(bRow.pagos_enlace_invalido), valor: round2(num(bRow.valor_enlace_invalido)) }, noConsiderados)
  };
  return texto(`🧾 [MVEVIP MCP] Pendiente de facturar ${q.desde} a ${q.hastaExclusivo} (exclusivo), por ${q.fechaBase}:`, payload);
};
