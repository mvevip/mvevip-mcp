import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthStore } from '../src/services/authStore';
import { hashPassword, verifyPassword, validatePasswordPolicy } from '../src/auth/password';

process.env.MCP_SIGNING_SECRET = 'secreto-de-firma-de-pruebas-0123456789abcdef';

let store: MemoryAuthStore;
let run: typeof import('../src/admin/adminCommands').runAdminCommand;

beforeEach(async () => {
  const { setStore } = await import('../src/deps');
  store = new MemoryAuthStore();
  setStore(store);
  run = (await import('../src/admin/adminCommands')).runAdminCommand;
});

test('hash de contraseña: verifica la correcta y rechaza la incorrecta', async () => {
  const hash = await hashPassword('Contrasena-123456');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('Contrasena-123456', hash), true);
  assert.equal(await verifyPassword('otra', hash), false);
  assert.notEqual(hash, await hashPassword('Contrasena-123456'));
});

test('política de contraseñas', () => {
  assert.ok(validatePasswordPolicy('corta1'));
  assert.ok(validatePasswordPolicy('solo-letras-largas'));
  assert.equal(validatePasswordPolicy('Contrasena-123456'), null);
});

test('create-user genera contraseña, guarda solo el hash y evita duplicados', async () => {
  const out: any = await run({ command: 'create-user', username: 'Ana', email: 'ANA@mvevip.com' });
  assert.equal(out.username, 'ana');
  assert.equal(out.email, 'ana@mvevip.com');
  assert.ok(out.generatedPassword);
  const user = await store.findUserByUsername('ana');
  assert.ok(user && user.passwordHash.startsWith('scrypt$') && !user.passwordHash.includes(out.generatedPassword));
  await assert.rejects(run({ command: 'create-user', username: 'ana', email: 'x@mvevip.com' }), /ya existe/);
});

test('valida usuario, correo y contraseña', async () => {
  await assert.rejects(run({ command: 'create-user', username: 'a', email: 'a@mvevip.com' }), /username/);
  await assert.rejects(run({ command: 'create-user', username: 'beto', email: 'sin-arroba' }), /email/);
  await assert.rejects(run({ command: 'create-user', username: 'beto', email: 'b@mvevip.com', password: 'corta' }), /contraseña/);
});

test('set-password, disable/enable y list-users (sin exponer hashes)', async () => {
  await run({ command: 'create-user', username: 'carla', email: 'c@mvevip.com' });
  await run({ command: 'set-password', username: 'carla', password: 'Nueva-Contrasena-99' });
  assert.equal(await verifyPassword('Nueva-Contrasena-99', (await store.findUserByUsername('carla'))!.passwordHash), true);
  await run({ command: 'disable-user', username: 'carla' });
  assert.equal((await store.findUserByUsername('carla'))!.isActive, false);
  await run({ command: 'enable-user', username: 'carla' });
  const list: any = await run({ command: 'list-users' });
  assert.equal(list.users.length, 1);
  assert.equal(list.users[0].passwordHash, undefined);
  await assert.rejects(run({ command: 'disable-user', username: 'nadie' }), /no encontrado/);
});
