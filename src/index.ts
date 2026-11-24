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
  SalesReportInputSchema,
  CuadroVentasInputSchema,
  RequerimientosInputSchema,
  EncontrarContactoInputSchema,
  ValidarCruceVentasInputSchema,
  BuscarBaseInputSchema,
  AplicarBaseInputSchema,
  EncerarCuposInputSchema,
  AsignarBaseUsuarioInputSchema,
  EncerarCupoUsuarioInputSchema,
  HistorialBaseInputSchema,
  PagosFacturacionInputSchema,
  AsistenciaInputSchema
} from './mcp/types';
import { handleSalesReport } from './mcp/tools/salesReportTool';
import { handleCuadro } from './mcp/tools/cuadroTool';
import { handleRequerimientos } from './mcp/tools/requerimientosTool';
import { handleBuscarBase, handleAplicarBase, handleEncerarCupos } from './mcp/tools/baseTool';
import { handleAsignarBaseUsuario, handleEncerarCupoUsuario } from './mcp/tools/cuposTool';
import { handleHistorialBase } from './mcp/tools/historialBaseTool';
import { handlePagosFacturacion } from './mcp/tools/pagosFacturacionTool';
import { handleCruceVentas } from './mcp/tools/cruceVentasTool';
import { handleAsistencia } from './mcp/tools/asistenciaTool';
import { handleEncontrarContacto } from './mcp/tools/contactoTool';

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

app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req: Request, res: Response) => {
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
    // Las URL de retorno no son secretas; registrarlas permite ajustar la lista de clientes permitidos.
    const rejected = redirectUris.filter((u) => !isAllowedRedirectUri(u)).map((u) => u.slice(0, 200));
    console.warn(`[REGISTER] redirect_uri rechazado: ${JSON.stringify(rejected)}`);
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
const BASE_PROPS = {
  mes: { type: 'number', description: 'Mes 1-12 de la fecha de alta de la base. Úselo junto con anio, o use fecha_desde y fecha_hasta. El rango de fechas es OBLIGATORIO: si el usuario no lo dio, pregúntelo.' },
  anio: { type: 'number', description: 'Año (ej: 2026). Si solo se da mes, se usa el año actual.' },
  fecha_desde: { type: 'string', description: 'Inicio del rango de fecha de alta (YYYY-MM-DD), inclusive. Reemplaza a mes y anio. "La última semana de octubre" = 2026-10-25 a 2026-10-31: confirme el rango con el usuario si es ambiguo.' },
  fecha_hasta: { type: 'string', description: 'Fin del rango de fecha de alta (YYYY-MM-DD), inclusive.' },
  banco: { type: 'number', description: 'id_banco de notas_registros_bancos. Por defecto 2 (Diners, DIN). Otros: 1 Pichincha (PIC), 3 BGR, 7 Pacífico (PAC), etc.' },
  estados_incluir: { type: 'array', items: { type: ['string', 'number'] }, description: 'Solo estos estados, por nombre o id (ej: ["Interesado", "Llamar más tarde"]). Si se indica, reemplaza la exclusión por defecto. Omitir para usar la exclusión por defecto.' },
  estados_excluir: { type: 'array', items: { type: ['string', 'number'] }, description: 'Estados a excluir, por nombre o id. Por defecto se excluyen 7 (Venta Realizada), 10 (Bloqueado), 27 (Detener Contacto) y 35 (Pendiente Habilitacion). Si se indica, reemplaza esa lista.' },
  ciudad: { type: 'string', description: 'Solo esta ciudad (nombre exacto, ej: CUENCA, QUITO, GUAYAQUIL). Omitir para todas.' },
  filtrar_identificador: { type: 'string', description: 'Solo registros cuyo identificador actual sea exactamente este (ej: "2025-09-11 DIN-570").' },
  filtrar_identificador_original: { type: 'string', description: 'Solo registros cuyo identificadorOriginal CONTENGA este texto (ej: "pic").' },
  excluir_bloq: { type: 'boolean', description: 'true para excluir los identificadores que contienen BLOQ.' },
  asterisk_desde: { type: 'string', description: 'Inicio del rango de llamadas de Asterisk (YYYY-MM-DD). Por defecto el 1 de enero del año en curso.' },
  asterisk_hasta: { type: 'string', description: 'Fin del rango de llamadas de Asterisk (YYYY-MM-DD). Por defecto hoy.' },
  billsec_max: { type: 'number', description: 'Tiempo hablado total máximo (segundos) para liberar un teléfono. Por defecto 0. Ej: "de 0 a 10 segundos" => 10.' },
  incluir_sin_registro: { type: 'boolean', description: 'Liberar también los teléfonos sin ningún registro de llamadas en Asterisk. Por defecto true.' },
  para_predictivo: { type: 'boolean', description: 'true SOLO si el usuario pidió la base "para predictivo". Entonces el identificador es "AAAA-MM-DD SIGLA-PREDICTIVO", se desmarcan los predictivos actuales y NO se crean cupos.' },
  nombre_identificador: { type: 'string', description: 'Nombre del identificador nuevo si el usuario lo dio (se respeta tal cual). Si no, se genera: fecha de hoy (Ecuador) + sigla del banco + cantidad liberada (ej: "2026-11-10 DIN-1000").' }
};

const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'reporte_ventas_mes',
    description: 'Reporte oficial de ventas de un mes (por defecto el mes actual, zona America/Guayaquil), por fecha de venta. Excluye ventas anuladas (estados 9 y 13) e incluye todos los líderes, aunque hoy estén inactivos u ocultos (permite comparar meses). Los líderes sin ventas en el período no aparecen. Siempre devuelve los totales del mes. Sin agrupar: una fila por venta con fecha, grupo, líder asistente, cliente, ciudad, abono pagado, valor total, valor pendiente, comisión del asesor, contrato, tipo de contrato y asesor. Agrupado: ventas, valor total, abonos, pendiente y comisión por asesor, líder, ciudad, etc. Úsala para "reporte de ventas del mes", "mejor vendedor" (agrupar_por=asesor, ordenar_por=valor_total, direccion=desc), ventas por líder o ciudad. Prefiérela a query_database_sample para ventas.',
    inputSchema: {
      type: 'object',
      properties: {
        mes: { type: 'number', description: 'Mes 1-12. Omitir para el mes actual.' },
        anio: { type: 'number', description: 'Año (ej: 2026). Omitir para el año actual.' },
        agrupar_por: {
          type: 'string',
          enum: ['ninguno', 'asesor', 'lider', 'lider_asistente', 'ciudad', 'contrato', 'tipo_contrato'],
          description: "Dimensión de agrupación. 'ninguno' (por defecto) devuelve el detalle venta por venta; 'asesor' sirve para ranking de vendedores."
        },
        ordenar_por: {
          type: 'string',
          description: "Columna de orden (por defecto valor_total). Sin agrupar: fecha_venta, grupos, lider_asistente, id_cliente, nombre_del_cliente, ciudad, abono_pagado, valor_total, valor_pendiente, comision_asesor, contrato, tipoContrato, fecha_ingreso_cliente, nombre_del_asesor. Agrupado: grupo, ventas, valor_total, abono_pagado, valor_pendiente, comision_asesor."
        },
        direccion: { type: 'string', enum: ['asc', 'desc'], description: "Dirección del orden. Por defecto 'desc'." },
        incluir_requerimientos: {
          type: 'boolean',
          description: "Si es true agrega los requerimientos (devoluciones y reclamos) ingresados en el mes y la comisión neta (comision_asesor menos requerimientos_valor). Se desglosa por asesor con agrupar_por='asesor'; con otras agrupaciones aparece solo en los totales. Con agrupar_por='asesor' también se puede ordenar_por requerimientos_cantidad, requerimientos_valor o comision_neta."
        }
      }
    }
  },
  {
    name: 'cuadro_ventas',
    description: 'Cuadro de ventas de MVEVIP (el mismo de la pantalla de la oficina) a una fecha (por defecto hoy, zona America/Guayaquil): resumen (ventas de hoy, falta hoy, ventas del mes, comisión del mes y su meta), días laborables y restantes, equipos (líderes) con meta diaria/mensual, avance y meta a fecha, grupos (ventas netas, comisión acumulada, ventas de hoy, meta y falta), líderes por cierres y ventas del día por asesor. Las metas se miden contra la comisión. Excluye ventas anuladas (estados 9 y 13); ventas = abono pagado. Úsala para "cómo vamos hoy", "cuánto falta para la meta", "ventas de hoy por asesor". Para el detalle o comparación de ventas por mes usa reporte_ventas_mes.',
    inputSchema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Fecha del cuadro en formato YYYY-MM-DD. Omitir para hoy.' }
      }
    }
  },
  {
    name: 'requerimientos',
    description: 'Requerimientos de MVEVIP: devoluciones y reclamos de ventas realizadas por asesores. Se cuentan siempre en el período en que se ingresaron (fecha del requerimiento, por defecto el mes actual en America/Guayaquil) y su valor se descuenta de la comisión del asesor. Sin agrupar devuelve cada requerimiento (fecha de ingreso y hora de registro, fecha de la venta original, cliente, valor, observaciones y asesor); agrupado por asesor devuelve cantidad y valor. Siempre trae los totales. Úsala para "la lista de requerimientos del mes anterior", "¿ingresó un requerimiento hoy?" (fecha_desde y fecha_hasta de hoy; la hora de registro viene en fecha_alta) o los requerimientos de un asesor. Para ventas y comisión neta por asesor usa reporte_ventas_mes con incluir_requerimientos.',
    inputSchema: {
      type: 'object',
      properties: {
        mes: { type: 'number', description: 'Mes 1-12. Omitir para el mes actual.' },
        anio: { type: 'number', description: 'Año (ej: 2026). Omitir para el año actual.' },
        fecha_desde: { type: 'string', description: 'Inicio del rango (YYYY-MM-DD), inclusive. Si se indica, reemplaza a mes y anio.' },
        fecha_hasta: { type: 'string', description: 'Fin del rango (YYYY-MM-DD), inclusive. Si solo se indica una de las dos fechas, se usa un solo día.' },
        agrupar_por: { type: 'string', enum: ['ninguno', 'asesor'], description: "'ninguno' (por defecto) lista cada requerimiento; 'asesor' da cantidad y valor por asesor." },
        ordenar_por: {
          type: 'string',
          description: 'Sin agrupar: fecha_alta (por defecto, más recientes primero), fecha_requerimiento, fecha_venta, valor, nombre_cliente, asesor. Agrupado: grupo, cantidad, valor (por defecto).'
        },
        direccion: { type: 'string', enum: ['asc', 'desc'], description: "Dirección del orden. Por defecto 'desc'." }
      }
    }
  },
  {
    name: 'validar_cruce_ventas',
    description: 'Valida que las ventas registradas no estén cruzadas (solo lectura). Regla 1: el contacto de la venta (nota en notas_registros) debe estar asignado al mismo asesor que hizo la venta; si está asignado a otro asesor es un CRUCE_CONTACTO (si la venta no tiene nota enlazada se busca por documento y se toma la última asignación, con observación si hay varios asesores). Regla 2: si la venta es una cuota, el cliente debe pertenecer (cli_vendedor) al asesor de la venta; si no, es un CRUCE_CUOTA. SIN_NOTA, NOTA_SIN_ASIGNAR, CUOTA_SIN_DUENO y SIN_ASESOR no son cruces: falta información para decidir. Por defecto revisa el mes actual (America/Guayaquil, por fecha de venta, sin anuladas) y devuelve totales, resumen por asesor y el detalle de las ventas con hallazgos. Úsala para "¿hay ventas cruzadas este mes?", "cruces de octubre" o los cruces de un asesor.',
    inputSchema: {
      type: 'object',
      properties: {
        mes: { type: 'number', description: 'Mes 1-12. Omitir para el mes actual.' },
        anio: { type: 'number', description: 'Año (ej: 2026). Omitir para el año actual.' },
        fecha_desde: { type: 'string', description: 'Inicio del rango (YYYY-MM-DD), inclusive. Si se indica, reemplaza a mes y anio.' },
        fecha_hasta: { type: 'string', description: 'Fin del rango (YYYY-MM-DD), inclusive. Si solo se indica una de las dos fechas, se usa un solo día.' },
        asesor: { type: 'string', description: 'Parte del nombre del asesor de la venta. Omitir para todos.' }
      }
    }
  },
  {
    name: 'asistencia',
    description: 'Asistencia del personal según el biométrico: horas de ENTRADA y atrasos (las salidas nunca se consideran; sábados y domingos tampoco). Una marcación cuenta como entrada por su hora del día (antes del punto medio entre la hora de entrada y de salida del departamento), sin usar el campo punch del dispositivo. Hora esperada = la de pico y placa del empleado si ese día le corresponde, si no la de entrada de su departamento (hoy 09:45). Atraso = minutos después de la hora esperada, solo en la primera entrada del día de cada empleado. Por defecto devuelve esas entradas del mes actual (America/Guayaquil) con minutos de atraso; con agrupar_por da el resumen por empleado, por día o por departamento (días con marcación, atrasos, minutos totales, hora promedio de ingreso). Siempre trae los totales. Si un filtro de departamento o dispositivo no encuentra nada, devuelve los nombres válidos. Úsala para "¿quién llegó tarde hoy?", "atrasos de abril por empleado", "entradas de Juan esta semana". No informa ausencias (quién no marcó).',
    inputSchema: {
      type: 'object',
      properties: {
        mes: { type: 'number', description: 'Mes 1-12. Omitir para el mes actual.' },
        anio: { type: 'number', description: 'Año (ej: 2026). Omitir para el año actual.' },
        fecha_desde: { type: 'string', description: 'Inicio del rango (YYYY-MM-DD), inclusive. Si se indica, reemplaza a mes y anio.' },
        fecha_hasta: { type: 'string', description: 'Fin del rango (YYYY-MM-DD), inclusive. Si solo se indica una de las dos fechas, se usa un solo día (ej. hoy).' },
        departamento: { type: 'string', description: 'Parte del nombre del departamento (ej: CALL CENTER, LIDERES, CONTABILIDAD). Omitir para todos.' },
        empleado: { type: 'string', description: 'Parte del nombre del empleado. Omitir para todos.' },
        dispositivo: { type: 'string', description: 'Parte del nombre del dispositivo biométrico. Omitir para todos.' },
        agrupar_por: { type: 'string', enum: ['ninguno', 'empleado', 'dia', 'departamento'], description: "'ninguno' (por defecto) lista las marcaciones; 'empleado', 'dia' o 'departamento' resumen de atrasos." },
        todas_las_marcaciones: { type: 'boolean', description: 'Solo sin agrupar: si es true lista todas las entradas del día (no solo la primera) con dispositivo y hora del día; los atrasos siguen contando solo la primera.' },
        tolerancia_minutos: { type: 'number', description: 'Minutos de gracia (0-120, por defecto 0): un atraso cuenta solo si supera esta tolerancia.' },
        ordenar_por: {
          type: 'string',
          description: 'Sin agrupar: fecha_hora_marcacion (por defecto), fecha, empleado, departamento, hora_esperada, minutos_atraso. Por empleado: empleado, departamento, dias_con_marcacion, atrasos, minutos_atraso_total (por defecto), hora_promedio_ingreso. Por dia: fecha (por defecto), empleados, atrasos, minutos_atraso_total. Por departamento: departamento, dias_con_marcacion, atrasos, minutos_atraso_total (por defecto).'
        },
        direccion: { type: 'string', enum: ['asc', 'desc'], description: "Dirección del orden. Por defecto 'desc'." }
      }
    }
  },
  {
    name: 'encontrar_contacto',
    description: 'SOLO LECTURA. Busca contactos (notas_registros) por documento, nombres, teléfono, correo o nombre del asesor asignado y devuelve TODOS los registros que coincidan (puede ser uno o varios; el mismo teléfono puede estar en varias bases): id_lista, banco, identificador, identificadorOriginal, documento, nombres, teléfono, correo, asesor, fecha de alta, fecha del último contacto, fecha de asignación y estado, del más reciente al más antiguo. La búsqueda es "contiene" (mínimo 3 caracteres). Use "campo" para buscar solo en uno (documento, nombres, telefono, correo o asesor); si no se indica busca en los cinco. En nombres y asesor basta con que aparezcan todas las palabras, en cualquier orden. Por defecto devuelve hasta 50 contactos (limite hasta 200) e indica si hay más. Ejemplos: "busca el contacto con teléfono 0958978745", "quién es el documento 1719708677", "contactos del asesor Samantha", "busca el correo calolomino@gmail.com".',
    inputSchema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Texto a buscar (mínimo 3 caracteres): parte del documento, nombre, teléfono, correo o asesor.' },
        campo: { type: 'string', enum: ['todos', 'documento', 'nombres', 'telefono', 'correo', 'asesor'], description: "Dónde buscar. Por defecto 'todos' (los cinco campos). Es más rápido y preciso indicar el campo." },
        limite: { type: 'integer', minimum: 1, maximum: 200, description: 'Máximo de contactos a devolver (por defecto 50, máximo 200).' }
      },
      required: ['texto']
    }
  },
  {
    name: 'buscar_base',
    description: 'PASO 1 para "sacar base" / "liberar base" (SOLO LECTURA, no modifica nada). Busca en notas_registros los contactos que llegaron en un rango de fecha de alta (banco 2 = Diners por defecto, teléfono de 10 dígitos, sin los estados 7, 10, 27 y 35), consulta en la central Asterisk el tiempo hablado de esos teléfonos (año en curso por defecto) y se queda con los que NO tienen registro de llamadas o tienen billsec total = 0 (el usuario puede ampliar con billsec_max, o excluir los sin registro). Devuelve una vista previa: cuántos se encontraron, cuántos se descartan por tener llamadas, cuántos se liberarían, el identificador nuevo (AAAA-MM-DD SIGLA-cantidad, o SIGLA-PREDICTIVO; el usuario puede dar el nombre), los cupos que se crearían (o los predictivos que se desmarcarían), desgloses, una muestra y un codigo_confirmacion. Muestre ese resumen al usuario y NO llame a aplicar_base hasta que confirme explícitamente. Ejemplos: "busca base de la última semana de octubre", "quiero base del mes de septiembre", "base de Cuenca de los interesados de noviembre", "sácame base para predictivo de mayo de 0 a 10 segundos incluido sin registro".',
    inputSchema: { type: 'object', properties: BASE_PROPS }
  },
  {
    name: 'aplicar_base',
    description: 'PASO 2: ESCRIBE en la base de datos. Úsela SOLO después de llamar a buscar_base, mostrar la vista previa al usuario y recibir su confirmación explícita. Reciba EXACTAMENTE los mismos parámetros de buscar_base más el codigo_confirmacion que esa vista previa devolvió. Recalcula todo y solo aplica si nada cambió; si cambió, no aplica y devuelve una vista previa nueva para confirmar otra vez. Modo normal: libera los registros (guarda el estado anterior, asignado=0, estado=0, observaciones vacías, identificador nuevo) y crea los cupos en 0 para los usuarios tipo 6 activos (id de banco + identificador). Modo predictivo (para_predictivo=true): desmarca los predictivos actuales, marca estos como predictivo y NO crea cupos. Todo en una transacción. NUNCA la llame por su cuenta ni sin confirmación del usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        ...BASE_PROPS,
        codigo_confirmacion: { type: 'string', description: 'El codigo_confirmacion devuelto por buscar_base (vale 30 minutos y solo sirve con los mismos parámetros).' }
      },
      required: ['codigo_confirmacion']
    }
  },
  {
    name: 'encerar_cupos',
    description: 'ESCRIBE en la base de datos: pone cupo = 0 en TODAS las filas de notas_registros_cupos (todos los bancos e identificadores). Úsela SOLO si el usuario lo pide explícitamente ("encérame los cupos"); nunca como parte de buscar_base/aplicar_base. Funciona en dos pasos: sin parámetros devuelve el estado actual y un codigo_confirmacion (no modifica nada); muéstrelo al usuario y, solo con su confirmación explícita, llámela de nuevo con ese codigo_confirmacion.',
    inputSchema: {
      type: 'object',
      properties: {
        codigo_confirmacion: { type: 'string', description: 'Código devuelto por la primera llamada. Omitir en la primera llamada.' }
      }
    }
  },
  {
    name: 'asignar_base_usuario',
    description: 'ESCRIBE en la base de datos: asigna cupo de una base (banco + identificador) a UNO O VARIOS asesores (usuarios tipo 6 activos), por ejemplo "asígnale 20 datos de la base 2026-11-17 VIS-1244 a VENDEDOR 21". El cupo es el acumulado asignado al asesor; el CRM le entrega lo pendiente (cupo - ya entregado). Modo "sumar" (por defecto): suma la cantidad al cupo (si el asesor ya recibió más que su cupo, p. ej. porque se le enceró, parte de lo ya entregado para que le lleguen exactamente N datos nuevos); modo "fijar": deja el cupo exactamente en la cantidad. El IDENTIFICADOR ES OBLIGATORIO: si el usuario no lo dio, NO lo asuma ni lo invente: llame sin él y la herramienta devolverá los más recientes para que usted se los pregunte. Funciona en dos pasos: sin codigo_confirmacion devuelve la vista previa (cupo actual, ya entregado, cupo nuevo y pendiente de cada asesor, y advertencias, p. ej. si se piden más datos que contactos libres) y NO modifica nada; muéstresela al usuario y, solo con su confirmación explícita, llame de nuevo con los MISMOS parámetros y el codigo_confirmacion. Máximo 500 por asesor y por operación. Para poner el cupo en 0 use encerar_cupo_usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        identificador: { type: 'string', description: 'Identificador (nombre de la base) tal como está en los cupos, p. ej. "2026-11-17 VIS-1244". Obligatorio: si falta, pregúntelo al usuario.' },
        banco: { type: 'integer', description: 'Id del banco. Solo hace falta si el identificador existe en más de un banco.' },
        usuarios: {
          type: 'array',
          description: 'Asesores a los que asignar. Cada uno por nombre (o parte del nombre) o id_usuario; con "cupo" propio o usando el cupo común.',
          items: {
            type: 'object',
            properties: {
              usuario: { type: ['string', 'integer'], description: 'Nombre completo o parcial del asesor, o su id_usuario.' },
              cupo: { type: 'integer', minimum: 1, maximum: 500, description: 'Cantidad para este asesor (si no se indica, se usa "cupo").' }
            },
            required: ['usuario']
          }
        },
        cupo: { type: 'integer', minimum: 1, maximum: 500, description: 'Cantidad común para los asesores que no tengan su propio cupo.' },
        modo: { type: 'string', enum: ['sumar', 'fijar'], description: "'sumar' (por defecto) suma al cupo; 'fijar' deja el cupo exactamente en la cantidad." },
        codigo_confirmacion: { type: 'string', description: 'Código devuelto por la vista previa. Omitir en la primera llamada.' }
      }
    }
  },
  {
    name: 'encerar_cupo_usuario',
    description: 'ESCRIBE en la base de datos: pone cupo = 0 SOLO a los asesores indicados ("quítale / encérale el cupo al asesor XXX"); los demás no se tocan. Sin identificador encera todos los cupos de ese asesor (todas las bases); con identificador (y banco si hace falta) solo esa base. Lo ya entregado (total_asignado) no cambia. Para encerar a TODOS los asesores use encerar_cupos. Funciona en dos pasos: sin codigo_confirmacion devuelve la vista previa (filas y cupos de cada asesor) y NO modifica nada; muéstrela al usuario y, solo con su confirmación explícita, llame de nuevo con los MISMOS parámetros y el codigo_confirmacion.',
    inputSchema: {
      type: 'object',
      properties: {
        usuarios: { type: 'array', items: { type: ['string', 'integer'] }, description: 'Asesores (nombre completo o parcial, o id_usuario). Obligatorio.' },
        identificador: { type: 'string', description: 'Opcional: encerar solo el cupo de esta base. Sin él se encera todo el cupo del asesor.' },
        banco: { type: 'integer', description: 'Id del banco; solo con identificador y si ese identificador existe en más de un banco.' },
        codigo_confirmacion: { type: 'string', description: 'Código devuelto por la vista previa. Omitir en la primera llamada.' }
      }
    }
  },
  {
    name: 'historial_base',
    description: 'Historial de liberaciones de base hechas con aplicar_base (SOLO LECTURA). Por contacto (id_lista, telefono o documento) muestra cada vez que fue liberado: a quién estaba asignado antes (asesor), en qué estado y base (identificador) estaba, su fecha de asignación, a qué base pasó, quién lo liberó y cuándo, además de su situación actual. Sin datos de contacto lista las liberaciones (lotes): fecha, usuario, banco, identificador nuevo, cantidad, cupos creados y filtros; con id_lote da el detalle de ese lote con sus contactos; se puede filtrar por mes/año o fecha_desde y fecha_hasta, y por banco. Úsela para "¿de quién era el contacto 918520?", "¿cuándo se reasignó este teléfono?", "¿qué se liberó la semana pasada y quién lo hizo?". Solo incluye liberaciones hechas con aplicar_base desde que existe el historial (no las hechas a mano).',
    inputSchema: {
      type: 'object',
      properties: {
        id_lista: { type: 'number', description: 'id_lista del contacto en notas_registros.' },
        telefono: { type: 'string', description: 'Teléfono exacto del contacto (10 dígitos con 0 inicial, ej: 0969816358).' },
        documento: { type: 'string', description: 'Documento (cédula/pasaporte) exacto del contacto.' },
        id_lote: { type: 'number', description: 'Número de lote (liberación) para ver su detalle.' },
        mes: { type: 'number', description: 'Mes 1-12 en que se hizo la liberación (con anio, o el año actual).' },
        anio: { type: 'number', description: 'Año (ej: 2026).' },
        fecha_desde: { type: 'string', description: 'Inicio del rango de fecha de la liberación (YYYY-MM-DD), inclusive.' },
        fecha_hasta: { type: 'string', description: 'Fin del rango (YYYY-MM-DD), inclusive.' },
        banco: { type: 'number', description: 'id_banco de la liberación (ej: 2 Diners).' },
        limite: { type: 'number', description: 'Máximo de filas (por defecto 50; hasta 300).' }
      }
    }
  },
  {
    name: 'pagos_facturacion',
    description: 'Abonos FACTURADOS de MVEVIP (SOLO LECTURA): cuánto se facturó, por qué concepto, con qué forma de pago, de qué origen y qué usuario lo registró. Toma los abonos del CRM (mve_abonos) en estado facturado (5 y 6), vengan o no de ventas, con el valor del abono (abo_valor, una sola vez por abono) y sin las ventas anuladas. El concepto es la descripción de la cotización (PAQUETE, FORMULARIOS, FEE CAMBIO DESTINO, IMPUESTOS, SEGURO, etc.). La forma de pago es el banco o tarjeta del abono y su tipo (tarjeta de crédito, depósitos, efectivo). fecha_base: "venta" (por defecto; fecha de venta del contrato, y la fecha del abono para los abonos de otros módulos), "factura" (fecha en que se facturó) o "abono" (fecha en que se ingresó el abono). Período: mes y anio (por defecto el mes actual) o fecha_desde y fecha_hasta. agrupar_por: concepto (por defecto), forma_pago, tipo_pago, origen (ventas u otros módulos), destino (destino o promoción de la cotización), usuario, mes_factura, dia_factura o ninguno (detalle con número de factura). comparar_anio_anterior=true trae el mismo período del año anterior con su variación. Con fecha_base=venta avisa además lo que falta por facturar de esas ventas. vista=pendiente (separada de lo facturado, nunca se suma a ello) lista lo que FALTA POR FACTURAR: abonos en estado ingresada o autorizada y pagos de ventas que aún no tienen abono, con los días que llevan pendientes, por abono o desglosados por estado, concepto, forma_pago, usuario, dia o antiguedad; en esa vista fecha_base solo admite venta o abono y no hay total combinado. Si hay abonos con la forma de pago mal ingresada los incluye y lo avisa. Úsela para "¿cuál fue la forma de pago más usada en octubre?" (agrupar_por=forma_pago, ordenar_por=abonos), "¿cuánto y cómo se facturó el mes pasado?" (fecha_base=factura), "ventas de octubre y cuándo se facturaron" (fecha_base=venta, agrupar_por=mes_factura), facturado por concepto, por usuario o comparado con el año anterior.',
    inputSchema: {
      type: 'object',
      properties: {
        mes: { type: 'number', description: 'Mes 1-12. Omitir para el mes actual.' },
        anio: { type: 'number', description: 'Año (ej: 2026). Omitir para el año actual.' },
        fecha_desde: { type: 'string', description: 'Inicio del rango (YYYY-MM-DD), inclusive. Alternativa a mes/anio.' },
        fecha_hasta: { type: 'string', description: 'Fin del rango (YYYY-MM-DD), inclusive.' },
        vista: { type: 'string', enum: ['facturado', 'pendiente'], description: "'facturado' (por defecto) o 'pendiente' (lo que falta por facturar: abonos en estado 1 y 2 y pagos de ventas sin abono; va separado, sin total combinado)." },
        fecha_base: { type: 'string', enum: ['venta', 'factura', 'abono'], description: "Qué fecha define el período: 'venta' (por defecto), 'factura' (abo_fecha_factura) o 'abono' (abo_fecha)." },
        agrupar_por: {
          type: 'string',
          enum: ['ninguno', 'concepto', 'forma_pago', 'tipo_pago', 'origen', 'destino', 'usuario', 'mes_factura', 'dia_factura', 'estado', 'dia', 'antiguedad'],
          description: "Desglose. Facturado (por defecto 'concepto'): concepto, forma_pago, tipo_pago, origen, destino, usuario, mes_factura, dia_factura o ninguno (cada abono con su factura, máx. 500). Pendiente (por defecto 'ninguno' = detalle): estado, concepto, forma_pago, tipo_pago, origen, destino, usuario, dia o antiguedad."
        },
        ordenar_por: { type: 'string', description: "Al agrupar: grupo, abonos o valor (por defecto valor; mes_factura y dia_factura van por grupo). Sin agrupar: id_abono, factura, fecha_factura, fecha_abono, fecha_venta, origen, valor, forma_pago, tipo_pago, destino, usuario." },
        direccion: { type: 'string', enum: ['asc', 'desc'], description: 'Dirección del orden.' },
        comparar_anio_anterior: { type: 'boolean', description: 'Si es true agrega el mismo período del año anterior y la variación (por grupo al agrupar).' }
      }
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
          case 'reporte_ventas_mes': {
            const parsed = SalesReportInputSchema.parse(toolArgs);
            return rpcResult(await handleSalesReport(parsed));
          }

          case 'cuadro_ventas': {
            const parsed = CuadroVentasInputSchema.parse(toolArgs);
            return rpcResult(await handleCuadro(parsed));
          }

          case 'requerimientos': {
            const parsed = RequerimientosInputSchema.parse(toolArgs);
            return rpcResult(await handleRequerimientos(parsed));
          }

          case 'validar_cruce_ventas': {
            const parsed = ValidarCruceVentasInputSchema.parse(toolArgs);
            return rpcResult(await handleCruceVentas(parsed));
          }

          case 'asistencia': {
            const parsed = AsistenciaInputSchema.parse(toolArgs);
            return rpcResult(await handleAsistencia(parsed));
          }

          case 'encontrar_contacto': {
            const parsed = EncontrarContactoInputSchema.parse(toolArgs);
            return rpcResult(await handleEncontrarContacto(parsed));
          }

          case 'buscar_base': {
            const parsed = BuscarBaseInputSchema.parse(toolArgs);
            return rpcResult(await handleBuscarBase(parsed, String((req as any).userId)));
          }

          case 'aplicar_base': {
            const parsed = AplicarBaseInputSchema.parse(toolArgs);
            return rpcResult(await handleAplicarBase(parsed, String((req as any).userId)));
          }

          case 'asignar_base_usuario': {
            const parsed = AsignarBaseUsuarioInputSchema.parse(toolArgs);
            return rpcResult(await handleAsignarBaseUsuario(parsed, String((req as any).userId)));
          }

          case 'encerar_cupo_usuario': {
            const parsed = EncerarCupoUsuarioInputSchema.parse(toolArgs);
            return rpcResult(await handleEncerarCupoUsuario(parsed, String((req as any).userId)));
          }

          case 'encerar_cupos': {
            const parsed = EncerarCuposInputSchema.parse(toolArgs);
            return rpcResult(await handleEncerarCupos(parsed, String((req as any).userId)));
          }

          case 'historial_base': {
            const parsed = HistorialBaseInputSchema.parse(toolArgs);
            return rpcResult(await handleHistorialBase(parsed));
          }

          case 'pagos_facturacion': {
            const parsed = PagosFacturacionInputSchema.parse(toolArgs);
            return rpcResult(await handlePagosFacturacion(parsed));
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
