import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const ACCESS_KEY = 'clave-de-pruebas-0123456789';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
let server: Server;
let base: string;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MCP_ACCESS_KEY = ACCESS_KEY;
  process.env.MCP_SIGNING_SECRET = 'secreto-de-firma-de-pruebas-0123456789abcdef';
  process.env.MCP_CLIENT_ID = 'test-client';
  const { default: app } = await import('../src/index');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const form = (data: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(data).toString(),
  redirect: 'manual' as const
});

const authorize = (challenge: string, overrides: Record<string, string> = {}) =>
  fetch(`${base}/authorize`, form({
    access_key: ACCESS_KEY,
    client_id: 'test-client',
    redirect_uri: REDIRECT,
    state: 'xyz',
    code_challenge: challenge,
    ...overrides
  }));

const getCode = async (challenge: string): Promise<string> => {
  const res = await authorize(challenge);
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location')!).searchParams.get('code')!;
};

const exchange = (data: Record<string, string>) => fetch(`${base}/token`, form({ grant_type: 'authorization_code', ...data }));

const rpc = (token: string | null, body: unknown) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });

const getToken = async (): Promise<string> => {
  const { verifier, challenge } = pkce();
  const code = await getCode(challenge);
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

test('flujo OAuth + PKCE completo y uso del token en /mcp', async () => {
  const token = await getToken();
  assert.match(token, /^mvevip_/);

  const init = await (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json();
  assert.equal(init.result.protocolVersion, '2025-03-26');

  const list = await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.equal(list.result.tools.length, 4);

  const notif = await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif.status, 202);
});

test('token manipulado es rechazado', async () => {
  const token = await getToken();
  const res = await rpc(token.slice(0, -2) + 'xx', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(res.status, 401);
});

test('un código de autorización no sirve como Bearer token', async () => {
  const { challenge } = pkce();
  const code = await getCode(challenge);
  assert.equal((await rpc(`mvevip_${code}`, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
});

test('/authorize rechaza redirect_uri no permitido, client_id desconocido y falta de PKCE', async () => {
  const { challenge } = pkce();
  assert.equal((await authorize(challenge, { redirect_uri: 'https://evil.example/cb' })).status, 400);
  assert.equal((await authorize(challenge, { client_id: 'otro' })).status, 400);
  assert.equal((await authorize('')).status, 400);
});

test('GET /authorize exige response_type=code y S256', async () => {
  const { challenge } = pkce();
  const q = (extra: Record<string, string>) =>
    fetch(`${base}/authorize?${new URLSearchParams({ client_id: 'test-client', redirect_uri: REDIRECT, state: 's', code_challenge: challenge, ...extra })}`);
  assert.equal((await q({ response_type: 'code', code_challenge_method: 'S256' })).status, 200);
  assert.equal((await q({ response_type: 'code', code_challenge_method: 'plain' })).status, 400);
  assert.equal((await q({ response_type: 'token', code_challenge_method: 'S256' })).status, 400);
});

test('/token rechaza verifier incorrecto, redirect_uri distinto y código inválido', async () => {
  const { verifier, challenge } = pkce();
  const code = await getCode(challenge);
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
  const invalid = await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_table_schema', arguments: {} } })).json();
  assert.equal(invalid.error.code, -32602);
});

test('consulta SQL peligrosa se responde con isError sin llegar a la BD', async () => {
  const token = await getToken();
  const res = await (await rpc(token, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'query_database_sample', arguments: { query: 'DELETE FROM clientes' } }
  })).json();
  assert.equal(res.result.isError, true);
});

test('bloquea la fuerza bruta de la clave (429 tras 5 fallos)', async () => {
  const { challenge } = pkce();
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) {
    statuses.push((await authorize(challenge, { access_key: 'incorrecta' })).status);
  }
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[6], 429);
  // incluso la clave correcta queda bloqueada mientras dure el bloqueo
  assert.equal((await authorize(challenge)).status, 429);
});
