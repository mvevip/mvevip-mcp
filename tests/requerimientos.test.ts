import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequerimientosQueries,
  mergeRequerimientosByAsesor,
  requerimientosByAsesorSql,
  requerimientosTotalsSql,
  resolveRequerimientosRange,
  withRequerimientosTotals
} from '../src/mcp/tools/requerimientosTool';
import { buildSalesReportQueries } from '../src/mcp/tools/salesReportTool';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const NOW = new Date('2026-10-30T17:00:00Z');

test('período por fecha de ingreso: mes actual, mes dado y rango inclusivo', () => {
  assert.deepEqual(resolveRequerimientosRange({}, NOW), { desde: '2026-10-01', hastaExclusivo: '2026-11-01' });
  assert.deepEqual(resolveRequerimientosRange({ mes: 9, anio: 2026 }, NOW), { desde: '2026-09-01', hastaExclusivo: '2026-10-01' });
  assert.deepEqual(resolveRequerimientosRange({ fecha_desde: '2026-10-30', fecha_hasta: '2026-10-30' }, NOW), { desde: '2026-10-30', hastaExclusivo: '2026-10-31' });
  // una sola fecha = un solo día; el fin de mes y de año se resuelven bien
  assert.deepEqual(resolveRequerimientosRange({ fecha_hasta: '2026-12-31' }, NOW), { desde: '2026-12-31', hastaExclusivo: '2027-01-01' });
  assert.throws(() => resolveRequerimientosRange({ fecha_desde: '2026-10-30', fecha_hasta: '2026-10-01' }, NOW), /posterior/);
  assert.throws(() => resolveRequerimientosRange({ fecha_desde: "2026-10-01'; DROP TABLE x; --" }, NOW), /formato/);
  assert.throws(() => resolveRequerimientosRange({ mes: 13 }, NOW), /mes/);
});

test('consultas: filtran por fecha_requerimiento, no usan estado y pasan el guard de solo lectura', () => {
  const variants = [{}, { agrupar_por: 'asesor' as const }, { ordenar_por: 'valor', direccion: 'asc' as const }, { mes: 9, anio: 2026, agrupar_por: 'asesor' as const, ordenar_por: 'cantidad' }];
  for (const v of variants) {
    const q = buildRequerimientosQueries(v, NOW);
    validateReadOnlySql(q.detailSql);
    validateReadOnlySql(q.totalsSql);
    assert.match(q.detailSql, /R\.fecha_requerimiento >= '\d{4}-\d{2}-\d{2}' AND R\.fecha_requerimiento < '\d{4}-\d{2}-\d{2}'/);
    assert.doesNotMatch(q.detailSql, /estado/);
  }
  validateReadOnlySql(requerimientosTotalsSql('2026-10-01', '2026-11-01'));
  validateReadOnlySql(requerimientosByAsesorSql('2026-10-01', '2026-11-01'));
});

test('ordenamiento por lista cerrada', () => {
  assert.throws(() => buildRequerimientosQueries({ ordenar_por: 'valor; DROP TABLE requerimientos' }, NOW), /ordenar_por inválido/);
  assert.throws(() => buildRequerimientosQueries({ agrupar_por: 'asesor', ordenar_por: 'fecha_alta' }, NOW), /ordenar_por inválido/);
  assert.match(buildRequerimientosQueries({}, NOW).detailSql, /ORDER BY `fecha_alta` DESC, id_requerimiento DESC/);
});

test('comisión neta: los requerimientos se descuentan de la comisión, incluso de asesores sin ventas', () => {
  const ventas = [
    { grupo: 'ANA PEREZ', ventas: 10, valor_total: 5000, abono_pagado: 4000, valor_pendiente: 1000, comision_asesor: 500 },
    { grupo: 'LUIS MORA', ventas: 4, valor_total: 2000, abono_pagado: 2000, valor_pendiente: 0, comision_asesor: 200 }
  ];
  const reqs = [
    { grupo: 'ANA PEREZ', cantidad: 2, valor: 120.5 },
    { grupo: 'SIN VENTAS', cantidad: 1, valor: 80 }
  ];
  const out = mergeRequerimientosByAsesor(ventas, reqs, 'comision_neta', 'desc');
  assert.deepEqual(out.map((r) => [r.grupo, r.requerimientos_cantidad, r.requerimientos_valor, r.comision_neta]), [
    ['ANA PEREZ', 2, 120.5, 379.5],
    ['LUIS MORA', 0, 0, 200],
    ['SIN VENTAS', 1, 80, -80]
  ]);
  assert.equal(mergeRequerimientosByAsesor(ventas, reqs, 'requerimientos_valor', 'desc')[0].grupo, 'ANA PEREZ');

  const totals = withRequerimientosTotals({ ventas: 14, comision_asesor: 700 }, { cantidad: 3, valor: 200.5 });
  assert.equal(totals.requerimientos_cantidad, 3);
  assert.equal(totals.requerimientos_valor, 200.5);
  assert.equal(totals.comision_neta, 499.5);
});

test('reporte de ventas: ordenar por columnas de requerimientos solo con incluir_requerimientos y agrupar por asesor', () => {
  assert.throws(() => buildSalesReportQueries({ ordenar_por: 'comision_neta' }, NOW), /incluir_requerimientos/);
  assert.throws(() => buildSalesReportQueries({ agrupar_por: 'lider', incluir_requerimientos: true, ordenar_por: 'comision_neta' }, NOW), /incluir_requerimientos/);
  const q = buildSalesReportQueries({ agrupar_por: 'asesor', incluir_requerimientos: true, ordenar_por: 'comision_neta' }, NOW);
  validateReadOnlySql(q.detailSql);
  assert.doesNotMatch(q.detailSql, /comision_neta|requerimientos/);
});
