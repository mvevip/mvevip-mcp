import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BaseDeps, FilaBase, SQL_CUPOS_INSERT, SQL_ENCERAR_CUPOS, SQL_PREDICTIVO_LIMPIAR,
  buildBaseQuery, construirIdentificador, evaluarLlamadas, generarCodigo, handleAplicarBase, handleBuscarBase,
  handleEncerarCupos, normalizarFiltro, resolverEstados, sqlLiberar, sqlPredictivo, validarCodigo
} from '../src/mcp/tools/baseTool';
import { consultarLlamadas, LlamadasPorTelefono } from '../src/services/asteriskClient';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const NOW = new Date('2026-11-10T17:00:00Z'); // 10-nov-2026 en Ecuador
const SECRETO = 's'.repeat(40);
const CATALOGO = [
  { id_estados: 0, descripcion: 'Sin Contactar' }, { id_estados: 1, descripcion: 'Llamar más tarde' }, { id_estados: 2, descripcion: 'No Contesta' },
  { id_estados: 3, descripcion: 'Apagado' }, { id_estados: 4, descripcion: 'Interesado' }, { id_estados: 5, descripcion: 'No interesado' },
  { id_estados: 7, descripcion: 'Venta Realizada' }
];

// Los 12 contactos reales del Excel del usuario (cruceNotasRegistros_Asterisk.xlsx); en la BD el teléfono lleva el 0 inicial.
const REAL: Array<[number, string, string, string]> = [
  [918512, '0969816358', 'Llamar más tarde', '2026-11-05 DIN-1000'], [918513, '0987502584', 'No interesado', '2026-11-04 DIN-1500'],
  [918514, '0980527293', 'No Contesta', '2026-11-05 DIN-1000'], [918515, '0999655433', 'Apagado', '2026-11-05 DIN-1000'],
  [918516, '0985586604', 'No interesado', '2026-11-05 DIN-1000'], [918517, '0999899134', 'No interesado', '2026-11-04 DIN-1500'],
  [918518, '0979410134', 'No interesado', '2026-11-07 DIN-200'], [918520, '0962118477', 'No interesado', '2026-11-04 DIN-1500'],
  [918521, '0968804755', 'Apagado', '2026-11-04 DIN-1500'], [918522, '0994252091', 'No interesado', '2026-11-04 DIN-1500'],
  [918523, '0998056376', 'No interesado', '2026-11-05 DIN-1000'], [918524, '0987481913', 'No Contesta', '2026-11-04 DIN-1500']
];
const FILAS: FilaBase[] = REAL.map(([id, tel, est, ident]) => ({
  id_lista: id, identificador: ident, identificadorOriginal: '2026-11-04 DIN-1500', documento: null, nombres: 'X', telefono: tel,
  estado: 5, estado_descripcion: est, ciudad: 'QUITO'
}));
// Hoja "Sheet2" del Excel: billsec por teléfono (los demás no tienen registro en cdr: #N/A)
const BILLSEC: Record<string, number> = {
  '0969816358': 1132, '0987502584': 69, '0980527293': 88, '0999655433': 10, '0985586604': 42, '0999899134': 100, '0979410134': 16
};
const llamadasReales = (): LlamadasPorTelefono =>
  new Map(Object.entries(BILLSEC).map(([t, b]) => [t, { llamadas: 1, duracion: b + 5, billsec: b, ultima_llamada: '2026-11-05 18:04:00' }]));

interface Opciones { cupos?: number; filas?: FilaBase[]; maxFilas?: boolean }
function crearDeps(op: Opciones = {}) {
  const escrituras: Array<{ sql: string; values: Array<string | number> }> = [];
  let transacciones = 0;
  const consultasAsterisk: string[][] = [];
  const deps: BaseDeps = {
    consultar: async (sql) => {
      if (/FROM notas_registros_estados ORDER/.test(sql)) return { rows: CATALOGO, truncated: false };
      if (/FROM notas_registros_bancos/.test(sql)) return { rows: [{ id_banco: 2, banco: 'DINERS', prefijo: 'DIN' }], truncated: false };
      if (/FROM notas_registros R/.test(sql)) return { rows: op.filas ?? FILAS, truncated: Boolean(op.maxFilas) };
      if (/FROM usuarios/.test(sql)) return { rows: [{ n: 39 }], truncated: false };
      if (/FROM notas_registros_cupos WHERE id_banco/.test(sql)) return { rows: [{ n: op.cupos ?? 0 }], truncated: false };
      if (/WHERE predictivo = 1/.test(sql)) return { rows: [{ n: 761 }], truncated: false };
      if (/FROM notas_registros WHERE banco/.test(sql)) return { rows: [{ n: 0 }], truncated: false };
      if (/FROM notas_registros_cupos$/.test(sql)) return { rows: [{ filas: 48780, con_cupo: 120, cupo_total: 900, identificadores: 400 }], truncated: false };
      throw new Error(`consulta no prevista: ${sql}`);
    },
    llamadas: async (telefonos) => {
      consultasAsterisk.push(telefonos);
      return llamadasReales();
    },
    transaccion: async (fn) => {
      transacciones++;
      return fn({
        ejecutar: async (sql, values = []) => {
          escrituras.push({ sql, values });
          if (sql === SQL_PREDICTIVO_LIMPIAR) return { affectedRows: 761 };
          if (sql === SQL_CUPOS_INSERT) return { affectedRows: 39 };
          if (sql === SQL_ENCERAR_CUPOS) return { affectedRows: 120 };
          return { affectedRows: values.length - 2 };
        },
        consultar: async () => [{ n: op.cupos ?? 0 }]
      });
    },
    ahora: () => NOW,
    secreto: () => SECRETO,
    log: () => undefined
  };
  return { deps, escrituras, consultasAsterisk, transacciones: () => transacciones };
}

const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(/```json\n([\s\S]*)\n```/.exec(r.content[0].text)![1]);
const PARAMS = { fecha_desde: '2026-11-04', fecha_hasta: '2026-11-07' };

test('consulta por defecto: banco 2, rango semiabierto de fecha_alta, 10 dígitos y estados excluidos 7, 10, 27 y 35', () => {
  const f = normalizarFiltro({ mes: 11, anio: 2026 }, CATALOGO, NOW);
  const q = buildBaseQuery(f);
  assert.match(q.sql, /WHERE R\.banco = \? AND R\.fecha_alta >= \? AND R\.fecha_alta < \? AND LENGTH\(R\.telefono\) = 10 AND R\.estado NOT IN \(\?,\?,\?,\?\)/);
  assert.deepEqual(q.values, [2, '2026-11-01 00:00:00', '2026-12-01 00:00:00', 7, 10, 27, 35]);
  assert.doesNotThrow(() => validateReadOnlySql(q.sql));
});

test('filtros opcionales ajustan la consulta (banco, estados por nombre, ciudad, identificadores, BLOQ)', () => {
  const f = normalizarFiltro({
    ...PARAMS, banco: 1, estados_incluir: ['interesado', 'Llamar mas tarde'], ciudad: 'CUENCA', filtrar_identificador: '2025-09-11 DIN-570',
    filtrar_identificador_original: 'pic', excluir_bloq: true
  }, CATALOGO, NOW);
  const q = buildBaseQuery(f);
  assert.match(q.sql, /R\.estado IN \(\?,\?\)/);
  assert.doesNotMatch(q.sql, /NOT IN/);
  assert.match(q.sql, /R\.ciudad = \?/);
  assert.match(q.sql, /R\.identificador = \?/);
  assert.match(q.sql, /R\.identificadorOriginal LIKE \?/);
  assert.match(q.sql, /NOT LIKE '%BLOQ%'/);
  assert.deepEqual(q.values, [1, '2026-11-04 00:00:00', '2026-11-08 00:00:00', 4, 1, 'CUENCA', '2025-09-11 DIN-570', '%pic%']);
  assert.doesNotThrow(() => validateReadOnlySql(q.sql));
});

test('el rango de fechas es obligatorio y los estados deben existir', () => {
  assert.throws(() => normalizarFiltro({}, CATALOGO, NOW), /rango de fechas/);
  assert.throws(() => resolverEstados(['Inventado'], CATALOGO), /no reconocido/);
  assert.deepEqual(resolverEstados([4, 'no interesado', '7'], CATALOGO), [4, 5, 7]);
});

test('identificador: el del usuario se respeta; si no, fecha + sigla + cantidad (o PREDICTIVO)', () => {
  const base = { hoy: '2026-11-10', prefijo: 'DIN', cantidad: 1000, predictivo: false };
  assert.equal(construirIdentificador(base), '2026-11-10 DIN-1000');
  assert.equal(construirIdentificador({ ...base, predictivo: true }), '2026-11-10 DIN-PREDICTIVO');
  assert.equal(construirIdentificador({ ...base, nombre: ' 2026-11-10 FUERTE ' }), '2026-11-10 FUERTE');
  assert.throws(() => construirIdentificador({ ...base, prefijo: null }), /sigla/);
});

test('cifras reales del Excel del usuario: de 12 contactos se liberan los 5 sin registro (918520 a 918524)', () => {
  const e = evaluarLlamadas(FILAS, llamadasReales(), 0, true);
  assert.deepEqual(e.liberables.map((f) => f.id_lista), [918520, 918521, 918522, 918523, 918524]);
  assert.equal(e.stats.encontrados_en_notas, 12);
  assert.equal(e.stats.sin_registro_de_llamadas, 5);
  assert.equal(e.stats.con_llamadas_sobre_el_umbral, 7);
  // "de 0 a 20 segundos incluido sin registro": suman 0999655433 (10 s) y 0979410134 (16 s)
  const amplio = evaluarLlamadas(FILAS, llamadasReales(), 20, true);
  assert.deepEqual(amplio.liberables.map((f) => f.id_lista), [918515, 918518, 918520, 918521, 918522, 918523, 918524]);
  // sin incluir los "sin registro": solo los que tienen llamadas dentro del umbral
  assert.deepEqual(evaluarLlamadas(FILAS, llamadasReales(), 20, false).liberables.map((f) => f.id_lista), [918515, 918518]);
});

test('teléfonos fuera de formato no se envían a Asterisk y cuentan como sin registro', () => {
  const filas = [{ ...FILAS[0], telefono: '9698163581' }];
  const e = evaluarLlamadas(filas, llamadasReales(), 0, true);
  assert.equal(e.stats.telefonos_fuera_de_formato, 1);
  assert.equal(e.liberables.length, 1);
});

test('buscar_base: vista previa con cifras reales, identificador, cupos y código; no escribe nada', async () => {
  const t = crearDeps();
  const r = await handleBuscarBase(PARAMS, 'u1', t.deps);
  assert.equal(r.isError, undefined);
  const p = payload(r);
  assert.equal(p.puede_aplicarse, true);
  assert.equal(p.resultado.a_liberar, 5);
  assert.equal(p.identificador_nuevo, '2026-11-10 DIN-5');
  assert.equal(p.efecto_al_confirmar.cupos_que_se_crean, 39);
  assert.match(p.codigo_confirmacion, /^\d+\.[0-9a-f]{32}$/);
  assert.equal(p.muestra[0].billsec, 'sin registro');
  assert.equal(t.escrituras.length, 0);
  assert.equal(t.transacciones(), 0);
  assert.deepEqual(t.consultasAsterisk[0].length, 12);
});

test('aplicar_base (normal): libera los 5, crea cupos con el id de banco y el identificador, en una transacción', async () => {
  const t = crearDeps();
  const codigo = payload(await handleBuscarBase(PARAMS, 'u1', t.deps)).codigo_confirmacion;
  const r = await handleAplicarBase({ ...PARAMS, codigo_confirmacion: codigo }, 'u1', t.deps);
  const p = payload(r);
  assert.equal(p.aplicado, true);
  assert.equal(p.registros_liberados, 5);
  assert.equal(p.cupos_creados, 39);
  assert.equal(t.transacciones(), 1);
  assert.equal(t.escrituras.length, 2);
  assert.equal(t.escrituras[0].sql, sqlLiberar(5));
  assert.deepEqual(t.escrituras[0].values, ['2026-11-10 DIN-5', 2, 918520, 918521, 918522, 918523, 918524]);
  // los "Anterior" se guardan ANTES de poner asignado=0 / estado=0 (el orden importa en MySQL)
  assert.match(t.escrituras[0].sql, /^UPDATE notas_registros SET asignadoAnterior=asignado, estadoAnterior=estado, identificadorAnterior=identificador, observacionesAnterior=observaciones, fechaAsignadoAnterior=fecha_asignacion, asignado=0, estado=0, observaciones='', identificador=\? WHERE/);
  assert.equal(t.escrituras[1].sql, SQL_CUPOS_INSERT);
  assert.deepEqual(t.escrituras[1].values, [2, '2026-11-10 DIN-5']);
  assert.match(SQL_CUPOS_INSERT, /SELECT id_usuario, \?, \?, 0 FROM usuarios WHERE \(tipo=6\) AND \(estado=0\)/);
});

test('aplicar_base (predictivo): desmarca los predictivos, marca estos y NO crea cupos', async () => {
  const t = crearDeps();
  const pr = { ...PARAMS, para_predictivo: true };
  const prev = payload(await handleBuscarBase(pr, 'u1', t.deps));
  assert.equal(prev.identificador_nuevo, '2026-11-10 DIN-PREDICTIVO');
  assert.equal(prev.efecto_al_confirmar.predictivos_actuales_que_se_desmarcan, 761);
  const p = payload(await handleAplicarBase({ ...pr, codigo_confirmacion: prev.codigo_confirmacion }, 'u1', t.deps));
  assert.equal(p.aplicado, true);
  assert.equal(p.predictivos_desmarcados, 761);
  assert.deepEqual(t.escrituras.map((e) => e.sql), [SQL_PREDICTIVO_LIMPIAR, sqlPredictivo(5)]);
  assert.match(sqlPredictivo(1), /identificador=\?, predictivo=1, intentos_predictivo=0, codigo_predictivo=0 WHERE/);
});

test('aplicar_base con nombre del usuario: respeta el nombre', async () => {
  const t = crearDeps();
  const pr = { ...PARAMS, nombre_identificador: '2026-11-10 DIN-FUERTE' };
  const prev = payload(await handleBuscarBase(pr, 'u1', t.deps));
  assert.equal(prev.identificador_nuevo, '2026-11-10 DIN-FUERTE');
  await handleAplicarBase({ ...pr, codigo_confirmacion: prev.codigo_confirmacion }, 'u1', t.deps);
  assert.equal(t.escrituras[0].values[0], '2026-11-10 DIN-FUERTE');
});

test('aplicar_base no escribe con código incorrecto, de otro usuario, vencido o con parámetros distintos', async () => {
  const t = crearDeps();
  const codigo = payload(await handleBuscarBase(PARAMS, 'u1', t.deps)).codigo_confirmacion;
  const intentos = [
    handleAplicarBase({ ...PARAMS, codigo_confirmacion: 'basura-basura' }, 'u1', t.deps),
    handleAplicarBase({ ...PARAMS, codigo_confirmacion: codigo }, 'otro-usuario', t.deps),
    handleAplicarBase({ ...PARAMS, billsec_max: 20, codigo_confirmacion: codigo }, 'u1', t.deps),
    handleAplicarBase({ ...PARAMS, codigo_confirmacion: codigo }, 'u1', { ...t.deps, ahora: () => new Date(NOW.getTime() + 31 * 60_000) })
  ];
  for (const r of await Promise.all(intentos)) {
    const p = payload(r);
    assert.equal(p.aplicado, false);
    assert.ok(p.motivo);
  }
  assert.equal(t.escrituras.length, 0);
  assert.equal(t.transacciones(), 0);
});

test('aplicar_base no escribe si los datos cambiaron desde la vista previa', async () => {
  const t = crearDeps();
  const codigo = payload(await handleBuscarBase(PARAMS, 'u1', t.deps)).codigo_confirmacion;
  const cambiado = crearDeps({ filas: FILAS.slice(0, 11) }); // un contacto menos
  const p = payload(await handleAplicarBase({ ...PARAMS, codigo_confirmacion: codigo }, 'u1', cambiado.deps));
  assert.equal(p.aplicado, false);
  assert.match(p.motivo, /cambiaron/);
  assert.equal(cambiado.escrituras.length, 0);
});

test('si ya existen cupos para ese identificador, no hay código ni se aplica (evita duplicar)', async () => {
  const t = crearDeps({ cupos: 39 });
  const p = payload(await handleBuscarBase(PARAMS, 'u1', t.deps));
  assert.equal(p.puede_aplicarse, false);
  assert.equal(p.codigo_confirmacion, undefined);
  assert.match(p.bloqueos[0], /duplicaría/);
  const a = payload(await handleAplicarBase({ ...PARAMS, codigo_confirmacion: '1790000000.' + 'a'.repeat(32) }, 'u1', t.deps));
  assert.equal(a.aplicado, false);
  assert.equal(t.escrituras.length, 0);
});

test('si la transacción falla se informa y no se confirma nada; si Asterisk falla no se escribe', async () => {
  const t = crearDeps();
  const codigo = payload(await handleBuscarBase(PARAMS, 'u1', t.deps)).codigo_confirmacion;
  const r = await handleAplicarBase({ ...PARAMS, codigo_confirmacion: codigo }, 'u1', {
    ...t.deps, transaccion: async () => { throw new Error('Deadlock'); }
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /se revirtió/);
  const sinAsterisk = await handleBuscarBase(PARAMS, 'u1', { ...t.deps, llamadas: async () => { throw new Error('No se pudo conectar con el servicio de Asterisk'); } });
  assert.equal(sinAsterisk.isError, true);
  assert.match(sinAsterisk.content[0].text, /Asterisk/);
});

test('demasiados registros: se pide acortar el rango', async () => {
  const r = await handleBuscarBase(PARAMS, 'u1', crearDeps({ maxFilas: true }).deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Acorte/);
});

test('encerar_cupos: primero vista previa; solo con el código se ejecuta UPDATE ... SET cupo=0', async () => {
  const t = crearDeps();
  const prev = payload(await handleEncerarCupos({}, 'u1', t.deps));
  assert.equal(prev.estado_actual.con_cupo, 120);
  assert.equal(t.escrituras.length, 0);
  const mal = await handleEncerarCupos({ codigo_confirmacion: 'x'.repeat(20) }, 'u1', t.deps);
  assert.equal(mal.isError, true);
  assert.equal(t.escrituras.length, 0);
  const ok = payload(await handleEncerarCupos({ codigo_confirmacion: prev.codigo_confirmacion }, 'u1', t.deps));
  assert.equal(ok.aplicado, true);
  assert.deepEqual(t.escrituras.map((e) => e.sql), [SQL_ENCERAR_CUPOS]);
  assert.equal(SQL_ENCERAR_CUPOS, 'UPDATE notas_registros_cupos SET cupo=0');
});

test('código de confirmación: vigente 30 minutos y ligado a los datos', () => {
  const firma = { a: 1 };
  const { codigo } = generarCodigo(SECRETO, firma, NOW.getTime());
  assert.equal(validarCodigo(SECRETO, firma, codigo, NOW.getTime() + 29 * 60_000).ok, true);
  assert.equal(validarCodigo(SECRETO, firma, codigo, NOW.getTime() + 31 * 60_000).ok, false);
  assert.equal(validarCodigo(SECRETO, { a: 2 }, codigo, NOW.getTime()).ok, false);
  assert.equal(validarCodigo('otro'.repeat(10), firma, codigo, NOW.getTime()).ok, false);
});

test('cliente de Asterisk: envía lotes con token, devuelve números y falla con mensaje claro', async () => {
  process.env.ASTERISK_API_URL = 'https://bases.mvevip.com/';
  process.env.ASTERISK_API_TOKEN = 't'.repeat(40);
  const pedidos: any[] = [];
  const falso = (async (url: string, init: any) => {
    pedidos.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ registros: [{ dst: '0969816358', llamadas: 7, duracion: 1249, billsec: 1132, ultima_llamada: '2026-11-05 18:04:00' }] }) };
  }) as unknown as typeof fetch;
  const tels = Array.from({ length: 2500 }, (_, i) => `0${900000000 + i}`);
  const m = await consultarLlamadas(tels, '2026-01-01', '2026-11-10', falso);
  assert.equal(pedidos.length, 2); // lotes de 2000
  assert.equal(pedidos[0].url, 'https://bases.mvevip.com/cdr/resumen');
  assert.equal(pedidos[0].auth, `Bearer ${'t'.repeat(40)}`);
  assert.equal(m.get('0969816358')?.billsec, 1132);
  const malo = (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(consultarLlamadas(['0969816358'], '2026-01-01', '2026-11-10', malo), /error 502/);
  const caido = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
  await assert.rejects(consultarLlamadas(['0969816358'], '2026-01-01', '2026-11-10', caido), /No se pudo conectar/);
  delete process.env.ASTERISK_API_TOKEN;
  await assert.rejects(consultarLlamadas(['0969816358'], '2026-01-01', '2026-11-10', falso), /no está configurada/);
});
