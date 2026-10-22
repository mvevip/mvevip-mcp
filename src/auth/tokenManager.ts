import { createHmac, timingSafeEqual } from 'crypto';

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // Códigos de autorización válidos por 5 minutos
const BEARER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // Tokens válidos por 30 días

/**
 * Obtiene la clave maestra requerida en la pantalla de autorización.
 */
export const getMasterAccessKey = (): string => {
  return process.env.MCP_ACCESS_KEY || process.env.MCP_LOGIN_PASSWORD || 'mvevip_master_key_2026';
};

/**
 * Genera un código de autorización firmado temporal: "<expiryMs>.<client_id>.<hmac>"
 */
export const signAuthCode = (secret: string, clientId: string = 'claude'): string => {
  const expiry = Date.now() + AUTH_CODE_TTL_MS;
  const payload = `${expiry}:${clientId}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${expiry}.${Buffer.from(clientId).toString('base64url')}.${sig}`;
};

/**
 * Valida un código de autorización firmado
 */
export const verifyAuthCode = (code: string, secret: string): boolean => {
  if (!code) return false;
  const parts = code.split('.');
  if (parts.length !== 3) return false;

  const [expiryStr, clientIdB64, sig] = parts;
  const expiry = Number(expiryStr);

  if (!Number.isFinite(expiry) || Date.now() > expiry) {
    return false;
  }

  const clientId = Buffer.from(clientIdB64, 'base64url').toString('utf8');
  const payload = `${expiry}:${clientId}`;
  const expectedSig = createHmac('sha256', secret).update(payload).digest('hex');

  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/**
 * Genera un token Bearer para Claude: "mvevip_<expiry>.<sig>"
 */
export const generateBearerToken = (secret: string): string => {
  const expiry = Date.now() + BEARER_TOKEN_TTL_MS;
  const payload = `bearer:${expiry}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `mvevip_${expiry}.${sig}`;
};

/**
 * Valida un token Bearer enviado en la cabecera Authorization
 */
export const verifyBearerToken = (token: string, secret: string): boolean => {
  if (!token) return false;

  const raw = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  if (!raw.startsWith('mvevip_')) return false;

  const withoutPrefix = raw.replace('mvevip_', '');
  const parts = withoutPrefix.split('.');
  if (parts.length !== 2) return false;

  const [expiryStr, sig] = parts;
  const expiry = Number(expiryStr);

  if (!Number.isFinite(expiry) || Date.now() > expiry) {
    return false;
  }

  const payload = `bearer:${expiry}`;
  const expectedSig = createHmac('sha256', secret).update(payload).digest('hex');

  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/**
 * Valida en tiempo constante dos cadenas de texto
 */
export const safeCompareStrings = (input: string, target: string): boolean => {
  if (!input || !target) return false;
  const bufA = Buffer.from(input);
  const bufB = Buffer.from(target);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};
