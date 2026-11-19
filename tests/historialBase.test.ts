import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HistorialDeps, buildContactosQuery, buildHistorialPorContactos, buildHistorialPorLote, buildLotesQuery, handleHistorialBase
} from '../src/mcp/tools/historialBaseTool';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const NOW = new Date('2026-11-10T17:00:00Z');
const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(/```json\n([\s\S]*)\n```/.exec(r.content[0].text)![1]);

test('todas las consultas del historial son de solo lectura válidas y con valores enlazados', () => {
  const consultas = [
    buildContactosQuery({ id_lista: 918520, telefono: '0962118477', documento: 'X' }),
    buildHistorialPorContactos([918520, 918521], 50),
    buildHistorialPorLote(7, 100),
    buildLotesQuery({ mes: 11, anio: 2026, banco: 2 }, 30, NOW),
    buildLotesQuery({}, 30, NOW)
  ];
  for (const q of consultas) assert.doesNotThrow(() => validateReadOnlySql(q.sql), q.sql);
  assert.deepEqual(buildContactosQuery({ telefono: '0962118477' }).values, ['0962118477']);
  assert.deepEqual(buildLotesQuery({ mes: 11, anio: 2026, banco: 2 }, 30, NOW).values, ['2026-11-01 00:00:00', '2026-12-01 00:00:00', 2]);
});

function deps(rutas: Array<[RegExp, any[]]>, truncated = false): HistorialDeps & { sqls: string[] } {
  const sqls: string[] = [];
  return {
    sqls,
    consultar: async (sql) => {
      sqls.push(sql);
      const r = rutas.find(([re]) => re.test(sql));
      if (!r) throw new Error(`consulta no prevista: ${sql}`);
      return { rows: r[1], truncated };
    }
  };
}

test('por contacto: muestra de quién era, en qué base/estado estaba, cuándo se liberó y quién lo hizo', async () => {
  const d = deps([
    [/FROM notas_registros R/, [{ id_lista: 918520, nombres: 'X', telefono: '0962118477', documento: '1', banco: 2, identificador_actual: '2026-11-10 DIN-5', estado_actual: 'Sin Contactar', asignado_actual: 0, asesor_actual: null }]],
    [/FROM mcp_base_historial H/, [
      { id_historial: 2, id_lote: 9, fecha_liberacion: '2026-11-10 12:00:00', id_lista: 918520, asignado_anterior: 46, asesor_anterior: 'ANA PEREZ', estado_anterior: 'No interesado', identificador_anterior: '2026-11-04 DIN-1500', fecha_asignacion_anterior: '2026-11-05 09:10:00', observaciones_anterior: '', identificador_nuevo: '2026-11-10 DIN-5', accion: 'liberar', usuario_mcp: 'cmino' },
      { id_historial: 1, id_lote: 3, fecha_liberacion: '2026-10-01 10:00:00', id_lista: 918520, asignado_anterior: 0, asesor_anterior: null, estado_anterior: 'Sin Contactar', identificador_anterior: '2026-09-20 DIN-900', fecha_asignacion_anterior: null, observaciones_anterior: 'x', identificador_nuevo: '2026-10-01 DIN-100', accion: 'liberar', usuario_mcp: 'dproano' }
    ]]
  ]);
  const p = payload(await handleHistorialBase({ telefono: '0962118477' }, d, NOW));
  const c = p.contactos[0];
  assert.equal(c.situacion_actual.asesor, 'sin asignar');
  assert.equal(c.liberaciones.length, 2);
  assert.deepEqual(
    [c.liberaciones[0].asesor_anterior, c.liberaciones[0].estado_anterior, c.liberaciones[0].identificador_anterior, c.liberaciones[0].identificador_nuevo, c.liberaciones[0].liberado_por],
    ['ANA PEREZ', 'No interesado', '2026-11-04 DIN-1500', '2026-11-10 DIN-5', 'cmino']
  );
  assert.equal(c.liberaciones[1].asesor_anterior, 'sin asignar');
});

test('contacto que no existe, lote que no existe y lista de lotes', async () => {
  const vacio = await handleHistorialBase({ id_lista: 1 }, deps([[/FROM notas_registros R/, []]]), NOW);
  assert.match(vacio.content[0].text, /No se encontró/);
  const sinLote = await handleHistorialBase({ id_lote: 99 }, deps([[/FROM mcp_base_lotes L/, []]]), NOW);
  assert.match(sinLote.content[0].text, /No existe el lote 99/);
  const lista = payload(await handleHistorialBase({}, deps([[/FROM mcp_base_lotes L/, [{ id_lote: 9, fecha_liberacion: '2026-11-10 12:00:00', usuario_mcp: 'cmino', accion: 'liberar', id_banco: 2, banco: 'DINERS', identificador_nuevo: '2026-11-10 DIN-5', cantidad: 5, cupos_creados: 39, predictivos_desmarcados: null, filtros: {} }]]]), NOW));
  assert.equal(lista.total_mostrado, 1);
  assert.equal(lista.lotes[0].usuario_mcp, 'cmino');
});

test('detalle de un lote: datos del lote y sus contactos', async () => {
  const d = deps([
    [/FROM mcp_base_lotes L/, [{ id_lote: 9, identificador_nuevo: '2026-11-10 DIN-5', cantidad: 5 }]],
    [/FROM mcp_base_historial H/, [{ id_historial: 1, id_lote: 9, fecha_liberacion: '2026-11-10 12:00:00', id_lista: 918520, asignado_anterior: 46, asesor_anterior: 'ANA PEREZ', estado_anterior: 'Apagado' }]]
  ]);
  const p = payload(await handleHistorialBase({ id_lote: 9 }, d, NOW));
  assert.equal(p.lote.id_lote, 9);
  assert.equal(p.contactos[0].asesor_anterior, 'ANA PEREZ');
});

test('si las tablas no existen o falla la consulta se informa el error', async () => {
  const r = await handleHistorialBase({}, { consultar: async () => { throw new Error("Table 'mcp_base_lotes' doesn't exist"); } }, NOW);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /doesn't exist/);
});
