import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContactoQuery, CONTACTO_SELECT, handleEncontrarContacto } from '../src/mcp/tools/contactoTool';
import { dbService } from '../src/services/dbService';
import { validateReadOnlySql } from '../src/services/sqlGuard';

test('campo todos: los cinco campos con OR, valores enlazados y orden por id_lista DESC', () => {
  const q = buildContactoQuery({ texto: '0958978745' });
  validateReadOnlySql(q.sql);
  assert.equal(q.campo, 'todos');
  assert.equal(q.limite, 50);
  assert.match(q.sql, /R\.documento LIKE \? OR R\.nombres LIKE \? OR R\.telefono LIKE \? OR R\.correo LIKE \? OR U\.nombres LIKE \?/);
  assert.match(q.sql, /ORDER BY R\.id_lista DESC$/);
  assert.deepEqual(q.values, Array(5).fill('%0958978745%'));
  assert.doesNotMatch(q.sql, /0958978745/);
});

test('un solo campo: solo esa condición', () => {
  for (const [campo, col] of [['documento', 'R.documento'], ['telefono', 'R.telefono'], ['correo', 'R.correo']] as const) {
    const q = buildContactoQuery({ texto: 'abc123', campo });
    assert.match(q.sql, new RegExp(`WHERE ${col.replace('.', '\\.')} LIKE \\?\\nORDER`));
    assert.deepEqual(q.values, ['%abc123%']);
  }
});

test('nombres y asesor: todas las palabras en cualquier orden', () => {
  const n = buildContactoQuery({ texto: '  mino   carlos ', campo: 'nombres' });
  assert.match(n.sql, /\(R\.nombres LIKE \? AND R\.nombres LIKE \?\)/);
  assert.deepEqual(n.values, ['%mino%', '%carlos%']);
  const a = buildContactoQuery({ texto: 'samantha', campo: 'asesor' });
  assert.match(a.sql, /WHERE U\.nombres LIKE \?\n/);
});

test('comodines escritos por el usuario se escapan y la inyección queda como texto', () => {
  const q = buildContactoQuery({ texto: "100%_x' OR 1=1 --", campo: 'correo' });
  assert.deepEqual(q.values, ["%100\\%\\_x' OR 1=1 --%"]);
  assert.doesNotMatch(q.sql, /OR 1=1/);
  validateReadOnlySql(q.sql);
});

test('validaciones: mínimo de caracteres, máximo, campo y límite', () => {
  assert.throws(() => buildContactoQuery({ texto: '  a ' }), /al menos 3/);
  assert.throws(() => buildContactoQuery({ texto: '' }), /al menos 3/);
  assert.throws(() => buildContactoQuery({ texto: 'x'.repeat(81) }), /demasiado largo/);
  assert.throws(() => buildContactoQuery({ texto: 'abc', campo: 'password' as any }), /campo inválido/);
  assert.throws(() => buildContactoQuery({ texto: 'abc', limite: 0 }), /limite/);
  assert.throws(() => buildContactoQuery({ texto: 'abc', limite: 201 }), /limite/);
  assert.equal(buildContactoQuery({ texto: 'abc', limite: 10 }).limite, 10);
});

test('solo se leen las columnas acordadas (no la clave ni otros datos de usuarios)', () => {
  assert.match(CONTACTO_SELECT, /U\.nombres AS asesor/);
  assert.doesNotMatch(CONTACTO_SELECT, /password|hash|U\.\*|R\.\*/i);
});

test('mismo teléfono en dos bases (caso real): se devuelven los dos registros', async () => {
  const filas = [
    { id_lista: 914503, banco: 'LEADS', documento: '1', nombres: 'CALOLO', telefono: '0958978745', correo: 'NA', asesor: 'ONTANEDA SAMANIEGO SAMANTHA NAYELLI', estado: 'Llamar más tarde' },
    { id_lista: 780947, banco: 'MIS CONTACTOS', documento: '1719708677', nombres: 'MINO FLORES CARLOS ENRIQUE', telefono: '0958978745', correo: 'calolomino@gmail.com', asesor: 'VENDEDOR 21', estado: 'Interesado' }
  ];
  let visto: any;
  const original = dbService.executeReadOnlyQuery;
  (dbService as any).executeReadOnlyQuery = async (sql: string, max: number, values: unknown[], cap: number) => {
    visto = { sql, max, values, cap };
    return { rowCount: filas.length, rows: filas, truncated: false };
  };
  try {
    const r = await handleEncontrarContacto({ texto: '0958978745', campo: 'telefono' });
    assert.ok(!r.isError);
    const json = JSON.parse(r.content[0].text.split('```json\n')[1].split('\n```')[0]);
    assert.equal(json.contactos_devueltos, 2);
    assert.equal(json.hay_mas_resultados, false);
    assert.deepEqual(json.contactos.map((c: any) => c.id_lista), [914503, 780947]);
    assert.deepEqual(visto.values, ['%0958978745%']);
    assert.equal(visto.max, 50);
  } finally {
    (dbService as any).executeReadOnlyQuery = original;
  }
});

test('más resultados que el límite: avisa; sin resultados: avisa; error: isError', async () => {
  const original = dbService.executeReadOnlyQuery;
  try {
    (dbService as any).executeReadOnlyQuery = async () => ({ rowCount: 2, rows: [{ id_lista: 2 }, { id_lista: 1 }], truncated: true });
    let r = await handleEncontrarContacto({ texto: 'perez', campo: 'nombres', limite: 2 });
    assert.match(r.content[0].text, /"hay_mas_resultados":true/);
    assert.match(r.content[0].text, /Hay más de 2 coincidencias/);
    (dbService as any).executeReadOnlyQuery = async () => ({ rowCount: 0, rows: [], truncated: false });
    r = await handleEncontrarContacto({ texto: 'zzzz' });
    assert.match(r.content[0].text, /Sin coincidencias/);
    r = await handleEncontrarContacto({ texto: 'a' });
    assert.equal(r.isError, true);
  } finally {
    (dbService as any).executeReadOnlyQuery = original;
  }
});
