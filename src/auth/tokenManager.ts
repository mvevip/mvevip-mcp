import { createHash, createHmac, timingSafeEqual } from 'crypto';

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // Códigos de autorización válidos por 5 minutos
const BEARER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // Tokens válidos por 30 días
const TOKEN_PREFIX = 'mvevip_';

export interface AuthCodePayload {
  exp: number;
  cid: string; // client_id
  uri: string; // redirect_uri
  chl: string; // code_challenge (PKCE S256)
}

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

// La firma incluye el propósito para que un código no pueda usarse como token y viceversa.
const sign = (secret: string, purpose: 'code' | 'bearer', data: string): string =>
  createHmac('sha256', secret).update(`${purpose}.${data}`).digest('base64url');

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

const parseSigned = (value: string, secret: string, purpose: 'code' | 'bearer'): any | null => {
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!safeEqual(sig, sign(secret, purpose, data))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
};

/**
 * Genera un código de autorización firmado, ligado al cliente, al redirect_uri y al code_challenge PKCE.
 */
export const signAuthCode = (secret: string, clientId: string, redirectUri: string, codeChallenge: string): string => {
  const payload: AuthCodePayload = { exp: Date.now() + AUTH_CODE_TTL_MS, cid: clientId, uri: redirectUri, chl: codeChallenge };
  const data = b64(JSON.stringify(payload));
  return `${data}.${sign(secret, 'code', data)}`;
};

export const verifyAuthCode = (code: string, secret: string): AuthCodePayload | null => {
  if (!code) return null;
  const payload = parseSigned(code, secret, 'code');
  if (!payload || typeof payload.cid !== 'string' || typeof payload.uri !== 'string' || typeof payload.chl !== 'string') {
    return null;
  }
  return payload as AuthCodePayload;
};

/**
 * PKCE S256: BASE64URL(SHA256(code_verifier)) debe coincidir con el code_challenge.
 */
export const verifyPkce = (codeVerifier: string, codeChallenge: string): boolean => {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const expected = createHash('sha256').update(codeVerifier).digest('base64url');
  return safeEqual(expected, codeChallenge);
};

export const generateBearerToken = (secret: string): string => {
  const now = Date.now();
  const data = b64(JSON.stringify({ iat: now, exp: now + BEARER_TOKEN_TTL_MS }));
  return `${TOKEN_PREFIX}${data}.${sign(secret, 'bearer', data)}`;
};

/**
 * Valida el valor de la cabecera Authorization ("Bearer mvevip_...").
 */
export const verifyBearerToken = (authHeader: string | undefined, secret: string): boolean => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const raw = authHeader.slice(7).trim();
  if (!raw.startsWith(TOKEN_PREFIX)) return false;
  return parseSigned(raw.slice(TOKEN_PREFIX.length), secret, 'bearer') !== null;
};

/**
 * Compara en tiempo constante sin filtrar la longitud de la clave.
 */
export const safeCompareStrings = (input: string, target: string): boolean => {
  if (!input || !target) return false;
  const hash = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(hash(input), hash(target));
};
