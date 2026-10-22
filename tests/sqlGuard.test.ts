import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReadOnlySql } from '../src/services/sqlGuard';

const blocked = [
  'DELETE FROM t',
  'SELECT 1; DROP TABLE t',
  'SELECT * FROM t INTO OUTFILE "/tmp/x"',
  'SELECT * FROM t INTO DUMPFILE "/tmp/x"',
  'SELECT SLEEP(10)',
  'SELECT BENCHMARK(1000000, MD5(1))',
  'SELECT LOAD_FILE("/etc/passwd")',
  'SELECT * FROM t FOR UPDATE',
  'SELECT * FROM t LOCK IN SHARE MODE',
  'SELECT /*! 1 */ 1',
  'SELECT @a := 1',
  'WITH x AS (SELECT 1) DELETE FROM t',
  'SELECT * FROM mysql.user',
  'SET @a = 1',
  'CALL do_something()',
  'SELECT /* sin cerrar',
  "SELECT 'sin cerrar"
];

for (const sql of blocked) {
  test(`bloquea: ${sql}`, () => {
    assert.throws(() => validateReadOnlySql(sql));
  });
}

const allowed = [
  'SELECT * FROM mve_ventas LIMIT 10',
  "SELECT * FROM t WHERE nombre = 'Update; DROP delete'",
  'SELECT REPLACE(nombre, "a", "b") FROM t',
  'SELECT `update`, `set` FROM t',
  'SELECT 1; ',
  'SHOW TABLES',
  'DESCRIBE mve_ventas',
  'EXPLAIN SELECT * FROM t',
  'WITH x AS (SELECT 1 AS a) SELECT a FROM x',
  'SELECT 1 -- comentario final'
];

for (const sql of allowed) {
  test(`permite: ${sql}`, () => {
    assert.doesNotThrow(() => validateReadOnlySql(sql));
  });
}

test('detecta LIMIT solo fuera de literales', () => {
  assert.equal(validateReadOnlySql("SELECT 'limit' FROM t").hasLimit, false);
  assert.equal(validateReadOnlySql('SELECT * FROM t LIMIT 5').hasLimit, true);
});
