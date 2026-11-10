import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
// @ts-ignore módulo ESM sin tipos (servicio aparte, carpeta asterisk-gateway)
import { construirConsulta, crearLimitador, leerConfig, lotes, tokenValido, validarSolicitud } from '../asterisk-gateway/src/logic.mjs';
// @ts-ignore
import { crearApp } from '../asterisk-gateway/src/app.mjs';

const TOKEN = 'a'.repeat(40);
const ENV = { GATEWAY_TOKEN: TOKEN, DB_HOST: 'h', DB_USER: 'u', DB_PASSWORD: 'p' };

test('config: exige token de 32+ caracteres y datos de la base', () => {
  assert.throws(() => leerConfig({ ...ENV, GATEWAY_TOKEN: 'corto' }), /32/);
  assert.throws(() => leerConfig({ ...ENV, DB_PASSWORD: '' }), /DB_PASSWORD/);
  assert.throws(() => leerConfig({ ...ENV, CDR_DB: 'x;drop' }), /CDR_DB/);
  assert.equal(leerConfig(ENV).cdrDb, 'asterisk');
  // archivos .env creados en Windows traen \r al final de cada valor
  const c = leerConfig({ ...ENV, GATEWAY_TOKEN: `${TOKEN}\r`, DB_PASSWORD: 'p\r' });
  assert.equal(c.token, TOKEN);
  assert.equal(c.db.password, 'p');
});

test('token: solo "Bearer <token>" exacto', () => {
  assert.equal(tokenValido(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(tokenValido(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(tokenValido(TOKEN, TOKEN), false);
  assert.equal(tokenValido(undefined, TOKEN), false);
});

test('solicitud: teléfonos con 0 inicial y 10 dígitos, fechas reales, hasta inclusivo', () => {
  const s = validarSolicitud({ telefonos: ['0969816358', '0969816358', '0987502584'], desde: '2026-01-01', hasta: '2026-12-31' });
  assert.deepEqual(s.telefonos, ['0969816358', '0987502584']);
  assert.equal(s.hastaExcl, '2027-01-01');
  const mal = (c: unknown) => assert.throws(() => validarSolicitud(c), (e: any) => e.status === 400);
  mal({ telefonos: ['969816358'], desde: '2026-01-01', hasta: '2026-01-02' }); // sin 0 inicial
  mal({ telefonos: ["0969816358' OR 1=1"], desde: '2026-01-01', hasta: '2026-01-02' });
  mal({ telefonos: [969816358], desde: '2026-01-01', hasta: '2026-01-02' }); // número, no texto
  mal({ telefonos: [], desde: '2026-01-01', hasta: '2026-01-02' });
  mal({ telefonos: ['0969816358'], desde: '2026-02-30', hasta: '2026-03-01' });
  mal({ telefonos: ['0969816358'], desde: '2026-03-02', hasta: '2026-03-01' });
  mal({ telefonos: ['0969816358'], desde: '2020-01-01', hasta: '2026-03-01' }); // más de 1100 días
  mal(null);
});

test('consulta: valores enlazados, rango semiabierto y base validada', () => {
  const { sql, params } = construirConsulta('asterisk', ['0969816358', '0987502584'], '2026-01-01', '2027-01-01');
  assert.match(sql, /FROM `asterisk`\.`cdr`/);
  assert.match(sql, /calldate >= \? AND calldate < \? AND dst IN \(\?,\?\) GROUP BY dst/);
  assert.doesNotMatch(sql, /0969816358/);
  assert.deepEqual(params, ['2026-01-01 00:00:00', '2027-01-01 00:00:00', '0969816358', '0987502584']);
  assert.throws(() => construirConsulta('a`b', ['0969816358'], '2026-01-01', '2027-01-01'));
});

test('lotes y limitador', () => {
  assert.deepEqual(lotes([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  let t = 0;
  const p = crearLimitador(2, 1000, () => t);
  assert.deepEqual([p('a'), p('a'), p('a'), p('b')], [true, true, false, true]);
  t = 1500;
  assert.equal(p('a'), true);
});

async function conServidor(consultar: (sql: string, params: any[]) => Promise<any[]>, fn: (url: string) => Promise<void>) {
  const server = crearApp({ config: { token: TOKEN, cdrDb: 'asterisk' }, consultar });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (url: string, cuerpo: unknown, token: string | null = TOKEN) =>
  fetch(`${url}/cdr/resumen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(cuerpo)
  });

test('servicio: health, sin token 401, token incorrecto 401, solicitud inválida 400', async () => {
  await conServidor(async () => [], async (url) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const ok = { telefonos: ['0969816358'], desde: '2026-01-01', hasta: '2026-12-31' };
    assert.equal((await post(url, ok, null)).status, 401);
    assert.equal((await post(url, ok, 'b'.repeat(40))).status, 401);
    assert.equal((await post(url, { ...ok, telefonos: ['969816358'] })).status, 400);
    assert.equal((await fetch(`${url}/otra`)).status, 404);
  });
});

test('servicio: divide en lotes de 500 y devuelve las cifras como números', async () => {
  const llamadas: any[][] = [];
  const fake = async (_sql: string, params: any[]) => {
    llamadas.push(params);
    return [{ dst: '0969816358', llamadas: '7', duracion: '1249', billsec: '1132', ultima_llamada: '2026-11-05 18:04:00' }];
  };
  await conServidor(fake, async (url) => {
    const telefonos = Array.from({ length: 1200 }, (_, i) => `0${String(900000000 + i)}`);
    const r = await post(url, { telefonos, desde: '2026-01-01', hasta: '2026-11-10' });
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(llamadas.length, 3);
    assert.equal(j.telefonos_consultados, 1200);
    assert.deepEqual(j.registros[0], { dst: '0969816358', llamadas: 7, duracion: 1249, billsec: 1132, ultima_llamada: '2026-11-05 18:04:00' });
  });
});

test('servicio: si Asterisk falla responde 502 sin detalles', async () => {
  await conServidor(async () => { throw Object.assign(new Error('secreto interno'), { code: 'ECONNREFUSED' }); }, async (url) => {
    const r = await post(url, { telefonos: ['0969816358'], desde: '2026-01-01', hasta: '2026-12-31' });
    assert.equal(r.status, 502);
    assert.doesNotMatch(await r.text(), /secreto/);
  });
});

test('servicio: bloquea tras 10 tokens incorrectos por minuto', async () => {
  await conServidor(async () => [], async (url) => {
    const ok = { telefonos: ['0969816358'], desde: '2026-01-01', hasta: '2026-12-31' };
    const estados = [];
    for (let i = 0; i < 12; i++) estados.push((await post(url, ok, 'c'.repeat(40))).status);
    assert.equal(estados.slice(0, 10).every((s) => s === 401), true);
    assert.equal(estados[11], 429);
  });
});
