import { randomBytes, scrypt as scryptCb, timingSafeEqual, ScryptOptions } from 'crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
export const MIN_PASSWORD_LENGTH = 12;

const scrypt = (password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scryptCb(password, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)))
  );

/** Formato: scrypt$N$r$p$salt(b64)$hash(b64) */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
};

let dummyHash: Promise<string> | null = null;

/** Gasta el mismo tiempo que una verificación real cuando el usuario no existe (evita enumeración). */
export const verifyDummyPassword = async (password: string): Promise<false> => {
  dummyHash ??= hashPassword(randomBytes(12).toString('hex'));
  await verifyPassword(password, await dummyHash);
  return false;
};

export const validatePasswordPolicy = (password: string): string | null => {
  if (password.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'La contraseña debe combinar letras y números.';
  return null;
};

export const generatePassword = (): string => `${randomBytes(12).toString('base64url')}7a`;
