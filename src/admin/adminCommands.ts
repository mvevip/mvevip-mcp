import { getStore } from '../deps';
import { generatePassword, hashPassword, validatePasswordPolicy } from '../auth/password';

export interface AdminRequest {
  command: 'init' | 'create-user' | 'set-password' | 'disable-user' | 'enable-user' | 'list-users';
  username?: string;
  email?: string;
  password?: string;
}

const USERNAME = /^[a-z0-9._-]{3,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const requireUsername = (req: AdminRequest): string => {
  const username = (req.username || '').trim().toLowerCase();
  if (!USERNAME.test(username)) throw new Error('username inválido (3-64 caracteres: a-z, 0-9, ., _, -).');
  return username;
};

/** Operaciones de administración de usuarios (local con tsx o vía `aws lambda invoke`). */
export const runAdminCommand = async (req: AdminRequest): Promise<Record<string, unknown>> => {
  const store = getStore();

  switch (req.command) {
    case 'init':
      await store.ensureSchema();
      return { ok: true, message: 'Esquema de autenticación listo.' };

    case 'create-user': {
      const username = requireUsername(req);
      const email = (req.email || '').trim().toLowerCase();
      if (!EMAIL.test(email) || email.length > 190) throw new Error('email inválido.');
      const generated = !req.password;
      const password = req.password || generatePassword();
      const policyError = validatePasswordPolicy(password);
      if (policyError) throw new Error(policyError);
      if (await store.findUserByUsername(username)) throw new Error(`El usuario '${username}' ya existe.`);
      const id = await store.createUser({ username, email, passwordHash: await hashPassword(password) });
      return { ok: true, id, username, email, ...(generated ? { generatedPassword: password } : {}) };
    }

    case 'set-password': {
      const username = requireUsername(req);
      const generated = !req.password;
      const password = req.password || generatePassword();
      const policyError = validatePasswordPolicy(password);
      if (policyError) throw new Error(policyError);
      if (!(await store.updatePassword(username, await hashPassword(password)))) throw new Error('Usuario no encontrado.');
      return { ok: true, username, ...(generated ? { generatedPassword: password } : {}) };
    }

    case 'disable-user':
    case 'enable-user': {
      const username = requireUsername(req);
      const active = req.command === 'enable-user';
      if (!(await store.setActive(username, active))) throw new Error('Usuario no encontrado.');
      return { ok: true, username, isActive: active };
    }

    case 'list-users':
      return { ok: true, users: await store.listUsers() };

    default:
      throw new Error(`Comando desconocido: ${String((req as any).command)}`);
  }
};
