import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENTE_SELECT, buildClienteQuery, formatearCliente, handleEncontrarCliente, nucleoTelefono
} from '../src/mcp/tools/clienteTool';
import { EncontrarClienteInputSchema } from '../src/mcp/types';
import { dbService } from '../src/services/dbService';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text.split('```json\n')[1].split('\n```')[0]);

async function conDb<T>(rows: any[], truncated: boolean, fn: (visto: { sql: string; max: number; values: unknown[]; cap: number }) => Promise<T>): Promise<T> {
  const visto: any = {};
  const original = dbService.executeReadOnlyQuery;
  (dbService as any).executeReadOnlyQuery = async (sql: string, max: number, values: unknown[], cap: number) => {
    Object.assign(visto, { sql, max, values, cap });
    return { rowCount: rows.length, rows, truncated };
  };
  try {
    return await fn(visto);
  } finally {
    (dbService as any).executeReadOnlyQuery = original;
  }
}

test('teléfono: solo dígitos, sin 0 inicial ni código de país (formatos reales de mve_clientes)', () => {
  // 43 676 celulares con 10 dígitos que empiezan con 09 y 4 345 de 9 dígitos que empiezan con 99 (sin el 0 inicial)
  assert.equal(nucleoTelefono('0969816358'), '969816358');
  assert.equal(nucleoTelefono('969816358'), '969816358');
  assert.equal(nucleoTelefono('0969 816-358'), '969816358');
  assert.equal(nucleoTelefono('+593 969 816 358'), '969816358');
  assert.equal(nucleoTelefono('593969816358'), '969816358');
  assert.equal(nucleoTelefono('00593969816358'), '969816358');
  assert.equal(nucleoTelefono('5930969816358'), '969816358');
  assert.equal(nucleoTelefono('(02) 255-1234'), '22551234');
  // un número local que empieza con 593 y es corto no se confunde con el código de país
  assert.equal(nucleoTelefono('5931234'), '5931234');
  assert.equal(nucleoTelefono('juan perez'), '');
});

test('campo telefono: busca en celular, teléfono 1 y teléfono 2 por dígitos, con valores enlazados', () => {
  const q = buildClienteQuery({ texto: '0969 816-358', campo: 'telefono' });
  validateReadOnlySql(q.sql);
  assert.match(q.sql, /WHERE \(REGEXP_REPLACE\(C\.cli_celular, '\[\^0-9\]', ''\) LIKE \? OR REGEXP_REPLACE\(C\.cli_telefono1, '\[\^0-9\]', ''\) LIKE \? OR REGEXP_REPLACE\(C\.cli_telefono2, '\[\^0-9\]', ''\) LIKE \?\)\nORDER BY C\.cli_codigo DESC$/);
  assert.deepEqual(q.values, ['%969816358%', '%969816358%', '%969816358%']);
  assert.doesNotMatch(q.sql, /969816358/);
});

test('campo todos con un texto de dígitos: documento, nombres, teléfono y correo con OR', () => {
  const q = buildClienteQuery({ texto: '0969816358' });
  validateReadOnlySql(q.sql);
  assert.equal(q.campo, 'todos');
  assert.equal(q.limite, 50);
  assert.match(q.sql, /WHERE C\.cli_cedula LIKE \? OR CONCAT_WS\(' ', C\.cli_nombre, C\.cli_apellido\) LIKE \? OR \(REGEXP_REPLACE/);
  assert.match(q.sql, /C\.cli_email LIKE \?\nORDER BY/);
  assert.deepEqual(q.values, ['%0969816358%', '%0969816358%', '%969816358%', '%969816358%', '%969816358%', '%0969816358%']);
});

test('campo todos con un nombre: no se activa la condición de teléfono', () => {
  const q = buildClienteQuery({ texto: 'carlos mino' });
  validateReadOnlySql(q.sql);
  assert.doesNotMatch(q.sql, /REGEXP_REPLACE\(C\.cli_celular/);
  assert.deepEqual(q.values, ['%carlos mino%', '%carlos%', '%mino%', '%carlos mino%']);
});

test('un solo campo: solo esa condición', () => {
  const d = buildClienteQuery({ texto: '1719708677', campo: 'documento' });
  assert.match(d.sql, /WHERE C\.cli_cedula LIKE \?\nORDER/);
  assert.deepEqual(d.values, ['%1719708677%']);
  const c = buildClienteQuery({ texto: 'calolomino@gmail.com', campo: 'correo' });
  assert.match(c.sql, /WHERE C\.cli_email LIKE \?\nORDER/);
  assert.deepEqual(c.values, ['%calolomino@gmail.com%']);
});

test('nombres: todas las palabras en cualquier orden entre nombre y apellido', () => {
  const n = buildClienteQuery({ texto: '  mino   carlos ', campo: 'nombres' });
  assert.match(n.sql, /WHERE \(CONCAT_WS\(' ', C\.cli_nombre, C\.cli_apellido\) LIKE \? AND CONCAT_WS\(' ', C\.cli_nombre, C\.cli_apellido\) LIKE \?\)\nORDER/);
  assert.deepEqual(n.values, ['%mino%', '%carlos%']);
});

test('comodines escritos por el usuario se escapan y la inyección queda como texto', () => {
  const q = buildClienteQuery({ texto: "100%_x' OR 1=1 --", campo: 'correo' });
  assert.deepEqual(q.values, ["%100\\%\\_x' OR 1=1 --%"]);
  assert.doesNotMatch(q.sql, /OR 1=1/);
  validateReadOnlySql(q.sql);
  const t = buildClienteQuery({ texto: "5551234'; DROP TABLE mve_clientes; --", campo: 'telefono' });
  assert.deepEqual(t.values, Array(3).fill('%5551234%'));
  assert.doesNotMatch(t.sql, /DROP/);
});

test('validaciones: mínimo, máximo, campo, límite y dígitos mínimos del teléfono', () => {
  assert.throws(() => buildClienteQuery({ texto: '  a ' }), /al menos 3/);
  assert.throws(() => buildClienteQuery({ texto: 'SD' }), /al menos 3/);
  assert.throws(() => buildClienteQuery({ texto: 'x'.repeat(81) }), /demasiado largo/);
  assert.throws(() => buildClienteQuery({ texto: 'abc', campo: 'clave' as any }), /campo inválido/);
  assert.throws(() => buildClienteQuery({ texto: 'abc', limite: 0 }), /limite/);
  assert.throws(() => buildClienteQuery({ texto: 'abc', limite: 201 }), /limite/);
  assert.throws(() => buildClienteQuery({ texto: 'abcdef', campo: 'telefono' }), /al menos 3 dígitos/);
  assert.throws(() => buildClienteQuery({ texto: '+0 0 12', campo: 'telefono' }), /al menos 3 dígitos/);
  assert.equal(buildClienteQuery({ texto: 'abc', limite: 10 }).limite, 10);
  assert.doesNotThrow(() => EncontrarClienteInputSchema.parse({ texto: 'abc', campo: 'telefono', limite: 5 }));
  assert.throws(() => EncontrarClienteInputSchema.parse({ texto: 'abc', campo: 'clave' }));
});

test('solo se leen las columnas acordadas (nunca clave, login, token, estado, dirección ni fecha de nacimiento)', () => {
  assert.doesNotMatch(CLIENTE_SELECT, /cli_clave|cli_login|cli_token|cli_estado\b|cli_direccion|cli_fecha_nacimiento|cli_ingresos|cli_observaciones|C\.\*|U\.usu_pass|usu_email|usu_login/i);
  for (const col of ['cli_codigo', 'cli_nombre', 'cli_apellido', 'cli_tipo_id', 'cli_cedula', 'cli_email', 'cli_celular', 'cli_telefono1', 'cli_telefono2', 'cli_ciudad', 'cli_vendedor', 'cli_fecha_ingreso']) {
    assert.match(CLIENTE_SELECT, new RegExp(`C\\.${col}`));
  }
});

test("el valor vacío del CRM ('SD') se devuelve como null y el vendedor desconocido queda sin nombre", () => {
  const f = formatearCliente({
    id_cliente: 67680, nombres: 'ANA', apellidos: 'PEREZ', tipo_documento: 'CEDULA', documento: '0921234567', correo: 'SD',
    celular: '0982123456', telefono1: 'SD', telefono2: '  ', ciudad: 'GUAYAQUIL', vendedor: null, id_vendedor: 0, fecha_ingreso: '2026-11-24', clientes_con_mismo_documento: null
  });
  assert.equal(f.correo, null);
  assert.equal(f.telefono1, null);
  assert.equal(f.telefono2, null);
  assert.equal(f.celular, '0982123456');
  assert.equal(f.vendedor, null);
  assert.equal(f.id_vendedor, null);
  assert.equal(f.clientes_con_mismo_documento, null);
});

test('documento repetido (hay 1 498 documentos repetidos en 3 382 clientes): se devuelven todos y se avisa', async () => {
  const filas = [
    { id_cliente: 60001, nombres: 'ANA', apellidos: 'PEREZ', tipo_documento: 'CEDULA', documento: '0912345678', correo: 'ana@x.com', celular: '0982111111', telefono1: 'SD', telefono2: 'SD', ciudad: 'GUAYAQUIL', id_vendedor: 837, vendedor: 'SIMBANA VILLACIS KENNY MATHIAS', fecha_ingreso: '2026-01-10', clientes_con_mismo_documento: 2 },
    { id_cliente: 45002, nombres: 'ANA MARIA', apellidos: 'PEREZ', tipo_documento: 'CEDULA', documento: '0912345678', correo: 'SD', celular: 'SD', telefono1: 'SD', telefono2: 'SD', ciudad: null, id_vendedor: 0, vendedor: null, fecha_ingreso: '2023-05-02', clientes_con_mismo_documento: 2 }
  ];
  await conDb(filas, false, async (visto) => {
    const r = await handleEncontrarCliente({ texto: '0912345678', campo: 'documento' });
    assert.ok(!r.isError);
    const j = payload(r);
    assert.equal(j.clientes_devueltos, 2);
    assert.deepEqual(j.clientes.map((c: any) => c.id_cliente), [60001, 45002]);
    assert.equal(j.clientes[1].correo, null);
    assert.ok(j.avisos.some((a: string) => /2 cliente\(s\).*comparten su documento/.test(a)));
    assert.deepEqual(visto.values, ['%0912345678%']);
    assert.equal(visto.max, 50);
    assert.equal(visto.cap, 200);
  });
});

test('más resultados que el límite: avisa; sin resultados: avisa; error: isError', async () => {
  await conDb([{ id_cliente: 2 }, { id_cliente: 1 }], true, async () => {
    const r = await handleEncontrarCliente({ texto: 'perez', campo: 'nombres', limite: 2 });
    assert.match(r.content[0].text, /"hay_mas_resultados":true/);
    assert.match(r.content[0].text, /Hay más de 2 coincidencias/);
  });
  await conDb([], false, async () => {
    const r = await handleEncontrarCliente({ texto: 'zzzz' });
    assert.match(r.content[0].text, /Sin coincidencias/);
    const e = await handleEncontrarCliente({ texto: 'a' });
    assert.equal(e.isError, true);
    const t = await handleEncontrarCliente({ texto: 'abc', campo: 'telefono' });
    assert.equal(t.isError, true);
  });
});
