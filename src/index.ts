import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ZodError } from 'zod';
import { getConfig, isAllowedRedirectUri } from './config';
import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
import {
  signAuthCode,
  verifyAuthCode,
  verifyPkce,
  generateBearerToken,
  verifyBearerToken,
  hashVerificationCode
} from './auth/tokenManager';
import { RateLimiter } from './auth/rateLimiter';
import { verifyPassword, verifyDummyPassword } from './auth/password';
import { renderLoginScreen, renderCodeScreen } from './auth/loginView';
import { getStore, getMailer } from './deps';
import {
  JsonRpcRequest,
  McpToolDefinition,
  TestDbInputSchema,
  DescribeDatabaseInputSchema,
  GetTableSchemaInputSchema,
  QueryDatabaseInputSchema
} from './mcp/types';
import { handleTestDbConnection } from './mcp/tools/testDbTool';
import { handleDescribeDatabase, handleGetTableSchema } from './mcp/tools/schemaTool';
import { handleQueryDatabase } from './mcp/tools/queryTool';

dotenv.config();

// Falla en el arranque (y no en la primera petición) si faltan secretos.
const config = getConfig();

const app = express();
const port = Number(process.env.PORT) || 6420;
const host = process.env.HOST || '0.0.0.0';

// Saltos de proxy confiables (Lambda Function URL = 1) para obtener la IP real del cliente.
app.set('trust proxy', config.trustProxyHops);
app.disable('x-powered-by');

app.use(cors({
  origin: config.allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'mcp-protocol-version', 'mcp-session-id']
}));

// Con CloudFront delante, solo se acepta tráfico que traiga el secreto de origen (la Function URL es pública).
app.use((req: Request, res: Response, next: NextFunction) => {
  if (config.originVerifySecret) {
    const provided = Buffer.from(String(req.headers['x-origin-verify'] || ''));
    const expected = Buffer.from(config.originVerifySecret);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  return next();
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Log de solicitudes: solo método y ruta (sin query string, cabeceras ni cuerpo, que contienen secretos).
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Errores de parseo de JSON/urlencoded
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(err.status || 400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: err.type === 'entity.too.large' ? -32600 : -32700, message: 'Solicitud inválida' }
    });
  }
  return next(err);
});

// IP real del cliente. Detrás de CloudFront (origen verificado) se usa CloudFront-Viewer-Address.
const clientIp = (req: Request): string => {
  const viewer = config.originVerifySecret ? String(req.headers['cloudfront-viewer-address'] || '') : '';
  if (viewer) return viewer.slice(0, viewer.lastIndexOf(':')).replace(/^\[|\]$/g, '') || viewer;
  return req.ip || 'unknown';
};

const loginLimiter = new RateLimiter(10, 15 * 60 * 1000); // 10 intentos fallidos / 15 min / IP
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODES_PER_WINDOW = 3; // códigos enviados por usuario cada 10 min
const tokenLimiter = new RateLimiter(30, 60 * 1000); // 30 intercambios / min / IP

// ---------------------------------------------------------------------------
// 1. Health Check
// ---------------------------------------------------------------------------
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'mvevip-mcp-server' });
});

// ---------------------------------------------------------------------------
// 2. Metadatos de Autenticación OAuth 2.0 (RFC 8414 / RFC 9728)
// ---------------------------------------------------------------------------
const getBaseUrl = (req: Request): string => {
  if (config.publicUrl) return config.publicUrl;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = forwardedProto ? String(forwardedProto).split(',')[0].trim() : req.protocol;
  return `${proto}://${req.headers.host}`;
};

app.get(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], (req: Request, res: Response) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:all']
  });
});

app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ['mcp:all'],
    bearer_methods_supported: ['header']
  });
});

// ---------------------------------------------------------------------------
// 3. Autorización obligatoria (Login Gate) con PKCE
// ---------------------------------------------------------------------------
interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

const noStore = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Valida los parámetros OAuth. Devuelve un mensaje de error o los parámetros limpios. */
const parseAuthorizeParams = (source: Record<string, unknown>): AuthorizeParams | string => {
  const clientId = str(source.client_id);
  const redirectUri = str(source.redirect_uri);
  const state = str(source.state);
  const codeChallenge = str(source.code_challenge);

  if (clientId !== config.clientId) return 'client_id inválido.';
  if (!redirectUri || !isAllowedRedirectUri(redirectUri)) return 'redirect_uri no permitido.';
  if (!state) return 'Falta el parámetro state.';
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) return 'Falta un code_challenge PKCE (S256) válido.';
  return { clientId, redirectUri, state, codeChallenge };
};

const sendAuthorizeError = (res: Response, message: string) => {
  noStore(res);
  res.status(400).type('text/plain').send(`Solicitud de autorización inválida: ${message}`);
};

const securePage = (res: Response, status: number, html: string) => {
  noStore(res);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.status(status).type('text/html; charset=utf-8').send(html);
};

const sendLoginScreen = (res: Response, params: AuthorizeParams, status = 200, error?: string) =>
  securePage(res, status, renderLoginScreen({
    actionPath: '/authorize',
    redirectUri: params.redirectUri,
    state: params.state,
    clientId: params.clientId,
    codeChallenge: params.codeChallenge,
    error
  }));

const sendCodeScreen = (res: Response, challengeId: string, email: string, status = 200, error?: string) =>
  securePage(res, status, renderCodeScreen({
    actionPath: '/authorize',
    challengeId,
    maskedEmail: maskEmail(email),
    error
  }));

const maskEmail = (email: string): string => {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

app.get('/authorize', (req: Request, res: Response) => {
  if (str(req.query.response_type) !== 'code') {
    return sendAuthorizeError(res, 'response_type debe ser "code".');
  }
  if (str(req.query.code_challenge_method) !== 'S256') {
    return sendAuthorizeError(res, 'code_challenge_method debe ser "S256".');
  }
  const params = parseAuthorizeParams(req.query as Record<string, unknown>);
  if (typeof params === 'string') return sendAuthorizeError(res, params);
  return sendLoginScreen(res, params);
});

const INVALID_CREDENTIALS = 'Usuario o contraseña incorrectos, o cuenta bloqueada temporalmente.';

// Paso 1: usuario + contraseña -> se envía un código por correo
const handleLogin = async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const params = parseAuthorizeParams(body);
  if (typeof params === 'string') return sendAuthorizeError(res, params);

  const ip = clientIp(req);
  const retryAfter = loginLimiter.retryAfterSeconds(ip);
  if (retryAfter > 0) {
    res.setHeader('Retry-After', String(retryAfter));
    return sendLoginScreen(res, params, 429, 'Demasiados intentos fallidos. Intente de nuevo más tarde.');
  }

  const store = getStore();
  const username = str(body.username).trim().toLowerCase().slice(0, 64);
  const password = str(body.password).slice(0, 256);
  const user = username && password ? await store.findUserByUsername(username) : null;
  const locked = !!user && user.lockedUntil > Date.now();

  let valid = false;
  if (user && user.isActive && !locked) {
    valid = await verifyPassword(password, user.passwordHash);
    if (!valid) await store.recordLoginFailure(user.id);
  } else {
    await verifyDummyPassword(password); // mismo costo de tiempo: no revela si el usuario existe
  }

  if (!user || !valid) {
    loginLimiter.record(ip);
    console.warn('[AUTH] Inicio de sesión fallido.');
    return sendLoginScreen(res, params, 401, INVALID_CREDENTIALS);
  }

  if ((await store.countRecentChallenges(user.id, Date.now() - CODE_TTL_MS)) >= MAX_CODES_PER_WINDOW) {
    return sendLoginScreen(res, params, 429, 'Ya se enviaron varios códigos. Espere unos minutos e intente de nuevo.');
  }

  const challengeId = randomBytes(16).toString('hex');
  const code = String(randomInt(100000, 1000000));
  await store.createChallenge({
    id: challengeId,
    userId: user.id,
    codeHash: hashVerificationCode(config.signingSecret, challengeId, code),
    expiresAt: Date.now() + CODE_TTL_MS,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    state: params.state,
    codeChallenge: params.codeChallenge
  });

  try {
    await getMailer().sendVerificationCode(user.email, code);
  } catch (err: any) {
    console.error('[MAIL] Error enviando el código:', err?.name || err?.message);
    return sendLoginScreen(res, params, 502, 'No se pudo enviar el correo de verificación. Contacte al administrador.');
  }

  console.log(`[AUTH] Código de verificación enviado (usuario ${user.id}).`);
  return sendCodeScreen(res, challengeId, user.email);
};

// Paso 2: código del correo -> código OAuth y redirección
const handleVerify = async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const store = getStore();
  const challengeId = str(body.challenge_id);
  const ip = clientIp(req);

  const retryAfter = loginLimiter.retryAfterSeconds(ip);
  if (retryAfter > 0) {
    res.setHeader('Retry-After', String(retryAfter));
    return sendAuthorizeError(res, 'Demasiados intentos fallidos. Intente de nuevo más tarde.');
  }

  const challenge = /^[a-f0-9]{32}$/.test(challengeId) ? await store.getChallenge(challengeId) : null;
  if (!challenge) {
    loginLimiter.record(ip);
    return sendAuthorizeError(res, 'La verificación expiró o no es válida. Vuelva a iniciar el proceso desde Claude o ChatGPT.');
  }

  const restart = (message: string) =>
    sendLoginScreen(res, {
      clientId: challenge.clientId,
      redirectUri: challenge.redirectUri,
      state: challenge.state,
      codeChallenge: challenge.codeChallenge
    }, 400, message);

  if (challenge.consumed || Date.now() > challenge.expiresAt || challenge.attempts >= MAX_CODE_ATTEMPTS) {
    return restart('El código expiró o superó los intentos permitidos. Inicie sesión nuevamente.');
  }

  const user = await store.findUserById(challenge.userId);
  if (!user || !user.isActive) return restart(INVALID_CREDENTIALS);

  const expected = Buffer.from(challenge.codeHash);
  const provided = Buffer.from(hashVerificationCode(config.signingSecret, challenge.id, str(body.code).trim()));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    await store.incrementChallengeAttempts(challenge.id);
    loginLimiter.record(ip);
    return sendCodeScreen(res, challenge.id, user.email, 401, 'Código incorrecto.');
  }

  if (!(await store.consumeChallenge(challenge.id))) {
    return restart('El código ya fue utilizado. Inicie sesión nuevamente.');
  }
  await store.recordLoginSuccess(user.id);
  loginLimiter.reset(ip);

  const code = signAuthCode(config.signingSecret, user.id, challenge.clientId, challenge.redirectUri, challenge.codeChallenge);
  const targetUrl = new URL(challenge.redirectUri);
  targetUrl.searchParams.set('code', code);
  targetUrl.searchParams.set('state', challenge.state);

  console.log(`[AUTH] Autorización concedida (usuario ${user.id}).`);
  noStore(res);
  return res.redirect(targetUrl.toString());
};

app.post('/authorize', async (req: Request, res: Response) => {
  try {
    return str(req.body?.step) === 'verify' ? await handleVerify(req, res) : await handleLogin(req, res);
  } catch (err: any) {
    console.error('[AUTH] Error en /authorize:', err?.message || err);
    return sendAuthorizeError(res, 'Error interno. Intente nuevamente.');
  }
});

// Intercambio del código por el Bearer token
app.post('/token', (req: Request, res: Response) => {
  noStore(res);
  const body = (req.body || {}) as Record<string, unknown>;
  const oauthError = (status: number, error: string, description: string) =>
    res.status(status).json({ error, error_description: description });

  const ip = clientIp(req);
  if (tokenLimiter.retryAfterSeconds(ip) > 0) {
    return oauthError(429, 'slow_down', 'Demasiadas solicitudes.');
  }
  tokenLimiter.record(ip);

  if (str(body.grant_type) !== 'authorization_code') {
    return oauthError(400, 'unsupported_grant_type', 'Solo se soporta authorization_code.');
  }

  const payload = verifyAuthCode(str(body.code), config.signingSecret);
  if (!payload) {
    return oauthError(400, 'invalid_grant', 'El código de autorización es inválido o ha expirado.');
  }
  if (body.client_id !== undefined && str(body.client_id) !== payload.cid) {
    return oauthError(400, 'invalid_grant', 'El código no corresponde a este client_id.');
  }
  if (str(body.redirect_uri) !== payload.uri) {
    return oauthError(400, 'invalid_grant', 'redirect_uri no coincide con el de la autorización.');
  }
  if (!verifyPkce(str(body.code_verifier), payload.chl)) {
    return oauthError(400, 'invalid_grant', 'code_verifier PKCE inválido.');
  }

  console.log('[AUTH] Token de acceso emitido.');
  return res.json({
    access_token: generateBearerToken(config.signingSecret, payload.sub),
    token_type: 'Bearer',
    expires_in: 2592000, // 30 días
    scope: 'mcp:all'
  });
});

// Registro dinámico de clientes: cliente público (sin secreto) y solo redirect_uris permitidos.
app.post('/register', (req: Request, res: Response) => {
  const requested: unknown = req.body?.redirect_uris;
  const redirectUris = Array.isArray(requested) ? requested.map(String) : [];
  if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
    return res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris ausente o no permitido.'
    });
  }
  return res.status(201).json({
    client_id: config.clientId,
    client_name: 'MVEVIP Claude Connector',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  });
});

// ---------------------------------------------------------------------------
// 4. Middleware de Seguridad para /mcp (todas las llamadas requieren Bearer token)
// ---------------------------------------------------------------------------
const userCache = new Map<number, number>(); // userId -> expira (ms) de la comprobación "usuario activo"
const USER_CHECK_TTL_MS = 60 * 1000;

const authenticateMcp = async (req: Request, res: Response, next: NextFunction) => {
  const unauthorized = () => {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${getBaseUrl(req)}/.well-known/oauth-protected-resource"`
    );
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'No autorizado. Complete la autorización e incluya el Bearer token.' }
    });
  };

  const token = verifyBearerToken(req.headers.authorization, config.signingSecret);
  if (!token) return unauthorized();

  // Un usuario deshabilitado pierde el acceso en máximo 60 s, aunque su token siga vigente.
  if ((userCache.get(token.userId) ?? 0) < Date.now()) {
    try {
      const user = await getStore().findUserById(token.userId);
      if (!user || !user.isActive) {
        userCache.delete(token.userId);
        return unauthorized();
      }
      userCache.set(token.userId, Date.now() + USER_CHECK_TTL_MS);
    } catch (err: any) {
      console.error('[AUTH] No se pudo validar al usuario:', err?.message || err);
      return res.status(503).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32002, message: 'Servicio de autenticación no disponible.' }
      });
    }
  }

  (req as any).userId = token.userId;
  return next();
};

// ---------------------------------------------------------------------------
// 5. Catálogo de Herramientas MCP (Tools Definitions)
// ---------------------------------------------------------------------------
const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'test_db_connection',
    description: 'Función de prueba inicial para verificar conectividad, latencia, versión y estado de la base de datos corporativa MVEVIP.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'describe_database',
    description: 'Proporciona a Claude un catálogo completo de las tablas existentes en la base de datos corporativa MVEVIP, con número estimado de registros y comentarios.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_table_schema',
    description: 'Devuelve la lista detallada de columnas, tipos de datos, claves primarias y restricciones de una tabla específica.',
    inputSchema: {
      type: 'object',
      properties: {
        tableName: {
          type: 'string',
          description: 'Nombre exacto de la tabla a inspeccionar (ej: mve_clientes, mve_cotizaciones, etc.)'
        }
      },
      required: ['tableName']
    }
  },
  {
    name: 'query_database_sample',
    description: 'Ejecuta una consulta SQL segura de solo lectura (SELECT, SHOW, DESCRIBE) contra la base de datos corporativa para extraer información con límite de filas.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Sentencia SQL de solo lectura a ejecutar (ej: SELECT cli_codigo, cli_nombre FROM mve_clientes LIMIT 10)'
        },
        maxRows: {
          type: 'number',
          description: 'Cantidad máxima de filas a retornar (por defecto 50, máximo 500)'
        }
      },
      required: ['query']
    }
  }
];

// ---------------------------------------------------------------------------
// 6. Endpoint Stateless MCP JSON-RPC (/mcp)
// ---------------------------------------------------------------------------
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

app.get('/mcp', (_req: Request, res: Response) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'Method Not Allowed' });
});

app.post('/mcp', authenticateMcp, async (req: Request, res: Response) => {
  const body = req.body as JsonRpcRequest;

  if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request: se requiere un mensaje JSON-RPC 2.0' }
    });
  }

  const { id, method, params } = body;
  const rpcError = (code: number, message: string) => res.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const rpcResult = (result: unknown) => res.json({ jsonrpc: '2.0', id, result });

  // Las notificaciones (sin id) no tienen respuesta
  if (id === undefined || id === null) {
    return res.status(202).end();
  }

  try {
    switch (method) {
      case 'initialize': {
        const requested = String(params?.protocolVersion || '');
        return rpcResult({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mvevip-mcp-server', version: '1.0.0' }
        });
      }

      case 'ping':
        return rpcResult({});

      case 'tools/list':
        return rpcResult({ tools: MCP_TOOLS });

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        console.log(`[TOOL_CALL] user=${(req as any).userId} tool=${String(toolName)}`);

        switch (toolName) {
          case 'test_db_connection':
            TestDbInputSchema.parse(toolArgs);
            return rpcResult(await handleTestDbConnection());

          case 'describe_database':
            DescribeDatabaseInputSchema.parse(toolArgs);
            return rpcResult(await handleDescribeDatabase());

          case 'get_table_schema': {
            const parsed = GetTableSchemaInputSchema.parse(toolArgs);
            return rpcResult(await handleGetTableSchema(parsed.tableName));
          }

          case 'query_database_sample': {
            const parsed = QueryDatabaseInputSchema.parse(toolArgs);
            return rpcResult(await handleQueryDatabase(parsed.query, parsed.maxRows));
          }

          default:
            return rpcError(-32602, `Herramienta desconocida: '${String(toolName)}'`);
        }
      }

      default:
        return rpcError(-32601, `Método desconocido: '${method}'`);
    }
  } catch (error: any) {
    if (error instanceof ZodError) {
      return rpcError(-32602, `Parámetros inválidos: ${error.issues.map((i) => i.message).join('; ')}`);
    }
    console.error(`[ERROR] Error procesando método ${method}:`, error?.message || error);
    return res.status(500).json({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'Error interno en el servidor MCP' }
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Inicio del Servidor
// ---------------------------------------------------------------------------
export default app;

if (process.env.NODE_ENV !== 'test' && !process.env.LAMBDA_TASK_ROOT) {
  app.listen(port, host, () => {
    console.log(`🚀 [MVEVIP MCP] Servidor escuchando en http://${host}:${port}`);
    console.log(`📡 URL de Conexión para Claude: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/mcp`);
  });
}
