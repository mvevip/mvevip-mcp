import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOTE_MAX_VALORES, coincidePor, prepararLote } from '../src/mcp/tools/loteUtils';
import { buildClienteLoteQuery, handleEncontrarCliente } from '../src/mcp/tools/clienteTool';
import { buildContactoLoteQuery, handleEncontrarContacto } from '../src/mcp/tools/contactoTool';
import { EncontrarClienteInputSchema, EncontrarContactoInputSchema } from '../src/mcp/types';
import { dbService } from '../src/services/dbService';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text.split('```json\n')[1].split('\n```')[0]);

async function conDb<T>(rows: any[], truncated: boolean, fn: (visto: { llamadas: number; sql: string; max: number; values: any[] }) => Promise<T>): Promise<T> {
  const visto: any = { llamadas: 0 };
  const original = dbService.executeReadOnlyQuery;
  (dbService as any).executeReadOnlyQuery = async (sql: string, max: number, values: unknown[]) => {
    visto.llamadas++;
    Object.assign(visto, { sql, max, values });
    return { rowCount: rows.length, rows, truncated };
  };
  try {
    return await fn(visto);
  } finally {
    (dbService as any).executeReadOnlyQuery = original;
  }
}

test('lista mixta de cédulas y celulares (campo todos): documento, teléfono si parece uno y correo si trae @', () => {
  const p = prepararLote(['0912345678', '969816358', 'Ana.Perez@Mail.com', 'AB123456', '+593 982 111 222', '0912345678', 'ab', ''], 'todos');
  assert.equal(p.recibidos, 8);
  assert.equal(p.repetidos, 1);
  assert.deepEqual(p.invalidos.map((i) => i.motivo), ['menos de 3 caracteres', 'valor vacío']);
  const [cedulaOCelular, celular, correo, pasaporte, internacional] = p.items;
  // un número de 10 dígitos puede ser cédula o celular: se prueban las dos cosas
  assert.deepEqual([cedulaOCelular.documento, cedulaOCelular.telefono], ['0912345678', '912345678']);
  assert.deepEqual([celular.documento, celular.telefono], ['969816358', '969816358']);
  assert.deepEqual([correo.correo, correo.documento, correo.telefono], ['ana.perez@mail.com', undefined, undefined]);
  assert.deepEqual([pasaporte.documento, pasaporte.telefono], ['ab123456', undefined]);
  assert.equal(internacional.telefono, '982111222');
  assert.equal(p.items.length, 5);
});

test('validaciones de la lista: máximo 100, nombres máximo 20, campo, teléfono corto y correo sin @', () => {
  assert.throws(() => prepararLote([], 'todos'), /al menos un valor/);
  assert.throws(() => prepararLote(Array(LOTE_MAX_VALORES + 1).fill('1234567'), 'todos'), /Máximo 100/);
  assert.doesNotThrow(() => prepararLote(Array.from({ length: 100 }, (_, i) => `09000000${String(i).padStart(2, '0')}`), 'telefono'));
  assert.throws(() => prepararLote(Array.from({ length: 21 }, (_, i) => `nombre${i}`), 'nombres'), /máximo es 20/);
  assert.throws(() => prepararLote(['abc'], 'asesor' as any), /campo inválido/);
  const t = prepararLote(['12345', '0969816358'], 'telefono');
  assert.equal(t.items.length, 1);
  assert.match(t.invalidos[0].motivo, /menos de 7 dígitos/);
  const c = prepararLote(['sin-arroba', 'a@b.co'], 'correo');
  assert.equal(c.items.length, 1);
  assert.match(c.invalidos[0].motivo, /falta @/);
});

test('coincidencia exacta: teléfono con y sin 0, con símbolos y con +593; documento y correo sin mayúsculas; nombres en cualquier orden', () => {
  const [tel] = prepararLote(['0969816358'], 'telefono').items;
  for (const guardado of ['0969816358', '969816358', '0969 816-358', '+593969816358', '593 969 816 358']) {
    assert.deepEqual(coincidePor(tel, { telefonos: [{ etiqueta: 'celular', valor: guardado }] }), ['celular'], guardado);
  }
  assert.deepEqual(coincidePor(tel, { telefonos: [{ etiqueta: 'celular', valor: '0969816359' }, { etiqueta: 'telefono1', valor: 'SD' }] }), []);
  // no es «contiene»: un número más largo que lo incluye no coincide
  assert.deepEqual(coincidePor(tel, { telefonos: [{ etiqueta: 'celular', valor: '10969816358' }] }), []);
  const [doc] = prepararLote(['0912345678'], 'documento').items;
  assert.deepEqual(coincidePor(doc, { documento: ' 0912345678 ' }), ['documento']);
  assert.deepEqual(coincidePor(doc, { documento: '09123456789' }), []);
  const [mail] = prepararLote(['Ana@Mail.com'], 'correo').items;
  assert.deepEqual(coincidePor(mail, { correo: 'ana@mail.com' }), ['correo']);
  const [nom] = prepararLote(['mino carlos'], 'nombres').items;
  assert.deepEqual(coincidePor(nom, { nombres: 'CARLOS ENRIQUE MINO FLORES' }), ['nombres']);
  assert.deepEqual(coincidePor(nom, { nombres: 'CARLOS PEREZ' }), []);
});

test('SQL de clientes por lista: una sola consulta de solo lectura con valores enlazados', () => {
  const { items } = prepararLote(['0912345678', 'ana@x.com', '0969816358', '22551234'], 'todos');
  const q = buildClienteLoteQuery(items);
  validateReadOnlySql(q.sql!);
  // el correo solo se busca como correo; los otros tres valores (incluido el de 8 dígitos) también como documento
  assert.match(q.sql!, /LOWER\(TRIM\(C\.cli_cedula\)\) IN \(\?, \?, \?\)/);
  assert.match(q.sql!, /LOWER\(TRIM\(C\.cli_email\)\) IN \(\?\)/);
  // teléfonos por sus últimos dígitos, agrupados por largo (9 y 8 dígitos), en los tres campos
  for (const col of ['cli_celular', 'cli_telefono1', 'cli_telefono2']) {
    assert.match(q.sql!, new RegExp(`RIGHT\\(REGEXP_REPLACE\\(C\\.${col}, '\\[\\^0-9\\]', ''\\), 9\\) IN \\(\\?, \\?\\)`));
    assert.match(q.sql!, new RegExp(`RIGHT\\(REGEXP_REPLACE\\(C\\.${col}, '\\[\\^0-9\\]', ''\\), 8\\) IN \\(\\?\\)`));
  }
  assert.match(q.sql!, /ORDER BY C\.cli_codigo DESC$/);
  assert.doesNotMatch(q.sql!, /0912345678|ana@x\.com|0969816358/);
  assert.ok(q.values.includes('0912345678') && q.values.includes('ana@x.com') && q.values.includes('969816358'));
  // si todos son inválidos no hay consulta
  assert.equal(buildClienteLoteQuery(prepararLote(['ab'], 'todos').items).sql, null);
});

const clientes = [
  { id_cliente: 60001, nombres: 'ANA', apellidos: 'PEREZ', tipo_documento: 'CEDULA', documento: '0912345678', correo: 'ana@x.com', celular: '0982111111', telefono1: 'SD', telefono2: 'SD', ciudad: 'GUAYAQUIL', id_vendedor: 837, vendedor: 'SIMBANA VILLACIS KENNY MATHIAS', fecha_ingreso: '2026-01-10', clientes_con_mismo_documento: 2 },
  { id_cliente: 45002, nombres: 'ANA MARIA', apellidos: 'PEREZ', tipo_documento: 'CEDULA', documento: '0912345678', correo: 'SD', celular: 'SD', telefono1: 'SD', telefono2: 'SD', ciudad: null, id_vendedor: 0, vendedor: null, fecha_ingreso: '2023-05-02', clientes_con_mismo_documento: 2 },
  { id_cliente: 50003, nombres: 'LUIS', apellidos: 'MORA', tipo_documento: 'CEDULA', documento: '1700000001', correo: 'luis@x.com', celular: '969816358', telefono1: '+593 969 816 358', telefono2: 'SD', ciudad: 'QUITO', id_vendedor: 169, vendedor: 'TOAPANTA ABATA PAOLA FERNANDA', fecha_ingreso: '2025-03-03', clientes_con_mismo_documento: null },
  // lo trae el conjunto amplio de la consulta pero NO coincide exactamente con nada de lo pedido
  { id_cliente: 40004, nombres: 'OTRO', apellidos: 'CLIENTE', tipo_documento: 'CEDULA', documento: '1799999999', correo: 'otro@x.com', celular: '10969816358', telefono1: 'SD', telefono2: 'SD', ciudad: null, id_vendedor: 0, vendedor: null, fecha_ingreso: '2020-01-01', clientes_con_mismo_documento: null }
];

test('encontrar_cliente por lista (50 datos serían igual): una sola consulta y una entrada por valor', async () => {
  await conDb(clientes, false, async (visto) => {
    const r = await handleEncontrarCliente({ valores: ['0912345678', '0969816358', 'luis@x.com', '1111111111', 'ab', '0912345678'] });
    assert.ok(!r.isError);
    const j = payload(r);
    assert.equal(visto.llamadas, 1, 'toda la lista va en una sola consulta');
    assert.equal(j.busqueda.modo, 'lista');
    assert.deepEqual(j.resumen, { valores_recibidos: 6, valores_buscados: 4, con_resultado: 3, sin_resultado: 1, con_varios_resultados: 1, clientes_distintos: 3 });
    assert.deepEqual(j.no_encontrados, ['1111111111']);
    assert.deepEqual(j.valores_invalidos, [{ valor: 'ab', motivo: 'menos de 3 caracteres' }]);
    const porConsulta = Object.fromEntries(j.resultados.map((x: any) => [x.consulta, x]));
    // la cédula repetida trae los dos clientes
    assert.deepEqual(porConsulta['0912345678'].clientes.map((c: any) => c.id_cliente), [60001, 45002]);
    assert.deepEqual(porConsulta['0912345678'].clientes[0].coincide_por, ['documento']);
    // el mismo celular en dos campos del mismo cliente, y el valor 'SD' devuelto como null
    assert.deepEqual(porConsulta['0969816358'].clientes.map((c: any) => c.id_cliente), [50003]);
    assert.deepEqual(porConsulta['0969816358'].clientes[0].coincide_por, ['celular', 'telefono1']);
    assert.equal(porConsulta['0969816358'].clientes[0].telefono2, null);
    assert.deepEqual(porConsulta['luis@x.com'].clientes[0].coincide_por, ['correo']);
    assert.equal(porConsulta['1111111111'].encontrados, 0);
    // el cliente que solo contiene el número no se devuelve (exacto, no «contiene»)
    assert.ok(!JSON.stringify(j.resultados).includes('40004'));
    assert.ok(j.avisos.some((a: string) => /coinciden con más de un cliente/.test(a)));
    assert.ok(j.avisos.some((a: string) => /1 valor\(es\) repetido\(s\)/.test(a)));
    assert.ok(j.avisos.some((a: string) => /no se pudieron buscar/.test(a)));
    assert.ok(j.avisos.some((a: string) => /comparten su documento/.test(a)));
  });
});

test('encontrar_cliente por lista: 100 valores, aviso si se llega al máximo de filas y sin consulta si todos son inválidos', async () => {
  const cien = Array.from({ length: 100 }, (_, i) => `09100000${String(i).padStart(2, '0')}`);
  await conDb([], true, async (visto) => {
    const j = payload(await handleEncontrarCliente({ valores: cien, campo: 'documento' }));
    assert.equal(visto.llamadas, 1);
    assert.equal(visto.max, 500);
    assert.equal(j.resumen.valores_buscados, 100);
    assert.equal(j.resumen.sin_resultado, 100);
    assert.ok(j.avisos.some((a: string) => /máximo de 500 filas/.test(a)));
  });
  await conDb([], false, async (visto) => {
    const j = payload(await handleEncontrarCliente({ valores: ['ab', 'cd'] }));
    assert.equal(visto.llamadas, 0);
    assert.equal(j.resumen.valores_buscados, 0);
  });
});

test('texto y valores: no se aceptan juntos ni ninguno; más de 100 valores y asesor en lista dan error legible', async () => {
  await conDb([], false, async (visto) => {
    for (const h of [handleEncontrarCliente, handleEncontrarContacto] as const) {
      let r = await h({ texto: 'abc', valores: ['0912345678'] });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /no ambos/);
      r = await h({});
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /texto .* o valores/);
      r = await h({ valores: Array(101).fill('0912345678') });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /Máximo 100/);
    }
    const a = await handleEncontrarContacto({ valores: ['0912345678'], campo: 'asesor' });
    assert.equal(a.isError, true);
    assert.match(a.content[0].text, /asesor/);
    assert.equal(visto.llamadas, 0);
  });
  assert.doesNotThrow(() => EncontrarClienteInputSchema.parse({ valores: ['0912345678'], campo: 'todos' }));
  assert.throws(() => EncontrarClienteInputSchema.parse({ texto: 'abc', valores: ['abc'] }));
  assert.throws(() => EncontrarClienteInputSchema.parse({}));
  assert.throws(() => EncontrarClienteInputSchema.parse({ valores: Array(101).fill('abc') }));
  assert.doesNotThrow(() => EncontrarContactoInputSchema.parse({ valores: ['0958978745'] }));
  assert.throws(() => EncontrarContactoInputSchema.parse({ texto: 'abc', valores: ['abc'] }));
});

test('SQL de contactos por lista: teléfono por su índice (con y sin 0), documento y correo exactos', () => {
  const { items } = prepararLote(['0958978745', '1719708677', 'calolomino@gmail.com'], 'todos');
  const q = buildContactoLoteQuery(items);
  validateReadOnlySql(q.sql!);
  // una cédula de 10 dígitos también se prueba como teléfono (con y sin 0): 2 valores x 2 formas
  assert.match(q.sql!, /R\.telefono IN \(\?, \?, \?, \?\)/);
  assert.match(q.sql!, /LOWER\(TRIM\(R\.documento\)\) IN \(\?, \?\)/);
  assert.match(q.sql!, /LOWER\(TRIM\(R\.correo\)\) IN \(\?\)/);
  assert.match(q.sql!, /ORDER BY R\.id_lista DESC$/);
  assert.deepEqual(q.values.slice(0, 2), ['0958978745', '958978745']);
  assert.doesNotMatch(q.sql!, /0958978745|calolomino/);
});

test('encontrar_contacto por lista (caso real): el mismo teléfono en dos bases devuelve los dos contactos de ese valor', async () => {
  const filas = [
    { id_lista: 914503, banco: 'LEADS', documento: '1', nombres: 'CALOLO', telefono: '0958978745', correo: 'NA', asesor: 'ONTANEDA SAMANIEGO SAMANTHA NAYELLI', estado: 'Llamar más tarde' },
    { id_lista: 780947, banco: 'MIS CONTACTOS', documento: '1719708677', nombres: 'MINO FLORES CARLOS ENRIQUE', telefono: '0958978745', correo: 'calolomino@gmail.com', asesor: 'VENDEDOR 21', estado: 'Interesado' }
  ];
  await conDb(filas, false, async (visto) => {
    const j = payload(await handleEncontrarContacto({ valores: ['958978745', '1719708677', '0990000000'] }));
    assert.equal(visto.llamadas, 1);
    const p = Object.fromEntries(j.resultados.map((x: any) => [x.consulta, x]));
    assert.deepEqual(p['958978745'].contactos.map((c: any) => c.id_lista), [914503, 780947]);
    assert.deepEqual(p['958978745'].contactos[0].coincide_por, ['telefono']);
    assert.deepEqual(p['1719708677'].contactos.map((c: any) => c.id_lista), [780947]);
    assert.deepEqual(j.no_encontrados, ['0990000000']);
    assert.equal(j.resumen.contactos_distintos, 2);
    assert.ok(j.avisos.some((a: string) => /más de un contacto/.test(a)));
  });
});
