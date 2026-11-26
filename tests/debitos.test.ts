import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DebitosDeps, armarResumen, buildConsultasDebitos, formatearAlerta, handleDebitos } from '../src/mcp/tools/debitosTool';
import { DebitosInterdinInputSchema } from '../src/mcp/types';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(/```json\n([\s\S]*)\n```/.exec(r.content[0].text)![1]);

// Cifras reales de la conciliación de Diners (banco 26), 26-nov-2026: abril = 4 solo en procesamientos (3 × 50,00 LQ + 253,93 PR) y 2 ajustes repetidos.
const FILAS_ABRIL = [
  { id: 19788, tipo: 'SOLO_EN_PROCESAMIENTOS', severidad: 'ALTA', banco: 26, anio: 2026, mes: 4, recap: '9164182', vale: '9164205', tarjeta4: '', fecha_pago: '2026-04-24', valor: '50.00', valor_otro: null, liquidado: 'LQ', detalle: 'Débito de 50.00 ...', refs: '19788', estado: 'NUEVA', comentario: null, usuario: null, fecha_estado: null },
  { id: 16121, tipo: 'SOLO_EN_PROCESAMIENTOS', severidad: 'MEDIA', banco: 26, anio: 2026, mes: 4, recap: '9162685', vale: '9162702', tarjeta4: '', fecha_pago: '2026-04-05', valor: '253.93', valor_otro: null, liquidado: 'PR', detalle: 'Débito de 253.93 ...', refs: '16121', estado: 'NUEVA', comentario: null, usuario: null, fecha_estado: null }
];

function deps(filas: any[], truncated = false, extra: Partial<Record<'porTipo' | 'porPeriodo' | 'meta', any[]>> = {}) {
  const llamadas: Array<{ sql: string; max: number; values: Array<string | number>; cap: number }> = [];
  const d: DebitosDeps = {
    consultar: async (sql, max, values, cap) => {
      llamadas.push({ sql, max, values, cap });
      if (/GROUP BY tipo, estado/.test(sql)) return { rows: extra.porTipo ?? [{ tipo: 'SOLO_EN_PROCESAMIENTOS', estado: 'NUEVA', cantidad: 4, valor: '403.93' }, { tipo: 'AJUSTE_REPETIDO', estado: 'NUEVA', cantidad: 2, valor: '100.00' }], truncated: false };
      if (/GROUP BY banco, anio, mes/.test(sql)) return { rows: extra.porPeriodo ?? [{ banco: 26, anio: 2026, mes: 4, cantidad: 6, valor: '503.93' }], truncated: false };
      if (/MAX\(fecha_creacion\)/.test(sql)) return { rows: extra.meta ?? [{ ultima_alerta_creada: '2026-11-26 21:10', ultimo_cambio_de_estado: null, alertas_en_total: 109 }], truncated: false };
      return { rows: filas, truncated };
    }
  };
  return { d, llamadas };
}

test('todas las combinaciones de filtros generan SQL de solo lectura válido y sin valores incrustados', () => {
  const casos = [
    {}, { vista: 'resumen' as const }, { marca: 'Diners', mes: 9, anio: 2026 }, { tipo: 'EXCEDE_VENTA', severidad: 'ALTA', estado: 'todas' },
    { fecha_desde: '2026-09-01', fecha_hasta: '2026-09-30', estado: 'AUTO_RESUELTA', limite: 200 }
  ];
  for (const c of casos) {
    const q = buildConsultasDebitos(c);
    for (const sql of [q.detalleSql, q.porTipoSql, q.porPeriodoSql, q.metaSql]) assert.doesNotThrow(() => validateReadOnlySql(sql), sql);
    // los valores del usuario no aparecen en la parte WHERE (el ORDER BY FIELD lleva 'ALTA', 'MEDIA' y 'BAJA' como constantes propias)
    const where = q.detalleSql.split('\nORDER BY')[0];
    for (const v of q.values) if (typeof v === 'string') assert.ok(!where.includes(v), `valor incrustado: ${v}`);
    assert.equal((where.match(/\?/g) ?? []).length, q.values.length);
  }
});

test('por defecto: alertas abiertas de todos los meses y marcas; marca y período se enlazan como valores', () => {
  const d = buildConsultasDebitos({});
  assert.match(d.detalleSql, /WHERE estado IN \('NUEVA', 'REVISADA', 'RECLAMADA'\)\nORDER BY FIELD\(severidad, 'ALTA', 'MEDIA', 'BAJA'\)/);
  assert.deepEqual(d.values, []);
  assert.equal(d.limite, 50);
  const f = buildConsultasDebitos({ marca: 'diners', mes: 9, anio: 2026, tipo: 'SOLO_EN_CSV', estado: 'todas' });
  assert.match(f.detalleSql, /WHERE banco = \? AND anio = \? AND mes = \? AND tipo = \?\nORDER BY/);
  assert.deepEqual(f.values, [26, 2026, 9, 'SOLO_EN_CSV']);
  const m = buildConsultasDebitos({ marca: 'Mastercard' });
  assert.deepEqual(m.values.slice(0, 1), [6]);
  assert.equal(buildConsultasDebitos({ marca: 'Visa' }).values[0], 4);
  assert.equal(buildConsultasDebitos({ marca: 'Discover' }).values[0], 15);
  const e = buildConsultasDebitos({ estado: 'AUTO_RESUELTA' });
  assert.match(e.detalleSql, /WHERE estado = \?\n/);
  assert.deepEqual(e.values, ['AUTO_RESUELTA']);
});

test('la inyección en los filtros se rechaza o queda como valor enlazado', () => {
  assert.throws(() => buildConsultasDebitos({ tipo: "X' OR 1=1 --" }), /tipo inválido/);
  assert.throws(() => buildConsultasDebitos({ estado: 'x; DROP TABLE y' }), /estado inválido/);
  assert.throws(() => buildConsultasDebitos({ severidad: 'ALTA OR 1=1' }), /severidad inválida/);
  assert.throws(() => buildConsultasDebitos({ marca: 'abc' }), /marca inválida/);
  assert.throws(() => buildConsultasDebitos({ fecha_desde: "2026-01-01' OR '1'='1" }), /YYYY-MM-DD/);
  assert.throws(() => buildConsultasDebitos({ mes: 13 }), /mes inválido/);
  assert.throws(() => buildConsultasDebitos({ limite: 0 }), /limite/);
  assert.throws(() => buildConsultasDebitos({ limite: 201 }), /limite/);
  assert.throws(() => buildConsultasDebitos({ vista: 'x' as any }), /vista inválida/);
  assert.throws(() => DebitosInterdinInputSchema.parse({ tipo: 'OTRO' }));
  assert.doesNotThrow(() => DebitosInterdinInputSchema.parse({ marca: 'Diners', mes: 9, anio: 2026, tipo: 'SIN_VENTA', limite: 10 }));
});

test('solo se leen las columnas con GRANT (nunca la llave interna) y solo de la tabla de alertas', () => {
  const q = buildConsultasDebitos({});
  for (const sql of [q.detalleSql, q.porTipoSql, q.porPeriodoSql, q.metaSql]) {
    assert.doesNotMatch(sql, /llave|SELECT \*|\.\*/);
    assert.match(sql, /FROM mvevip_cruce\.cruce_alertas_debitos/);
    assert.doesNotMatch(sql, /mve_tarjetas_procesamientos|\bJOIN\b/i);
  }
});

test('caso real de abril (Diners): alertas con liquidado/preliquidado, resumen por tipo y estado del cruce', async () => {
  const { d, llamadas } = deps(FILAS_ABRIL);
  const r = await handleDebitos({ marca: 'Diners', anio: 2026, mes: 4 }, d);
  assert.ok(!r.isError);
  const j = payload(r);
  assert.equal(j.resumen.total_alertas, 6);
  assert.equal(j.resumen.por_tipo.SOLO_EN_PROCESAMIENTOS.cantidad, 4);
  assert.equal(j.resumen.por_tipo.SOLO_EN_PROCESAMIENTOS.valor, 403.93);
  assert.equal(j.resumen.por_tipo.AJUSTE_REPETIDO.valor, 100);
  assert.deepEqual(j.resumen.por_periodo, [{ marca: 'Diners', anio: 2026, mes: 4, cantidad: 6, valor: 503.93 }]);
  assert.equal(j.alertas_devueltas, 2);
  assert.equal(j.alertas[0].liquidado, 'liquidado');
  assert.equal(j.alertas[1].liquidado, 'preliquidado (provisional)');
  assert.equal(j.alertas[1].valor, 253.93);
  assert.equal(j.alertas[0].tarjeta_ultimos4, null);
  assert.equal(j.alertas[0].periodo, '2026-04');
  assert.equal(j.estado_del_cruce.alertas_en_total, 109);
  assert.deepEqual(j.filtros, { marca: 'Diners', anio: 2026, mes: 4, estado: 'abiertas' });
  assert.ok(j.observaciones.some((o: string) => /no haberse conciliado todavía/.test(o)));
  const detalle = llamadas.find((l) => /FROM mvevip_cruce\.cruce_alertas_debitos\nWHERE/.test(l.sql) && /ORDER BY FIELD/.test(l.sql))!;
  assert.deepEqual(detalle.values, [26, 2026, 4]);
  assert.equal(detalle.max, 50);
  assert.equal(detalle.cap, 200);
});

test('caso real de septiembre (Diners): los rechazados ya no están y las 16 auto-resueltas solo salen con estado=todas', async () => {
  const porTipo = [{ tipo: 'SOLO_EN_CSV', estado: 'AUTO_RESUELTA', cantidad: 16, valor: '10094.20' }, { tipo: 'SOLO_EN_PROCESAMIENTOS', estado: 'NUEVA', cantidad: 4, valor: '1000.00' }];
  const { d } = deps([], false, { porTipo, porPeriodo: [{ banco: 26, anio: 2026, mes: 9, cantidad: 20, valor: '11094.20' }] });
  const j = payload(await handleDebitos({ vista: 'resumen', marca: 'Diners', mes: 9, anio: 2026, estado: 'todas' }, d));
  assert.equal(j.vista, 'resumen');
  assert.equal(j.alertas, undefined);
  assert.equal(j.resumen.total_alertas, 20);
  assert.deepEqual(j.resumen.por_tipo.SOLO_EN_CSV.por_estado, { AUTO_RESUELTA: 16 });
  assert.match(j.resumen.por_tipo.SOLO_EN_CSV.significado, /NO está en procesamientos/);
  assert.ok(j.observaciones.some((o: string) => /vales rechazados/.test(o)));
});

test('más alertas que el límite: avisa; sin alertas: lo dice; error de la base: isError', async () => {
  const { d } = deps(FILAS_ABRIL, true);
  const j = payload(await handleDebitos({ limite: 2 }, d));
  assert.equal(j.hay_mas_resultados, true);
  assert.ok(j.observaciones.some((o: string) => /más de 2 alertas/.test(o)));

  const vacio = deps([], false, { porTipo: [], porPeriodo: [] });
  const k = payload(await handleDebitos({ marca: 'Discover', mes: 4, anio: 2026 }, vacio.d));
  assert.equal(k.resumen.total_alertas, 0);
  assert.ok(k.observaciones.includes('Sin alertas con esos filtros.'));

  const roto: DebitosDeps = { consultar: async () => { throw new Error("SELECT command denied to user 'mcp_ro'"); } };
  const e = await handleDebitos({}, roto);
  assert.equal(e.isError, true);
  assert.match(e.content[0].text, /denied/);
  const bad = await handleDebitos({ tipo: 'NADA' }, d);
  assert.equal(bad.isError, true);
});

test('formatearAlerta y armarResumen no fallan con valores vacíos', () => {
  const a = formatearAlerta({ id: 1, tipo: 'SIN_VENTA', severidad: 'MEDIA', banco: 4, anio: 2026, mes: 3, recap: '', vale: null, tarjeta4: '1545', fecha_pago: null, valor: '465.50', valor_otro: null, liquidado: null, detalle: null, refs: null, estado: 'NUEVA', comentario: null, usuario: null, fecha_estado: null });
  assert.equal(a.marca, 'Visa');
  assert.equal(a.lote, null);
  assert.equal(a.vale, null);
  assert.equal(a.liquidado, null);
  assert.equal(a.valor, 465.5);
  assert.deepEqual(armarResumen([], []), { total_alertas: 0, por_tipo: {}, por_periodo: [] });
});
