import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';
import { resolverMarca } from './pagosTarjetasTool';

/**
 * debitos_interdin (solo lectura): alertas de la conciliación de DÉBITOS de Interdin.
 *
 * El servicio `mvevip_cruce_tarjetas_interdin` cruza los débitos del CSV de liquidaciones del banco con
 * mve.mve_tarjetas_procesamientos (concepto DEBITO) y guarda las diferencias en `mvevip_cruce.cruce_alertas_debitos`. Esta herramienta
 * solo LEE esa tabla (GRANT por columna aplicado el 26-nov-2026); no concilia ni cambia el estado de las alertas (eso se hace en el cruce).
 *
 * Reglas ya aplicadas por el cruce (validadas con datos reales de Diners, Visa, Mastercard y Discover de marzo a octubre de 2026):
 * - Los vales rechazados del banco (VALE RECHAZADO en procesamientos) no son débitos y no generan alertas.
 * - Lo preliquidado (PR) es provisional; un débito liquidado (LQ) que falta en el CSV es más grave.
 */
export const TIPOS_ALERTA_DEBITO = [
  'SOLO_EN_CSV', 'SOLO_EN_PROCESAMIENTOS', 'MONTO_DISTINTO', 'FECHA_DISTINTA', 'SIN_VENTA', 'EXCEDE_VENTA', 'POSIBLE_DOBLE_DEBITO', 'AJUSTE_REPETIDO'
] as const;
export const ESTADOS_ALERTA_DEBITO = ['abiertas', 'todas', 'NUEVA', 'REVISADA', 'RECLAMADA', 'DESCARTADA', 'AUTO_RESUELTA'] as const;
export const SEVERIDADES_DEBITO = ['ALTA', 'MEDIA', 'BAJA'] as const;
export const VISTAS_DEBITOS = ['detalle', 'resumen'] as const;

export const SIGNIFICADO_TIPO: Record<string, string> = {
  SOLO_EN_CSV: 'El banco liquidó un débito que NO está en procesamientos (posible reclamo o falta de registro).',
  SOLO_EN_PROCESAMIENTOS: 'Hay un débito en procesamientos que NO vino en el CSV del banco (revisar con el banco; los LQ son los más graves, los PR son provisionales).',
  MONTO_DISTINTO: 'El mismo débito está en las dos fuentes con distinto valor.',
  FECHA_DISTINTA: 'El mismo débito está en las dos fuentes con otra fecha de pago.',
  SIN_VENTA: 'Débito sin una venta (lote, vale y tarjeta) en procesamientos que lo justifique.',
  EXCEDE_VENTA: 'Lo debitado de una venta supera lo que se pagó por ella (típico doble débito: el vale con su lote y otra vez con lote 0): se puede reclamar al banco.',
  POSIBLE_DOBLE_DEBITO: 'La misma tarjeta y el mismo valor debitados dos veces en pocos días: puede ser legítimo (dos ventas iguales); verificar.',
  AJUSTE_REPETIDO: 'Ajuste sin tarjeta con el mismo valor repetido en pocos días.'
};

/** banco del cruce (código de la tabla de alertas) por sigla de marca. */
const BANCO_POR_SIGLA: Record<string, number> = { DN: 26, DI: 15, VI: 4, MC: 6 };
const MARCA_POR_BANCO: Record<number, string> = { 26: 'Diners', 15: 'Discover', 4: 'Visa', 6: 'Mastercard' };

export interface DebitosParams {
  vista?: (typeof VISTAS_DEBITOS)[number];
  marca?: string;
  mes?: number;
  anio?: number;
  fecha_desde?: string;
  fecha_hasta?: string;
  tipo?: string;
  severidad?: string;
  estado?: string;
  limite?: number;
}

export interface DebitosDeps {
  consultar(sql: string, maxRows: number, values: Array<string | number>, cap: number): Promise<{ rows: any[]; truncated: boolean }>;
}

export const defaultDebitosDeps: DebitosDeps = {
  consultar: async (sql, maxRows, values, cap) => {
    const r = await dbService.executeReadOnlyQuery(sql, maxRows, values, cap);
    return { rows: r.rows, truncated: r.truncated };
  }
};

const LIMITE_DEFECTO = 50;
const LIMITE_MAX = 200;
const MAX_OUTPUT_CHARS = 100_000;
const TABLA = 'mvevip_cruce.cruce_alertas_debitos';

export interface ConsultasDebitos {
  vista: (typeof VISTAS_DEBITOS)[number];
  limite: number;
  detalleSql: string;
  porTipoSql: string;
  porPeriodoSql: string;
  metaSql: string;
  values: Array<string | number>;
  filtros: Record<string, unknown>;
}

/** Todos los valores del usuario van como parámetros enlazados; el SQL solo lleva listas cerradas. */
export const buildConsultasDebitos = (p: DebitosParams): ConsultasDebitos => {
  const vista = p.vista ?? 'detalle';
  if (!(VISTAS_DEBITOS as readonly string[]).includes(vista)) throw new Error(`vista inválida. Opciones: ${VISTAS_DEBITOS.join(', ')}`);
  const where: string[] = [];
  const values: Array<string | number> = [];
  const filtros: Record<string, unknown> = {};

  const sigla = resolverMarca(p.marca);
  if (sigla) { where.push('banco = ?'); values.push(BANCO_POR_SIGLA[sigla]); filtros.marca = MARCA_POR_BANCO[BANCO_POR_SIGLA[sigla]]; }
  if (p.anio !== undefined) {
    if (!Number.isInteger(p.anio) || p.anio < 2000 || p.anio > 2100) throw new Error('anio inválido.');
    where.push('anio = ?'); values.push(p.anio); filtros.anio = p.anio;
  }
  if (p.mes !== undefined) {
    if (!Number.isInteger(p.mes) || p.mes < 1 || p.mes > 12) throw new Error('mes inválido (1-12).');
    where.push('mes = ?'); values.push(p.mes); filtros.mes = p.mes;
  }
  for (const [col, val] of [['fecha_desde', p.fecha_desde], ['fecha_hasta', p.fecha_hasta]] as const) {
    if (val === undefined) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) throw new Error(`${col} debe tener formato YYYY-MM-DD.`);
    where.push(col === 'fecha_desde' ? 'fecha_pago >= ?' : 'fecha_pago <= ?');
    values.push(val);
    filtros[col] = val;
  }
  if (p.tipo !== undefined) {
    if (!(TIPOS_ALERTA_DEBITO as readonly string[]).includes(p.tipo)) throw new Error(`tipo inválido. Opciones: ${TIPOS_ALERTA_DEBITO.join(', ')}`);
    where.push('tipo = ?'); values.push(p.tipo); filtros.tipo = p.tipo;
  }
  if (p.severidad !== undefined) {
    if (!(SEVERIDADES_DEBITO as readonly string[]).includes(p.severidad)) throw new Error(`severidad inválida. Opciones: ${SEVERIDADES_DEBITO.join(', ')}`);
    where.push('severidad = ?'); values.push(p.severidad); filtros.severidad = p.severidad;
  }
  const estado = p.estado ?? 'abiertas';
  if (!(ESTADOS_ALERTA_DEBITO as readonly string[]).includes(estado)) throw new Error(`estado inválido. Opciones: ${ESTADOS_ALERTA_DEBITO.join(', ')}`);
  if (estado === 'abiertas') where.push("estado IN ('NUEVA', 'REVISADA', 'RECLAMADA')");
  else if (estado !== 'todas') { where.push('estado = ?'); values.push(estado); }
  filtros.estado = estado;

  let limite = LIMITE_DEFECTO;
  if (p.limite !== undefined) {
    if (!Number.isInteger(p.limite) || p.limite < 1 || p.limite > LIMITE_MAX) throw new Error(`limite debe ser un entero entre 1 y ${LIMITE_MAX}.`);
    limite = p.limite;
  }

  const donde = where.length ? `WHERE ${where.join(' AND ')}\n` : '';
  return {
    vista, limite, values, filtros,
    detalleSql: `SELECT id, tipo, severidad, banco, anio, mes, recap, vale, tarjeta4, DATE_FORMAT(fecha_pago, '%Y-%m-%d') AS fecha_pago,
  valor, valor_otro, liquidado, detalle, refs, estado, comentario, usuario, DATE_FORMAT(fecha_estado, '%Y-%m-%d %H:%i') AS fecha_estado
FROM ${TABLA}
${donde}ORDER BY FIELD(severidad, 'ALTA', 'MEDIA', 'BAJA'), fecha_pago DESC, id DESC`,
    porTipoSql: `SELECT tipo, estado, COUNT(*) AS cantidad, COALESCE(SUM(valor), 0) AS valor
FROM ${TABLA}
${donde}GROUP BY tipo, estado
ORDER BY tipo, estado`,
    porPeriodoSql: `SELECT banco, anio, mes, COUNT(*) AS cantidad, COALESCE(SUM(valor), 0) AS valor
FROM ${TABLA}
${donde}GROUP BY banco, anio, mes
ORDER BY anio DESC, mes DESC, banco`,
    metaSql: `SELECT DATE_FORMAT(MAX(fecha_creacion), '%Y-%m-%d %H:%i') AS ultima_alerta_creada,
  DATE_FORMAT(MAX(fecha_estado), '%Y-%m-%d %H:%i') AS ultimo_cambio_de_estado, COUNT(*) AS alertas_en_total
FROM ${TABLA}`
  };
};

const num = (v: unknown): number => Number(v ?? 0) || 0;
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const marcaDe = (banco: unknown): string => MARCA_POR_BANCO[Number(banco)] ?? String(banco);

const texto = (titulo: string, payload: unknown): ToolResult => {
  let json = JSON.stringify(payload, null, 2);
  if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}\n... (salida recortada; use filtros o un límite menor)`;
  return { content: [{ type: 'text', text: `${titulo}\n\n\`\`\`json\n${json}\n\`\`\`` }] };
};

export const armarResumen = (porTipo: any[], porPeriodo: any[]) => {
  const tipos: Record<string, { cantidad: number; valor: number; por_estado: Record<string, number>; significado: string }> = {};
  for (const r of porTipo) {
    const t = (tipos[String(r.tipo)] ??= { cantidad: 0, valor: 0, por_estado: {}, significado: SIGNIFICADO_TIPO[String(r.tipo)] ?? '' });
    t.cantidad += num(r.cantidad);
    t.valor = round2(t.valor + num(r.valor));
    t.por_estado[String(r.estado)] = num(r.cantidad);
  }
  return {
    total_alertas: Object.values(tipos).reduce((s, t) => s + t.cantidad, 0),
    por_tipo: tipos,
    por_periodo: porPeriodo.map((r) => ({ marca: marcaDe(r.banco), anio: num(r.anio), mes: num(r.mes), cantidad: num(r.cantidad), valor: round2(num(r.valor)) }))
  };
};

export const formatearAlerta = (r: any) => ({
  id: num(r.id),
  tipo: String(r.tipo),
  severidad: String(r.severidad),
  marca: marcaDe(r.banco),
  periodo: `${num(r.anio)}-${String(num(r.mes)).padStart(2, '0')}`,
  lote: r.recap || null,
  vale: r.vale || null,
  tarjeta_ultimos4: r.tarjeta4 || null,
  fecha_pago: r.fecha_pago ?? null,
  valor: round2(num(r.valor)),
  valor_otro: r.valor_otro === null || r.valor_otro === undefined ? null : round2(num(r.valor_otro)),
  liquidado: r.liquidado === 'LQ' ? 'liquidado' : r.liquidado === 'PR' ? 'preliquidado (provisional)' : null,
  detalle: String(r.detalle ?? ''),
  estado: String(r.estado),
  comentario: r.comentario || null,
  revisado_por: r.usuario || null,
  fecha_estado: r.fecha_estado ?? null,
  referencias: r.refs || null
});

export const handleDebitos = async (params: DebitosParams, deps: DebitosDeps = defaultDebitosDeps): Promise<ToolResult> => {
  try {
    const q = buildConsultasDebitos(params);
    const [porTipo, porPeriodo, meta] = await Promise.all([
      deps.consultar(q.porTipoSql, 200, q.values, 200),
      deps.consultar(q.porPeriodoSql, 200, q.values, 200),
      deps.consultar(q.metaSql, 1, [], 1)
    ]);
    const resumen = armarResumen(porTipo.rows, porPeriodo.rows);
    const m = meta.rows[0] ?? {};
    const observaciones: string[] = [
      'Las alertas las genera el servicio de cruce de tarjetas al conciliar cada mes y marca; esta herramienta solo las lee. Un mes sin alertas puede estar limpio o no haberse conciliado todavía (ver ultima_alerta_creada).',
      'Los vales rechazados del banco no son débitos y no generan alertas. Lo preliquidado (PR) es provisional: puede cambiar cuando el banco liquide.',
      'Para reclamar al banco use las de tipo EXCEDE_VENTA y SOLO_EN_CSV; SOLO_EN_PROCESAMIENTOS liquidado (LQ) indica un débito registrado que el banco no confirmó en su archivo.'
    ];
    if (resumen.total_alertas === 0) observaciones.push('Sin alertas con esos filtros.');
    const base = {
      vista: q.vista,
      filtros: q.filtros,
      estado_del_cruce: { alertas_en_total: num(m.alertas_en_total), ultima_alerta_creada: m.ultima_alerta_creada ?? null, ultimo_cambio_de_estado: m.ultimo_cambio_de_estado ?? null },
      resumen
    };
    if (q.vista === 'resumen') return texto('🔎 [MVEVIP MCP] Conciliación de débitos de Interdin (resumen):', { ...base, observaciones });

    const detalle = await deps.consultar(q.detalleSql, q.limite, q.values, LIMITE_MAX);
    if (detalle.truncated) observaciones.push(`Hay más de ${q.limite} alertas con esos filtros: se muestran las ${q.limite} más graves y recientes; use filtros (marca, mes, tipo) o aumente limite (máximo ${LIMITE_MAX}).`);
    return texto('🔎 [MVEVIP MCP] Conciliación de débitos de Interdin (alertas):', {
      ...base,
      alertas_devueltas: detalle.rows.length,
      hay_mas_resultados: detalle.truncated,
      alertas: detalle.rows.map(formatearAlerta),
      observaciones
    });
  } catch (error: any) {
    return { content: [{ type: 'text', text: `❌ Error al consultar las alertas de débitos: ${error?.message || String(error)}` }], isError: true };
  }
};
