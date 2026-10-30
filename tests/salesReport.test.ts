import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesReportQueries, currentMonthInTimezone } from '../src/mcp/tools/salesReportTool';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const NOW = new Date('2026-10-30T17:00:00Z');

test('el mes actual se calcula en America/Guayaquil, no en UTC', () => {
  // 31-oct 20:00 en Guayaquil = 1-nov 01:00 UTC
  assert.deepEqual(currentMonthInTimezone(new Date('2026-11-01T01:00:00Z')), { anio: 2026, mes: 10 });
  assert.deepEqual(currentMonthInTimezone(new Date('2026-11-01T05:00:00Z')), { anio: 2026, mes: 11 });
});

test('rango del mes: desde el día 1 hasta el día 1 del mes siguiente (exclusivo)', () => {
  const q = buildSalesReportQueries({}, NOW);
  assert.equal(q.desde, '2026-10-01');
  assert.equal(q.hasta, '2026-11-01');
  assert.match(q.detailSql, /fecha_venta >= '2026-10-01' AND R\.fecha_venta < '2026-11-01'/);
  const dic = buildSalesReportQueries({ mes: 12, anio: 2026 }, NOW);
  assert.equal(dic.hasta, '2027-01-01');
});

test('excluye anulados (9, 13), líderes activos/visibles y no duplica por usuarios', () => {
  const { detailSql } = buildSalesReportQueries({}, NOW);
  assert.match(detailSql, /estado NOT IN \(9, 13\)/);
  assert.match(detailSql, /L\.estado = 1 AND L\.visual = 1/);
  assert.match(detailSql, /GROUP BY id_referencia/);
});

test('ordenamiento por lista cerrada: no admite texto libre', () => {
  assert.throws(() => buildSalesReportQueries({ ordenar_por: 'valor_total; DROP TABLE registros' }, NOW), /ordenar_por inválido/);
  assert.throws(() => buildSalesReportQueries({ agrupar_por: 'asesor', ordenar_por: 'fecha_venta' }, NOW), /ordenar_por inválido/);
  assert.throws(() => buildSalesReportQueries({ mes: 13 }, NOW), /mes/);
});

test('mejor vendedor: agrupa por asesor ordenado por valor total descendente', () => {
  const { detailSql } = buildSalesReportQueries({ agrupar_por: 'asesor', ordenar_por: 'valor_total', direccion: 'desc' }, NOW);
  assert.match(detailSql, /GROUP BY grupo\nORDER BY `valor_total` DESC/);
  assert.match(detailSql, /`nombre_del_asesor`/);
});

test('todas las consultas generadas pasan el guard de solo lectura', () => {
  const variants = [
    {}, { agrupar_por: 'asesor' as const }, { agrupar_por: 'lider' as const, direccion: 'asc' as const },
    { agrupar_por: 'ciudad' as const, ordenar_por: 'ventas' }, { ordenar_por: 'nombre_del_asesor', direccion: 'asc' as const }
  ];
  for (const v of variants) {
    const q = buildSalesReportQueries(v, NOW);
    validateReadOnlySql(q.detailSql);
    validateReadOnlySql(q.totalsSql);
  }
});
