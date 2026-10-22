import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ZodError } from 'zod';
import { getConfig, isAllowedRedirectUri } from './config';
import {
  signAuthCode,
  verifyAuthCode,
  verifyPkce,
  generateBearerToken,
  verifyBearerToken,
  safeCompareStrings
} from './auth/tokenManager';
import { RateLimiter } from './auth/rateLimiter';
import { renderLoginScreen } from './auth/loginView';
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

const loginLimiter = new RateLimiter(5, 15 * 60 * 1000); // 5 claves erróneas / 15 min / IP
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

const sendLoginScreen = (res: Response, params: AuthorizeParams, status = 200, error?: string) => {
  noStore(res);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.status(status).type('text/html; charset=utf-8').send(renderLoginScreen({
    actionPath: '/authorize',
    redirectUri: params.redirectUri,
    state: params.state,
    clientId: params.clientId,
    codeChallenge: params.codeChallenge,
    error
  }));
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

app.post('/authorize', (req: Request, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const params = parseAuthorizeParams(body);
  if (typeof params === 'string') return sendAuthorizeError(res, params);

  const ip = req.ip || 'unknown';
  const retryAfter = loginLimiter.retryAfterSeconds(ip);
  if (retryAfter > 0) {
    res.setHeader('Retry-After', String(retryAfter));
    return sendLoginScreen(res, params, 429, 'Demasiados intentos fallidos. Intente de nuevo más tarde.');
  }

  if (!safeCompareStrings(str(body.access_key).trim(), config.accessKey)) {
    loginLimiter.record(ip);
    console.warn('[AUTH] Intento de autorización con clave incorrecta.');
    return sendLoginScreen(res, params, 401, 'Clave de autorización incorrecta.');
  }

  loginLimiter.reset(ip);
  const code = signAuthCode(config.signingSecret, params.clientId, params.redirectUri, params.codeChallenge);

  const targetUrl = new URL(params.redirectUri);
  targetUrl.searchParams.set('code', code);
  targetUrl.searchParams.set('state', params.state);

  console.log('[AUTH] Autorización concedida.');
  noStore(res);
  return res.redirect(targetUrl.toString());
});

// Intercambio del código por el Bearer token
app.post('/token', (req: Request, res: Response) => {
  noStore(res);
  const body = (req.body || {}) as Record<string, unknown>;
  const oauthError = (status: number, error: string, description: string) =>
    res.status(status).json({ error, error_description: description });

  const ip = req.ip || 'unknown';
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
    access_token: generateBearerToken(config.signingSecret),
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
const authenticateMcp = (req: Request, res: Response, next: NextFunction) => {
  if (verifyBearerToken(req.headers.authorization, config.signingSecret)) {
    return next();
  }

  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${getBaseUrl(req)}/.well-known/oauth-protected-resource"`
  );
  return res.status(401).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32001, message: 'No autorizado. Complete la autorización OAuth e incluya el Bearer token.' }
  });
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
        console.log(`[TOOL_CALL] ${toolName}`);

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
