import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MemoryAuthStore } from '../src/services/authStore';
import { hashPassword } from '../src/auth/password';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const PASSWORD = 'Contrasena-Segura-123';
let server: Server;
let base: string;
let store: MemoryAuthStore;
let sentCodes: Array<{ to: string; code: string }>;
let userSeq = 0;
let ipSeq = 0;
let currentIp = '10.0.0.1';

// Cada prueba usa una IP distinta para que el límite por IP no se acumule entre pruebas.
beforeEach(() => { currentIp = `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`; });

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MCP_SIGNING_SECRET = 'secreto-de-firma-de-pruebas-0123456789abcdef';
  process.env.MCP_CLIENT_ID = 'test-client';
  process.env.TRUST_PROXY_HOPS = '1';
  const { setStore, setMailer } = await import('../src/deps');
  store = new MemoryAuthStore();
  sentCodes = [];
  setStore(store);
  setMailer({ sendVerificationCode: async (to, code) => { sentCodes.push({ to, code }); } });
  const { default: app } = await import('../src/index');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

const newUser = async (): Promise<string> => {
  const username = `usuario${++userSeq}`;
  await store.createUser({ username, email: `${username}@mvevip.com`, passwordHash: await hashPassword(PASSWORD) });
  return username;
};

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const form = (data: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': currentIp },
  body: new URLSearchParams(data).toString(),
  redirect: 'manual' as const
});

const login = (challenge: string, username: string, password = PASSWORD, overrides: Record<string, string> = {}) =>
  fetch(`${base}/authorize`, form({
    step: 'login',
    username,
    password,
    client_id: 'test-client',
    redirect_uri: REDIRECT,
    state: 'xyz',
    code_challenge: challenge,
    ...overrides
  }));

const challengeIdFrom = async (res: Response): Promise<string> => {
  const html = await res.text();
  return /name="challenge_id" value="([a-f0-9]{32})"/.exec(html)![1];
};

const verify = (challengeId: string, code: string) =>
  fetch(`${base}/authorize`, form({ step: 'verify', challenge_id: challengeId, code }));

/** Recorre login + código por correo y devuelve el código OAuth. */
const getCode = async (challenge: string, username?: string): Promise<{ code: string; username: string }> => {
  const user = username ?? (await newUser());
  const step1 = await login(challenge, user);
  assert.equal(step1.status, 200);
  const challengeId = await challengeIdFrom(step1);
  const mailed = sentCodes[sentCodes.length - 1];
  assert.equal(mailed.to, `${user}@mvevip.com`);
  const step2 = await verify(challengeId, mailed.code);
  assert.equal(step2.status, 302);
  return { code: new URL(step2.headers.get('location')!).searchParams.get('code')!, username: user };
};

const exchange = (data: Record<string, string>) => fetch(`${base}/token`, form({ grant_type: 'authorization_code', ...data }));

const rpc = (token: string | null, body: unknown) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });

const getToken = async (username?: string): Promise<string> => {
  const { verifier, challenge } = pkce();
  const { code } = await getCode(challenge, username);
  const res = await exchange({ code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: 'test-client' });
  assert.equal(res.status, 200);
  return (await res.json()).access_token;
};

test('health no expone detalles internos', async () => {
  const body = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(body, { status: 'ok', service: 'mvevip-mcp-server' });
});

test('/mcp exige token también para initialize y ping', async () => {
  for (const method of ['initialize', 'ping', 'tools/list']) {
    const res = await rpc(null, { jsonrpc: '2.0', id: 1, method });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /resource_metadata=/);
  }
});

test('flujo completo: usuario + contraseña + código por correo + PKCE + uso en /mcp', async () => {
  const token = await getToken();
  assert.match(token, /^mvevip_/);

  const init = await (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json();
  assert.equal(init.result.protocolVersion, '2025-03-26');

  const list = await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['reporte_ventas_mes', 'cuadro_ventas', 'requerimientos']);

  assert.equal((await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
});

test('el correo con el código se envía al correo del usuario y el código es de 6 dígitos', async () => {
  const { challenge } = pkce();
  const user = await newUser();
  const res = await login(challenge, user);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /u\*\*\*@mvevip\.com/);
  assert.match(sentCodes[sentCodes.length - 1].code, /^\d{6}$/);
});

test('contraseña incorrecta y usuario inexistente reciben el mismo mensaje y no envían correo', async () => {
  const { challenge } = pkce();
  const user = await newUser();
  const before = sentCodes.length;
  const wrongPass = await login(challenge, user, 'otra-contrasena-123');
  const unknown = await login(challenge, 'no-existe');
  assert.equal(wrongPass.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(await wrongPass.text(), await unknown.text());
  assert.equal(sentCodes.length, before);
});

test('la cuenta se bloquea tras 5 contraseñas erróneas (aun con la correcta)', async () => {
  const { challenge } = pkce();
  const user = await newUser();
  for (let i = 0; i < 5; i++) assert.equal((await login(challenge, user, 'incorrecta-123456')).status, 401);
  const before = sentCodes.length;
  assert.equal((await login(challenge, user)).status, 401);
  assert.equal(sentCodes.length, before);
});

test('código erróneo: 401, y tras 5 intentos el desafío queda invalidado', async () => {
  const { challenge } = pkce();
  const user = await newUser();
  const id = await challengeIdFrom(await login(challenge, user));
  const real = sentCodes[sentCodes.length - 1].code;
  const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await verify(id, wrong)).status, 401);
  assert.equal((await verify(id, real)).status, 400);
});

test('el código del correo es de un solo uso', async () => {
  const { challenge } = pkce();
  const user = await newUser();
  const id = await challengeIdFrom(await login(challenge, user));
  const real = sentCodes[sentCodes.length - 1].code;
  assert.equal((await verify(id, real)).status, 302);
  assert.equal((await verify(id, real)).status, 400);
});

test('desafío vencido o inexistente es rechazado', async () => {
  const { challenge } = pkce();
  const user = await newUser();
  const id = await challengeIdFrom(await login(challenge, user));
  const real = sentCodes[sentCodes.length - 1].code;
  store.challenges.find((c) => c.id === id)!.expiresAt = Date.now() - 1;
  assert.equal((await verify(id, real)).status, 400);
  assert.equal((await verify('f'.repeat(32), real)).status, 400);
});

test('máximo 3 códigos por usuario cada 10 minutos', async () => {
  const { challenge } = pkce();
  const user = await newUser();
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await login(challenge, user)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

test('un usuario deshabilitado no puede usar su token', async () => {
  const user = await newUser();
  const token = await getToken(user);
  await store.setActive(user, false);
  assert.equal((await rpc(token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
});

test('token manipulado o código OAuth usado como Bearer son rechazados', async () => {
  const token = await getToken();
  assert.equal((await rpc(token.slice(0, -2) + 'xx', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  const { code } = await getCode(pkce().challenge);
  assert.equal((await rpc(`mvevip_${code}`, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
});

test('/authorize rechaza redirect_uri no permitido, client_id desconocido y falta de PKCE', async () => {
  const { challenge } = pkce();
  const user = await newUser();
  assert.equal((await login(challenge, user, PASSWORD, { redirect_uri: 'https://evil.example/cb' })).status, 400);
  assert.equal((await login(challenge, user, PASSWORD, { client_id: 'otro' })).status, 400);
  assert.equal((await login('', user)).status, 400);
});

test('se aceptan los redirect_uri de ChatGPT', async () => {
  const { challenge } = pkce();
  const user = await newUser();
  for (const uri of [
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/aip/g-0123abc/oauth/callback'
  ]) {
    assert.equal((await login(challenge, user, PASSWORD, { redirect_uri: uri })).status, 200);
  }
});

test('GET /authorize exige response_type=code y S256', async () => {
  const { challenge } = pkce();
  const q = (extra: Record<string, string>) =>
    fetch(`${base}/authorize?${new URLSearchParams({ client_id: 'test-client', redirect_uri: REDIRECT, state: 's', code_challenge: challenge, ...extra })}`);
  const ok = await q({ response_type: 'code', code_challenge_method: 'S256' });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /name="username"/);
  assert.equal((await q({ response_type: 'code', code_challenge_method: 'plain' })).status, 400);
  assert.equal((await q({ response_type: 'token', code_challenge_method: 'S256' })).status, 400);
});

test('/token rechaza verifier incorrecto, redirect_uri distinto y código inválido', async () => {
  const { verifier, challenge } = pkce();
  const { code } = await getCode(challenge);
  assert.equal((await exchange({ code, redirect_uri: REDIRECT, code_verifier: pkce().verifier })).status, 400);
  assert.equal((await exchange({ code, redirect_uri: 'http://localhost:1/cb', code_verifier: verifier })).status, 400);
  assert.equal((await exchange({ code: 'basura', redirect_uri: REDIRECT, code_verifier: verifier })).status, 400);
  assert.equal((await exchange({ code, redirect_uri: REDIRECT, code_verifier: verifier })).status, 200);
});

test('/register solo acepta redirect_uris permitidos y no entrega secreto', async () => {
  const post = (redirect_uris: string[]) =>
    fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris }) });
  const ok = await post([REDIRECT]);
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).client_secret, undefined);
  assert.equal((await post(['https://evil.example/cb'])).status, 400);
});

test('herramienta desconocida y parámetros inválidos devuelven error JSON-RPC', async () => {
  const token = await getToken();
  const unknown = await (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } })).json();
  assert.equal(unknown.error.code, -32602);
  const invalid = await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reporte_ventas_mes', arguments: { mes: 13 } } })).json();
  assert.equal(invalid.error.code, -32602);
});

test('las herramientas genéricas de base de datos ya no existen', async () => {
  const token = await getToken();
  for (const name of ['test_db_connection', 'describe_database', 'get_table_schema', 'query_database_sample']) {
    const res = await (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { query: 'SELECT 1' } } })).json();
    assert.equal(res.error.code, -32602, name);
  }
});

test('límite por IP: tras 10 intentos fallidos se bloquea incluso con credenciales correctas', async () => {
  const { challenge } = pkce();
  const user = await newUser();
  for (let i = 0; i < 10; i++) await login(challenge, `no-existe-${i}`);
  assert.equal((await login(challenge, user)).status, 429);
});

test('ChatGPT: registro dinámico con sus URL de retorno y metadatos del recurso con sufijo de ruta', async () => {
  for (const uri of [
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/abC_123-xyz',
    'https://platform.openai.com/apps-manage/oauth'
  ]) {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [uri], token_endpoint_auth_method: 'none' })
    });
    assert.equal(res.status, 201, uri);
  }
  for (const uri of ['https://evil.example.com/connector/oauth/abc', 'https://chatgpt.com.evil.com/connector/oauth/abc', 'https://chatgpt.com/connector/oauth/a/b']) {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [uri] })
    });
    assert.equal(res.status, 400, uri);
  }
  const a = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  const b = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(b.status, 200);
  assert.deepEqual(await b.json(), a);
});
