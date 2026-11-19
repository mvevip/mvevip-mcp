import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseDeps } from '../src/mcp/tools/baseTool';
import {
  CUPO_MAXIMO_POR_ASESOR, SQL_BANCOS_DEL_IDENTIFICADOR, SQL_BANCOS_DEL_IDENTIFICADOR_EN_BANCO, SQL_CONTACTOS_LIBRES, SQL_CUPO_FILAS, SQL_CUPO_INSERT,
  SQL_CUPO_UPDATE, SQL_IDENTIFICADORES_RECIENTES, calcularCupoNuevo, handleAsignarBaseUsuario, handleEncerarCupoUsuario
} from '../src/mcp/tools/cuposTool';

const NOW = new Date('2026-11-19T15:00:00Z');
const VIS = '2026-11-17 VIS-1244';
const CARP = '2026-11-12 CARPETAS-2';

interface Fila { id_cupo: number; id_usuario: number; id_banco: number; id_identificador: string; cupo: number; total_asignado: number }
// Cifras reales (consulta del 19-nov): 250 = 85 de cupo / 77 entregados; 248 = 145/145 (agotó); 338 en CARPETAS-2 = 0/6 (enceró después de recibir 6)
const cuposIniciales = (): Fila[] => [
  { id_cupo: 80272, id_usuario: 250, id_banco: 2, id_identificador: VIS, cupo: 85, total_asignado: 77 },
  { id_cupo: 80270, id_usuario: 248, id_banco: 2, id_identificador: VIS, cupo: 145, total_asignado: 145 },
  { id_cupo: 80268, id_usuario: 185, id_banco: 2, id_identificador: VIS, cupo: 1, total_asignado: 1 },
  { id_cupo: 80339, id_usuario: 338, id_banco: 1001, id_identificador: CARP, cupo: 0, total_asignado: 6 },
  { id_cupo: 80335, id_usuario: 250, id_banco: 1001, id_identificador: CARP, cupo: 100, total_asignado: 0 },
  { id_cupo: 80331, id_usuario: 185, id_banco: 1001, id_identificador: CARP, cupo: 1, total_asignado: 1 }
];
const USUARIOS = [
  { id_usuario: 248, nombres: 'ALAYON JOSE', estado: 0 },
  { id_usuario: 250, nombres: 'MARTINEZ PAOLA', estado: 0 },
  { id_usuario: 249, nombres: 'MARTINEZ NATALIA', estado: 0 },
  { id_usuario: 185, nombres: 'VENDEDOR 21', estado: 0 },
  { id_usuario: 338, nombres: 'ONTANEDA SAMANIEGO SAMANTHA NAYELLI', estado: 0 },
  { id_usuario: 15, nombres: 'CEVALLOS ERIKA ', estado: 0 },
  { id_usuario: 99, nombres: 'EX ASESOR', estado: 1 }
];

interface Opciones { cupos?: Fila[]; libres?: number | 'falla'; affectedExtra?: number }
function crear(op: Opciones = {}) {
  const cupos = op.cupos ?? cuposIniciales();
  const escrituras: Array<{ sql: string; values: Array<string | number> }> = [];
  let transacciones = 0;
  const identificadores = () => [...new Set(cupos.map((f) => `${f.id_banco}|${f.id_identificador}`))].map((k) => ({ id_banco: Number(k.split('|')[0]), id_identificador: k.split('|')[1] }));
  const deps: BaseDeps = {
    consultar: async (sql, values = []) => {
      if (sql === SQL_IDENTIFICADORES_RECIENTES) return { rows: identificadores(), truncated: false };
      if (sql === SQL_BANCOS_DEL_IDENTIFICADOR) return { rows: identificadores().filter((i) => i.id_identificador.toLowerCase() === String(values[0]).toLowerCase()), truncated: false };
      if (sql === SQL_BANCOS_DEL_IDENTIFICADOR_EN_BANCO) return { rows: identificadores().filter((i) => i.id_identificador.toLowerCase() === String(values[0]).toLowerCase() && i.id_banco === values[1]), truncated: false };
      if (/FROM usuarios WHERE tipo = 6/.test(sql)) {
        const soloActivos = / AND estado = 0 /.test(sql);
        let lista = USUARIOS.filter((u) => !soloActivos || u.estado === 0);
        if (/id_usuario = \?/.test(sql)) lista = lista.filter((u) => u.id_usuario === values[0]);
        else for (const v of values) lista = lista.filter((u) => u.nombres.toLowerCase().includes(String(v).replace(/%/g, '').toLowerCase()));
        return { rows: [...lista].sort((a, b) => a.nombres.localeCompare(b.nombres)), truncated: false };
      }
      if (/SELECT id_cupo, id_usuario, cupo, total_asignado/.test(sql)) {
        const [banco, ident, ...ids] = values;
        return { rows: cupos.filter((f) => f.id_banco === banco && f.id_identificador === ident && ids.includes(f.id_usuario)), truncated: false };
      }
      if (sql === SQL_CONTACTOS_LIBRES) {
        if (op.libres === 'falla') throw new Error('timeout');
        return { rows: [{ n: op.libres ?? 500 }], truncated: false };
      }
      if (/WHERE cupo > 0 AND id_usuario IN/.test(sql)) {
        const conIdent = /AND id_banco = \? AND id_identificador = \?/.test(sql);
        const ids = (conIdent ? values.slice(0, -2) : values) as number[];
        return { rows: cupos.filter((f) => f.cupo > 0 && ids.includes(f.id_usuario) && (!conIdent || (f.id_banco === values[values.length - 2] && f.id_identificador === values[values.length - 1]))), truncated: false };
      }
      throw new Error(`consulta no prevista: ${sql}`);
    },
    llamadas: async () => new Map(),
    transaccion: async (fn) => {
      transacciones++;
      return fn({
        ejecutar: async (sql, values = []) => {
          escrituras.push({ sql, values });
          if (sql === SQL_CUPO_INSERT) return { affectedRows: 1 };
          if (sql === SQL_CUPO_UPDATE) return { affectedRows: 1 };
          const conIdent = /id_banco = \? AND id_identificador = \?/.test(sql);
          const ids = (conIdent ? values.slice(0, -2) : values) as number[];
          return { affectedRows: cupos.filter((f) => f.cupo > 0 && ids.includes(f.id_usuario)).length + (op.affectedExtra ?? 0) };
        },
        consultar: async (sql, values = []) => {
          if (sql === SQL_CUPO_FILAS) return [{ n: cupos.filter((f) => f.id_usuario === values[0] && f.id_banco === values[1] && f.id_identificador === values[2]).length }];
          if (/FROM usuarios WHERE tipo = 6 AND estado = 0/.test(sql)) return [{ n: USUARIOS.filter((u) => u.estado === 0 && values.includes(u.id_usuario)).length }];
          throw new Error(`consulta de transacción no prevista: ${sql}`);
        }
      });
    },
    ahora: () => NOW,
    secreto: () => 'secreto-de-prueba-secreto-de-prueba',
    log: () => undefined
  };
  return { deps, escrituras, transacciones: () => transacciones };
}
const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(/```json\n([\s\S]*)\n```/.exec(r.content[0].text)![1]);

// ---------------------------------------------------------------------------
test('calcularCupoNuevo: sumar parte del mayor entre cupo y entregado; fijar deja el número', () => {
  assert.equal(calcularCupoNuevo('sumar', 85, 77, 10), 95); // le quedaban datos: se suma al cupo
  assert.equal(calcularCupoNuevo('sumar', 145, 145, 10), 155); // agotó todo
  assert.equal(calcularCupoNuevo('sumar', 0, 6, 10), 16); // enceró después de recibir 6: llegan 10 nuevos
  assert.equal(calcularCupoNuevo('sumar', 0, 0, 20), 20);
  assert.equal(calcularCupoNuevo('fijar', 85, 77, 30), 30);
});

test('asignar: sin identificador no asume nada, devuelve los recientes y no escribe', async () => {
  const t = crear();
  const r = await handleAsignarBaseUsuario({ usuarios: [{ usuario: 'VENDEDOR 21', cupo: 20 }] }, 'u1', t.deps);
  assert.ok(!r.isError);
  const p = payload(r);
  assert.equal(p.falta, 'identificador');
  assert.ok(p.identificadores_recientes.length >= 2);
  assert.equal(t.transacciones(), 0);
  const vacio = await handleAsignarBaseUsuario({ identificador: '   ', usuarios: [{ usuario: 'VENDEDOR 21', cupo: 20 }] }, 'u1', t.deps);
  assert.equal(payload(vacio).falta, 'identificador');
});

test('asignar: sin asesores pide los asesores', async () => {
  const t = crear();
  const r = await handleAsignarBaseUsuario({ identificador: VIS, cupo: 20 }, 'u1', t.deps);
  assert.equal(payload(r).falta, 'usuarios');
  assert.equal(t.transacciones(), 0);
});

test('asignar (cifras reales): sumar 10 a 250 (85/77) = 95; a 248 (145/145) = 155; a 185 (1/1) = 11', async () => {
  const t = crear();
  const r = await handleAsignarBaseUsuario({ identificador: VIS, usuarios: [{ usuario: 250 }, { usuario: 'alayon jose' }, { usuario: 'VENDEDOR 21' }], cupo: 10 }, 'u1', t.deps);
  const p = payload(r);
  assert.equal(p.modo, 'sumar');
  assert.equal(p.puede_aplicarse, true);
  assert.equal(t.transacciones(), 0, 'la vista previa no escribe');
  const por = Object.fromEntries(p.asesores.map((a: any) => [a.id_usuario, a]));
  assert.deepEqual([por[250].cupo_actual, por[250].entregado, por[250].pendiente_actual, por[250].cupo_nuevo, por[250].pendiente_nuevo], [85, 77, 8, 95, 18]);
  assert.deepEqual([por[248].cupo_actual, por[248].cupo_nuevo, por[248].pendiente_nuevo], [145, 155, 10]);
  assert.deepEqual([por[185].cupo_nuevo, por[185].pendiente_nuevo], [11, 10]);
  assert.match(p.codigo_confirmacion, /^\d+\.[0-9a-f]{32}$/);
});

test('asignar (cifras reales): tras encerar con 6 entregados (338: 0/6), sumar 10 deja el cupo en 16', async () => {
  const t = crear();
  const p = payload(await handleAsignarBaseUsuario({ identificador: CARP, usuarios: [{ usuario: 338, cupo: 10 }] }, 'u1', t.deps));
  assert.equal(p.banco, 1001);
  assert.deepEqual([p.asesores[0].cupo_actual, p.asesores[0].entregado, p.asesores[0].cupo_nuevo, p.asesores[0].pendiente_nuevo], [0, 6, 16, 10]);
});

test('asignar: modo fijar y sus advertencias', async () => {
  const t = crear();
  const p = payload(await handleAsignarBaseUsuario({ identificador: VIS, usuarios: [{ usuario: 250, cupo: 50 }], modo: 'fijar' }, 'u1', t.deps));
  assert.equal(p.asesores[0].cupo_nuevo, 50);
  assert.equal(p.asesores[0].pendiente_nuevo, 0);
  assert.ok(p.advertencias.some((a: string) => /baja de 85 a 50/.test(a)));
  assert.ok(p.advertencias.some((a: string) => /no le llegará nada más/.test(a)));
});

test('asignar: advierte (no bloquea) si se piden más datos que contactos libres, o si no se pudo contar', async () => {
  const t = crear({ libres: 25 });
  const p = payload(await handleAsignarBaseUsuario({ identificador: VIS, usuarios: [{ usuario: 250 }, { usuario: 248 }], cupo: 20 }, 'u1', t.deps));
  assert.equal(p.puede_aplicarse, true);
  assert.equal(p.contactos_libres_en_la_base, 25);
  assert.ok(p.advertencias.some((a: string) => /Se piden 40 datos .* 25 contactos libres/.test(a)));
  const f = payload(await handleAsignarBaseUsuario({ identificador: VIS, usuarios: [{ usuario: 250 }], cupo: 5 }, 'u1', crear({ libres: 'falla' }).deps));
  assert.equal(f.puede_aplicarse, true);
  assert.ok(f.advertencias.some((a: string) => /No se pudo contar/.test(a)));
});

test('asignar: validaciones (identificador, banco, usuario ambiguo/inactivo, cupo)', async () => {
  const t = crear();
  const err = async (p: any) => (await handleAsignarBaseUsuario(p, 'u1', t.deps)).content[0].text;
  assert.match(await err({ identificador: 'NO EXISTE', usuarios: [{ usuario: 250, cupo: 5 }] }), /No existe el identificador "NO EXISTE".*más recientes/);
  assert.match(await err({ identificador: VIS, banco: 1001, usuarios: [{ usuario: 250, cupo: 5 }] }), /No existe el identificador .* en el banco 1001/);
  assert.match(await err({ identificador: VIS, usuarios: [{ usuario: 'martinez', cupo: 5 }] }), /coincide con varios asesores: .*MARTINEZ NATALIA \(id 249\).*MARTINEZ PAOLA \(id 250\)/);
  assert.match(await err({ identificador: VIS, usuarios: [{ usuario: 'EX ASESOR', cupo: 5 }] }), /No encontré al usuario "EX ASESOR".*activos/);
  assert.match(await err({ identificador: VIS, usuarios: [{ usuario: 'nadie', cupo: 5 }] }), /No encontré al usuario/);
  assert.match(await err({ identificador: VIS, usuarios: [{ usuario: 250 }] }), /Falta la cantidad/);
  assert.match(await err({ identificador: VIS, usuarios: [{ usuario: 250, cupo: CUPO_MAXIMO_POR_ASESOR + 1 }] }), /entre 1 y 500/);
  assert.match(await err({ identificador: VIS, usuarios: [{ usuario: 250, cupo: 0 }] }), /entre 1 y 500/);
  assert.match(await err({ identificador: VIS, usuarios: [{ usuario: 250, cupo: 5 }, { usuario: 'MARTINEZ PAOLA', cupo: 5 }] }), /repetido/);
  assert.equal(t.transacciones(), 0);
  // el espacio final del nombre en la base no estorba y la búsqueda por una palabra funciona
  const p = payload(await handleAsignarBaseUsuario({ identificador: VIS, usuarios: [{ usuario: 'erika', cupo: 5 }] }, 'u1', t.deps));
  assert.equal(p.asesores[0].asesor, 'CEVALLOS ERIKA');
  assert.equal(p.asesores[0].existe_fila, false);
});

test('asignar: identificador en varios bancos exige el banco', async () => {
  const cupos = [...cuposIniciales(), { id_cupo: 1, id_usuario: 250, id_banco: 4, id_identificador: VIS, cupo: 0, total_asignado: 0 }];
  const t = crear({ cupos });
  const r = await handleAsignarBaseUsuario({ identificador: VIS, usuarios: [{ usuario: 250, cupo: 5 }] }, 'u1', t.deps);
  assert.match(r.content[0].text, /existe en varios bancos \(2, 4\)\. Indique el banco/);
  const ok = payload(await handleAsignarBaseUsuario({ identificador: VIS, banco: 4, usuarios: [{ usuario: 250, cupo: 5 }] }, 'u1', t.deps));
  assert.equal(ok.banco, 4);
});

test('asignar: dos pasos; actualiza con el cupo anterior como guarda y crea la fila que falta', async () => {
  const t = crear();
  const params = { identificador: VIS, usuarios: [{ usuario: 250 }, { usuario: 'erika' }], cupo: 10 };
  const codigo = payload(await handleAsignarBaseUsuario(params, 'u1', t.deps)).codigo_confirmacion;
  assert.equal(t.escrituras.length, 0);
  const r = await handleAsignarBaseUsuario({ ...params, codigo_confirmacion: codigo }, 'u1', t.deps);
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(t.transacciones(), 1);
  assert.deepEqual(t.escrituras, [
    { sql: SQL_CUPO_UPDATE, values: [95, 250, 2, VIS, 85] },
    { sql: SQL_CUPO_INSERT, values: [15, 2, VIS, 10] }
  ]);
  const p = payload(r);
  assert.equal(p.aplicado, true);
  assert.equal(p.filas_actualizadas, 1);
  assert.equal(p.filas_creadas, 1);
});

test('asignar: código inválido, de otro usuario, con otros parámetros, vencido o con datos que cambiaron: no escribe', async () => {
  const t = crear();
  const params = { identificador: VIS, usuarios: [{ usuario: 250, cupo: 10 }] };
  const codigo = payload(await handleAsignarBaseUsuario(params, 'u1', t.deps)).codigo_confirmacion;
  const resultados = await Promise.all([
    handleAsignarBaseUsuario({ ...params, codigo_confirmacion: 'basura-basura' }, 'u1', t.deps),
    handleAsignarBaseUsuario({ ...params, codigo_confirmacion: codigo }, 'otro', t.deps),
    handleAsignarBaseUsuario({ ...params, usuarios: [{ usuario: 250, cupo: 11 }], codigo_confirmacion: codigo }, 'u1', t.deps),
    handleAsignarBaseUsuario({ ...params, modo: 'fijar', codigo_confirmacion: codigo }, 'u1', t.deps),
    handleAsignarBaseUsuario({ ...params, codigo_confirmacion: codigo }, 'u1', { ...t.deps, ahora: () => new Date(NOW.getTime() + 31 * 60_000) })
  ]);
  for (const r of resultados) assert.equal(r.isError, true);
  const cambiado = crear({ cupos: cuposIniciales().map((f) => (f.id_usuario === 250 && f.id_banco === 2 ? { ...f, cupo: 90 } : f)) });
  const r = await handleAsignarBaseUsuario({ ...params, codigo_confirmacion: codigo }, 'u1', cambiado.deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /cambiaron desde la vista previa/);
  assert.equal(t.transacciones() + cambiado.transacciones(), 0);
});

test('asignar: lo que entrega el CRM entre la vista previa y la confirmación no invalida el código (si no cambia el cupo nuevo)', async () => {
  const t = crear();
  const params = { identificador: VIS, usuarios: [{ usuario: 250, cupo: 10 }] };
  const codigo = payload(await handleAsignarBaseUsuario(params, 'u1', t.deps)).codigo_confirmacion;
  const avanzo = crear({ cupos: cuposIniciales().map((f) => (f.id_usuario === 250 && f.id_banco === 2 ? { ...f, total_asignado: 80 } : f)) });
  const r = await handleAsignarBaseUsuario({ ...params, codigo_confirmacion: codigo }, 'u1', avanzo.deps);
  assert.ok(!r.isError, r.content[0].text);
});

test('asignar: filas de cupo duplicadas bloquean (sin código)', async () => {
  const cupos = [...cuposIniciales(), { id_cupo: 5, id_usuario: 250, id_banco: 2, id_identificador: VIS, cupo: 3, total_asignado: 0 }];
  const t = crear({ cupos });
  const p = payload(await handleAsignarBaseUsuario({ identificador: VIS, usuarios: [{ usuario: 250, cupo: 5 }] }, 'u1', t.deps));
  assert.equal(p.puede_aplicarse, false);
  assert.equal(p.codigo_confirmacion, undefined);
  assert.match(p.bloqueos[0], /2 filas de cupo duplicadas/);
  const r = await handleAsignarBaseUsuario({ identificador: VIS, usuarios: [{ usuario: 250, cupo: 5 }], codigo_confirmacion: '1790000000.' + 'a'.repeat(32) }, 'u1', t.deps);
  assert.equal(r.isError, true);
  assert.equal(t.transacciones(), 0);
});

test('asignar: si la fila cambió dentro de la transacción se revierte', async () => {
  const t = crear();
  const params = { identificador: VIS, usuarios: [{ usuario: 250, cupo: 10 }] };
  const codigo = payload(await handleAsignarBaseUsuario(params, 'u1', t.deps)).codigo_confirmacion;
  const original = t.deps.transaccion;
  const deps: BaseDeps = {
    ...t.deps,
    transaccion: (fn) => original((tx) => fn({ ...tx, ejecutar: async (sql, values) => (sql === SQL_CUPO_UPDATE ? { affectedRows: 0 } : tx.ejecutar(sql, values)) }))
  };
  const r = await handleAsignarBaseUsuario({ ...params, codigo_confirmacion: codigo }, 'u1', deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /cambió mientras se aplicaba/);
});

// ---------------------------------------------------------------------------
test('encerar por asesor: sin asesores pide el asesor y no toca nada', async () => {
  const t = crear();
  assert.equal(payload(await handleEncerarCupoUsuario({}, 'u1', t.deps)).falta, 'usuarios');
  assert.equal(t.transacciones(), 0);
});

test('encerar por asesor: vista previa con sus cupos y SOLO ese asesor (VENDEDOR 21 = id 185)', async () => {
  const t = crear();
  const p = payload(await handleEncerarCupoUsuario({ usuarios: ['VENDEDOR 21'] }, 'u1', t.deps));
  assert.equal(p.asesores.length, 1);
  assert.equal(p.asesores[0].id_usuario, 185);
  assert.equal(p.asesores[0].filas_con_cupo, 2);
  assert.equal(p.asesores[0].cupo_total, 2);
  assert.equal(p.filas_a_actualizar, 2);
  assert.match(p.efecto_al_confirmar, /SOLO a estos asesores/);
  assert.match(p.codigo_confirmacion, /^\d+\.[0-9a-f]{32}$/);
  assert.equal(t.transacciones(), 0);
});

test('encerar por asesor: confirmar actualiza solo a ese asesor (WHERE id_usuario IN) y no a toda la tabla', async () => {
  const t = crear();
  const params = { usuarios: [250 as string | number] };
  const codigo = payload(await handleEncerarCupoUsuario(params, 'u1', t.deps)).codigo_confirmacion;
  const r = await handleEncerarCupoUsuario({ ...params, codigo_confirmacion: codigo }, 'u1', t.deps);
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(t.escrituras.length, 1);
  assert.match(t.escrituras[0].sql, /^UPDATE notas_registros_cupos SET cupo = 0 WHERE cupo > 0 AND id_usuario IN \(\?\)$/);
  assert.deepEqual(t.escrituras[0].values, [250]);
  assert.equal(payload(r).filas_actualizadas, 2);
});

test('encerar por asesor: con identificador solo esa base; varios asesores; banco solo con identificador', async () => {
  const t = crear();
  const params = { usuarios: [250 as string | number, 'VENDEDOR 21'], identificador: VIS };
  const p = payload(await handleEncerarCupoUsuario(params, 'u1', t.deps));
  assert.deepEqual(p.asesores.map((a: any) => [a.id_usuario, a.filas_con_cupo]), [[250, 1], [185, 1]]);
  assert.match(p.efecto_al_confirmar, /SOLO en el identificador "2026-11-17 VIS-1244" \(banco 2\)/);
  await handleEncerarCupoUsuario({ ...params, codigo_confirmacion: p.codigo_confirmacion }, 'u1', t.deps);
  assert.match(t.escrituras[0].sql, /id_usuario IN \(\?,\?\) AND id_banco = \? AND id_identificador = \?$/);
  assert.deepEqual(t.escrituras[0].values, [250, 185, 2, VIS]);
  const e = await handleEncerarCupoUsuario({ usuarios: [250], banco: 2 }, 'u1', t.deps);
  assert.match(e.content[0].text, /banco solo se usa junto con un identificador/);
});

test('encerar por asesor: sin cupos que encerar no pide confirmación; nombre ambiguo y usuarios inactivos', async () => {
  const t = crear();
  const nada = await handleEncerarCupoUsuario({ usuarios: ['CEVALLOS'] }, 'u1', t.deps);
  assert.ok(!nada.isError);
  assert.match(nada.content[0].text, /No hay nada que encerar/);
  assert.equal(payload(nada).asesores[0].filas_con_cupo, 0);
  assert.doesNotMatch(nada.content[0].text, /codigo_confirmacion/);
  const amb = await handleEncerarCupoUsuario({ usuarios: ['martinez'] }, 'u1', t.deps);
  assert.match(amb.content[0].text, /coincide con varios asesores/);
  // un asesor inactivo sí se puede encerar (puede tener cupos pendientes)
  const inact = await handleEncerarCupoUsuario({ usuarios: ['EX ASESOR'] }, 'u1', t.deps);
  assert.ok(!inact.isError);
});

test('encerar por asesor: código malo o con datos cambiados no escribe; si las filas no coinciden se revierte', async () => {
  const t = crear();
  const params = { usuarios: [250 as string | number] };
  const codigo = payload(await handleEncerarCupoUsuario(params, 'u1', t.deps)).codigo_confirmacion;
  for (const r of await Promise.all([
    handleEncerarCupoUsuario({ ...params, codigo_confirmacion: 'basura-basura' }, 'u1', t.deps),
    handleEncerarCupoUsuario({ ...params, codigo_confirmacion: codigo }, 'otro', t.deps),
    handleEncerarCupoUsuario({ usuarios: [185], codigo_confirmacion: codigo }, 'u1', t.deps)
  ])) assert.equal(r.isError, true);
  const cambiado = crear({ cupos: cuposIniciales().map((f) => (f.id_usuario === 250 ? { ...f, cupo: f.cupo + 1 } : f)) });
  const c = await handleEncerarCupoUsuario({ ...params, codigo_confirmacion: codigo }, 'u1', cambiado.deps);
  assert.equal(c.isError, true);
  assert.equal(t.transacciones() + cambiado.transacciones(), 0);
  const desfase = crear({ affectedExtra: 1 });
  const d = await handleEncerarCupoUsuario({ ...params, codigo_confirmacion: codigo }, 'u1', desfase.deps);
  assert.equal(d.isError, true);
  assert.match(d.content[0].text, /se revirtió todo/);
});
