import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAsistenciaQueries, likePattern } from '../src/mcp/tools/asistenciaTool';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const NOW = new Date('2026-10-30T17:00:00Z');

test('período: mes actual, mes dado, un solo día y rango inclusivo', () => {
  const mes = buildAsistenciaQueries({}, NOW);
  assert.deepEqual([mes.desde, mes.hastaExclusivo], ['2026-10-01', '2026-11-01']);
  const abril = buildAsistenciaQueries({ mes: 4, anio: 2026 }, NOW);
  assert.deepEqual([abril.desde, abril.hastaExclusivo], ['2026-04-01', '2026-05-01']);
  const hoy = buildAsistenciaQueries({ fecha_desde: '2026-10-30' }, NOW);
  assert.deepEqual([hoy.desde, hoy.hastaExclusivo], ['2026-10-30', '2026-10-31']);
  assert.match(abril.detailSql, /a\.timestamp >= '2026-04-01' AND a\.timestamp < '2026-05-01'/);
  assert.doesNotMatch(abril.detailSql, /DATE\(a\.timestamp\) BETWEEN/);
  assert.throws(() => buildAsistenciaQueries({ fecha_desde: "2026-10-01'; DROP TABLE x; --" }, NOW), /formato/);
});

test('todas las variantes pasan el guard de solo lectura y solo leen entradas (punch 0) del biométrico', () => {
  const variants = [
    {}, { todas_las_marcaciones: true }, { agrupar_por: 'empleado' as const }, { agrupar_por: 'dia' as const, direccion: 'asc' as const },
    { agrupar_por: 'departamento' as const, tolerancia_minutos: 5 }, { departamento: 'CALL CENTER', empleado: 'perez' }
  ];
  for (const v of variants) {
    const q = buildAsistenciaQueries(v, NOW);
    validateReadOnlySql(q.detailSql);
    validateReadOnlySql(q.totalsSql);
    assert.match(q.detailSql, /a\.punch = 0/);
    assert.match(q.detailSql, /mvevip_biometrico\.mve_asistencias/);
  }
});

test('atraso solo en la primera marcación del día y con tolerancia', () => {
  const q = buildAsistenciaQueries({}, NOW);
  assert.match(q.detailSql, /WHERE marca_del_dia = 1/);
  assert.match(q.detailSql, /ROW_NUMBER\(\) OVER \(PARTITION BY a\.user_id_biometrico, DATE\(a\.timestamp\)/);
  assert.match(q.detailSql, /pico_placa_dia = WEEKDAY\(m\.ts\) \+ 1 THEN u\.pico_placa_hora/);
  assert.match(buildAsistenciaQueries({ tolerancia_minutos: 5 }, NOW).totalsSql, /minutos_atraso > 5/);
  assert.doesNotMatch(buildAsistenciaQueries({ todas_las_marcaciones: true }, NOW).detailSql, /WHERE marca_del_dia = 1/);
  assert.throws(() => buildAsistenciaQueries({ tolerancia_minutos: 500 }, NOW), /tolerancia/);
});

test('filtros de texto como valores enlazados, nunca dentro del SQL', () => {
  const q = buildAsistenciaQueries({ departamento: "call' OR 1=1 --", empleado: '50%_ana' }, NOW);
  assert.equal(q.values.length, 2);
  assert.equal(q.values[0], "%call' OR 1=1 --%");
  assert.equal(q.values[1], '%50\\%\\_ana%');
  assert.doesNotMatch(q.detailSql, /OR 1=1/);
  assert.equal((q.detailSql.match(/\?/g) ?? []).length, 2);
  assert.equal(likePattern('a_b'), '%a\\_b%');
  assert.deepEqual(buildAsistenciaQueries({ departamento: '  ' }, NOW).values, []);
  assert.throws(() => buildAsistenciaQueries({ empleado: 'x'.repeat(61) }, NOW), /demasiado largo/);
});

test('ordenamiento por lista cerrada según la vista', () => {
  assert.throws(() => buildAsistenciaQueries({ ordenar_por: 'empleado; DROP TABLE x' }, NOW), /ordenar_por inválido/);
  assert.throws(() => buildAsistenciaQueries({ agrupar_por: 'dia', ordenar_por: 'empleado' }, NOW), /ordenar_por inválido/);
  assert.match(buildAsistenciaQueries({ agrupar_por: 'empleado' }, NOW).detailSql, /ORDER BY `minutos_atraso_total` DESC/);
  assert.match(buildAsistenciaQueries({}, NOW).detailSql, /ORDER BY `fecha_hora_marcacion` DESC/);
});
