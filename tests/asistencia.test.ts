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

test('todas las variantes pasan el guard de solo lectura y leen solo el biométrico', () => {
  const variants = [
    {}, { todas_las_marcaciones: true }, { agrupar_por: 'empleado' as const }, { agrupar_por: 'dia' as const, direccion: 'asc' as const },
    { agrupar_por: 'departamento' as const, tolerancia_minutos: 5 }, { departamento: 'CALL CENTER', empleado: 'perez', dispositivo: 'entrada' }
  ];
  for (const v of variants) {
    const q = buildAsistenciaQueries(v, NOW);
    validateReadOnlySql(q.detailSql);
    validateReadOnlySql(q.totalsSql);
    assert.match(q.detailSql, /mvevip_biometrico\.mve_asistencias/);
  }
});

test('entrada por hora del día (sin usar punch), sin salidas y sin fines de semana', () => {
  const q = buildAsistenciaQueries({}, NOW);
  assert.doesNotMatch(q.detailSql, /punch/);
  assert.match(q.detailSql, /WEEKDAY\(a\.timestamp\) < 5/);
  // punto medio entre hora de entrada y de salida del departamento
  assert.match(q.detailSql, /TIME_TO_SEC\(COALESCE\(d\.hora_entrada, '09:45:00'\)\) \/ 60 \+ TIME_TO_SEC\(COALESCE\(d\.hora_salida, '18:00:00'\)\) \/ 60\s*\) \/ 2 AS es_entrada/);
  assert.match(q.detailSql, /WHERE es_entrada = 1/);
  assert.match(q.detailSql, /pico_placa_dia = WEEKDAY\(a\.timestamp\) \+ 1 THEN COALESCE\(u\.pico_placa_hora/);
});

test('primera entrada del día, tolerancia y empleados sin departamento', () => {
  const q = buildAsistenciaQueries({}, NOW);
  assert.match(q.detailSql, /WHERE marca_del_dia = 1/);
  assert.match(q.detailSql, /ROW_NUMBER\(\) OVER \(PARTITION BY user_id_biometrico, DATE\(ts\) ORDER BY ts\)/);
  assert.match(q.detailSql, /COALESCE\(d\.nombre, 'SIN DEPARTAMENTO'\) AS departamento/);
  assert.match(q.detailSql, /LEFT JOIN mvevip_biometrico\.mve_departamentos d/);
  assert.match(buildAsistenciaQueries({ tolerancia_minutos: 5 }, NOW).totalsSql, /minutos_atraso > 5/);
  assert.doesNotMatch(buildAsistenciaQueries({ todas_las_marcaciones: true }, NOW).detailSql, /WHERE marca_del_dia = 1/);
  assert.throws(() => buildAsistenciaQueries({ tolerancia_minutos: 500 }, NOW), /tolerancia/);
});

test('filtros de texto como valores enlazados, nunca dentro del SQL', () => {
  const q = buildAsistenciaQueries({ departamento: "call' OR 1=1 --", empleado: '50%_ana', dispositivo: 'principal' }, NOW);
  assert.deepEqual(q.values, ["%call' OR 1=1 --%", '%50\\%\\_ana%', '%principal%']);
  assert.doesNotMatch(q.detailSql, /OR 1=1/);
  assert.equal((q.detailSql.match(/\?/g) ?? []).length, 3);
  assert.match(q.detailSql, /d\.nombre LIKE \? AND u\.nombre LIKE \? AND disp\.nombre LIKE \?/);
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
