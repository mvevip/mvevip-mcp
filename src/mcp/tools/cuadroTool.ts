import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { REPORT_TIMEZONE } from './salesReportTool';

const MAX_OUTPUT_CHARS = 100_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => Number(v ?? 0) || 0;

const parseIso = (s: string): Date => {
  if (!ISO_DATE.test(s)) throw new Error('La fecha debe tener formato YYYY-MM-DD.');
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.toISOString().slice(0, 10) !== s) throw new Error('La fecha no es válida.');
  return date;
};
const toIso = (d: Date) => d.toISOString().slice(0, 10);

/** Fecha de hoy en la zona horaria del negocio (el servidor corre en UTC). */
export const todayInTimezone = (now: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};

export const monthRange = (fecha: string): { desde: string; hastaExclusivo: string } => {
  const d = parseIso(fecha);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return { desde: toIso(new Date(Date.UTC(y, m, 1))), hastaExclusivo: toIso(new Date(Date.UTC(y, m + 1, 1))) };
};

/**
 * Días laborables del mes de `fecha`: lunes a viernes menos feriados (cada feriado se resta una sola vez).
 * Restantes = días laborables posteriores a `fecha` (el día consultado cuenta como transcurrido).
 */
export const computeWorkingDays = (fecha: string, feriados: string[]) => {
  const day = parseIso(fecha);
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const holidays = new Set(feriados);
  let laborables = 0;
  let transcurridos = 0;
  for (let d = 1; d <= last; d++) {
    const cur = new Date(Date.UTC(y, m, d));
    const dow = cur.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const iso = toIso(cur);
    if (holidays.has(iso)) continue;
    laborables++;
    if (iso <= fecha) transcurridos++;
  }
  return { laborables, transcurridos, restantes: laborables - transcurridos };
};

// Un solo registro de usuarios por vendedor; id_referencia = 0 agrupa personal que no vende y se ignora.
const ASESORES_CTE = `asesores AS (
  SELECT U.id_referencia, U.nombres, U.id_agrupacion
  FROM usuarios U
  JOIN (SELECT MIN(id_usuario) AS id_usuario FROM usuarios WHERE id_referencia > 0 GROUP BY id_referencia) K
    ON K.id_usuario = U.id_usuario
)`;

export interface CuadroQueries {
  feriadosSql: string;
  lideresSql: string;
  gruposSql: string;
  cierresSql: string;
  asesoresSql: string;
  desde: string;
  hastaExclusivo: string;
}

/**
 * Consultas del cuadro de ventas. Ventas = abono pagado (suma de valor_voucher); estados 9 y 13 (anulados)
 * siempre excluidos. Las fechas están validadas (YYYY-MM-DD) antes de entrar al SQL.
 */
export const buildCuadroQueries = (fecha: string): CuadroQueries => {
  const { desde, hastaExclusivo } = monthRange(fecha);
  const activo = `R.estado NOT IN (9, 13)`;

  const feriadosSql = `SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha FROM cuadro_feriados
WHERE fecha >= '${desde}' AND fecha < '${hastaExclusivo}'`;

  const lideresSql = `SELECT L.id_lider, L.lider, L.meta AS meta_mensual,
  COALESCE(D.ventas, 0) AS ventas_dia, COALESCE(M.ventas, 0) AS ventas_mes, COALESCE(M.comision, 0) AS comision_mes
FROM lideres L
LEFT JOIN (
  SELECT R.id_lider, SUM(P.valor_voucher) AS ventas
  FROM registros R JOIN registros_pagos P ON P.id_registro = R.id_registro
  WHERE R.fecha_venta = '${fecha}' AND ${activo}
  GROUP BY R.id_lider
) D ON D.id_lider = L.id_lider
LEFT JOIN (
  SELECT R.id_lider, SUM(P.valor_voucher) AS ventas, SUM(P.comision) AS comision
  FROM registros R JOIN registros_pagos P ON P.id_registro = R.id_registro
  WHERE R.fecha_venta >= '${desde}' AND R.fecha_venta <= '${fecha}' AND ${activo}
  GROUP BY R.id_lider
) M ON M.id_lider = L.id_lider
WHERE L.estado = 1 AND L.visual = 1
ORDER BY L.lider`;

  const gruposSql = `WITH ${ASESORES_CTE}
SELECT A.id, A.grupo, A.meta AS meta_mensual,
  COALESCE(D.ventas, 0) AS ahora, COALESCE(M.ventas, 0) AS netas, COALESCE(M.comision, 0) AS acumulado
FROM usuarios_agrupaciones A
LEFT JOIN (
  SELECT S.id_agrupacion, SUM(P.valor_voucher) AS ventas
  FROM registros R
  JOIN registros_pagos P ON P.id_registro = R.id_registro
  JOIN asesores S ON S.id_referencia = R.id_vendedor
  WHERE R.fecha_venta = '${fecha}' AND ${activo}
  GROUP BY S.id_agrupacion
) D ON D.id_agrupacion = A.id
LEFT JOIN (
  SELECT S.id_agrupacion, SUM(P.valor_voucher) AS ventas, SUM(P.comision) AS comision
  FROM registros R
  JOIN registros_pagos P ON P.id_registro = R.id_registro
  JOIN asesores S ON S.id_referencia = R.id_vendedor
  WHERE R.fecha_venta >= '${desde}' AND R.fecha_venta < '${hastaExclusivo}' AND ${activo}
  GROUP BY S.id_agrupacion
) M ON M.id_agrupacion = A.id
WHERE A.estado = 1
ORDER BY A.grupo`;

  const cierresSql = `SELECT UPPER(L.lider) AS lider, COALESCE(SUM(P.valor_voucher), 0) AS total_pagado,
  COALESCE(SUM(P.comision), 0) AS total_comision
FROM lideres L
LEFT JOIN registros R ON L.id_lider = R.id_lider_asistente
  AND R.fecha_venta >= '${desde}' AND R.fecha_venta < '${hastaExclusivo}' AND ${activo}
LEFT JOIN registros_pagos P ON P.id_registro = R.id_registro
WHERE L.realiza_cierre = 1 AND L.estado = 1
GROUP BY L.id_lider, L.lider
ORDER BY total_pagado DESC, L.lider ASC`;

  const asesoresSql = `WITH ${ASESORES_CTE},
pagos AS (
  SELECT id_registro, SUM(valor_voucher) AS abono
  FROM registros_pagos
  WHERE id_registro IN (SELECT id_registro FROM registros WHERE fecha_venta = '${fecha}' AND estado NOT IN (9, 13))
  GROUP BY id_registro
)
SELECT S.nombres AS asesor, UPPER(T.nombre_comercial) AS tipo, ROUND(COALESCE(P.abono, 0), 2) AS abono_pagado
FROM registros R
JOIN lideres L ON R.id_lider = L.id_lider AND L.visual = 1
LEFT JOIN asesores S ON S.id_referencia = R.id_vendedor
LEFT JOIN registros_tipos T ON R.tipo_venta = T.id_tipo
LEFT JOIN pagos P ON P.id_registro = R.id_registro
WHERE R.fecha_venta = '${fecha}' AND ${activo}
ORDER BY R.id_registro ASC`;

  return { feriadosSql, lideresSql, gruposSql, cierresSql, asesoresSql, desde, hastaExclusivo };
};

export interface CuadroRows {
  feriados: Array<{ fecha: string }>;
  lideres: Array<Record<string, any>>;
  grupos: Array<Record<string, any>>;
  cierres: Array<Record<string, any>>;
  asesores: Array<Record<string, any>>;
}

const siglaOf = (lider: string) =>
  String(lider ?? '').split(' ').filter(Boolean).map((w) => w[0].toUpperCase()).join('');

/** Arma el cuadro con las mismas fórmulas del cuadro de ventas (metas contra comisión, meta diaria = meta / días laborables). */
export const assembleCuadro = (fecha: string, rows: CuadroRows) => {
  const dias = computeWorkingDays(fecha, rows.feriados.map((f) => f.fecha));
  const dl = dias.laborables;

  const equipos = rows.lideres.map((l) => {
    const meta = num(l.meta_mensual);
    const metaDiaria = dl > 0 ? meta / dl : 0;
    const aFecha = meta - metaDiaria * dias.restantes;
    const ventasDia = num(l.ventas_dia);
    const comision = num(l.comision_mes);
    return {
      equipo: l.lider,
      sigla: siglaOf(l.lider),
      diario: { meta: r2(metaDiaria), ventas: r2(ventasDia), falta: r2(Math.max(metaDiaria - ventasDia, 0)) },
      mensual: {
        meta: r2(meta),
        ventas: r2(num(l.ventas_mes)),
        comision: r2(comision),
        avance_pct: meta > 0 ? r2((comision / meta) * 100) : 0,
        meta_a_fecha: r2(aFecha),
        meta_a_fecha_pct: meta > 0 ? r2((aFecha / meta) * 100) : 0
      }
    };
  });

  const grupos = rows.grupos.map((g) => {
    const metaMensual = num(g.meta_mensual);
    const metaAFecha = dl > 0 ? (metaMensual / dl) * (dl - dias.restantes) : 0;
    const acumulado = num(g.acumulado);
    return {
      grupo: g.grupo,
      ventas_netas_mes: r2(num(g.netas)),
      comision_acumulada: r2(acumulado),
      ventas_hoy: r2(num(g.ahora)),
      meta_a_fecha: r2(metaAFecha),
      falta: r2(Math.max(metaAFecha - acumulado, 0))
    };
  });

  const sum = (f: (e: (typeof equipos)[number]) => number) => r2(equipos.reduce((a, e) => a + f(e), 0));
  const metaMes = sum((e) => e.mensual.meta);
  const comisionMes = sum((e) => e.mensual.comision);
  const resumen = {
    ventas_hoy: sum((e) => e.diario.ventas),
    meta_diaria_total: sum((e) => e.diario.meta),
    falta_hoy: sum((e) => e.diario.falta),
    ventas_mes: sum((e) => e.mensual.ventas),
    comision_mes: comisionMes,
    meta_comision_mes: metaMes,
    avance_comision_pct: metaMes > 0 ? r2((comisionMes / metaMes) * 100) : 0
  };

  return {
    fecha,
    dias_laborables: dias,
    feriados_del_mes: rows.feriados.map((f) => f.fecha),
    resumen,
    equipos,
    grupos,
    lideres_por_cierres: rows.cierres.map((c) => ({
      lider: c.lider,
      total_pagado: r2(num(c.total_pagado)),
      total_comision: r2(num(c.total_comision))
    })),
    ventas_del_dia_por_asesor: rows.asesores.map((a) => ({
      asesor: a.asesor ?? 'SIN ASESOR',
      tipo: a.tipo,
      abono_pagado: r2(num(a.abono_pagado))
    }))
  };
};

export const handleCuadro = async (params: { fecha?: string }): Promise<ToolResult> => {
  try {
    const fecha = params.fecha ?? todayInTimezone();
    const q = buildCuadroQueries(fecha);
    const [feriados, lideres, grupos, cierres, asesores] = await Promise.all([
      dbService.executeReadOnlyQuery(q.feriadosSql, 50),
      dbService.executeReadOnlyQuery(q.lideresSql, 100),
      dbService.executeReadOnlyQuery(q.gruposSql, 100),
      dbService.executeReadOnlyQuery(q.cierresSql, 100),
      dbService.executeReadOnlyQuery(q.asesoresSql, 500)
    ]);

    const cuadro = assembleCuadro(fecha, {
      feriados: feriados.rows as any,
      lideres: lideres.rows,
      grupos: grupos.rows,
      cierres: cierres.rows,
      asesores: asesores.rows
    });

    let json = JSON.stringify({ ...cuadro, ventas_del_dia_recortadas: asesores.truncated }, null, 2);
    if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}\n... (salida recortada)`;
    return { content: [{ type: 'text', text: `📊 [MVEVIP MCP] Cuadro de ventas al ${fecha}:\n\n\`\`\`json\n${json}\n\`\`\`` }] };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `❌ Error al generar el cuadro de ventas: ${error?.message || String(error)}` }],
      isError: true
    };
  }
};
