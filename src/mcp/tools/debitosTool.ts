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

export type AccionDebito = 'preguntar_al_banco' | 'confirmar_que_el_banco_lo_desconto' | 'revisar_internamente';

export interface InfoTipo {
  /** Nombre para el usuario (no se muestra el código técnico). */
  nombre: string;
  que_es: string;
  que_hacer: string;
  accion: AccionDebito;
  orden: number;
}

/** Cómo se explica cada tipo de alerta a quien no conoce los códigos. */
export const INFO_TIPO: Record<string, InfoTipo> = {
  EXCEDE_VENTA: {
    nombre: 'Se descontó más de lo que se pagó por la venta (posible descuento doble)',
    que_es: 'Del mismo vale el banco ya había descontado lo que correspondía y lo volvió a descontar (por ejemplo, una vez con su lote y otra con lote 0), así que lo descontado supera el valor pagado por esa venta.',
    que_hacer: 'Reclamar al banco el valor de más y pedir que lo devuelva.',
    accion: 'preguntar_al_banco', orden: 1
  },
  SOLO_EN_CSV: {
    nombre: 'El banco nos descontó un valor que no tenemos registrado en el sistema',
    que_es: 'El banco descontó este valor en la liquidación de un pago, pero ese descuento no está en los datos de tarjetas que se cargaron al sistema.',
    que_hacer: 'Preguntar al banco por qué lo descontó y, si corresponde, registrarlo en el sistema.',
    accion: 'preguntar_al_banco', orden: 2
  },
  SIN_VENTA: {
    nombre: 'Descuento sin una venta que lo respalde',
    que_es: 'El banco descontó un valor de un vale y en el sistema no encontramos la venta (mismo lote, vale y tarjeta) que lo justifique.',
    que_hacer: 'Ubicar la venta en el sistema; si no existe, preguntar al banco por qué descontó ese valor.',
    accion: 'preguntar_al_banco', orden: 3
  },
  POSIBLE_DOBLE_DEBITO: {
    nombre: 'Posible descuento repetido (misma tarjeta y mismo valor en pocos días)',
    que_es: 'La misma tarjeta fue descontada dos veces por el mismo valor en pocos días. Puede ser correcto si hubo dos ventas iguales; también puede ser un descuento duplicado o un cobro repetido al cliente.',
    que_hacer: 'Verificar en ventas si hubo realmente dos ventas iguales; si no, reclamar al banco el descuento repetido.',
    accion: 'revisar_internamente', orden: 4
  },
  AJUSTE_REPETIDO: {
    nombre: 'Ajuste repetido sin tarjeta asociada',
    que_es: 'Un ajuste con el mismo valor y sin tarjeta (no ligado a una venta) aparece varias veces en fechas cercanas.',
    que_hacer: 'Preguntar al banco qué es ese ajuste y por qué se repite.',
    accion: 'preguntar_al_banco', orden: 5
  },
  SOLO_EN_PROCESAMIENTOS: {
    nombre: 'Descuento registrado en el sistema que el banco no confirmó en su liquidación',
    que_es: 'En los datos de tarjetas cargados al sistema aparece un descuento, pero no viene en la liquidación que el banco entregó. Si es «liquidado» ya debería haber estado en la liquidación; si es «preliquidado» es provisional y puede cambiar.',
    que_hacer: 'Confirmar con el banco o con el estado de cuenta si realmente se descontó. Primero los liquidados; los preliquidados esperar a que el banco liquide.',
    accion: 'confirmar_que_el_banco_lo_desconto', orden: 6
  },
  MONTO_DISTINTO: {
    nombre: 'El mismo descuento tiene un valor distinto en la liquidación y en el sistema',
    que_es: 'El descuento está en las dos fuentes, pero con valores diferentes.',
    que_hacer: 'Revisar cuál es el valor correcto y corregir el sistema o pedir aclaración al banco.',
    accion: 'revisar_internamente', orden: 7
  },
  FECHA_DISTINTA: {
    nombre: 'El mismo descuento tiene otra fecha de pago en la liquidación y en el sistema',
    que_es: 'El descuento está en las dos fuentes, con el mismo valor, pero con distinta fecha de pago.',
    que_hacer: 'Revisar la fecha correcta; normalmente es solo una diferencia de fechas.',
    accion: 'revisar_internamente', orden: 8
  }
};

export const ACCION_TEXTO: Record<AccionDebito, string> = {
  preguntar_al_banco: 'Preguntar o reclamar al banco',
  confirmar_que_el_banco_lo_desconto: 'Confirmar con el banco o el estado de cuenta si realmente se descontó',
  revisar_internamente: 'Revisar internamente (ventas o contabilidad) antes de ir al banco'
};

export const ESTADO_TEXTO: Record<string, string> = {
  NUEVA: 'sin revisar',
  REVISADA: 'revisada',
  RECLAMADA: 'reclamada al banco',
  DESCARTADA: 'descartada (no es un problema)',
  AUTO_RESUELTA: 'ya no aplica (se resolvió sola al actualizar los datos)'
};

export const COMO_LEER =
  'Esta herramienta busca DESCUENTOS (débitos) que Diners, Visa, Mastercard o Discover hacen sobre lo que pagan a la empresa y que no cuadran. ' +
  'Compara dos fuentes: (1) los datos de tarjetas que el banco envía y se cargan al sistema, con los que se ve día a día lo que se va a recibir; ' +
  'y (2) las liquidaciones que el banco entrega en cada pago, que contabilidad procesa con los estados de cuenta y bancos para confirmar que llegó todo, ' +
  'cruzándolas con las ventas generadas en el sistema. Una alerta es un descuento que no aparece en las dos fuentes, o que parece sospechoso. ' +
  'Sirven para pedirle al banco que confirme por qué descontó un valor, por qué no pagó una transacción o cómo la pagó.';

export const INSTRUCCIONES_PARA_PRESENTAR = [
  'Escriba para personas que no conocen los códigos: use el campo «nombre» de cada tipo y explique con «que_es» y «que_hacer»; no mencione códigos como EXCEDE_VENTA o SOLO_EN_CSV.',
  'Empiece por lo que hay que hacer (preguntar al banco, confirmar o revisar internamente), con cantidades y valores, y luego dé ejemplos concretos (marca, fecha de pago, vale y valor).',
  'Diga siempre si un descuento es liquidado (confirmado por el banco) o preliquidado (provisional, puede cambiar).',
  'No concluya que el banco se equivocó: son casos para confirmar con el banco.'
];

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
  const tipos = new Map<string, { cantidad: number; valor: number; por_estado: Array<{ estado: string; codigo_estado: string; cantidad: number }> }>();
  for (const r of porTipo) {
    const t = tipos.get(String(r.tipo)) ?? { cantidad: 0, valor: 0, por_estado: [] };
    t.cantidad += num(r.cantidad);
    t.valor = round2(t.valor + num(r.valor));
    t.por_estado.push({ estado: ESTADO_TEXTO[String(r.estado)] ?? String(r.estado), codigo_estado: String(r.estado), cantidad: num(r.cantidad) });
    tipos.set(String(r.tipo), t);
  }
  const lista = [...tipos.entries()]
    .map(([codigo, t]) => {
      const info = INFO_TIPO[codigo];
      return {
        orden: info?.orden ?? 99,
        nombre: info?.nombre ?? codigo,
        codigo_tipo: codigo,
        cantidad: t.cantidad,
        valor: t.valor,
        por_estado: t.por_estado,
        que_es: info?.que_es ?? '',
        que_hacer: info?.que_hacer ?? '',
        accion: info ? ACCION_TEXTO[info.accion] : ''
      };
    })
    .sort((a, b) => a.orden - b.orden)
    .map(({ orden, ...resto }) => resto);

  const acciones = new Map<string, { cantidad: number; valor: number }>();
  for (const t of lista) {
    const a = acciones.get(t.accion) ?? { cantidad: 0, valor: 0 };
    a.cantidad += t.cantidad;
    a.valor = round2(a.valor + t.valor);
    acciones.set(t.accion, a);
  }
  return {
    total_alertas: lista.reduce((s, t) => s + t.cantidad, 0),
    que_hacer_en_resumen: [...acciones.entries()].map(([accion, v]) => ({ accion, cantidad: v.cantidad, valor: v.valor })),
    por_tipo: lista,
    por_periodo: porPeriodo.map((r) => ({ marca: marcaDe(r.banco), anio: num(r.anio), mes: num(r.mes), cantidad: num(r.cantidad), valor: round2(num(r.valor)) }))
  };
};

const usd = (v: number): string => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Frase que cuenta qué pasó con ese descuento en palabras del usuario. */
export const queSePaso = (r: any): string => {
  const valor = usd(round2(num(r.valor)));
  const marca = marcaDe(r.banco);
  const vale = r.vale ? `vale ${r.vale}` : 'sin vale';
  const lote = r.recap ? `, lote ${r.recap}` : '';
  const tarjeta = r.tarjeta4 ? `, tarjeta ****${r.tarjeta4}` : ', sin tarjeta asociada (ajuste)';
  const fecha = r.fecha_pago ? ` con fecha de pago ${r.fecha_pago}` : '';
  const ident = `(${vale}${lote}${tarjeta})`;
  const estado = r.liquidado === 'LQ' ? 'liquidado' : r.liquidado === 'PR' ? 'preliquidado (provisional)' : '';
  switch (String(r.tipo)) {
    case 'SOLO_EN_CSV':
      return `${marca} descontó ${valor}${fecha} ${ident} en su liquidación, pero ese descuento no está registrado en el sistema.`;
    case 'SOLO_EN_PROCESAMIENTOS':
      return `En el sistema figura un descuento de ${valor}${estado ? ` (${estado})` : ''}${fecha} ${ident}, pero no aparece en la liquidación que entregó ${marca}.`;
    case 'SIN_VENTA':
      return `${marca} descontó ${valor}${fecha} ${ident} y no encontramos en el sistema la venta que lo justifique.`;
    case 'EXCEDE_VENTA':
      return `Del ${vale}${lote} se ha descontado más de lo que se pagó por esa venta (${valor}${fecha}): posible descuento doble.`;
    case 'POSIBLE_DOBLE_DEBITO':
      return `${r.tarjeta4 ? `La tarjeta ****${r.tarjeta4}` : 'Una tarjeta'} fue descontada dos veces por ${valor} en pocos días ${ident}: puede ser correcto si hubo dos ventas iguales.`;
    case 'AJUSTE_REPETIDO':
      return `Un ajuste de ${valor} sin tarjeta asociada se repite en fechas cercanas ${ident}.`;
    case 'MONTO_DISTINTO':
      return `El descuento del ${vale}${lote} tiene distinto valor: ${valor} en la liquidación y ${usd(round2(num(r.valor_otro)))} en el sistema.`;
    case 'FECHA_DISTINTA':
      return `El descuento de ${valor} del ${vale}${lote} tiene otra fecha de pago en la liquidación que en el sistema.`;
    default:
      return String(r.detalle ?? '');
  }
};

export const formatearAlerta = (r: any) => {
  const info = INFO_TIPO[String(r.tipo)];
  return {
    id: num(r.id),
    que_paso: queSePaso(r),
    tipo_de_alerta: info?.nombre ?? String(r.tipo),
    que_hacer: info?.que_hacer ?? '',
    prioridad: r.severidad === 'ALTA' ? 'alta' : r.severidad === 'MEDIA' ? 'media' : 'baja',
    marca: marcaDe(r.banco),
    periodo_conciliado: `${num(r.anio)}-${String(num(r.mes)).padStart(2, '0')}`,
    lote: r.recap || null,
    vale: r.vale || null,
    tarjeta_ultimos4: r.tarjeta4 || null,
    fecha_pago: r.fecha_pago ?? null,
    valor: round2(num(r.valor)),
    valor_otro: r.valor_otro === null || r.valor_otro === undefined ? null : round2(num(r.valor_otro)),
    liquidado: r.liquidado === 'LQ' ? 'liquidado (confirmado por el banco)' : r.liquidado === 'PR' ? 'preliquidado (provisional)' : null,
    estado: ESTADO_TEXTO[String(r.estado)] ?? String(r.estado),
    codigo_estado: String(r.estado),
    codigo_tipo: String(r.tipo),
    comentario: r.comentario || null,
    revisado_por: r.usuario || null,
    fecha_estado: r.fecha_estado ?? null,
    detalle_tecnico: String(r.detalle ?? ''),
    referencias: r.refs || null
  };
};

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
      'Las alertas las genera el servicio de cruce de tarjetas al conciliar cada mes y marca; esta herramienta solo las lee y no las modifica. Un mes sin alertas puede estar limpio o no haberse conciliado todavía (ver ultima_alerta_creada).',
      'Las ventas que el banco rechazó no son descuentos y no generan alertas. Lo preliquidado es provisional: puede cambiar cuando el banco liquide.',
      'Una alerta no significa que el banco se equivocó: es un caso para confirmar con el banco, con el estado de cuenta o con ventas.'
    ];
    if (resumen.total_alertas === 0) observaciones.push('Sin alertas con esos filtros.');
    const base = {
      como_leer: COMO_LEER,
      instrucciones_para_presentar: INSTRUCCIONES_PARA_PRESENTAR,
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
