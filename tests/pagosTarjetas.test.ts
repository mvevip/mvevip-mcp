import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PagosTarjetasDeps, armarGrupos, armarMarcas, armarObservaciones, buildConsultasTarjetas, handlePagosTarjetas, resolverMarca
} from '../src/mcp/tools/pagosTarjetasTool';
import { PagosTarjetasInputSchema } from '../src/mcp/types';
import { validateReadOnlySql } from '../src/services/sqlGuard';

// Hoy (25-nov-2026, Ecuador)
const NOW = new Date('2026-11-25T17:00:00Z');
const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(/```json\n([\s\S]*)\n```/.exec(r.content[0].text)![1]);

test('todas las vistas y agrupaciones generan SQL de solo lectura válido', () => {
  const consultas = [
    buildConsultasTarjetas({ vista: 'resumen', fecha_desde: '2026-09-01', fecha_hasta: '2026-11-19' }, NOW),
    buildConsultasTarjetas({ vista: 'resumen', fecha_base: 'pago', tipo_valor: 'bruto', marca: 'Visa' }, NOW),
    buildConsultasTarjetas({ vista: 'por_cobrar' }, NOW),
    buildConsultasTarjetas({ vista: 'por_cobrar', mes: 12, anio: 2026, marca: 'DN' }, NOW)
  ];
  for (const d of ['dia', 'semana', 'mes', 'marca', 'tipo_credito'] as const) {
    consultas.push(buildConsultasTarjetas({ vista: 'flujo', agrupar_por: d }, NOW));
    consultas.push(buildConsultasTarjetas({ vista: 'flujo', agrupar_por: d, desglosar_por: d === 'dia' ? 'tipo_credito' : 'dia' }, NOW));
  }
  for (const q of consultas) {
    for (const sql of [q.marcasSql, q.porMesSql, q.comisionesSql, q.gruposSql, q.detalleSql, q.totalesSql, q.observacionesSql]) {
      if (sql) assert.doesNotThrow(() => validateReadOnlySql(sql), sql);
    }
  }
});

test('reglas del panel en el SQL: VALE y CREDITO suman, DEBITO resta, rechazados fuera, rango por fecha_facturacion', () => {
  const q = buildConsultasTarjetas({ vista: 'resumen', fecha_desde: '2026-09-01', fecha_hasta: '2026-11-19' }, NOW);
  assert.equal(q.contexto.desde, '2026-09-01');
  assert.equal(q.contexto.hastaExclusivo, '2026-11-20');
  assert.match(q.marcasSql!, /P\.concepto_registro IN \('VALE', 'CREDITO'\) THEN P\.valor_pago/);
  assert.match(q.marcasSql!, /P\.concepto_registro = 'DEBITO' THEN P\.valor_pago/);
  assert.match(q.marcasSql!, /WHERE P\.fecha_facturacion >= '2026-09-01' AND P\.fecha_facturacion < '2026-11-20' AND P\.concepto_registro IN \('VALE', 'CREDITO', 'DEBITO'\)/);
  assert.doesNotMatch(q.marcasSql!, /VALE RECHAZADO/);
  // el catálogo de comisiones se une sin duplicar filas (hay un código repetido en el catálogo)
  assert.match(q.comisionesSql!, /GROUP BY codigo_antiguo\n\) CM ON CM\.codigo_antiguo = P\.codigo_anterior/);
  // grupos: abonos facturados (5 y 6), sin el grupo 2 de tid_agrupacion
  assert.match(q.gruposSql!, /A\.abo_estado IN \(5, 6\) AND D\.tid_agrupacion <> 2/);
  assert.match(q.gruposSql!, /A\.abo_fecha >= '2026-09-01' AND A\.abo_fecha < '2026-11-20'/);
  // por defecto neto; con bruto usa valor_bruto
  assert.match(buildConsultasTarjetas({ tipo_valor: 'bruto' }, NOW).marcasSql!, /P\.valor_bruto/);
  // fecha_base=pago usa fecha_del_pago
  assert.match(buildConsultasTarjetas({ fecha_base: 'pago' }, NOW).marcasSql!, /P\.fecha_del_pago >= '2026-11-01'/);
});

test('por_cobrar: desde hoy (inclusive) sin importar cuándo se facturó; un período solo acota y nunca antes de hoy', () => {
  const sin = buildConsultasTarjetas({ vista: 'por_cobrar' }, NOW);
  assert.equal(sin.contexto.hoy, '2026-11-25');
  assert.equal(sin.contexto.desde, '2026-11-25');
  assert.equal(sin.contexto.hastaExclusivo, null);
  assert.match(sin.detalleSql!, /WHERE P\.fecha_del_pago >= '2026-11-25' AND P\.concepto_registro IN \('VALE', 'CREDITO', 'DEBITO'\)\nGROUP BY grupo\nORDER BY `grupo` ASC, grupo ASC$/);
  assert.doesNotMatch(sin.detalleSql!, /fecha_facturacion/);
  // un mes pasado no baja de hoy; un mes futuro sí acota
  assert.equal(buildConsultasTarjetas({ vista: 'por_cobrar', mes: 10, anio: 2026 }, NOW).contexto.desde, '2026-11-25');
  const dic = buildConsultasTarjetas({ vista: 'por_cobrar', mes: 12, anio: 2026 }, NOW).contexto;
  assert.deepEqual([dic.desde, dic.hastaExclusivo], ['2026-12-01', '2027-01-01']);
  const hasta = buildConsultasTarjetas({ vista: 'por_cobrar', fecha_hasta: '2026-12-05' }, NOW).contexto;
  assert.deepEqual([hasta.desde, hasta.hastaExclusivo], ['2026-11-25', '2026-12-06']);
  assert.throws(() => buildConsultasTarjetas({ vista: 'por_cobrar', fecha_hasta: '2026-11-20' }, NOW), /anterior a hoy/);
});

test('flujo: filas del rango de facturación agrupadas por fecha de pago, con desglose opcional', () => {
  const q = buildConsultasTarjetas({ vista: 'flujo', fecha_desde: '2026-09-01', fecha_hasta: '2026-11-19', agrupar_por: 'tipo_credito', desglosar_por: 'dia' }, NOW);
  assert.match(q.detalleSql!, /COALESCE\(CM\.tipo_credito, 'SIN CATALOGO'\) AS grupo, COALESCE\(DATE_FORMAT\(P\.fecha_del_pago, '%Y-%m-%d'\), 'SIN FECHA'\) AS subgrupo/);
  assert.match(q.detalleSql!, /P\.fecha_facturacion >= '2026-09-01' AND P\.fecha_facturacion < '2026-11-20'/);
  assert.match(q.detalleSql!, /GROUP BY grupo, subgrupo\nORDER BY `neto` DESC, grupo ASC, subgrupo ASC$/);
  assert.match(q.totalesSql!, /P\.fecha_del_pago < '2026-11-25' THEN/);
  assert.match(q.totalesSql!, /P\.fecha_del_pago >= '2026-11-25' THEN/);
});

test('validaciones: marca, vista, listas cerradas y datos nunca concatenados', () => {
  assert.equal(resolverMarca('diners club'), 'DN');
  assert.equal(resolverMarca(' Master Card '), 'MC');
  assert.equal(resolverMarca(undefined), null);
  assert.throws(() => resolverMarca("VI' OR 1=1 --"), /marca inválida/);
  assert.throws(() => buildConsultasTarjetas({ vista: 'otra' as any }, NOW), /vista inválida/);
  assert.throws(() => buildConsultasTarjetas({ fecha_base: 'x' as any }, NOW), /fecha_base inválida/);
  assert.throws(() => buildConsultasTarjetas({ tipo_valor: 'x' as any }, NOW), /tipo_valor inválido/);
  assert.throws(() => buildConsultasTarjetas({ vista: 'flujo', agrupar_por: 'x' as any }, NOW), /agrupar_por inválido/);
  assert.throws(() => buildConsultasTarjetas({ vista: 'flujo', agrupar_por: 'dia', desglosar_por: 'dia' }, NOW), /distinto/);
  assert.throws(() => buildConsultasTarjetas({ vista: 'flujo', ordenar_por: 'neto; DROP TABLE x' }, NOW), /ordenar_por inválido/);
  assert.throws(() => buildConsultasTarjetas({ fecha_desde: "2026-09-01'; DROP TABLE x; --" }, NOW), /formato/);
  const q = buildConsultasTarjetas({ vista: 'resumen', marca: 'VISA' }, NOW);
  assert.match(q.marcasSql!, /AND P\.marca = 'VI'/);
  assert.doesNotMatch(q.marcasSql!, /VISA/);
  assert.doesNotThrow(() => PagosTarjetasInputSchema.parse({ vista: 'por_cobrar', marca: 'Visa', agrupar_por: 'semana', desglosar_por: 'marca' }));
  assert.throws(() => PagosTarjetasInputSchema.parse({ vista: 'otra' }));
  assert.throws(() => PagosTarjetasInputSchema.parse({ tipo_valor: 'x' }));
});

// ---------------------------------------------------------------------------
// Cifras reales del volcado del 24-nov-2026 (rango de fecha_facturacion del 1-sep al 19-nov; ventas = VALE + CREDITO, neto)
// ---------------------------------------------------------------------------
const MARCAS_REAL = [
  { marca: 'DINERS CLUB', ventas: '265226.79', debitos: '23038.62' },
  { marca: 'VISA', ventas: '158215.31', debitos: '18062.39' },
  { marca: 'MASTERCARD', ventas: '39196.36', debitos: '1466.00' },
  { marca: 'DISCOVER', ventas: '5266.36', debitos: '0.00' }
];
const COMISIONES_REAL = [
  ['PLAN 9 PAGOS SIN INTERESES', '12.65', '14292.22'], ['DIFERIDO CON INTERESES HASTA 36 MESES CON MESES DE GRACIA', '6.90', '12629.23'],
  ['CORRIENTE', '4.60', '2953.24'], ['SIN CATALOGO', null, '2776.20'], ['DIFERIDO PREFERENTE A 24 MESES', '13.80', '2217.88'],
  ['PLAN 3 PAGOS SIN INTERESES', '8.05', '2045.62'], ['DIFERIDO CON INTERESES HASTA 36 MESES', '4.60', '1957.44'],
  ['DIFERIDO PREFERENTE A 12 MESES', '10.35', '1772.03'], ['PLAN 6 PAGOS SIN INTERESES', '10.35', '1505.03'],
  ['PLAN 12 PAGOS SIN INTERESES', '14.95', '853.20'], ['DIFERIDO PREFERENTE A 6 MESES', '8.05', '518.03'],
  ['DIFERIDO PREFERENTE A 18 MESES', '12.65', '201.90'], ['ELECTRON', '2.30', '74.45']
].map(([tipo_credito, comision_pct, total]) => ({ tipo_credito, comision_pct, total }));

const fake = (rutas: Array<[RegExp, any[]]>, sqls: string[] = []): PagosTarjetasDeps => ({
  consultar: async (sql) => {
    sqls.push(sql);
    const r = rutas.find(([re]) => re.test(sql));
    if (!r) throw new Error(`consulta no prevista: ${sql.slice(0, 90)}`);
    return { rows: r[1], truncated: false };
  }
});

test('reproduce el panel del 1-sep al 19-nov: ventas por marca, débitos y porcentajes, grupos y comisiones', () => {
  const m = armarMarcas(MARCAS_REAL);
  assert.deepEqual(m.totales, { ventas: 467904.82, debitos: 42567.01 });
  assert.deepEqual(m.filas.map((f) => [f.marca, f.porcentaje_debitos]), [['DINERS CLUB', 8.7], ['VISA', 11.4], ['MASTERCARD', 3.7], ['DISCOVER', 0]]);
  // grupos de la pantalla: INTERDIN 467 904,82 + efectivo/transferencias 126 956,61 + otras tarjetas 61 690,58 = 656 552,01
  const g = armarGrupos([{ grupo: 'EFECTIVO TRANSFERENCIAS', ventas: '126956.61' }, { grupo: 'OTRAS TARJETAS', ventas: '61690.58' }], m.totales.ventas);
  assert.deepEqual(g.filas.map((f) => f.grupo), ['INTERDIN', 'EFECTIVO TRANSFERENCIAS', 'OTRAS TARJETAS']);
  assert.equal(g.total, 656552.01);
});

test('handler resumen: una consulta por tabla, comisiones 43 796,47 con la fila SIN CATALOGO y observaciones', async () => {
  const sqls: string[] = [];
  const deps = fake([
    [/AS ventas,\n  ROUND\(COALESCE\(SUM\(CASE WHEN P\.concepto_registro = 'DEBITO'.*AS debitos/s, MARCAS_REAL],
    [/AS total\n.*GROUP BY mes/s, [{ mes: '2026-09', total: '163727.94' }, { mes: '2026-10', total: '184942.76' }, { mes: '2026-11', total: '119234.12' }]],
    [/AS comision_pct/, COMISIONES_REAL],
    [/FROM mve\.mve_abonos A/, [{ grupo: 'EFECTIVO TRANSFERENCIAS', ventas: '126956.61' }, { grupo: 'OTRAS TARJETAS', ventas: '61690.58' }]],
    [/AS neto_preliquidado/, [{ neto_preliquidado: '202104.53', neto_liquidado: '223233.28', sin_catalogo_filas: 59, sin_catalogo_valor: '31983.97', filas_formato_invalido: 0 }]]
  ], sqls);
  const p = payload(await handlePagosTarjetas({ vista: 'resumen', fecha_desde: '2026-09-01', fecha_hasta: '2026-11-19' }, deps, NOW));
  assert.equal(sqls.length, 5);
  assert.deepEqual(p.marcas.totales, { ventas: 467904.82, debitos: 42567.01 });
  assert.equal(p.comisiones.total, 43796.47);
  assert.deepEqual(p.comisiones.filas.find((f: any) => f.tipo_credito === 'SIN CATALOGO'), { tipo_credito: 'SIN CATALOGO', comision_pct: null, total: 2776.2 });
  assert.equal(p.grupos.total, 656552.01);
  assert.equal(p.ventas_por_mes.reduce((a: number, f: any) => a + f.total, 0).toFixed(2), '467904.82');
  assert.equal(p.fecha_base, 'facturacion');
  // preliquidado como observación (no separa las cifras)
  assert.ok(p.observaciones.some((o: string) => /Preliquidado: 202,104\.53 \(47\.5 % del neto\).*provisional.*liquidado: 223,233\.28/.test(o)));
  assert.ok(p.observaciones.some((o: string) => /59 fila\(s\) por 31,983\.97.*SIN CATALOGO/.test(o)));
  assert.ok(p.observaciones.some((o: string) => /CREDITO es un pago.*DEBITO.*restan/.test(o)));
  assert.ok(!p.observaciones.some((o: string) => /columnas corridas/.test(o)), 'sin filas corridas no avisa');
});

test('flujo (1-sep al 19-nov): neto = ventas − débitos y coincide con los días de la pantalla del 9 al 19-nov', async () => {
  const dias = [
    ['2026-11-09', '852.18', '0.00', '852.18'], ['2026-11-10', '618.20', '64.49', '553.71'], ['2026-11-11', '2887.35', '0.00', '2887.35'],
    ['2026-11-12', '4701.38', '0.00', '4701.38'], ['2026-11-13', '17161.38', '0.00', '17161.38'], ['2026-11-14', '10000.77', '1628.27', '8372.50'],
    ['2026-11-16', '9019.23', '558.50', '8460.73'], ['2026-11-17', '5560.67', '680.14', '4880.53'], ['2026-11-18', '10213.65', '0.00', '10213.65'],
    ['2026-11-19', '2351.62', '0.00', '2351.62']
  ].map(([grupo, ventas, debitos, neto]) => ({ grupo, subgrupo: '', ventas, debitos, neto }));
  const deps = fake([
    [/AS ultima_fecha_de_pago/, [{ ventas: '467904.82', debitos: '42567.01', neto: '425337.81', neto_antes_de_hoy: '392093.43', neto_desde_hoy: '33244.38', ultima_fecha_de_pago: '2026-12-14' }]],
    [/AS neto_preliquidado/, [{ neto_preliquidado: '202104.53', neto_liquidado: '223233.28', sin_catalogo_filas: 59, sin_catalogo_valor: '31983.97', filas_formato_invalido: 0 }]],
    [/AS grupo/, dias]
  ]);
  const p = payload(await handlePagosTarjetas({ vista: 'flujo', fecha_desde: '2026-09-01', fecha_hasta: '2026-11-19' }, deps, NOW));
  assert.equal(p.totales.neto, 425337.81);
  assert.equal(p.totales.ventas - p.totales.debitos, p.totales.neto);
  assert.equal(p.totales.neto_pagado_antes_de_hoy + p.totales.neto_por_cobrar_desde_hoy, p.totales.neto);
  assert.equal(p.totales.neto_por_cobrar_desde_hoy, 33244.38);
  const porDia = Object.fromEntries(p.filas.map((f: any) => [f.grupo, f]));
  assert.equal(porDia['2026-11-14'].neto, 8372.5);
  assert.equal(porDia['2026-11-14'].ventas - porDia['2026-11-14'].debitos, 8372.5);
  assert.equal(porDia['2026-11-17'].neto, 4880.53);
  assert.equal(p.filas.length, 10);
});

test('flujo por tipo de crédito: las 13 filas suman 425 337,81 con SIN CATALOGO = 30 460,09', async () => {
  const tipos = [
    ['SIN CATALOGO', '30460.09'], ['CORRIENTE', '51855.39'], ['DIFERIDO CON INTERESES HASTA 36 MESES', '38351.90'],
    ['DIFERIDO CON INTERESES HASTA 36 MESES CON MESES DE GRACIA', '164516.98'], ['DIFERIDO PREFERENTE A 12 MESES', '14789.57'],
    ['DIFERIDO PREFERENTE A 18 MESES', '1341.95'], ['DIFERIDO PREFERENTE A 24 MESES', '13328.96'], ['DIFERIDO PREFERENTE A 6 MESES', '5706.46'],
    ['ELECTRON', '3078.89'], ['PLAN 12 PAGOS SIN INTERESES', '4699.46'], ['PLAN 3 PAGOS SIN INTERESES', '8456.37'],
    ['PLAN 6 PAGOS SIN INTERESES', '10128.58'], ['PLAN 9 PAGOS SIN INTERESES', '78623.21']
  ].map(([grupo, neto]) => ({ grupo, subgrupo: '', ventas: neto, debitos: '0.00', neto }));
  const deps = fake([
    [/AS ultima_fecha_de_pago/, [{ ventas: '425337.81', debitos: '0', neto: '425337.81', neto_antes_de_hoy: '392093.43', neto_desde_hoy: '33244.38', ultima_fecha_de_pago: '2026-12-14' }]],
    [/AS neto_preliquidado/, [{ neto_preliquidado: '0', neto_liquidado: '0', sin_catalogo_filas: 0, sin_catalogo_valor: '0', filas_formato_invalido: 0 }]],
    [/AS grupo/, tipos]
  ]);
  const p = payload(await handlePagosTarjetas({ vista: 'flujo', agrupar_por: 'tipo_credito', fecha_desde: '2026-09-01', fecha_hasta: '2026-11-19' }, deps, NOW));
  assert.equal(p.filas.length, 13);
  assert.equal(p.filas.reduce((a: number, f: any) => a + f.neto, 0).toFixed(2), '425337.81');
  assert.equal(p.filas[0].grupo, 'SIN CATALOGO');
});

test('por cobrar desde hoy (25-nov): 33 244,38 netos entre el 25-nov y el 14-dic, con débitos restando; solo un horizonte corto', async () => {
  const dias = [
    ['2026-11-25', '8477.62', '0.00', '8477.62'], ['2026-11-26', '6589.53', '0.00', '6589.53'], ['2026-11-27', '1346.06', '0.00', '1346.06'],
    ['2026-11-29', '13295.59', '5154.09', '8141.50'], ['2026-12-05', '4520.22', '1721.98', '2798.24'], ['2026-12-14', '5891.43', '0.00', '5891.43']
  ].map(([grupo, ventas, debitos, neto]) => ({ grupo, subgrupo: '', ventas, debitos, neto }));
  const deps = fake([
    [/AS ultima_fecha_de_pago/, [{ ventas: '40120.45', debitos: '6876.07', neto: '33244.38', neto_antes_de_hoy: '0', neto_desde_hoy: '33244.38', ultima_fecha_de_pago: '2026-12-14' }]],
    [/AS neto_preliquidado/, [{ neto_preliquidado: '24766.76', neto_liquidado: '8477.62', sin_catalogo_filas: 2, sin_catalogo_valor: '1200.00', filas_formato_invalido: 24 }]],
    [/AS grupo/, dias]
  ]);
  const p = payload(await handlePagosTarjetas({ vista: 'por_cobrar' }, deps, NOW));
  assert.equal(p.vista, 'por_cobrar');
  assert.equal(p.periodo.desde, '2026-11-25');
  assert.equal(p.totales.ventas, 40120.45);
  assert.equal(p.totales.debitos, 6876.07);
  assert.equal(p.totales.neto, 33244.38);
  assert.equal(p.totales.ultima_fecha_de_pago, '2026-12-14');
  assert.equal(p.filas.length, 6);
  assert.equal(p.filas.reduce((a: number, f: any) => a + f.neto, 0).toFixed(2), '33244.38');
  assert.ok(p.observaciones.some((o: string) => /Preliquidado: 24,766\.76 \(74\.5 % del neto\)/.test(o)));
  assert.ok(p.observaciones.some((o: string) => /horizonte corto/.test(o)));
  assert.ok(!p.observaciones.some((o: string) => /columnas corridas/.test(o)), 'en por cobrar no se avisa de las filas corridas');
});

test('observaciones: avisa de las filas corridas en el resumen y un parámetro inválido da un error legible sin consultar', async () => {
  assert.ok(armarObservaciones({ filas_formato_invalido: 141 }, 'resumen', 'neto').some((o) => /141 fila\(s\).*columnas corridas.*No afectan a los pagos por venir/.test(o)));
  assert.ok(!armarObservaciones({ neto_preliquidado: 0, neto_liquidado: 5 }, 'flujo', 'bruto').some((o) => /Preliquidado|Valores netos/.test(o)));
  let llamadas = 0;
  const deps: PagosTarjetasDeps = { consultar: async () => { llamadas++; return { rows: [], truncated: false }; } };
  const r = await handlePagosTarjetas({ vista: 'flujo', marca: 'Amex' }, deps, NOW);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /marca inválida/);
  assert.equal(llamadas, 0);
});
