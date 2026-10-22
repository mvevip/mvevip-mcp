import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {
  getMasterAccessKey,
  signAuthCode,
  verifyAuthCode,
  generateBearerToken,
  verifyBearerToken,
  safeCompareStrings
} from './auth/tokenManager';
import { renderLoginScreen, renderSuccessScreen } from './auth/loginView';
import {
  JsonRpcRequest,
  JsonRpcResponse,
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

const app = express();
const port = Number(process.env.PORT) || 6420;
const host = process.env.HOST || '0.0.0.0';

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'mcp-version', 'x-claude-request-id']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log estructurado de solicitudes entrantes
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} | Auth: ${req.headers.authorization ? 'Bearer present' : 'none'}`);
  next();
});

// ---------------------------------------------------------------------------
// 1. Health Check
// ---------------------------------------------------------------------------
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'mvevip-mcp-server',
    port,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ---------------------------------------------------------------------------
// 2. Metadatos de Autenticación OAuth 2.0 (RFC 7591 / RFC 9728)
// ---------------------------------------------------------------------------
const getBaseUrl = (req: Request): string => {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = forwardedProto ? String(forwardedProto).split(',')[0].trim() : req.protocol;
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${hostHeader}`;
};

const getOauthMetadata = (baseUrl: string) => ({
  issuer: baseUrl,
  authorization_endpoint: `${baseUrl}/authorize`,
  token_endpoint: `${baseUrl}/token`,
  registration_endpoint: `${baseUrl}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
  code_challenge_methods_supported: ['S256', 'plain'],
  scopes_supported: ['mcp:all', 'read', 'write']
});

app.get(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], (req: Request, res: Response) => {
  res.json(getOauthMetadata(getBaseUrl(req)));
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
// 3. Pantalla de Autorización Obligatoria (Login Gate)
// ---------------------------------------------------------------------------
app.get('/authorize', (req: Request, res: Response) => {
  const redirectUri = String(req.query.redirect_uri || '');
  const state = String(req.query.state || '');
  const clientId = String(req.query.client_id || 'claude');

  // Si no se especifica redirect_uri, usar callback oficial de Claude
  const finalRedirectUri = redirectUri || 'https://claude.ai/api/mcp/auth_callback';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderLoginScreen({
    actionPath: '/authorize',
    redirectUri: finalRedirectUri,
    state,
    clientId
  }));
});

app.post('/authorize', (req: Request, res: Response) => {
  const { access_key, redirect_uri, state, client_id } = req.body;
  const masterKey = getMasterAccessKey();

  if (!safeCompareStrings(String(access_key || '').trim(), masterKey.trim())) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send(renderLoginScreen({
      actionPath: '/authorize',
      redirectUri: String(redirect_uri || 'https://claude.ai/api/mcp/auth_callback'),
      state: String(state || ''),
      clientId: String(client_id || 'claude'),
      error: 'Clave de autorización corporativa incorrecta. Verifique la clave en el archivo .env.'
    }));
  }

  // Generar código temporal firmado con HMAC
  const code = signAuthCode(masterKey, String(client_id || 'claude'));

  // Si no hay state (el usuario ingresó manualmente en el navegador para probar)
  if (!state || String(state).trim() === '') {
    console.log('[AUTH] Prueba manual exitosa en navegador (sin state). Mostrando pantalla de confirmación.');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderSuccessScreen(code));
  }

  const targetUrl = new URL(String(redirect_uri || 'https://claude.ai/api/mcp/auth_callback'));
  targetUrl.searchParams.set('code', code);
  targetUrl.searchParams.set('state', String(state));

  console.log(`[AUTH] Autorización concedida exitosamente para client_id: ${client_id || 'claude'} con state.`);
  return res.redirect(targetUrl.toString());
});

// Emisión del Token Bearer a Claude
app.post('/token', (req: Request, res: Response) => {
  const { code } = req.body;
  const masterKey = getMasterAccessKey();

  if (!code || !verifyAuthCode(String(code), masterKey)) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'El código de autorización es inválido o ha expirado (TTL: 5 min).'
    });
  }

  const accessToken = generateBearerToken(masterKey);
  console.log('[AUTH] Token de acceso Bearer emitido exitosamente a Claude.');

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 2592000, // 30 días
    scope: 'mcp:all'
  });
});

app.post('/register', (_req: Request, res: Response) => {
  res.status(201).json({
    client_id: 'mvevip_claude_connector',
    client_secret: 'mvevip_client_secret_token',
    client_name: 'MVEVIP Claude Connector',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback']
  });
});

// ---------------------------------------------------------------------------
// 4. Middleware de Seguridad para /mcp
// ---------------------------------------------------------------------------
const authenticateMcp = (req: Request, res: Response, next: NextFunction) => {
  const masterKey = getMasterAccessKey();
  const authHeader = req.headers.authorization;

  // Si Claude hace una verificación preliminar (OPTIONS o probe sin token pero con initialize)
  // Claude envía initialize en la primera conexión antes de tener el token si usa flujo manual.
  // Sin embargo, cuando se configura OAuth, Claude envía el token en cada llamada.
  if (authHeader && verifyBearerToken(authHeader, masterKey)) {
    return next();
  }

  // Para permitir la sonda inicial de descubrimiento si Claude aún no ha obtenido el token
  const body = req.body as JsonRpcRequest;
  if (body && (body.method === 'initialize' || body.method === 'ping')) {
    return next();
  }

  return res.status(401).json({
    jsonrpc: '2.0',
    id: body?.id || null,
    error: {
      code: -32000,
      message: 'No autorizado. Debe completar la autorización en /authorize e incluir el Bearer token.'
    }
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
app.post('/mcp', authenticateMcp, async (req: Request, res: Response) => {
  const body = req.body as JsonRpcRequest;

  if (!body || body.jsonrpc !== '2.0') {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request: se requiere jsonrpc 2.0' }
    });
  }

  const { id, method, params } = body;

  try {
    switch (method) {
      case 'initialize': {
        const response: JsonRpcResponse = {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: { listChanged: false }
            },
            serverInfo: {
              name: 'mvevip-mcp-server',
              version: '1.0.0'
            }
          }
        };
        return res.json(response);
      }

      case 'notifications/initialized': {
        // Notificación de confirmación enviada por Claude tras initialize
        return res.status(200).send();
      }

      case 'ping': {
        return res.json({ jsonrpc: '2.0', id, result: {} });
      }

      case 'tools/list': {
        const response: JsonRpcResponse = {
          jsonrpc: '2.0',
          id,
          result: {
            tools: MCP_TOOLS
          }
        };
        return res.json(response);
      }

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        console.log(`[TOOL_CALL] Invocando herramienta: ${toolName}`, toolArgs);

        switch (toolName) {
          case 'test_db_connection': {
            TestDbInputSchema.parse(toolArgs);
            const toolResult = await handleTestDbConnection();
            return res.json({ jsonrpc: '2.0', id, result: toolResult });
          }

          case 'describe_database': {
            DescribeDatabaseInputSchema.parse(toolArgs);
            const toolResult = await handleDescribeDatabase();
            return res.json({ jsonrpc: '2.0', id, result: toolResult });
          }

          case 'get_table_schema': {
            const parsed = GetTableSchemaInputSchema.parse(toolArgs);
            const toolResult = await handleGetTableSchema(parsed.tableName);
            return res.json({ jsonrpc: '2.0', id, result: toolResult });
          }

          case 'query_database_sample': {
            const parsed = QueryDatabaseInputSchema.parse(toolArgs);
            const toolResult = await handleQueryDatabase(parsed.query, parsed.maxRows);
            return res.json({ jsonrpc: '2.0', id, result: toolResult });
          }

          default:
            return res.status(404).json({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32601,
                message: `Herramienta desconocida: '${toolName}'`
              }
            });
        }
      }

      default:
        return res.status(404).json({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Método desconocido: '${method}'`
          }
        });
    }
  } catch (error: any) {
    console.error(`[ERROR] Error procesando método ${method}:`, error);
    return res.status(500).json({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: error?.message || 'Error interno en el servidor MCP'
      }
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
    console.log(`🔑 Clave de Autorización configurada: [${getMasterAccessKey() ? 'ACTIVA' : 'INACTIVA'}]`);
    console.log(`📡 URL de Conexión para Claude: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/mcp`);
  });
}
