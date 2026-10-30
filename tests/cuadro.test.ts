import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleCuadro, buildCuadroQueries, computeWorkingDays, monthRange, todayInTimezone } from '../src/mcp/tools/cuadroTool';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const FERIADOS_OCT = ['2026-10-09'];

test('días laborables: octubre 2026 con el feriado del 9 da 21 y el feriado se resta una sola vez', () => {
  assert.deepEqual(computeWorkingDays('2026-10-30', FERIADOS_OCT), { laborables: 21, transcurridos: 21, restantes: 0 });
  assert.equal(computeWorkingDays('2026-10-30', []).laborables, 22);
});

test('días restantes: solo los laborables posteriores a la fecha consultada, nunca negativos', () => {
  // miércoles 21: restan 22, 23, 26, 27, 28, 29 y 30
  assert.equal(computeWorkingDays('2026-10-21', FERIADOS_OCT).restantes, 7);
  // sábado 31 (último día del mes, fin de semana): no queda ninguno
  assert.equal(computeWorkingDays('2026-10-31', FERIADOS_OCT).restantes, 0);
  // inicio de mes
  assert.equal(computeWorkingDays('2026-10-01', FERIADOS_OCT).restantes, 20);
});

test('rango del mes y validación de fecha', () => {
  assert.deepEqual(monthRange('2026-12-15'), { desde: '2026-12-01', hastaExclusivo: '2027-01-01' });
  assert.throws(() => buildCuadroQueries('2026-02-30'), /no es válida/);
  assert.throws(() => buildCuadroQueries("2026-10-30'; DROP TABLE registros; --"), /formato/);
});

test('la fecha de hoy se calcula en America/Guayaquil', () => {
  assert.equal(todayInTimezone(new Date('2026-11-01T01:00:00Z')), '2026-10-31');
  assert.equal(todayInTimezone(new Date('2026-11-01T05:00:00Z')), '2026-11-01');
});

test('consultas: estados 9 y 13 siempre excluidos, un solo usuario por vendedor y pasan el guard de solo lectura', () => {
  const q = buildCuadroQueries('2026-10-30');
  for (const sql of [q.feriadosSql, q.lideresSql, q.gruposSql, q.cierresSql, q.asesoresSql]) validateReadOnlySql(sql);
  for (const sql of [q.lideresSql, q.gruposSql, q.cierresSql, q.asesoresSql]) {
    assert.match(sql, /estado NOT IN \(9, 13\)/);
    assert.doesNotMatch(sql, /pago_cuadro/);
  }
  assert.match(q.gruposSql, /id_referencia > 0/);
  assert.match(q.asesoresSql, /id_referencia > 0/);
});

test('reproduce el cuadro del 30-oct-2026 (cifras de la pantalla)', () => {
  const cuadro = assembleCuadro('2026-10-30', {
    feriados: [{ fecha: '2026-10-09' }],
    lideres: [
      { lider: 'Leads', meta_mensual: 42000, ventas_dia: 0, ventas_mes: 46143.46, comision_mes: 27415.9 },
      { lider: 'Sala General', meta_mensual: 258000, ventas_dia: 1050, ventas_mes: 168286.68, comision_mes: 153579.23 }
    ],
    grupos: [
      { grupo: 'GRUPO LEADS', meta_mensual: 42000, ahora: 0, netas: 46143.46, acumulado: 27415.9 },
      { grupo: 'SALA GENERAL', meta_mensual: 258000, ahora: 1050, netas: 168286.68, acumulado: 153579.23 }
    ],
    cierres: [{ lider: 'ANGEL SALTOS', total_pagado: 63125.15, total_comision: 59870.44 }],
    asesores: [{ asesor: 'CORDOVA KAREN', tipo: 'visado', abono_pagado: 250 }]
  });
  assert.equal(cuadro.dias_laborables.laborables, 21);
  assert.equal(cuadro.dias_laborables.restantes, 0);
  assert.deepEqual(cuadro.equipos.map((e) => e.sigla), ['L', 'SG']);
  assert.equal(cuadro.equipos[0].diario.meta, 2000);
  assert.equal(cuadro.equipos[1].diario.meta, 12285.71);
  assert.equal(cuadro.equipos[1].diario.falta, 11235.71);
  assert.equal(cuadro.equipos[0].mensual.avance_pct, 65.28);
  assert.equal(cuadro.equipos[1].mensual.meta_a_fecha, 258000);
  assert.deepEqual(cuadro.resumen, {
    ventas_hoy: 1050,
    meta_diaria_total: 14285.71,
    falta_hoy: 13235.71,
    ventas_mes: 214430.14,
    comision_mes: 180995.13,
    meta_comision_mes: 300000,
    avance_comision_pct: 60.33
  });
  assert.equal(cuadro.grupos[0].falta, 14584.1);
  assert.equal(cuadro.grupos[1].falta, 104420.77);
  assert.equal(cuadro.ventas_del_dia_por_asesor[0].tipo, 'visado');
});
