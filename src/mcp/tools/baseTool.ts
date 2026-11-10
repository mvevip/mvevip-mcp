import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { getConfig } from '../../config';
import { dbService } from '../../services/dbService';
import { writeDb, WriteTx } from '../../services/dbWriteService';
import { LlamadasPorTelefono, consultarLlamadas } from '../../services/asteriskClient';
import { getStore } from '../../deps';
import { ToolResult } from '../types';
import { REPORT_TIMEZONE, parseIso, resolveDateRange, todayInTimezone } from './dates';
import { likePattern } from './asistenciaTool';

/**
 * Herramientas buscar_base / aplicar_base / encerar_cupos.
 *
 * Flujo acordado con el usuario (equivale a su proceso manual con Excel):
 *  1. notas_registros: contactos que llegaron en un rango de fecha_alta (banco 2 = Diners por defecto, teléfono de 10 dígitos,
 *     estados distintos de 7, 10, 27 y 35).
 *  2. Asterisk (tabla cdr, por el servicio asterisk-gateway): por defecto se liberan los teléfonos SIN registro de llamadas o con
 *     SUM(billsec) = 0 en el año en curso (el usuario puede ampliar el umbral).
 *  3. Vista previa (solo lectura) con un código de confirmación; solo con ese código se escribe (aplicar_base).
 */

export const BANCO_POR_DEFECTO = 2;
export const ESTADOS_EXCLUIDOS_POR_DEFECTO = [7, 10, 27, 35];
export const MAX_FILAS = 60_000;
export const LOTE_ACTUALIZACION = 1000;
export const VIGENCIA_CODIGO_SEG = 30 * 60;
const MAX_IDENTIFICADOR = 100;
const FORMATO_TELEFONO = /^0\d{9}$/;

export interface BaseParams {
  mes?: number;
  anio?: number;
  fecha_desde?: string;
  fecha_hasta?: string;
  banco?: number;
  estados_incluir?: Array<string | number>;
  estados_excluir?: Array<string | number>;
  ciudad?: string;
  filtrar_identificador?: string;
  filtrar_identificador_original?: string;
  excluir_bloq?: boolean;
  asterisk_desde?: string;
  asterisk_hasta?: string;
  billsec_max?: number;
  incluir_sin_registro?: boolean;
  para_predictivo?: boolean;
  nombre_identificador?: string;
}
export interface AplicarBaseParams extends BaseParams {
  codigo_confirmacion: string;
}
export interface EncerarCuposParams {
  codigo_confirmacion?: string;
}

export interface FiltroNormalizado {
  banco: number;
  desde: string;
  hastaExclusivo: string;
  estadosIncluir: number[] | null;
  estadosExcluir: number[];
  ciudad: string | null;
  identificador: string | null;
  identificadorOriginal: string | null;
  excluirBloq: boolean;
}

export interface FilaBase {
  id_lista: number;
  identificador: string | null;
  identificadorOriginal: string | null;
  documento: string | null;
  nombres: string | null;
  telefono: string | null;
  estado: number | null;
  estado_descripcion: string | null;
  ciudad: string | null;
}

// ---------------------------------------------------------------------------
// Dependencias (inyectables en las pruebas)
// ---------------------------------------------------------------------------
export interface BaseDeps {
  consultar(sql: string, values: Array<string | number>, maxRows?: number): Promise<{ rows: any[]; truncated: boolean }>;
  llamadas(telefonos: string[], desde: string, hasta: string): Promise<LlamadasPorTelefono>;
  transaccion<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T>;
  ahora(): Date;
  usuarioMcp(userId: string): Promise<string>;
  secreto(): string;
  log(linea: string): void;
}

export const defaultDeps: BaseDeps = {
  consultar: async (sql, values, maxRows = 500) => {
    const r = await dbService.executeReadOnlyQuery(sql, maxRows, values, MAX_FILAS + 1);
    return { rows: r.rows, truncated: r.truncated };
  },
  llamadas: (telefonos, desde, hasta) => consultarLlamadas(telefonos, desde, hasta),
  transaccion: (fn) => writeDb.transaction(fn),
  ahora: () => new Date(),
  usuarioMcp: async (userId) => {
    try {
      const u = await getStore().findUserById(Number(userId));
      return u?.username || `usuario ${userId}`;
    } catch {
      return `usuario ${userId}`;
    }
  },
  secreto: () => getConfig().signingSecret,
  log: (l) => console.log(l)
};

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------
const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** Convierte nombres ("Interesado", "llamar mas tarde") o ids de estado en ids, validando contra el catálogo. */
export const resolverEstados = (lista: Array<string | number>, catalogo: Array<{ id_estados: number; descripcion: string | null }>): number[] => {
  const porNombre = new Map(catalogo.map((e) => [sinAcentos(String(e.descripcion ?? '')), Number(e.id_estados)]));
  const ids = new Set(catalogo.map((e) => Number(e.id_estados)));
  const out: number[] = [];
  const invalidos: string[] = [];
  for (const item of lista) {
    const n = typeof item === 'number' ? item : /^\d+$/.test(String(item).trim()) ? Number(String(item).trim()) : undefined;
    const id = n !== undefined ? (ids.has(n) ? n : undefined) : porNombre.get(sinAcentos(String(item)));
    if (id === undefined) invalidos.push(String(item));
    else if (!out.includes(id)) out.push(id);
  }
  if (invalidos.length) {
    throw new Error(
      `Estado(s) no reconocido(s): ${invalidos.join(', ')}. Estados válidos: ${catalogo.map((e) => `${e.id_estados}=${e.descripcion}`).join('; ')}.`
    );
  }
  return out;
};

export const normalizarFiltro = (
  p: BaseParams,
  catalogo: Array<{ id_estados: number; descripcion: string | null }>,
  now: Date = new Date()
): FiltroNormalizado => {
  if (p.mes === undefined && !p.fecha_desde && !p.fecha_hasta) {
    throw new Error('Indique el rango de fechas de alta: fecha_desde y fecha_hasta (o mes y año).');
  }
  const { desde, hastaExclusivo } = resolveDateRange(p, now);
  const texto = (v: string | undefined) => (v ?? '').trim() || null;
  return {
    banco: p.banco ?? BANCO_POR_DEFECTO,
    desde,
    hastaExclusivo,
    estadosIncluir: p.estados_incluir?.length ? resolverEstados(p.estados_incluir, catalogo) : null,
    estadosExcluir: p.estados_excluir ? resolverEstados(p.estados_excluir, catalogo) : [...ESTADOS_EXCLUIDOS_POR_DEFECTO],
    ciudad: texto(p.ciudad),
    identificador: texto(p.filtrar_identificador),
    identificadorOriginal: texto(p.filtrar_identificador_original),
    excluirBloq: Boolean(p.excluir_bloq)
  };
};

/**
 * Consulta del usuario (notas_registros + estados), con valores enlazados y fechas en rango semiabierto
 * (equivale a DATE(fecha_alta) BETWEEN desde AND hasta, pero sin función sobre la columna).
 */
export const buildBaseQuery = (f: FiltroNormalizado): { sql: string; values: Array<string | number> } => {
  const values: Array<string | number> = [f.banco, `${f.desde} 00:00:00`, `${f.hastaExclusivo} 00:00:00`];
  let where = 'R.banco = ? AND R.fecha_alta >= ? AND R.fecha_alta < ? AND LENGTH(R.telefono) = 10';
  const marks = (n: number) => Array(n).fill('?').join(',');
  if (f.estadosIncluir) {
    where += ` AND R.estado IN (${marks(f.estadosIncluir.length)})`;
    values.push(...f.estadosIncluir);
  } else if (f.estadosExcluir.length) {
    where += ` AND R.estado NOT IN (${marks(f.estadosExcluir.length)})`;
    values.push(...f.estadosExcluir);
  }
  if (f.ciudad) {
    where += ' AND R.ciudad = ?';
    values.push(f.ciudad);
  }
  if (f.identificador) {
    where += ' AND R.identificador = ?';
    values.push(f.identificador);
  }
  if (f.identificadorOriginal) {
    where += ' AND R.identificadorOriginal LIKE ?';
    values.push(likePattern(f.identificadorOriginal));
  }
  if (f.excluirBloq) where += " AND (R.identificador IS NULL OR R.identificador NOT LIKE '%BLOQ%')";
  const sql =
    'SELECT R.id_lista, R.identificador, R.identificadorOriginal, R.documento, R.nombres, R.telefono, R.estado, ' +
    'E.descripcion AS estado_descripcion, R.ciudad ' +
    'FROM notas_registros R LEFT JOIN notas_registros_estados E ON R.estado = E.id_estados ' +
    `WHERE ${where} ORDER BY R.id_lista`;
  return { sql, values };
};

export interface Evaluacion {
  liberables: Array<FilaBase & { billsec: number | null }>;
  stats: {
    encontrados_en_notas: number;
    telefonos_unicos: number;
    telefonos_fuera_de_formato: number;
    sin_registro_de_llamadas: number;
    con_llamadas_dentro_del_umbral: number;
    con_llamadas_sobre_el_umbral: number;
    a_liberar: number;
  };
}

export const esTelefonoConsultable = (t: string | null | undefined): t is string => FORMATO_TELEFONO.test(String(t ?? ''));

/** Cruce de notas con las llamadas de Asterisk: libera los sin registro (si se pide) y los de billsec <= umbral. */
export const evaluarLlamadas = (
  filas: FilaBase[],
  llamadas: LlamadasPorTelefono,
  umbral: number,
  incluirSinRegistro: boolean
): Evaluacion => {
  const liberables: Evaluacion['liberables'] = [];
  let sinRegistro = 0;
  let dentro = 0;
  let sobre = 0;
  let fueraFormato = 0;
  for (const f of filas) {
    const consultable = esTelefonoConsultable(f.telefono);
    if (!consultable) fueraFormato++;
    const info = consultable ? llamadas.get(String(f.telefono)) : undefined;
    if (!info) {
      sinRegistro++;
      if (incluirSinRegistro) liberables.push({ ...f, billsec: null });
    } else if (info.billsec <= umbral) {
      dentro++;
      liberables.push({ ...f, billsec: info.billsec });
    } else {
      sobre++;
    }
  }
  return {
    liberables,
    stats: {
      encontrados_en_notas: filas.length,
      telefonos_unicos: new Set(filas.map((f) => f.telefono)).size,
      telefonos_fuera_de_formato: fueraFormato,
      sin_registro_de_llamadas: sinRegistro,
      con_llamadas_dentro_del_umbral: dentro,
      con_llamadas_sobre_el_umbral: sobre,
      a_liberar: liberables.length
    }
  };
};

/** AAAA-MM-DD SIGLA-cantidad (o SIGLA-PREDICTIVO). Si el usuario da un nombre, se respeta tal cual. */
export const construirIdentificador = (o: {
  hoy: string;
  prefijo: string | null;
  cantidad: number;
  predictivo: boolean;
  nombre?: string;
}): string => {
  const nombre = (o.nombre ?? '').trim();
  if (nombre) return nombre;
  const prefijo = (o.prefijo ?? '').trim();
  if (!prefijo) throw new Error('Este banco no tiene sigla (prefijo): indique el nombre del identificador (nombre_identificador).');
  return `${o.hoy} ${prefijo}-${o.predictivo ? 'PREDICTIVO' : o.cantidad}`;
};

const marcas = (n: number) => Array(n).fill('?').join(',');
const SET_ANTERIORES =
  'asignadoAnterior=asignado, estadoAnterior=estado, identificadorAnterior=identificador, observacionesAnterior=observaciones, fechaAsignadoAnterior=fecha_asignacion';

// Sentencias de escritura: las del usuario, con valores enlazados. El orden de las asignaciones importa (primero se guardan los "Anterior").
export const sqlLiberar = (n: number) =>
  `UPDATE notas_registros SET ${SET_ANTERIORES}, asignado=0, estado=0, observaciones='', identificador=? WHERE banco = ? AND id_lista IN (${marcas(n)})`;
export const SQL_PREDICTIVO_LIMPIAR = 'UPDATE notas_registros SET predictivo=0, codigo_predictivo=0 WHERE predictivo=1';
export const sqlPredictivo = (n: number) =>
  `UPDATE notas_registros SET ${SET_ANTERIORES}, asignado=0, estado=0, observaciones='', identificador=?, predictivo=1, intentos_predictivo=0, codigo_predictivo=0 WHERE banco = ? AND id_lista IN (${marcas(n)})`;
export const SQL_CUPOS_INSERT =
  'INSERT INTO notas_registros_cupos (id_usuario, id_banco, id_identificador, cupo) SELECT id_usuario, ?, ?, 0 FROM usuarios WHERE (tipo=6) AND (estado=0)';
// Historial (tablas mcp_base_lotes y mcp_base_historial): se copia el estado ANTES de modificar los contactos, en la misma transacción.
export const SQL_LOTE_INSERT =
  'INSERT INTO mcp_base_lotes (fecha_hora, usuario_mcp_id, usuario_mcp, accion, id_banco, identificador_nuevo, cantidad, cupos_creados, predictivos_desmarcados, filtros) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
export const sqlHistorial = (n: number) =>
  'INSERT INTO mcp_base_historial (id_lote, id_lista, fecha_hora, id_banco, asignado_anterior, estado_anterior, identificador_anterior, observaciones_anterior, fecha_asignacion_anterior) ' +
  `SELECT ?, id_lista, ?, banco, asignado, estado, identificador, observaciones, fecha_asignacion FROM notas_registros WHERE banco = ? AND id_lista IN (${marcas(n)})`;
export const SQL_CONTAR_CUPOS_USUARIOS = 'SELECT COUNT(*) AS n FROM usuarios WHERE tipo = 6 AND estado = 0';
export const SQL_CONTAR_PREDICTIVOS = 'SELECT COUNT(*) AS n FROM notas_registros WHERE predictivo = 1';

/** Fecha y hora de Ecuador como AAAA-MM-DD HH:MM:SS (el servidor corre en UTC). */
export const fechaHoraEcuador = (now: Date): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
};

export const SQL_ENCERAR_CUPOS = 'UPDATE notas_registros_cupos SET cupo=0';

export const lotes = <T>(lista: T[], tamano = LOTE_ACTUALIZACION): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < lista.length; i += tamano) out.push(lista.slice(i, i + tamano));
  return out;
};

export const hashIds = (ids: number[]): string => createHash('sha256').update([...ids].sort((a, b) => a - b).join(',')).digest('hex');

/** Código de confirmación: HMAC de lo que se va a hacer + vencimiento. Se valida recalculando todo al aplicar. */
export const generarCodigo = (secreto: string, firma: unknown, ahoraMs: number): { codigo: string; vence: string } => {
  const exp = Math.floor(ahoraMs / 1000) + VIGENCIA_CODIGO_SEG;
  const mac = createHmac('sha256', secreto).update(`${exp}|${JSON.stringify(firma)}`).digest('hex').slice(0, 32);
  return { codigo: `${exp}.${mac}`, vence: new Date(exp * 1000).toISOString() };
};

export const validarCodigo = (secreto: string, firma: unknown, codigo: string, ahoraMs: number): { ok: boolean; motivo?: string } => {
  const m = /^(\d{9,12})\.([0-9a-f]{32})$/.exec((codigo ?? '').trim());
  if (!m) return { ok: false, motivo: 'El código de confirmación no tiene el formato esperado.' };
  if (Number(m[1]) < Math.floor(ahoraMs / 1000)) return { ok: false, motivo: 'El código de confirmación venció.' };
  const esperado = createHmac('sha256', secreto).update(`${m[1]}|${JSON.stringify(firma)}`).digest('hex').slice(0, 32);
  const a = Buffer.from(m[2]);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, motivo: 'Los datos cambiaron desde la vista previa (o los parámetros no son los mismos).' };
};

const contar = (filas: Array<Record<string, any>>, clave: string, tope: number) => {
  const m = new Map<string, number>();
  for (const f of filas) {
    const k = String(f[clave] ?? '(vacío)');
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, tope).map(([valor, cantidad]) => ({ valor, cantidad }));
};

// ---------------------------------------------------------------------------
// Plan (todo lo que se calcula antes de escribir)
// ---------------------------------------------------------------------------
interface Plan {
  modo: 'normal' | 'predictivo';
  hoy: string;
  filtro: FiltroNormalizado;
  banco: { id: number; nombre: string; prefijo: string | null };
  asterisk: { desde: string; hasta: string; billsec_max: number; incluir_sin_registro: boolean };
  evaluacion: Evaluacion;
  ids: number[];
  identificador: string | null;
  usuariosConCupo: number;
  cuposExistentes: number;
  registrosConEseIdentificador: number;
  predictivosActuales: number;
  bloqueos: string[];
  advertencias: string[];
  firma: unknown;
}

const numero = (v: unknown) => Number((v as any) ?? 0) || 0;

const calcularPlan = async (p: BaseParams, userId: string, deps: BaseDeps): Promise<Plan> => {
  const ahora = deps.ahora();
  const hoy = todayInTimezone(ahora);
  const bancoId = p.banco ?? BANCO_POR_DEFECTO;
  const [cat, bancoRows] = await Promise.all([
    deps.consultar('SELECT id_estados, descripcion FROM notas_registros_estados ORDER BY id_estados', []),
    deps.consultar('SELECT id_banco, banco, prefijo FROM notas_registros_bancos WHERE id_banco = ?', [bancoId])
  ]);
  if (!bancoRows.rows.length) throw new Error(`El banco ${bancoId} no existe en notas_registros_bancos.`);
  const b = bancoRows.rows[0];
  const banco = { id: Number(b.id_banco), nombre: String(b.banco ?? ''), prefijo: b.prefijo ? String(b.prefijo).trim() || null : null };

  const filtro = normalizarFiltro(p, cat.rows, ahora);
  const q = buildBaseQuery(filtro);
  const notas = await deps.consultar(q.sql, q.values, MAX_FILAS);
  if (notas.truncated || notas.rows.length > MAX_FILAS) {
    throw new Error(`Hay más de ${MAX_FILAS} registros en ese filtro. Acorte el rango de fechas.`);
  }
  const filas = notas.rows as FilaBase[];

  const asterisk = {
    desde: p.asterisk_desde ?? `${hoy.slice(0, 4)}-01-01`,
    hasta: p.asterisk_hasta ?? hoy,
    billsec_max: p.billsec_max ?? 0,
    incluir_sin_registro: p.incluir_sin_registro ?? true
  };
  parseIso(asterisk.desde);
  parseIso(asterisk.hasta);
  if (asterisk.desde > asterisk.hasta) throw new Error('asterisk_desde no puede ser posterior a asterisk_hasta.');

  const telefonos = [...new Set(filas.map((f) => f.telefono).filter(esTelefonoConsultable))];
  const llamadas: LlamadasPorTelefono = telefonos.length ? await deps.llamadas(telefonos, asterisk.desde, asterisk.hasta) : new Map();
  const evaluacion = evaluarLlamadas(filas, llamadas, asterisk.billsec_max, asterisk.incluir_sin_registro);
  const ids = evaluacion.liberables.map((f) => Number(f.id_lista));

  const modo: Plan['modo'] = p.para_predictivo ? 'predictivo' : 'normal';
  const bloqueos: string[] = [];
  const advertencias: string[] = [];
  let identificador: string | null = null;
  try {
    identificador = construirIdentificador({
      hoy,
      prefijo: banco.prefijo,
      cantidad: ids.length,
      predictivo: modo === 'predictivo',
      nombre: p.nombre_identificador
    });
    if (identificador.length > MAX_IDENTIFICADOR) throw new Error(`El identificador no puede superar ${MAX_IDENTIFICADOR} caracteres.`);
  } catch (e: any) {
    bloqueos.push(e.message);
    identificador = null;
  }
  if (!ids.length) bloqueos.push('No hay registros para liberar con estos criterios.');

  let usuariosConCupo = 0;
  let cuposExistentes = 0;
  let registrosConEseIdentificador = 0;
  let predictivosActuales = 0;
  if (ids.length && identificador) {
    if (modo === 'normal') {
      const [u, c, r] = await Promise.all([
        deps.consultar('SELECT COUNT(*) AS n FROM usuarios WHERE tipo = 6 AND estado = 0', []),
        deps.consultar('SELECT COUNT(*) AS n FROM notas_registros_cupos WHERE id_banco = ? AND id_identificador = ?', [banco.id, identificador]),
        deps.consultar('SELECT COUNT(*) AS n FROM notas_registros WHERE banco = ? AND identificador = ?', [banco.id, identificador])
      ]);
      usuariosConCupo = numero(u.rows[0]?.n);
      cuposExistentes = numero(c.rows[0]?.n);
      registrosConEseIdentificador = numero(r.rows[0]?.n);
      if (cuposExistentes > 0) {
        bloqueos.push(
          `Ya existen ${cuposExistentes} cupos para el identificador "${identificador}": crearlos de nuevo los duplicaría. Use otro nombre (nombre_identificador).`
        );
      }
      if (registrosConEseIdentificador > 0) {
        advertencias.push(`Ya hay ${registrosConEseIdentificador} registros con el identificador "${identificador}"; los liberados se sumarían a ese lote.`);
      }
      if (usuariosConCupo === 0) advertencias.push('No hay usuarios tipo 6 activos: no se crearía ningún cupo.');
    } else {
      const pr = await deps.consultar('SELECT COUNT(*) AS n FROM notas_registros WHERE predictivo = 1', []);
      predictivosActuales = numero(pr.rows[0]?.n);
    }
  }
  if (evaluacion.stats.telefonos_fuera_de_formato > 0) {
    advertencias.push(
      `${evaluacion.stats.telefonos_fuera_de_formato} registros tienen teléfono que no empieza en 0 o no son 10 dígitos: no se pueden buscar en Asterisk y cuentan como "sin registro de llamadas".`
    );
  }
  if (!asterisk.incluir_sin_registro) advertencias.push('Se excluyen los teléfonos sin registro de llamadas (incluir_sin_registro=false).');

  const firma = {
    u: userId,
    m: modo,
    f: filtro,
    a: asterisk,
    n: identificador,
    h: hashIds(ids),
    c: ids.length
  };
  return {
    modo, hoy, filtro, banco, asterisk, evaluacion, ids, identificador, usuariosConCupo, cuposExistentes,
    registrosConEseIdentificador, predictivosActuales, bloqueos, advertencias, firma
  };
};

const resumenPlan = (plan: Plan) => {
  const lib = plan.evaluacion.liberables;
  return {
    banco: `${plan.banco.id} ${plan.banco.nombre}${plan.banco.prefijo ? ` (${plan.banco.prefijo})` : ''}`,
    modo: plan.modo === 'predictivo' ? 'PREDICTIVO' : 'normal (con cupos)',
    zona_horaria: REPORT_TIMEZONE,
    filtros: {
      fecha_alta: `${plan.filtro.desde} a ${plan.filtro.hastaExclusivo} (exclusivo)`,
      estados: plan.filtro.estadosIncluir ? { solo: plan.filtro.estadosIncluir } : { excluidos: plan.filtro.estadosExcluir },
      telefono: '10 dígitos',
      ciudad: plan.filtro.ciudad ?? 'todas',
      identificador: plan.filtro.identificador ?? 'todos',
      identificador_original_contiene: plan.filtro.identificadorOriginal ?? undefined,
      excluir_bloq: plan.filtro.excluirBloq || undefined
    },
    asterisk: {
      rango_llamadas: `${plan.asterisk.desde} a ${plan.asterisk.hasta}`,
      criterio: `${plan.asterisk.incluir_sin_registro ? 'sin registro de llamadas o ' : ''}tiempo hablado (billsec) total <= ${plan.asterisk.billsec_max} s`
    },
    resultado: plan.evaluacion.stats,
    identificador_nuevo: plan.identificador,
    efecto_al_confirmar:
      plan.modo === 'normal'
        ? {
            registros_que_se_liberan: plan.ids.length,
            cupos_que_se_crean: plan.usuariosConCupo,
            nota: 'Se guarda el estado anterior de cada registro; asignado=0, estado=0, observaciones vacías e identificador nuevo.'
          }
        : {
            registros_que_se_liberan: plan.ids.length,
            predictivos_actuales_que_se_desmarcan: plan.predictivosActuales,
            nota: 'No se crean cupos. Primero se desmarcan los predictivos actuales y luego se marcan estos.'
          },
    desglose_a_liberar: {
      por_estado: contar(lib, 'estado_descripcion', 15),
      por_identificador_original: contar(lib, 'identificadorOriginal', 15),
      por_identificador_actual: contar(lib, 'identificador', 10),
      por_ciudad: contar(lib, 'ciudad', 10)
    },
    muestra: lib.slice(0, 10).map((f) => ({
      id_lista: f.id_lista,
      telefono: f.telefono,
      estado: f.estado_descripcion,
      identificador: f.identificador,
      identificador_original: f.identificadorOriginal,
      billsec: f.billsec ?? 'sin registro'
    })),
    bloqueos: plan.bloqueos,
    advertencias: plan.advertencias
  };
};

const texto = (titulo: string, payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: `${titulo}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` }]
});
const falla = (mensaje: string): ToolResult => ({ content: [{ type: 'text', text: `❌ ${mensaje}` }], isError: true });

// ---------------------------------------------------------------------------
// buscar_base (solo lectura: vista previa)
// ---------------------------------------------------------------------------
const vistaPrevia = (plan: Plan, deps: BaseDeps, extra: Record<string, unknown> = {}) => {
  const aplicable = plan.bloqueos.length === 0;
  const cod = aplicable ? generarCodigo(deps.secreto(), plan.firma, deps.ahora().getTime()) : undefined;
  return {
    ...extra,
    ...resumenPlan(plan),
    puede_aplicarse: aplicable,
    codigo_confirmacion: cod?.codigo,
    codigo_vence: cod?.vence,
    siguiente_paso: aplicable
      ? 'Muestre este resumen al usuario y pida su confirmación EXPLÍCITA. Solo con su "sí/confirmo" llame a aplicar_base con los mismos parámetros y codigo_confirmacion.'
      : 'No se puede aplicar todavía: resuelva los bloqueos (cambie parámetros) y vuelva a buscar.'
  };
};

export const handleBuscarBase = async (params: BaseParams, userId: string, deps: BaseDeps = defaultDeps): Promise<ToolResult> => {
  try {
    const plan = await calcularPlan(params, userId, deps);
    return texto('🔎 [MVEVIP MCP] Vista previa de base a liberar (NO se ha modificado nada):', vistaPrevia(plan, deps));
  } catch (error: any) {
    return falla(`No se pudo preparar la búsqueda de base: ${error?.message || String(error)}`);
  }
};

// ---------------------------------------------------------------------------
// aplicar_base (escritura)
// ---------------------------------------------------------------------------
export const handleAplicarBase = async (params: AplicarBaseParams, userId: string, deps: BaseDeps = defaultDeps): Promise<ToolResult> => {
  try {
    const plan = await calcularPlan(params, userId, deps);
    if (plan.bloqueos.length) {
      return texto('⚠️ [MVEVIP MCP] NO se aplicó nada:', vistaPrevia(plan, deps, { aplicado: false }));
    }
    const v = validarCodigo(deps.secreto(), plan.firma, params.codigo_confirmacion, deps.ahora().getTime());
    if (!v.ok) {
      return texto('⚠️ [MVEVIP MCP] NO se aplicó nada. Revise la nueva vista previa y confirme de nuevo:', vistaPrevia(plan, deps, { aplicado: false, motivo: v.motivo }));
    }
    const identificador = plan.identificador!;
    const bancoId = plan.banco.id;

    const usuario = await deps.usuarioMcp(userId);
    const fechaHora = fechaHoraEcuador(deps.ahora());
    const filtrosJson = JSON.stringify({ filtro: plan.filtro, asterisk: plan.asterisk, para_predictivo: plan.modo === 'predictivo' });

    const resultado = await deps.transaccion(async (tx) => {
      let cuposEsperados: number | null = null;
      let desmarcadosAntes: number | null = null;
      if (plan.modo === 'normal') {
        const dup = await tx.consultar('SELECT COUNT(*) AS n FROM notas_registros_cupos WHERE id_banco = ? AND id_identificador = ?', [bancoId, identificador]);
        if (numero(dup[0]?.n) > 0) throw new Error(`Ya existen cupos para "${identificador}"; no se aplicó nada.`);
        cuposEsperados = numero((await tx.consultar(SQL_CONTAR_CUPOS_USUARIOS))[0]?.n);
      } else {
        desmarcadosAntes = numero((await tx.consultar(SQL_CONTAR_PREDICTIVOS))[0]?.n);
      }

      // Historial: lote + estado anterior de cada contacto, ANTES de modificarlos.
      const lote = await tx.ejecutar(SQL_LOTE_INSERT, [
        fechaHora, userId, usuario, plan.modo === 'predictivo' ? 'predictivo' : 'liberar', bancoId, identificador, plan.ids.length,
        cuposEsperados, desmarcadosAntes, filtrosJson
      ]);
      let historial = 0;
      for (const lote_ids of lotes(plan.ids)) {
        historial += (await tx.ejecutar(sqlHistorial(lote_ids.length), [lote.insertId, fechaHora, bancoId, ...lote_ids])).affectedRows;
      }
      if (historial !== plan.ids.length) {
        throw new Error(`El historial (${historial}) no coincide con los contactos a liberar (${plan.ids.length}); no se aplicó nada.`);
      }

      let desmarcados = 0;
      if (plan.modo === 'predictivo') desmarcados = (await tx.ejecutar(SQL_PREDICTIVO_LIMPIAR)).affectedRows;
      let actualizados = 0;
      for (const lote_ids of lotes(plan.ids)) {
        const sql = plan.modo === 'normal' ? sqlLiberar(lote_ids.length) : sqlPredictivo(lote_ids.length);
        actualizados += (await tx.ejecutar(sql, [identificador, bancoId, ...lote_ids])).affectedRows;
      }
      let cupos = 0;
      if (plan.modo === 'normal') cupos = (await tx.ejecutar(SQL_CUPOS_INSERT, [bancoId, identificador])).affectedRows;
      return { desmarcados, actualizados, cupos, idLote: lote.insertId, historial };
    });

    deps.log(
      `[AUDIT] ${JSON.stringify({
        accion: 'aplicar_base', usuario: userId, id_lote: resultado.idLote, modo: plan.modo, banco: bancoId, identificador,
        registros: plan.ids.length, filas_actualizadas: resultado.actualizados, cupos_creados: resultado.cupos,
        predictivos_desmarcados: resultado.desmarcados, ids_hash: hashIds(plan.ids), primer_id: plan.ids[0], ultimo_id: plan.ids[plan.ids.length - 1]
      })}`
    );
    return texto('✅ [MVEVIP MCP] Base liberada:', {
      aplicado: true,
      modo: plan.modo === 'predictivo' ? 'PREDICTIVO' : 'normal',
      identificador,
      banco: `${plan.banco.id} ${plan.banco.nombre}`,
      id_lote: resultado.idLote,
      registros_liberados: plan.ids.length,
      filas_actualizadas: resultado.actualizados,
      cupos_creados: plan.modo === 'normal' ? resultado.cupos : undefined,
      predictivos_desmarcados: plan.modo === 'predictivo' ? resultado.desmarcados : undefined,
      nota: `Los valores anteriores de cada registro quedaron en las columnas ...Anterior y en el historial (lote ${resultado.idLote}); consúltelo con historial_base.`
    });
  } catch (error: any) {
    return falla(`No se aplicó la liberación (se revirtió cualquier cambio): ${error?.message || String(error)}`);
  }
};

// ---------------------------------------------------------------------------
// encerar_cupos (escritura, solo a pedido explícito del usuario)
// ---------------------------------------------------------------------------
export const handleEncerarCupos = async (params: EncerarCuposParams, userId: string, deps: BaseDeps = defaultDeps): Promise<ToolResult> => {
  try {
    const r = await deps.consultar(
      'SELECT COUNT(*) AS filas, CAST(COALESCE(SUM(cupo > 0), 0) AS SIGNED) AS con_cupo, CAST(COALESCE(SUM(cupo), 0) AS SIGNED) AS cupo_total, ' +
        'COUNT(DISTINCT id_identificador) AS identificadores FROM notas_registros_cupos',
      []
    );
    const c = r.rows[0] ?? {};
    const estado = { filas: numero(c.filas), con_cupo: numero(c.con_cupo), cupo_total: numero(c.cupo_total), identificadores: numero(c.identificadores) };
    const firma = { u: userId, m: 'encerar_cupos', c: estado };

    if (!params.codigo_confirmacion) {
      const cod = generarCodigo(deps.secreto(), firma, deps.ahora().getTime());
      return texto('🔎 [MVEVIP MCP] Vista previa de encerar cupos (NO se ha modificado nada):', {
        efecto_al_confirmar: 'Pone cupo = 0 en TODAS las filas de notas_registros_cupos (todos los bancos e identificadores, sin filtro).',
        estado_actual: estado,
        codigo_confirmacion: cod.codigo,
        codigo_vence: cod.vence,
        siguiente_paso: 'Muestre esto al usuario y pida su confirmación EXPLÍCITA; solo entonces llame de nuevo a encerar_cupos con codigo_confirmacion.'
      });
    }
    const v = validarCodigo(deps.secreto(), firma, params.codigo_confirmacion, deps.ahora().getTime());
    if (!v.ok) {
      return falla(`No se encerraron los cupos. ${v.motivo} Vuelva a llamar a encerar_cupos sin código para ver el estado actual y confirmar de nuevo.`);
    }
    const afectadas = await deps.transaccion(async (tx) => (await tx.ejecutar(SQL_ENCERAR_CUPOS)).affectedRows);
    deps.log(`[AUDIT] ${JSON.stringify({ accion: 'encerar_cupos', usuario: userId, filas_con_cupo_antes: estado.con_cupo, filas_actualizadas: afectadas })}`);
    return texto('✅ [MVEVIP MCP] Cupos encerados:', { aplicado: true, filas_actualizadas: afectadas, filas_con_cupo_antes: estado.con_cupo, cupo_total_antes: estado.cupo_total });
  } catch (error: any) {
    return falla(`No se encerraron los cupos: ${error?.message || String(error)}`);
  }
};
