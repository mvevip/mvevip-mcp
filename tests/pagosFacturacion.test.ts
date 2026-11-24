import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGRUPAR_POR, FECHA_BASE, PagosFacturacionDeps, armarAvisos, armarTotales, buildPagosFacturacionQueries,
  handlePagosFacturacion, shiftYears, unirComparativo
} from '../src/mcp/tools/pagosFacturacionTool';
import { PagosFacturacionInputSchema } from '../src/mcp/types';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const NOW = new Date('2026-11-24T17:00:00Z');
const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(/```json\n([\s\S]*)\n```/.exec(r.content[0].text)![1]);

test('todas las combinaciones de fecha_base y agrupar_por generan SQL de solo lectura válido', () => {
  for (const fecha_base of FECHA_BASE) {
    for (const agrupar_por of AGRUPAR_POR) {
      const q = buildPagosFacturacionQueries({ mes: 10, anio: 2026, fecha_base, agrupar_por }, NOW);
      for (const sql of [q.detalleSql, q.totalesSql, ...(q.pendientesSql ? [q.pendientesSql] : [])]) {
        assert.doesNotThrow(() => validateReadOnlySql(sql), `${fecha_base}/${agrupar_por}`);
      }
    }
  }
});

test('reglas acordadas en el SQL: estados 5 y 6, ventas anuladas fuera, idAbonoCRM > 1 y la fecha según fecha_base', () => {
  const venta = buildPagosFacturacionQueries({ mes: 10, anio: 2026, fecha_base: 'venta', agrupar_por: 'forma_pago' }, NOW);
  assert.match(venta.detalleSql, /A\.abo_estado IN \(5, 6\)/);
  assert.match(venta.detalleSql, /R\.estado NOT IN \(9, 13\)/);
  assert.match(venta.detalleSql, /P\.idAbonoCRM > 1/);
  assert.match(venta.detalleSql, /V\.n_validas > 0/);
  // ventas por fecha_venta; los abonos sin venta (otros módulos) por la fecha del abono
  assert.match(venta.detalleSql, /COALESCE\(V\.fecha_venta, A\.abo_fecha\) >= '2026-10-01' AND COALESCE\(V\.fecha_venta, A\.abo_fecha\) < '2026-11-01'/);
  assert.ok(venta.pendientesSql, 'con fecha_base=venta se calcula lo pendiente de facturar');

  const factura = buildPagosFacturacionQueries({ mes: 10, anio: 2026, fecha_base: 'factura' }, NOW);
  assert.match(factura.detalleSql, /A\.abo_fecha_factura >= '2026-10-01' AND A\.abo_fecha_factura < '2026-11-01'/);
  assert.equal(factura.pendientesSql, null);

  const abono = buildPagosFacturacionQueries({ fecha_desde: '2026-10-05', fecha_hasta: '2026-10-05', fecha_base: 'abono' }, NOW);
  assert.match(abono.detalleSql, /A\.abo_fecha >= '2026-10-05' AND A\.abo_fecha < '2026-10-06'/);
});

test('por defecto: mes actual en Ecuador, fecha de venta y desglose por concepto con el reparto proporcional de líneas', () => {
  const q = buildPagosFacturacionQueries({}, NOW);
  assert.equal(q.desde, '2026-11-01');
  assert.equal(q.hastaExclusivo, '2026-12-01');
  assert.equal(q.fechaBase, 'venta');
  assert.equal(q.agrupar, 'concepto');
  assert.match(q.detalleSql, /cod_descripcion/);
  assert.match(q.detalleSql, /AB\.abo_valor \* D\.cod_total_linea \/ T\.suma_lineas/);
  // el total sale de abo_valor por abono, no de las líneas
  assert.match(q.totalesSql, /SUM\(X\.abo_valor\)/);
  assert.doesNotMatch(q.totalesSql, /valor_linea/);
});

test('el orden sale de listas cerradas y las fechas se validan', () => {
  assert.throws(() => buildPagosFacturacionQueries({ ordenar_por: 'valor; DROP TABLE mve_abonos' }, NOW), /ordenar_por inválido/);
  assert.throws(() => buildPagosFacturacionQueries({ agrupar_por: 'ninguno', ordenar_por: 'abonos' }, NOW), /ordenar_por inválido para el detalle/);
  assert.throws(() => buildPagosFacturacionQueries({ fecha_desde: "2026-10-01'; DROP TABLE x; --" }, NOW), /formato/);
  assert.throws(() => buildPagosFacturacionQueries({ fecha_base: 'otra' as any }, NOW), /fecha_base inválida/);
  assert.throws(() => buildPagosFacturacionQueries({ agrupar_por: 'banco' as any }, NOW), /agrupar_por inválido/);
  assert.match(buildPagosFacturacionQueries({ agrupar_por: 'mes_factura' }, NOW).detalleSql, /ORDER BY `grupo` ASC/);
  assert.match(buildPagosFacturacionQueries({ agrupar_por: 'forma_pago' }, NOW).detalleSql, /ORDER BY `valor` DESC/);
  assert.match(buildPagosFacturacionQueries({ agrupar_por: 'forma_pago', ordenar_por: 'abonos' }, NOW).detalleSql, /ORDER BY `abonos` DESC/);
});

test('el esquema Zod acepta los parámetros válidos y rechaza los inválidos', () => {
  assert.doesNotThrow(() => PagosFacturacionInputSchema.parse({ mes: 10, anio: 2026, fecha_base: 'factura', agrupar_por: 'forma_pago', comparar_anio_anterior: true }));
  assert.throws(() => PagosFacturacionInputSchema.parse({ fecha_base: 'pago' }));
  assert.throws(() => PagosFacturacionInputSchema.parse({ mes: 13 }));
});

test('mismo período del año anterior (29-feb pasa al 28-feb)', () => {
  assert.equal(shiftYears('2026-10-01', -1), '2025-10-01');
  assert.equal(shiftYears('2024-02-29', -1), '2023-02-28');
  assert.equal(shiftYears('2026-11-01', -1), '2025-11-01');
  assert.throws(() => shiftYears('2000-01-01', -1), /antes del año 2000/);
});

// Cifras reales verificadas por el usuario el 24-nov-2026 (abonos facturados en octubre por fecha de factura):
// 537 abonos / 279 375,68 = 463 de ventas (260 275,79) + 74 de otros módulos (19 099,89),
// de los cuales 14 abonos / 9 583,73 son de ventas anuladas (12 en estado 9 por 8 236,13 y 2 en estado 13 por 1 347,60) y quedan fuera.
const TOTALES_OCT = {
  abonos: 523, valor: '269791.95', abonos_ventas: 449, valor_ventas: '250692.06',
  forma_inconsistente_abonos: 0, forma_inconsistente_valor: '0.00', sin_lineas: 0, cotizacion_valor_distinto: 5, cotizacion_repetida: 0
};

test('reproduce los totales de octubre 2026: ventas y otros módulos suman el total sin ventas anuladas', () => {
  const t = armarTotales(TOTALES_OCT);
  assert.equal(t.abonos_facturados, 523);
  assert.equal(t.valor_facturado, 269791.95);
  assert.deepEqual(t.ventas, { abonos: 449, valor: 250692.06 });
  assert.deepEqual(t.otros_modulos, { abonos: 74, valor: 19099.89 });
  // control con las cifras sin excluir anuladas: 537 y 279 375,68
  assert.equal(t.abonos_facturados + 14, 537);
  assert.equal(Math.round((t.valor_facturado + 8236.13 + 1347.6) * 100) / 100, 279375.68);
});

const fakeDeps = (rutas: Array<[RegExp, any[]]>, sqls: string[] = []): PagosFacturacionDeps => ({
  consultar: async (sql) => {
    sqls.push(sql);
    const r = rutas.find(([re]) => re.test(sql));
    if (!r) throw new Error(`consulta no prevista: ${sql.slice(0, 80)}`);
    return { rows: r[1], truncated: false };
  }
});

test('forma de pago: porcentajes sobre el total, nombres tal como vienen y aviso de la forma inconsistente', async () => {
  const deps = fakeDeps([
    [/AS abonos_ventas/, [{ ...TOTALES_OCT, forma_inconsistente_abonos: 3, forma_inconsistente_valor: '1200.50' }]],
    [/pagos_sin_abono/, [{ pagos_sin_abono: 0, valor_sin_abono: '0.00', pagos_abono_sin_facturar: 0, valor_abono_sin_facturar: '0.00', pagos_enlace_invalido: 0, valor_enlace_invalido: '0.00' }]],
    [/AS grupo/, [
      { grupo: 'DINERS CLUB', abonos: 200, valor: '100000.00' },
      { grupo: 'VISA BANCO PICHINCHA', abonos: 150, valor: '80000.00' },
      { grupo: 'BCO PICHINCHA CTA CORRIENTE', abonos: 100, valor: '60000.00' }
    ]]
  ]);
  const p = payload(await handlePagosFacturacion({ mes: 10, anio: 2026, fecha_base: 'factura', agrupar_por: 'forma_pago', ordenar_por: 'abonos' }, deps, NOW));
  assert.equal(p.totales.valor_facturado, 269791.95);
  assert.equal(p.filas[0].grupo, 'DINERS CLUB');
  assert.equal(p.filas[0].valor, 100000);
  assert.equal(p.filas[0].porcentaje_del_valor, 37.1);
  assert.ok(p.avisos.some((a: string) => /3 abono\(s\) por 1,200\.50 tienen la forma de pago inconsistente/.test(a)));
  assert.ok(p.avisos.some((a: string) => /cotización cuyas líneas suman un valor distinto/.test(a)));
  assert.ok(!('pendiente_de_facturar_ventas_del_periodo' in p), 'sin pendientes cuando la fecha base no es la venta');
  assert.equal(p.fecha_base, 'factura');
});

test('con fecha_base=venta avisa lo pendiente de facturar y los enlaces inválidos; sin inconsistencias no avisa de la forma de pago', async () => {
  const deps = fakeDeps([
    [/AS abonos_ventas/, [TOTALES_OCT]],
    [/pagos_sin_abono/, [{ pagos_sin_abono: 35, valor_sin_abono: '27808.00', pagos_abono_sin_facturar: 2, valor_abono_sin_facturar: '150.00', pagos_enlace_invalido: 10, valor_enlace_invalido: '38781.84' }]],
    [/AS grupo/, [{ grupo: 'PAQUETE', abonos: 239, valor: '150065.47' }]]
  ]);
  const p = payload(await handlePagosFacturacion({ mes: 11, anio: 2026 }, deps, NOW));
  assert.equal(p.fecha_base, 'venta');
  assert.equal(p.agrupado_por, 'concepto');
  assert.equal(p.pendiente_de_facturar_ventas_del_periodo.pagos_sin_abono, 35);
  assert.ok(p.avisos.some((a: string) => /35 pago\(s\) sin abono por 27,808\.00 y 2 pago\(s\) con abono aún no facturado por 150\.00/.test(a)));
  assert.ok(p.avisos.some((a: string) => /10 pago\(s\).*38,781\.84.*abono 1/.test(a)));
  assert.ok(!p.avisos.some((a: string) => /forma de pago inconsistente/.test(a)));
  assert.ok(p.avisos.some((a: string) => /cada concepto que contiene/.test(a)));
});

test('comparativo con el año anterior: variación por grupo y grupos que solo existían antes', async () => {
  const sqls: string[] = [];
  const deps = fakeDeps(
    [
      [/AS abonos_ventas[\s\S]*'2025-10-01'/, [{ ...TOTALES_OCT, abonos: 400, valor: '200000.00', abonos_ventas: 380, valor_ventas: '190000.00' }]],
      [/AS abonos_ventas/, [TOTALES_OCT]],
      [/pagos_sin_abono/, [{ pagos_sin_abono: 0, valor_sin_abono: 0, pagos_abono_sin_facturar: 0, valor_abono_sin_facturar: 0, pagos_enlace_invalido: 0, valor_enlace_invalido: 0 }]],
      [/AS grupo[\s\S]*'2025-10-01'/, [
        { grupo: 'PAQUETE', abonos: 200, valor: '120000.00' },
        { grupo: 'CHIP', abonos: 10, valor: '500.00' }
      ]],
      [/AS grupo/, [
        { grupo: 'PAQUETE', abonos: 239, valor: '150000.00' },
        { grupo: 'FORMULARIOS', abonos: 69, valor: '16655.00' }
      ]]
    ],
    sqls
  );
  const p = payload(await handlePagosFacturacion({ mes: 10, anio: 2026, comparar_anio_anterior: true }, deps, NOW));
  assert.deepEqual(p.comparativo_anio_anterior.periodo, { desde: '2025-10-01', hasta_exclusivo: '2025-11-01' });
  assert.equal(p.comparativo_anio_anterior.variacion.valor.variacion, 69791.95);
  assert.equal(p.comparativo_anio_anterior.variacion.valor.variacion_porcentaje, 34.9);
  const porGrupo = Object.fromEntries(p.filas.map((f: any) => [f.grupo, f]));
  assert.equal(porGrupo.PAQUETE.valor_anio_anterior, 120000);
  assert.equal(porGrupo.PAQUETE.variacion_valor, 30000);
  assert.equal(porGrupo.PAQUETE.variacion_porcentaje, 25);
  assert.equal(porGrupo.FORMULARIOS.valor_anio_anterior, 0);
  assert.equal(porGrupo.FORMULARIOS.variacion_porcentaje, null);
  assert.equal(porGrupo.CHIP.valor, 0);
  assert.equal(porGrupo.CHIP.variacion_porcentaje, -100);
  assert.ok(sqls.some((s) => /'2025-10-01'/.test(s)) && sqls.some((s) => /'2026-10-01'/.test(s)));
});

test('unirComparativo conserva el orden del período actual y deja al final lo que solo existía antes', () => {
  const filas = unirComparativo(
    [{ grupo: 'A', abonos: 1, valor: 10 }, { grupo: 'B', abonos: 1, valor: 5 }],
    [{ grupo: 'C', abonos: 2, valor: 7 }, { grupo: 'A', abonos: 1, valor: 20 }, { grupo: 'D', abonos: 1, valor: 9 }],
    15
  );
  assert.deepEqual(filas.map((f) => f.grupo), ['A', 'B', 'D', 'C']);
  assert.equal(filas[0].variacion_valor, -10);
  assert.equal(filas[0].variacion_porcentaje, -50);
});

test('armarAvisos: sin hallazgos solo queda la nota del reparto por concepto', () => {
  assert.deepEqual(armarAvisos({}, 'forma_pago', null), []);
  assert.equal(armarAvisos({}, 'concepto', null).length, 1);
});

test('un parámetro inválido devuelve un error legible y no consulta la base', async () => {
  let llamadas = 0;
  const deps: PagosFacturacionDeps = { consultar: async () => { llamadas++; return { rows: [], truncated: false }; } };
  const r = await handlePagosFacturacion({ ordenar_por: 'x; DROP TABLE y' }, deps, NOW);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ordenar_por inválido/);
  assert.equal(llamadas, 0);
});
