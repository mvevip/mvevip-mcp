import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { REPORT_TIMEZONE, addDays, parseIso, resolveDateRange, todayInTimezone } from './dates';

/**
 * pagos_tarjetas_interdin (solo lectura): reproduce los paneles «Pagos recibidos por marca de tarjeta» y «Flujo de Caja» del CRM
 * (PHP /listado-pagos-resumenes) con la liquidación de tarjetas de Interdin (mve.mve_tarjetas_procesamientos), y da por fecha los
 * pagos que van a venir.
 *
 * Reglas (reproducidas al centavo con el volcado del 24-nov-2026 y confirmadas con el usuario el 25-nov):
 * - Ventas = filas VALE y CREDITO (el CREDITO es un pago que se valida después, por eso suma); débitos = filas DEBITO (pagos que nos
 *   quitan o aplican y RESTAN a los pagos por venir); VALE RECHAZADO no cuenta. Neto = valor_pago (bruto − comisión − retenciones).
 * - El rango del panel es por fecha_facturacion; el Flujo de Caja muestra esas mismas filas por fecha_del_pago. Neto = ventas − débitos.
 * - Tipo de crédito = catálogo mve_tarjetas_comisiones por codigo_anterior (sin catálogo = SIN CATALOGO); marca = mve_tarjetas_nombres.
 * - Lo preliquidado (PR) es provisional: solo se informa como observación, no se separa en las cifras.
 * - Las 141 filas del 7-jul al 5-ago-2026 con las columnas corridas no se cuentan (se avisa); no afectan a los pagos por venir.
 */
export const VISTAS_TARJETAS = ['resumen', 'flujo', 'por_cobrar'] as const;
export type VistaTarjetas = (typeof VISTAS_TARJETAS)[number];
export const FECHA_BASE_TARJETAS = ['facturacion', 'pago'] as const;
export type FechaBaseTarjetas = (typeof FECHA_BASE_TARJETAS)[number];
export const TIPO_VALOR = ['neto', 'bruto'] as const;
export type TipoValor = (typeof TIPO_VALOR)[number];
export const DIMENSIONES_TARJETAS = ['dia', 'semana', 'mes', 'marca', 'tipo_credito'] as const;
export type DimensionTarjetas = (typeof DIMENSIONES_TARJETAS)[number];
export const ORDEN_TARJETAS = ['grupo', 'ventas', 'debitos', 'neto'] as const;

/** Nombres y siglas aceptados para filtrar por marca (lista cerrada: a la consulta solo llega la sigla). */
export const MARCAS_TARJETA: Record<string, string> = {
  DN: 'DN', DINERS: 'DN', 'DINERS CLUB': 'DN',
  DI: 'DI', DISCOVER: 'DI',
  VI: 'VI', VISA: 'VI',
  MC: 'MC', MASTERCARD: 'MC', 'MASTER CARD': 'MC'
};

export interface PagosTarjetasParams {
  vista?: VistaTarjetas;
  mes?: number;
  anio?: number;
  fecha_desde?: string;
  fecha_hasta?: string;
  fecha_base?: FechaBaseTarjetas;
  tipo_valor?: TipoValor;
  marca?: string;
  agrupar_por?: DimensionTarjetas;
  desglosar_por?: DimensionTarjetas;
  ordenar_por?: string;
  direccion?: 'asc' | 'desc';
}

export interface PagosTarjetasDeps {
  consultar(sql: string, maxRows: number): Promise<{ rows: any[]; truncated: boolean }>;
}

export const defaultPagosTarjetasDeps: PagosTarjetasDeps = {
  consultar: async (sql, maxRows) => {
    const r = await dbService.executeReadOnlyQuery(sql, maxRows);
    return { rows: r.rows, truncated: r.truncated };
  }
};

const MAX_FILAS = 500;
const MAX_OUTPUT_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Consultas (fechas validadas por resolveDateRange; marca y columnas salen de listas cerradas)
// ---------------------------------------------------------------------------
const CONCEPTOS = "('VALE', 'CREDITO', 'DEBITO')";
const ES_VENTA = "P.concepto_registro IN ('VALE', 'CREDITO')";
const ES_DEBITO = "P.concepto_registro = 'DEBITO'";

const FROM_TARJETAS = `FROM mve.mve_tarjetas_procesamientos P
LEFT JOIN mve.mve_tarjetas_nombres N ON N.codigo = P.marca
LEFT JOIN (
  SELECT codigo_antiguo, MIN(tipo_credito) AS tipo_credito, MIN(comision) AS comision
  FROM mve.mve_tarjetas_comisiones GROUP BY codigo_antiguo
) CM ON CM.codigo_antiguo = P.codigo_anterior`;

export const resolverMarca = (marca: string | undefined): string | null => {
  if (marca === undefined || marca.trim() === '') return null;
  const sigla = MARCAS_TARJETA[marca.trim().toUpperCase().replace(/\s+/g, ' ')];
  if (!sigla) throw new Error(`marca inválida. Opciones: ${[...new Set(Object.values(MARCAS_TARJETA))].join(', ')} (o Diners, Discover, Visa, Mastercard).`);
  return sigla;
};

const DIMENSION_SQL: Record<DimensionTarjetas, string> = {
  dia: "COALESCE(DATE_FORMAT(P.fecha_del_pago, '%Y-%m-%d'), 'SIN FECHA')",
  semana: "COALESCE(DATE_FORMAT(DATE_SUB(P.fecha_del_pago, INTERVAL WEEKDAY(P.fecha_del_pago) DAY), '%Y-%m-%d'), 'SIN FECHA')",
  mes: "COALESCE(DATE_FORMAT(P.fecha_del_pago, '%Y-%m'), 'SIN FECHA')",
  marca: "COALESCE(N.nombre_tarjeta, 'SIN MARCA')",
  tipo_credito: "COALESCE(CM.tipo_credito, 'SIN CATALOGO')"
};

export interface ContextoTarjetas {
  vista: VistaTarjetas;
  desde: string;
  /** Exclusivo. Null solo en por_cobrar sin fecha límite. */
  hastaExclusivo: string | null;
  hoy: string;
  fechaBase: FechaBaseTarjetas;
  tipoValor: TipoValor;
  marca: string | null;
}

export const resolverContexto = (params: PagosTarjetasParams, now: Date = new Date()): ContextoTarjetas => {
  const vista = params.vista ?? 'resumen';
  if (!(VISTAS_TARJETAS as readonly string[]).includes(vista)) throw new Error(`vista inválida. Opciones: ${VISTAS_TARJETAS.join(', ')}`);
  const fechaBase = params.fecha_base ?? 'facturacion';
  if (!(FECHA_BASE_TARJETAS as readonly string[]).includes(fechaBase)) throw new Error(`fecha_base inválida. Opciones: ${FECHA_BASE_TARJETAS.join(', ')}`);
  const tipoValor = params.tipo_valor ?? 'neto';
  if (!(TIPO_VALOR as readonly string[]).includes(tipoValor)) throw new Error(`tipo_valor inválido. Opciones: ${TIPO_VALOR.join(', ')}`);
  const marca = resolverMarca(params.marca);
  const hoy = todayInTimezone(now);

  const conPeriodo = params.mes !== undefined || params.anio !== undefined || !!params.fecha_desde || !!params.fecha_hasta;
  if (vista === 'por_cobrar') {
    // Lo que falta por cobrar: pagos desde hoy (inclusive), sea cual sea la fecha de facturación. Un período solo lo acota.
    if (!conPeriodo) return { vista, desde: hoy, hastaExclusivo: null, hoy, fechaBase: 'pago', tipoValor, marca };
    // Solo fecha_hasta: es un tope (desde hoy hasta esa fecha), no un único día.
    if (params.fecha_hasta && !params.fecha_desde && params.mes === undefined && params.anio === undefined) {
      parseIso(params.fecha_hasta);
      if (params.fecha_hasta < hoy) throw new Error('fecha_hasta no puede ser anterior a hoy: por_cobrar muestra los pagos de hoy en adelante.');
      return { vista, desde: hoy, hastaExclusivo: addDays(params.fecha_hasta, 1), hoy, fechaBase: 'pago', tipoValor, marca };
    }
    const r = resolveDateRange(params, now);
    return { vista, desde: r.desde > hoy ? r.desde : hoy, hastaExclusivo: r.hastaExclusivo, hoy, fechaBase: 'pago', tipoValor, marca };
  }
  const r = resolveDateRange(params, now);
  return { vista, desde: r.desde, hastaExclusivo: r.hastaExclusivo, hoy, fechaBase, tipoValor, marca };
};

const columnaFecha = (c: ContextoTarjetas) => (c.fechaBase === 'pago' ? 'P.fecha_del_pago' : 'P.fecha_facturacion');
const columnaValor = (c: ContextoTarjetas) => (c.tipoValor === 'bruto' ? 'P.valor_bruto' : 'P.valor_pago');

const whereTarjetas = (c: ContextoTarjetas, conceptos: boolean): string => {
  const f = columnaFecha(c);
  const partes = [`${f} >= '${c.desde}'`];
  if (c.hastaExclusivo) partes.push(`${f} < '${c.hastaExclusivo}'`);
  if (conceptos) partes.push(`P.concepto_registro IN ${CONCEPTOS}`);
  if (c.marca) partes.push(`P.marca = '${c.marca}'`);
  return `WHERE ${partes.join(' AND ')}`;
};

const firmado = (c: ContextoTarjetas) => {
  const v = columnaValor(c);
  return `CASE WHEN ${ES_VENTA} THEN ${v} WHEN ${ES_DEBITO} THEN -${v} ELSE 0 END`;
};

export interface ConsultasTarjetas {
  contexto: ContextoTarjetas;
  marcasSql?: string;
  porMesSql?: string;
  comisionesSql?: string;
  gruposSql?: string;
  detalleSql?: string;
  totalesSql?: string;
  observacionesSql: string;
}

const ordenSql = (params: PagosTarjetasParams, agrupar: DimensionTarjetas, conDesglose: boolean): string => {
  const temporal = agrupar === 'dia' || agrupar === 'semana' || agrupar === 'mes';
  const orden = params.ordenar_por ?? (temporal ? 'grupo' : 'neto');
  if (!(ORDEN_TARJETAS as readonly string[]).includes(orden)) throw new Error(`ordenar_por inválido. Opciones: ${ORDEN_TARJETAS.join(', ')}`);
  const direccion = params.direccion === 'asc' ? 'ASC' : params.direccion === 'desc' ? 'DESC' : orden === 'grupo' ? 'ASC' : 'DESC';
  return `ORDER BY \`${orden}\` ${direccion}, grupo ASC${conDesglose ? ', subgrupo ASC' : ''}`;
};

export const buildConsultasTarjetas = (params: PagosTarjetasParams, now: Date = new Date()): ConsultasTarjetas => {
  const c = resolverContexto(params, now);
  const v = columnaValor(c);
  const firma = firmado(c);

  // Observaciones: preliquidado (provisional), filas sin catálogo de comisión y filas con las columnas corridas.
  const observacionesSql = `SELECT
  ROUND(COALESCE(SUM(CASE WHEN P.indicador_liquidado_preliquidado = 'PR' THEN ${firma} END), 0), 2) AS neto_preliquidado,
  ROUND(COALESCE(SUM(CASE WHEN P.indicador_liquidado_preliquidado = 'LQ' THEN ${firma} END), 0), 2) AS neto_liquidado,
  CAST(COALESCE(SUM(P.concepto_registro IN ${CONCEPTOS} AND CM.codigo_antiguo IS NULL), 0) AS SIGNED) AS sin_catalogo_filas,
  ROUND(COALESCE(SUM(CASE WHEN CM.codigo_antiguo IS NULL THEN ${firma} END), 0), 2) AS sin_catalogo_valor,
  CAST(COALESCE(SUM(P.concepto_registro NOT IN ('VALE', 'CREDITO', 'DEBITO', 'VALE RECHAZADO')), 0) AS SIGNED) AS filas_formato_invalido
${FROM_TARJETAS}
${whereTarjetas(c, false)}`;

  if (c.vista === 'resumen') {
    const w = whereTarjetas(c, true);
    const marcasSql = `SELECT COALESCE(N.nombre_tarjeta, 'SIN MARCA') AS marca,
  ROUND(COALESCE(SUM(CASE WHEN ${ES_VENTA} THEN ${v} ELSE 0 END), 0), 2) AS ventas,
  ROUND(COALESCE(SUM(CASE WHEN ${ES_DEBITO} THEN ${v} ELSE 0 END), 0), 2) AS debitos
${FROM_TARJETAS}
${w}
GROUP BY marca
ORDER BY ventas DESC, marca ASC`;
    const mesCol = c.fechaBase === 'pago' ? 'P.fecha_del_pago' : 'P.fecha_facturacion';
    const porMesSql = `SELECT COALESCE(DATE_FORMAT(${mesCol}, '%Y-%m'), 'SIN FECHA') AS mes, ROUND(COALESCE(SUM(${v}), 0), 2) AS total
${FROM_TARJETAS}
${whereTarjetas(c, false)} AND ${ES_VENTA}
GROUP BY mes
ORDER BY mes ASC`;
    const comisionesSql = `SELECT COALESCE(CM.tipo_credito, 'SIN CATALOGO') AS tipo_credito, CM.comision AS comision_pct,
  ROUND(COALESCE(SUM(P.valor_comision), 0), 2) AS total
${FROM_TARJETAS}
${w}
GROUP BY tipo_credito, CM.comision
ORDER BY total DESC, tipo_credito ASC`;
    // Los grupos del CRM: efectivo y otras tarjetas salen de los abonos facturados (por fecha del abono); el grupo 2 de
    // tid_agrupacion (las tarjetas que ya vienen en el archivo de Interdin) se deja fuera para no contarlas dos veces.
    const gruposSql = `SELECT IF(D.tid_agrupacion = 0, 'OTRAS TARJETAS', 'EFECTIVO TRANSFERENCIAS') AS grupo, ROUND(COALESCE(SUM(A.abo_valor), 0), 2) AS ventas
FROM mve.mve_abonos A
LEFT JOIN mve.gen_tipo_detalle D ON A.abo_banco = D.tid_codigo
WHERE A.abo_fecha >= '${c.desde}' AND A.abo_fecha < '${c.hastaExclusivo}'
  AND A.abo_estado IN (5, 6) AND D.tid_agrupacion <> 2
GROUP BY grupo
ORDER BY ventas DESC`;
    return { contexto: c, marcasSql, porMesSql, comisionesSql, gruposSql, observacionesSql };
  }

  // flujo y por_cobrar: filas por fecha de pago, con un desglose opcional
  const agrupar = (params.agrupar_por ?? 'dia') as DimensionTarjetas;
  if (!(DIMENSIONES_TARJETAS as readonly string[]).includes(agrupar)) throw new Error(`agrupar_por inválido. Opciones: ${DIMENSIONES_TARJETAS.join(', ')}`);
  const desglosar = params.desglosar_por as DimensionTarjetas | undefined;
  if (desglosar !== undefined && !(DIMENSIONES_TARJETAS as readonly string[]).includes(desglosar)) throw new Error(`desglosar_por inválido. Opciones: ${DIMENSIONES_TARJETAS.join(', ')}`);
  if (desglosar === agrupar) throw new Error('desglosar_por debe ser distinto de agrupar_por.');
  const w = whereTarjetas(c, true);
  const detalleSql = `SELECT ${DIMENSION_SQL[agrupar]} AS grupo${desglosar ? `, ${DIMENSION_SQL[desglosar]} AS subgrupo` : ''},
  ROUND(COALESCE(SUM(CASE WHEN ${ES_VENTA} THEN ${v} ELSE 0 END), 0), 2) AS ventas,
  ROUND(COALESCE(SUM(CASE WHEN ${ES_DEBITO} THEN ${v} ELSE 0 END), 0), 2) AS debitos,
  ROUND(COALESCE(SUM(${firma}), 0), 2) AS neto
${FROM_TARJETAS}
${w}
GROUP BY grupo${desglosar ? ', subgrupo' : ''}
${ordenSql(params, agrupar, !!desglosar)}`;
  const totalesSql = `SELECT
  ROUND(COALESCE(SUM(CASE WHEN ${ES_VENTA} THEN ${v} ELSE 0 END), 0), 2) AS ventas,
  ROUND(COALESCE(SUM(CASE WHEN ${ES_DEBITO} THEN ${v} ELSE 0 END), 0), 2) AS debitos,
  ROUND(COALESCE(SUM(${firma}), 0), 2) AS neto,
  ROUND(COALESCE(SUM(CASE WHEN P.fecha_del_pago < '${c.hoy}' THEN ${firma} END), 0), 2) AS neto_antes_de_hoy,
  ROUND(COALESCE(SUM(CASE WHEN P.fecha_del_pago >= '${c.hoy}' THEN ${firma} END), 0), 2) AS neto_desde_hoy,
  DATE_FORMAT(MAX(P.fecha_del_pago), '%Y-%m-%d') AS ultima_fecha_de_pago
${FROM_TARJETAS}
${w}`;
  return { contexto: c, detalleSql, totalesSql, observacionesSql };
};

// ---------------------------------------------------------------------------
// Armado de la respuesta (funciones puras, probadas con cifras reales)
// ---------------------------------------------------------------------------
const num = (v: unknown): number => Number(v ?? 0) || 0;
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const pct = (parte: number, todo: number): number | null => (todo > 0 ? Math.round((parte / todo) * 1000) / 10 : null);
const dinero = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const armarMarcas = (rows: any[]) => {
  const filas = rows.map((r) => {
    const ventas = round2(num(r.ventas));
    const debitos = round2(num(r.debitos));
    return { marca: String(r.marca ?? ''), ventas, debitos, porcentaje_debitos: pct(debitos, ventas) };
  });
  return { filas, totales: { ventas: round2(filas.reduce((a, f) => a + f.ventas, 0)), debitos: round2(filas.reduce((a, f) => a + f.debitos, 0)) } };
};

export const armarComisiones = (rows: any[]) => {
  const filas = rows.map((r) => ({ tipo_credito: String(r.tipo_credito ?? ''), comision_pct: r.comision_pct === null || r.comision_pct === undefined ? null : num(r.comision_pct), total: round2(num(r.total)) }));
  return { filas, total: round2(filas.reduce((a, f) => a + f.total, 0)) };
};

export const armarGrupos = (rows: any[], interdin: number) => {
  const filas = [
    { grupo: 'INTERDIN', ventas: round2(interdin) },
    ...rows.map((r) => ({ grupo: String(r.grupo ?? ''), ventas: round2(num(r.ventas)) }))
  ].sort((a, b) => b.ventas - a.ventas);
  return { filas, total: round2(filas.reduce((a, f) => a + f.ventas, 0)) };
};

export const armarObservaciones = (o: any, vista: VistaTarjetas, tipoValor: TipoValor): string[] => {
  const obs: string[] = [];
  const pr = num(o?.neto_preliquidado);
  const lq = num(o?.neto_liquidado);
  if (pr + lq > 0 && pr > 0) {
    obs.push(
      `Preliquidado: ${dinero(pr)} (${pct(pr, pr + lq)} % del neto) es provisional y puede cambiar al liquidarse; liquidado: ${dinero(lq)}.`
    );
  }
  const sinCat = num(o?.sin_catalogo_filas);
  if (sinCat > 0) obs.push(`${sinCat} fila(s) por ${dinero(num(o?.sin_catalogo_valor))} no tienen su código en el catálogo de comisiones y salen como SIN CATALOGO.`);
  const invalidas = num(o?.filas_formato_invalido);
  if (invalidas > 0 && vista !== 'por_cobrar') {
    obs.push(`${invalidas} fila(s) del archivo de Interdin se cargaron con las columnas corridas (otro formato) y NO se cuentan en estas cifras; siguen sin corregir en la base. No afectan a los pagos por venir desde hoy.`);
  }
  obs.push('CREDITO es un pago que se valida después y se suma; DEBITO son pagos que nos quitan o aplican y restan a los pagos por venir. Los vales rechazados no cuentan.');
  if (tipoValor === 'neto') obs.push('Valores netos (valor_pago): lo que paga Interdin después de comisión y retenciones. Use tipo_valor=bruto para el valor del vale.');
  return obs;
};

const CRITERIO_FECHA: Record<FechaBaseTarjetas, string> = {
  facturacion: 'fecha de facturación del vale (fecha_facturacion), como el panel del CRM',
  pago: 'fecha en que Interdin paga el vale (fecha_del_pago)'
};

const texto = (titulo: string, payload: unknown): ToolResult => {
  let json = JSON.stringify(payload, null, 2);
  if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}\n... (salida recortada; agrupe por mes o semana, o reduzca el período)`;
  return { content: [{ type: 'text', text: `${titulo}\n\n\`\`\`json\n${json}\n\`\`\`` }] };
};

export const handlePagosTarjetas = async (
  params: PagosTarjetasParams,
  deps: PagosTarjetasDeps = defaultPagosTarjetasDeps,
  now: Date = new Date()
): Promise<ToolResult> => {
  try {
    const q = buildConsultasTarjetas(params, now);
    const c = q.contexto;
    const periodo = { desde: c.desde, hasta_exclusivo: c.hastaExclusivo, zona_horaria: REPORT_TIMEZONE, hoy: c.hoy };
    const base = { vista: c.vista, periodo, fecha_base: c.fechaBase, criterio_fecha: CRITERIO_FECHA[c.fechaBase], tipo_valor: c.tipoValor, marca: c.marca ?? 'todas' };

    if (c.vista === 'resumen') {
      const [marcas, porMes, comisiones, grupos, obs] = await Promise.all([
        deps.consultar(q.marcasSql!, MAX_FILAS),
        deps.consultar(q.porMesSql!, 60),
        deps.consultar(q.comisionesSql!, MAX_FILAS),
        deps.consultar(q.gruposSql!, 10),
        deps.consultar(q.observacionesSql, 1)
      ]);
      const m = armarMarcas(marcas.rows);
      const observaciones = armarObservaciones(obs.rows[0], c.vista, c.tipoValor);
      observaciones.push('Grupos: INTERDIN es el total de ventas de tarjetas de esta consulta; EFECTIVO TRANSFERENCIAS y OTRAS TARJETAS salen de los abonos facturados (abo_valor, estados 5 y 6, por fecha del abono) y no dependen del filtro de marca ni del tipo de valor.');
      return texto(`💳 [MVEVIP MCP] Pagos recibidos de Interdin por marca ${c.desde} a ${c.hastaExclusivo} (exclusivo):`, {
        ...base,
        marcas: m,
        grupos: armarGrupos(grupos.rows, m.totales.ventas),
        comisiones: armarComisiones(comisiones.rows),
        ventas_por_mes: porMes.rows.map((r) => ({ mes: String(r.mes), total: round2(num(r.total)) })),
        observaciones
      });
    }

    const [detalle, totales, obs] = await Promise.all([
      deps.consultar(q.detalleSql!, MAX_FILAS),
      deps.consultar(q.totalesSql!, 1),
      deps.consultar(q.observacionesSql, 1)
    ]);
    const t = totales.rows[0] ?? {};
    const filas = detalle.rows.map((r) => ({
      grupo: String(r.grupo ?? ''),
      ...(params.desglosar_por ? { [params.desglosar_por]: String(r.subgrupo ?? '') } : {}),
      ventas: round2(num(r.ventas)),
      debitos: round2(num(r.debitos)),
      neto: round2(num(r.neto))
    }));
    const observaciones = armarObservaciones(obs.rows[0], c.vista, c.tipoValor);
    if (c.vista === 'por_cobrar') {
      observaciones.push('Solo incluye lo que ya está en el archivo de Interdin (liquidado o preliquidado): cada vale trae una sola fecha de pago, así que es un horizonte corto de unas semanas y no una proyección de cuotas de varios meses.');
    }
    if (detalle.truncated) observaciones.push(`Se alcanzó el máximo de ${MAX_FILAS} filas: agrupe por semana o mes, o reduzca el período.`);
    const totalesOut = {
      ventas: round2(num(t.ventas)),
      debitos: round2(num(t.debitos)),
      neto: round2(num(t.neto)),
      ...(c.vista === 'flujo' ? { neto_pagado_antes_de_hoy: round2(num(t.neto_antes_de_hoy)), neto_por_cobrar_desde_hoy: round2(num(t.neto_desde_hoy)) } : {}),
      ultima_fecha_de_pago: t.ultima_fecha_de_pago ?? null
    };
    return texto(
      c.vista === 'flujo'
        ? `💳 [MVEVIP MCP] Flujo de caja de Interdin (vales de ${c.desde} a ${c.hastaExclusivo}, por fecha de pago):`
        : `💳 [MVEVIP MCP] Pagos de Interdin por cobrar desde ${c.desde}:`,
      {
        ...base,
        agrupado_por: params.agrupar_por ?? 'dia',
        ...(params.desglosar_por ? { desglosado_por: params.desglosar_por } : {}),
        totales: totalesOut,
        filas_devueltas: filas.length,
        filas_recortadas: detalle.truncated,
        filas,
        observaciones
      }
    );
  } catch (error: any) {
    return { content: [{ type: 'text', text: `❌ Error al generar el reporte de pagos de tarjetas: ${error?.message || String(error)}` }], isError: true };
  }
};
