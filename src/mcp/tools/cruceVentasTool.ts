import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { REPORT_TIMEZONE, resolveDateRange } from './dates';
import { likePattern } from './asistenciaTool';

const MAX_OUTPUT_CHARS = 100_000;
const MAX_FINDINGS = 500;
const DOC_BATCH = 50;

/** Categorías de tipo de venta que son cuota (registros_tipo_categorias: 2 y 22 = "Cuota"). `es_cuota` no es confiable (siempre 0). */
export const CUOTA_TIPOS = [2, 22] as const;

export type Regla1 = 'OK' | 'CRUCE_CONTACTO' | 'SIN_NOTA' | 'NOTA_SIN_ASIGNAR' | 'SIN_ASESOR';
export type Regla2 = 'NO_ES_CUOTA' | 'CUOTA_OK' | 'CRUCE_CUOTA' | 'CUOTA_SIN_DUENO' | 'SIN_ASESOR';

export interface CruceParams {
  mes?: number;
  anio?: number;
  fecha_desde?: string;
  fecha_hasta?: string;
  asesor?: string;
}

/**
 * Ventas del período con las dos validaciones calculadas (las mismas expresiones que se verificaron con datos reales de octubre):
 *  - regla1: la nota del contacto (notas_registros, enlazada por registros.id_lista) debe estar asignada al asesor de la venta.
 *    notas_registros.asignado = usuarios.id_usuario; el asesor de la venta sale de usuarios.id_referencia = registros.id_vendedor.
 *  - regla2 (solo cuotas): el dueño del cliente (mve_clientes.cli_vendedor = usuarios.id_usuario_crm) debe ser el asesor de la venta.
 * Estados 9 y 13 (anulados) excluidos. Los textos de filtro viajan como valores enlazados.
 */
export const cruceBaseSql = (desde: string, hastaExclusivo: string, conAsesor: boolean): string => `
SELECT
  R.id_registro,
  DATE_FORMAT(R.fecha_venta, '%Y-%m-%d') AS fecha_venta,
  R.id_cliente,
  CONCAT(C.cli_apellido, ' ', C.cli_nombre) AS nombre_del_cliente,
  R.documento,
  UPPER(G.nombre) AS tipo_venta,
  ROUND(R.valor_total, 2) AS valor_total,
  R.id_lista,
  V.id_usuario AS asesor_id,
  COALESCE(NULLIF(TRIM(CONCAT(UU.usu_apellido, ' ', UU.usu_nombre)), ''), NULLIF(TRIM(V.usuario_crm), ''), 'SIN ASESOR') AS asesor,
  N.id_lista AS nota_id,
  N.asignado AS nota_asignado_id,
  COALESCE(NULLIF(TRIM(CONCAT(NU.usu_apellido, ' ', NU.usu_nombre)), ''), NULLIF(TRIM(NV.usuario_crm), ''), NULL) AS nota_asignado_a,
  DATE_FORMAT(N.fecha_asignacion, '%Y-%m-%d %H:%i') AS nota_fecha_asignacion,
  CASE WHEN R.tipo IN (${CUOTA_TIPOS.join(', ')}) THEN 1 ELSE 0 END AS es_cuota,
  C.cli_vendedor AS dueno_cliente_codigo,
  NULLIF(TRIM(CONCAT(DU.usu_apellido, ' ', DU.usu_nombre)), '') AS dueno_cliente,
  CASE
    WHEN V.id_usuario IS NULL THEN 'SIN_ASESOR'
    WHEN N.id_lista IS NULL THEN 'SIN_NOTA'
    WHEN COALESCE(N.asignado, 0) = 0 THEN 'NOTA_SIN_ASIGNAR'
    WHEN N.asignado = V.id_usuario THEN 'OK'
    ELSE 'CRUCE_CONTACTO'
  END AS regla1,
  CASE
    WHEN R.tipo NOT IN (${CUOTA_TIPOS.join(', ')}) THEN 'NO_ES_CUOTA'
    WHEN V.id_usuario IS NULL THEN 'SIN_ASESOR'
    WHEN C.cli_vendedor IS NULL OR C.cli_vendedor = 0 THEN 'CUOTA_SIN_DUENO'
    WHEN C.cli_vendedor = V.id_usuario_crm THEN 'CUOTA_OK'
    ELSE 'CRUCE_CUOTA'
  END AS regla2
FROM registros R
LEFT JOIN notas_registros N ON N.id_lista = R.id_lista AND R.id_lista > 0
LEFT JOIN (
  SELECT id_referencia, MIN(id_usuario) AS id_usuario, MIN(id_usuario_crm) AS id_usuario_crm, MIN(usuario_crm) AS usuario_crm
  FROM usuarios
  WHERE id_referencia > 0
  GROUP BY id_referencia
) V ON V.id_referencia = R.id_vendedor
LEFT JOIN mve.mve_usuarios UU ON UU.usu_codigo = V.id_usuario_crm
LEFT JOIN usuarios NV ON NV.id_usuario = N.asignado
LEFT JOIN mve.mve_usuarios NU ON NU.usu_codigo = NV.id_usuario_crm
LEFT JOIN mve.mve_clientes C ON C.cli_codigo = R.id_cliente
LEFT JOIN mve.mve_usuarios DU ON DU.usu_codigo = C.cli_vendedor
LEFT JOIN registros_tipo_categorias G ON R.tipo = G.id_categoria
WHERE R.fecha_venta >= '${desde}' AND R.fecha_venta < '${hastaExclusivo}'
  AND R.estado NOT IN (9, 13)${conAsesor ? `
  AND COALESCE(NULLIF(TRIM(CONCAT(UU.usu_apellido, ' ', UU.usu_nombre)), ''), NULLIF(TRIM(V.usuario_crm), ''), 'SIN ASESOR') LIKE ?` : ''}`;

const CLEAN = `regla1 = 'OK' AND regla2 IN ('NO_ES_CUOTA', 'CUOTA_OK')`;

export interface CruceQueries {
  hallazgosSql: string;
  totalesPorAsesorSql: string;
  values: string[];
  desde: string;
  hastaExclusivo: string;
}

export const buildCruceQueries = (params: CruceParams, now: Date = new Date()): CruceQueries => {
  const { desde, hastaExclusivo } = resolveDateRange(params, now);
  const asesor = params.asesor?.trim();
  const base = cruceBaseSql(desde, hastaExclusivo, !!asesor);
  const values = asesor ? [likePattern(asesor)] : [];
  return {
    hallazgosSql: `SELECT * FROM (${base}) v WHERE NOT (${CLEAN}) ORDER BY asesor ASC, fecha_venta ASC, id_registro ASC`,
    totalesPorAsesorSql: `SELECT asesor, COUNT(*) AS ventas FROM (${base}) v GROUP BY asesor`,
    values,
    desde,
    hastaExclusivo
  };
};

export interface Hallazgo {
  id_registro: number;
  asesor: string;
  asesor_id: number | null;
  documento: string | null;
  id_lista: number | null;
  nota_id: number | null;
  nota_asignado_id: number | null;
  nota_asignado_a: string | null;
  nota_fecha_asignacion: string | null;
  regla1: Regla1;
  regla2: Regla2;
  origen_nota?: 'id_lista' | 'documento';
  observacion?: string;
  [k: string]: unknown;
}

export interface NotaPorDocumento {
  id_lista: number;
  documento: string;
  asignado: number | null;
  asignado_a: string | null;
  fecha_asignacion: string | null;
}

/** Consulta de respaldo: notas de los documentos de las ventas sin nota enlazada. Una sola pasada (documento no tiene índice). */
export const notasPorDocumentoSql = (cantidad: number): string => `
SELECT
  N.id_lista, N.documento, N.asignado,
  COALESCE(NULLIF(TRIM(CONCAT(NU.usu_apellido, ' ', NU.usu_nombre)), ''), NULLIF(TRIM(NV.usuario_crm), ''), NULL) AS asignado_a,
  DATE_FORMAT(N.fecha_asignacion, '%Y-%m-%d %H:%i') AS fecha_asignacion
FROM notas_registros N
LEFT JOIN usuarios NV ON NV.id_usuario = N.asignado
LEFT JOIN mve.mve_usuarios NU ON NU.usu_codigo = NV.id_usuario_crm
WHERE N.documento IN (${Array.from({ length: cantidad }, () => '?').join(', ')})`;

const num = (v: unknown): number => Number(v ?? 0) || 0;

/**
 * Respaldo por documento: de las notas del contacto se toma la última asignación (con asesor asignado; por fecha_asignacion y luego id_lista).
 * Si las notas con asesor pertenecen a asesores distintos se deja una observación. Si ninguna tiene asesor, queda NOTA_SIN_ASIGNAR.
 */
export const aplicarRespaldoPorDocumento = (h: Hallazgo, notas: NotaPorDocumento[]): Hallazgo => {
  if (h.regla1 !== 'SIN_NOTA' || !notas.length) return h;
  const orden = (a: NotaPorDocumento, b: NotaPorDocumento) =>
    String(b.fecha_asignacion ?? '').localeCompare(String(a.fecha_asignacion ?? '')) || num(b.id_lista) - num(a.id_lista);
  const conAsesor = notas.filter((n) => num(n.asignado) > 0).sort(orden);
  const ultima = conAsesor[0] ?? [...notas].sort(orden)[0];
  const distintos = new Set(conAsesor.map((n) => num(n.asignado)));
  const out: Hallazgo = {
    ...h,
    nota_id: ultima.id_lista,
    nota_asignado_id: num(ultima.asignado) || null,
    nota_asignado_a: ultima.asignado_a ?? null,
    nota_fecha_asignacion: ultima.fecha_asignacion ?? null,
    origen_nota: 'documento',
    regla1: !conAsesor.length ? 'NOTA_SIN_ASIGNAR' : num(ultima.asignado) === num(h.asesor_id) ? 'OK' : 'CRUCE_CONTACTO'
  };
  if (distintos.size > 1) {
    out.observacion = `El contacto tiene ${notas.length} notas y ${distintos.size} asesores distintos; se tomó la última asignación.`;
  }
  return out;
};

export interface ResumenAsesor {
  asesor: string;
  ventas: number;
  sin_hallazgos: number;
  cruces_contacto: number;
  cruces_cuota: number;
  sin_nota: number;
  nota_sin_asignar: number;
  cuota_sin_dueno: number;
  sin_asesor: number;
}

const emptyResumen = (asesor: string, ventas: number): ResumenAsesor => ({
  asesor, ventas, sin_hallazgos: 0, cruces_contacto: 0, cruces_cuota: 0,
  sin_nota: 0, nota_sin_asignar: 0, cuota_sin_dueno: 0, sin_asesor: 0
});

const isClean = (h: Pick<Hallazgo, 'regla1' | 'regla2'>) =>
  h.regla1 === 'OK' && (h.regla2 === 'NO_ES_CUOTA' || h.regla2 === 'CUOTA_OK');

/**
 * Totales finales (por asesor y generales). Las ventas sin ningún hallazgo salen de restar las ventas con hallazgo al total del asesor;
 * un hallazgo que el respaldo por documento resolvió (OK y cuota OK) cuenta como sin hallazgos.
 */
export const resumir = (totalesPorAsesor: Array<{ asesor: string; ventas: number }>, hallazgos: Hallazgo[]) => {
  const porAsesor = new Map<string, ResumenAsesor>();
  for (const t of totalesPorAsesor) porAsesor.set(t.asesor, emptyResumen(t.asesor, num(t.ventas)));
  const conHallazgo = new Map<string, number>();
  for (const h of hallazgos) {
    const r = porAsesor.get(h.asesor) ?? (porAsesor.set(h.asesor, emptyResumen(h.asesor, 0)), porAsesor.get(h.asesor)!);
    if (isClean(h)) continue;
    conHallazgo.set(h.asesor, (conHallazgo.get(h.asesor) ?? 0) + 1);
    if (h.regla1 === 'CRUCE_CONTACTO') r.cruces_contacto++;
    if (h.regla1 === 'SIN_NOTA') r.sin_nota++;
    if (h.regla1 === 'NOTA_SIN_ASIGNAR') r.nota_sin_asignar++;
    if (h.regla2 === 'CRUCE_CUOTA') r.cruces_cuota++;
    if (h.regla2 === 'CUOTA_SIN_DUENO') r.cuota_sin_dueno++;
    if (h.regla1 === 'SIN_ASESOR') r.sin_asesor++;
  }
  const filas = [...porAsesor.values()].map((r) => ({ ...r, sin_hallazgos: Math.max(0, r.ventas - (conHallazgo.get(r.asesor) ?? 0)) }));
  filas.sort((a, b) => (b.cruces_contacto + b.cruces_cuota) - (a.cruces_contacto + a.cruces_cuota) || a.asesor.localeCompare(b.asesor));
  const total = filas.reduce((acc, r) => {
    for (const k of Object.keys(acc) as Array<keyof Omit<ResumenAsesor, 'asesor'>>) acc[k] += r[k];
    return acc;
  }, { ventas: 0, sin_hallazgos: 0, cruces_contacto: 0, cruces_cuota: 0, sin_nota: 0, nota_sin_asignar: 0, cuota_sin_dueno: 0, sin_asesor: 0 });
  return { totales: total, por_asesor: filas };
};

export const handleCruceVentas = async (params: CruceParams): Promise<ToolResult> => {
  try {
    const q = buildCruceQueries(params);
    const [hall, tot] = await Promise.all([
      dbService.executeReadOnlyQuery(q.hallazgosSql, MAX_FINDINGS, q.values),
      dbService.executeReadOnlyQuery(q.totalesPorAsesorSql, 500, q.values)
    ]);

    let hallazgos = hall.rows as Hallazgo[];
    const documentos = [...new Set(
      hallazgos.filter((h) => h.regla1 === 'SIN_NOTA' && h.documento && String(h.documento).trim()).map((h) => String(h.documento).trim())
    )];
    let notasRecortadas = false;
    if (documentos.length) {
      // Lotes pequeños: el tope de filas por consulta es 500 y un contacto puede tener varias notas.
      const porDoc = new Map<string, NotaPorDocumento[]>();
      for (let i = 0; i < documentos.length; i += DOC_BATCH) {
        const lote = documentos.slice(i, i + DOC_BATCH);
        const notas = await dbService.executeReadOnlyQuery(notasPorDocumentoSql(lote.length), 500, lote);
        notasRecortadas = notasRecortadas || notas.truncated;
        for (const n of notas.rows as NotaPorDocumento[]) {
          const k = String(n.documento).trim();
          porDoc.set(k, [...(porDoc.get(k) ?? []), n]);
        }
      }
      hallazgos = hallazgos.map((h) => aplicarRespaldoPorDocumento(h, porDoc.get(String(h.documento ?? '').trim()) ?? []));
    }
    hallazgos = hallazgos.filter((h) => !isClean(h));

    const resumen = resumir(tot.rows as any[], hallazgos);
    const payload = {
      periodo: { desde: q.desde, hasta_exclusivo: q.hastaExclusivo, criterio: 'fecha de venta', zona_horaria: REPORT_TIMEZONE },
      reglas: {
        regla1: 'La nota del contacto (notas_registros, enlazada por id_lista; si la venta no la tiene, por documento con la última asignación) debe estar asignada al asesor de la venta. Otro asesor = CRUCE_CONTACTO.',
        regla2: 'En cuotas (tipo de venta Cuota), el dueño del cliente (cli_vendedor) debe ser el asesor de la venta. Otro asesor = CRUCE_CUOTA.',
        sin_resolver: 'SIN_NOTA, NOTA_SIN_ASIGNAR, CUOTA_SIN_DUENO y SIN_ASESOR no son cruces: falta información para decidir.'
      },
      advertencia: hall.truncated
        ? `Hay más de ${MAX_FINDINGS} ventas con hallazgos; los totales son parciales. Acorte el rango o filtre por asesor.`
        : notasRecortadas ? 'Algún contacto tiene demasiadas notas; el respaldo por documento puede estar incompleto.' : undefined,
      totales: resumen.totales,
      por_asesor: resumen.por_asesor,
      ventas_con_hallazgos: hallazgos.length,
      hallazgos
    };
    let json = JSON.stringify(payload);
    if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}... (salida recortada; acorte el rango o filtre por asesor)`;
    return { content: [{ type: 'text', text: `🔎 [MVEVIP MCP] Validación de cruces de ventas ${q.desde} a ${q.hastaExclusivo} (exclusivo):\n\n\`\`\`json\n${json}\n\`\`\`` }] };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `❌ Error al validar los cruces de ventas: ${error?.message || String(error)}` }],
      isError: true
    };
  }
};
