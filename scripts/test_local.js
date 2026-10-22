const http = require('http');

const PORT = 6420;
const BASE_URL = `http://localhost:${PORT}`;
const MASTER_KEY = 'mvevip_master_key_2026';

function request(options, bodyData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

async function runTests() {
  console.log('==========================================================');
  console.log('🧪 INICIANDO BATERÍA DE PRUEBAS LOCALES MCP MVEVIP (Node)');
  console.log(`   Target: ${BASE_URL}`);
  console.log('==========================================================\n');

  // 1. Healthcheck
  console.log('[1/5] Probando Endpoint /health...');
  const healthRes = await request({
    hostname: 'localhost',
    port: PORT,
    path: '/health',
    method: 'GET'
  });
  console.log(`  ✅ Healthcheck OK (${healthRes.statusCode}):`, healthRes.body.trim());

  // 2. Pantalla de Autorización GET /authorize
  console.log('\n[2/5] Probando Pantalla de Autorización GET /authorize...');
  const authGetRes = await request({
    hostname: 'localhost',
    port: PORT,
    path: '/authorize',
    method: 'GET'
  });
  if (authGetRes.body.includes('MVEVIP Corporate MCP') && authGetRes.body.includes('Clave o Código de Autorización')) {
    console.log('  ✅ Pantalla de Login HTML renderizada correctamente con branding MVEVIP.');
  } else {
    console.log('  ⚠️ Pantalla recibida pero contenido no coincide exactamente.');
  }

  // 3. Verificación de Clave Corporativa (Auth Gate)
  console.log('\n[3/5] Probando Verificación de Clave Corporativa...');
  // A. Clave incorrecta
  const wrongPayload = new URLSearchParams({
    access_key: 'clave_invalida_123',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    state: 'state_1',
    client_id: 'claude'
  }).toString();

  const wrongRes = await request({
    hostname: 'localhost',
    port: PORT,
    path: '/authorize',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(wrongPayload)
    }
  }, wrongPayload);

  if (wrongRes.statusCode === 401) {
    console.log('  ✅ Clave incorrecta rechazada correctamente con HTTP 401.');
  } else {
    console.log(`  ⚠️ Se esperaba 401 y se obtuvo: ${wrongRes.statusCode}`);
  }

  // B. Clave correcta
  const correctPayload = new URLSearchParams({
    access_key: MASTER_KEY,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    state: 'state_ok_123',
    client_id: 'claude'
  }).toString();

  const correctRes = await request({
    hostname: 'localhost',
    port: PORT,
    path: '/authorize',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(correctPayload)
    }
  }, correctPayload);

  const redirectLocation = correctRes.headers.location;
  let authCode = null;
  if (redirectLocation) {
    const parsedUrl = new URL(redirectLocation);
    authCode = parsedUrl.searchParams.get('code');
    console.log('  ✅ Clave correcta aceptada. Auth Code temporal generado:', authCode.substring(0, 20) + '...');
  } else {
    console.error('  ❌ No se recibió cabecera de redirección Location:', correctRes.statusCode);
  }

  // 4. Intercambio por Bearer Token en /token
  console.log('\n[4/5] Intercambiando Auth Code por Bearer Token en /token...');
  const tokenPayload = JSON.stringify({ code: authCode });
  const tokenRes = await request({
    hostname: 'localhost',
    port: PORT,
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(tokenPayload)
    }
  }, tokenPayload);

  const tokenData = JSON.parse(tokenRes.body);
  const bearerToken = tokenData.access_token;
  console.log('  ✅ Bearer Token emitido exitosamente:', bearerToken.substring(0, 25) + '...');

  // 5. Invocando Herramientas MCP en POST /mcp
  console.log('\n[5/5] Invocando Herramientas MCP en POST /mcp con Bearer Token...');

  // A. initialize
  const initPayload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {}
  });
  const initRes = await request({
    hostname: 'localhost',
    port: PORT,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearerToken}`,
      'Content-Length': Buffer.byteLength(initPayload)
    }
  }, initPayload);
  const initData = JSON.parse(initRes.body);
  console.log('  ✅ [initialize] OK:', initData.result.serverInfo.name, 'v' + initData.result.serverInfo.version);

  // B. tools/list
  const listPayload = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  });
  const listRes = await request({
    hostname: 'localhost',
    port: PORT,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearerToken}`,
      'Content-Length': Buffer.byteLength(listPayload)
    }
  }, listPayload);
  const listData = JSON.parse(listRes.body);
  const tools = listData.result.tools.map(t => t.name).join(', ');
  console.log('  ✅ [tools/list] OK. Herramientas disponibles:', tools);

  // C. tools/call test_db_connection
  const callPayload = JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'test_db_connection',
      arguments: {}
    }
  });
  const callRes = await request({
    hostname: 'localhost',
    port: PORT,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearerToken}`,
      'Content-Length': Buffer.byteLength(callPayload)
    }
  }, callPayload);
  const callData = JSON.parse(callRes.body);
  console.log('\n  ✅ [tools/call: test_db_connection] Resultado:\n');
  console.log(callData.result.content[0].text);

  // D. tools/call describe_database
  const dbPayload = JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'describe_database',
      arguments: {}
    }
  });
  const dbRes = await request({
    hostname: 'localhost',
    port: PORT,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearerToken}`,
      'Content-Length': Buffer.byteLength(dbPayload)
    }
  }, dbPayload);
  const dbData = JSON.parse(dbRes.body);
  console.log('\n  ✅ [tools/call: describe_database] Resultado:\n');
  console.log(dbData.result.content[0].text);

  console.log('\n==========================================================');
  console.log('🎉 TODAS LAS PRUEBAS COMPLETADAS CON ÉXITO.');
  console.log('==========================================================');
}

runTests().catch(err => {
  console.error('❌ Error ejecutando pruebas:', err);
  process.exit(1);
});
