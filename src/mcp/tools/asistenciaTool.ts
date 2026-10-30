import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { REPORT_TIMEZONE, resolveDateRange } from './dates';

const MAX_OUTPUT_CHARS = 100_000;
const BIO = 'mvevip_biometrico';

export const ASISTENCIA_GROUPS = ['ninguno', 'empleado', 'dia', 'departamento'] as const;

export const DETAIL_ORDER = ['fecha_hora_marcacion', 'fecha', 'empleado', 'departamento', 'hora_esperada', 'minutos_atraso'] as const;
const GROUP_ORDER: Record<'empleado' | 'dia' | 'departamento', { columns: readonly string[]; default: string }> = {
  empleado: {
    columns: ['empleado', 'departamento', 'dias_con_marcacion', 'atrasos', 'minutos_atraso_total', 'hora_promedio_ingreso'],
    default: 'minutos_atraso_total'
  },
  dia: { columns: ['fecha', 'empleados', 'atrasos', 'minutos_atraso_total'], default: 'fecha' },
  departamento: {
    columns: ['departamento', 'dias_con_marcacion', 'atrasos', 'minutos_atraso_total'],
    default: 'minutos_atraso_total'
  }
};

export interface AsistenciaParams {
  mes?: number;
  anio?: number;
  fecha_desde?: string;
  fecha_hasta?: string;
  departamento?: string;
  empleado?: string;
  agrupar_por?: (typeof ASISTENCIA_GROUPS)[number];
  todas_las_marcaciones?: boolean;
  tolerancia_minutos?: number;
  ordenar_por?: string;
  direccion?: 'asc' | 'desc';
}

export interface AsistenciaQueries {
  detailSql: string;
  totalsSql: string;
  values: string[];
  desde: string;
  hastaExclusivo: string;
  tolerancia: number;
}

/** Texto de búsqueda parcial seguro para LIKE: se escapan los comodines y se envía como valor enlazado, nunca dentro del SQL. */
export const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const cleanFilter = (v: string | undefined, label: string): string | undefined => {
  const t = (v ?? '').trim();
  if (!t) return undefined;
  if (t.length > 60) throw new Error(`${label} es demasiado largo (máximo 60 caracteres).`);
  return t;
};

/**
 * Marcaciones de entrada (punch = 0) del biométrico. Hora esperada: la de pico y placa si el día de la marcación es el día
 * de pico y placa del empleado; si no, la hora de entrada de su departamento. Atraso = minutos después de la hora esperada
 * (0 si llegó a tiempo). Los atrasos se cuentan solo en la primera marcación del día de cada empleado.
 * Fechas y tolerancia están validadas; los textos de filtro viajan como valores enlazados (?).
 */
const buildCte = (desde: string, hasta: string, filters: string): string => `WITH marcas AS (
  SELECT a.timestamp AS ts, a.user_id_biometrico, a.dispositivo_id,
    ROW_NUMBER() OVER (PARTITION BY a.user_id_biometrico, DATE(a.timestamp) ORDER BY a.timestamp) AS marca_del_dia
  FROM ${BIO}.mve_asistencias a
  WHERE a.punch = 0 AND a.timestamp >= '${desde}' AND a.timestamp < '${hasta}'
),
base AS (
  SELECT m.ts, m.marca_del_dia, m.user_id_biometrico,
    UPPER(u.nombre) AS empleado, d.nombre AS departamento, disp.nombre AS dispositivo,
    CASE
      WHEN u.pico_placa_dia = WEEKDAY(m.ts) + 1 THEN u.pico_placa_hora
      WHEN d.id IS NOT NULL THEN d.hora_entrada
      ELSE NULL
    END AS esperada
  FROM marcas m
  JOIN ${BIO}.mve_usuarios u ON u.user_id_biometrico = m.user_id_biometrico
  LEFT JOIN ${BIO}.mve_departamentos d ON d.id = u.departamento_id
  LEFT JOIN ${BIO}.mve_dispositivos disp ON disp.id = m.dispositivo_id
  WHERE 1 = 1${filters}
),
marcaciones AS (
  SELECT ts, marca_del_dia, user_id_biometrico, empleado, departamento, dispositivo, esperada,
    CASE WHEN esperada IS NULL THEN NULL
      ELSE GREATEST(0, ROUND(TIME_TO_SEC(TIMEDIFF(TIME(ts), esperada)) / 60)) END AS minutos_atraso
  FROM base
)`;

export const buildAsistenciaQueries = (params: AsistenciaParams, now: Date = new Date()): AsistenciaQueries => {
  const { desde, hastaExclusivo } = resolveDateRange(params, now);
  const tolerancia = params.tolerancia_minutos ?? 0;
  if (!Number.isInteger(tolerancia) || tolerancia < 0 || tolerancia > 120) {
    throw new Error('tolerancia_minutos debe ser un entero entre 0 y 120.');
  }

  const values: string[] = [];
  let filters = '';
  const departamento = cleanFilter(params.departamento, 'departamento');
  if (departamento) {
    filters += ' AND d.nombre LIKE ?';
    values.push(likePattern(departamento));
  }
  const empleado = cleanFilter(params.empleado, 'empleado');
  if (empleado) {
    filters += ' AND u.nombre LIKE ?';
    values.push(likePattern(empleado));
  }
  const cte = buildCte(desde, hastaExclusivo, filters);
  const direccion = params.direccion === 'asc' ? 'ASC' : 'DESC';
  const agrupar = params.agrupar_por ?? 'ninguno';
  if (!(ASISTENCIA_GROUPS as readonly string[]).includes(agrupar)) {
    throw new Error(`agrupar_por inválido. Opciones: ${ASISTENCIA_GROUPS.join(', ')}`);
  }

  const atrasado = `(minutos_atraso IS NOT NULL AND minutos_atraso > ${tolerancia})`;
  const totalsSql = `${cte}
SELECT COUNT(*) AS marcaciones, CAST(COALESCE(SUM(marca_del_dia = 1), 0) AS SIGNED) AS dias_empleado,
  COUNT(DISTINCT user_id_biometrico) AS empleados,
  CAST(COALESCE(SUM(marca_del_dia = 1 AND ${atrasado}), 0) AS SIGNED) AS atrasos,
  CAST(COALESCE(SUM(CASE WHEN marca_del_dia = 1 AND ${atrasado} THEN minutos_atraso END), 0) AS SIGNED) AS minutos_atraso_total
FROM marcaciones`;

  if (agrupar === 'ninguno') {
    const orden = params.ordenar_por ?? 'fecha_hora_marcacion';
    if (!(DETAIL_ORDER as readonly string[]).includes(orden)) {
      throw new Error(`ordenar_por inválido para el detalle. Opciones: ${DETAIL_ORDER.join(', ')}`);
    }
    const todas = !!params.todas_las_marcaciones;
    const columns = todas
      ? `DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s') AS fecha_hora_marcacion, DATE_FORMAT(ts, '%Y-%m-%d') AS fecha, HOUR(ts) AS hora_del_dia,
  marca_del_dia, dispositivo, departamento, empleado, user_id_biometrico, TIME_FORMAT(esperada, '%H:%i') AS hora_esperada, minutos_atraso`
      : `DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s') AS fecha_hora_marcacion, DATE_FORMAT(ts, '%Y-%m-%d') AS fecha,
  departamento, empleado, TIME_FORMAT(esperada, '%H:%i') AS hora_esperada, minutos_atraso`;
    const detailSql = `${cte}
SELECT ${columns}
FROM marcaciones
${todas ? '' : 'WHERE marca_del_dia = 1\n'}ORDER BY \`${orden}\` ${direccion}, ts DESC`;
    return { detailSql, totalsSql, values, desde, hastaExclusivo, tolerancia };
  }

  const cfg = GROUP_ORDER[agrupar];
  const orden = params.ordenar_por ?? cfg.default;
  if (!cfg.columns.includes(orden)) {
    throw new Error(`ordenar_por inválido al agrupar por ${agrupar}. Opciones: ${cfg.columns.join(', ')}`);
  }
  const sumas = `CAST(SUM(${atrasado}) AS SIGNED) AS atrasos,
  CAST(COALESCE(SUM(CASE WHEN ${atrasado} THEN minutos_atraso END), 0) AS SIGNED) AS minutos_atraso_total`;
  const horaPromedio = `TIME_FORMAT(SEC_TO_TIME(ROUND(AVG(TIME_TO_SEC(TIME(ts))))), '%H:%i') AS hora_promedio_ingreso`;
  const grupos = {
    empleado: `SELECT empleado, departamento, COUNT(*) AS dias_con_marcacion, ${sumas}, ${horaPromedio}
FROM marcaciones WHERE marca_del_dia = 1 GROUP BY user_id_biometrico, empleado, departamento`,
    dia: `SELECT DATE_FORMAT(ts, '%Y-%m-%d') AS fecha, COUNT(*) AS empleados, ${sumas}
FROM marcaciones WHERE marca_del_dia = 1 GROUP BY DATE(ts)`,
    departamento: `SELECT COALESCE(departamento, 'SIN DEPARTAMENTO') AS departamento, COUNT(*) AS dias_con_marcacion, ${sumas}
FROM marcaciones WHERE marca_del_dia = 1 GROUP BY departamento`
  }[agrupar];
  const detailSql = `${cte}
${grupos}
ORDER BY \`${orden}\` ${direccion}`;
  return { detailSql, totalsSql, values, desde, hastaExclusivo, tolerancia };
};

export const handleAsistencia = async (params: AsistenciaParams): Promise<ToolResult> => {
  try {
    const q = buildAsistenciaQueries(params);
    const [detail, totals] = await Promise.all([
      dbService.executeReadOnlyQuery(q.detailSql, 500, q.values),
      dbService.executeReadOnlyQuery(q.totalsSql, 1, q.values)
    ]);
    const payload = {
      periodo: { desde: q.desde, hasta_exclusivo: q.hastaExclusivo, zona_horaria: REPORT_TIMEZONE },
      criterio: `Entradas del biométrico (punch 0). Atraso = minutos después de la hora esperada (pico y placa si corresponde, si no la del departamento); se cuenta solo la primera marcación del día de cada empleado${q.tolerancia ? `, con tolerancia de ${q.tolerancia} min` : ''}.`,
      agrupado_por: params.agrupar_por ?? 'ninguno',
      todas_las_marcaciones: !!params.todas_las_marcaciones && (params.agrupar_por ?? 'ninguno') === 'ninguno',
      totales_del_periodo: totals.rows[0],
      filas_devueltas: detail.rowCount,
      filas_recortadas: detail.truncated,
      filas: detail.rows
    };
    let json = JSON.stringify(payload);
    if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}... (salida recortada; agrupe o acorte el rango)`;
    return { content: [{ type: 'text', text: `🕘 [MVEVIP MCP] Asistencia ${q.desde} a ${q.hastaExclusivo} (exclusivo):\n\n\`\`\`json\n${json}\n\`\`\`` }] };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `❌ Error al consultar la asistencia: ${error?.message || String(error)}` }],
      isError: true
    };
  }
};
