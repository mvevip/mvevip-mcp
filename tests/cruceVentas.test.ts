import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Hallazgo,
  aplicarRespaldoPorDocumento,
  buildCruceQueries,
  notasPorDocumentoSql,
  resumir
} from '../src/mcp/tools/cruceVentasTool';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const NOW = new Date('2026-10-30T17:00:00Z');

test('consultas: por fecha de venta, sin anuladas, solo lectura y con filtro de asesor enlazado', () => {
  const q = buildCruceQueries({ mes: 10, anio: 2026 }, NOW);
  validateReadOnlySql(q.hallazgosSql);
  validateReadOnlySql(q.totalesPorAsesorSql);
  assert.match(q.hallazgosSql, /R\.fecha_venta >= '2026-10-01' AND R\.fecha_venta < '2026-11-01'/);
  assert.match(q.hallazgosSql, /R\.estado NOT IN \(9, 13\)/);
  assert.match(q.hallazgosSql, /R\.tipo IN \(2, 22\)/);
  assert.match(q.hallazgosSql, /N\.id_lista = R\.id_lista AND R\.id_lista > 0/);
  assert.deepEqual(q.values, []);

  const f = buildCruceQueries({ asesor: "x'; DROP TABLE registros; --%_" }, NOW);
  validateReadOnlySql(f.hallazgosSql);
  assert.doesNotMatch(f.hallazgosSql, /DROP/);
  assert.equal(f.values.length, 1);
  assert.match(f.values[0], /^%x'; DROP TABLE registros; --\\%\\_%$/);
  assert.deepEqual(buildCruceQueries({ fecha_desde: '2026-10-05', fecha_hasta: '2026-10-05' }, NOW).hastaExclusivo, '2026-10-06');
  assert.throws(() => buildCruceQueries({ fecha_desde: "2026-10-01'; --" }, NOW), /formato/);
});

test('consulta de respaldo por documento: solo valores enlazados', () => {
  const sql = notasPorDocumentoSql(3);
  validateReadOnlySql(sql);
  assert.match(sql, /N\.documento IN \(\?, \?, \?\)/);
});

const hallazgo = (over: Partial<Hallazgo>): Hallazgo => ({
  id_registro: 1, asesor: 'ANA', asesor_id: 46, documento: '1750799833', id_lista: null, nota_id: null,
  nota_asignado_id: null, nota_asignado_a: null, nota_fecha_asignacion: null, regla1: 'SIN_NOTA', regla2: 'NO_ES_CUOTA', ...over
});
const nota = (id: number, asignado: number, fecha: string | null) =>
  ({ id_lista: id, documento: '1750799833', asignado, asignado_a: `USR ${asignado}`, fecha_asignacion: fecha });

test('respaldo por documento: toma la última asignación y avisa si hay varios asesores', () => {
  // venta 25783: asesor 46 y nota asignada a 46 -> OK
  assert.equal(aplicarRespaldoPorDocumento(hallazgo({}), [nota(923016, 46, '2026-11-06 16:37')]).regla1, 'OK');
  // varias notas: gana la más reciente, con observación
  const varias = aplicarRespaldoPorDocumento(hallazgo({}), [nota(1, 46, '2026-10-01 10:00'), nota(2, 99, '2026-10-20 09:00')]);
  assert.equal(varias.regla1, 'CRUCE_CONTACTO');
  assert.equal(varias.nota_asignado_id, 99);
  assert.equal(varias.origen_nota, 'documento');
  assert.match(varias.observacion!, /2 notas y 2 asesores distintos/);
  // la última asignación es del propio asesor: OK aunque haya una vieja de otro
  const propia = aplicarRespaldoPorDocumento(hallazgo({}), [nota(1, 99, '2026-09-01 10:00'), nota(2, 46, '2026-10-20 09:00')]);
  assert.equal(propia.regla1, 'OK');
  assert.ok(propia.observacion);
  // notas sin asesor
  assert.equal(aplicarRespaldoPorDocumento(hallazgo({}), [nota(1, 0, null)]).regla1, 'NOTA_SIN_ASIGNAR');
  // sin notas por documento o ya resuelta por id_lista: no cambia
  assert.equal(aplicarRespaldoPorDocumento(hallazgo({}), []).regla1, 'SIN_NOTA');
  assert.equal(aplicarRespaldoPorDocumento(hallazgo({ regla1: 'CRUCE_CONTACTO' }), [nota(1, 46, null)]).regla1, 'CRUCE_CONTACTO');
});

test('cifras reales de octubre 2026 (448 ventas, solo id_lista): cruces de contacto 5, de cuota 13, sin nota 111', () => {
  const distribucion: Array<[Hallazgo['regla1'], Hallazgo['regla2'], number]> = [
    ['SIN_NOTA', 'NO_ES_CUOTA', 108], ['OK', 'NO_ES_CUOTA', 256], ['OK', 'CUOTA_OK', 62], ['CRUCE_CONTACTO', 'NO_ES_CUOTA', 4],
    ['OK', 'CRUCE_CUOTA', 12], ['SIN_NOTA', 'CUOTA_OK', 2], ['SIN_NOTA', 'CRUCE_CUOTA', 1], ['NOTA_SIN_ASIGNAR', 'NO_ES_CUOTA', 2],
    ['CRUCE_CONTACTO', 'CUOTA_OK', 1]
  ];
  const hallazgos: Hallazgo[] = [];
  for (const [r1, r2, n] of distribucion) {
    for (let i = 0; i < n; i++) hallazgos.push(hallazgo({ regla1: r1, regla2: r2 }));
  }
  const soloHallazgos = hallazgos.filter((h) => !(h.regla1 === 'OK' && (h.regla2 === 'NO_ES_CUOTA' || h.regla2 === 'CUOTA_OK')));
  assert.equal(soloHallazgos.length, 130); // 448 - 256 - 62
  const { totales, por_asesor } = resumir([{ asesor: 'ANA', ventas: 448 }], soloHallazgos);
  assert.equal(totales.ventas, 448);
  assert.equal(totales.sin_hallazgos, 318);
  assert.equal(totales.cruces_contacto, 5);
  assert.equal(totales.cruces_cuota, 13);
  assert.equal(totales.sin_nota, 111);
  assert.equal(totales.nota_sin_asignar, 2);
  assert.equal(por_asesor.length, 1);
});

test('resumen por asesor: un hallazgo resuelto por el respaldo cuenta como sin hallazgos', () => {
  const resuelto = aplicarRespaldoPorDocumento(hallazgo({ asesor: 'ANA' }), [nota(7, 46, '2026-11-06 16:37')]);
  const cruce = hallazgo({ asesor: 'LUIS', asesor_id: 5, regla1: 'CRUCE_CONTACTO', regla2: 'CRUCE_CUOTA' });
  const out = resumir([{ asesor: 'ANA', ventas: 3 }, { asesor: 'LUIS', ventas: 2 }], [resuelto, cruce].filter((h) => h.regla1 !== 'OK' || h.regla2 === 'CRUCE_CUOTA'));
  assert.equal(out.por_asesor[0].asesor, 'LUIS'); // más cruces primero
  assert.deepEqual([out.por_asesor[0].cruces_contacto, out.por_asesor[0].cruces_cuota, out.por_asesor[0].sin_hallazgos], [1, 1, 1]);
  assert.equal(out.por_asesor[1].sin_hallazgos, 3);
});
