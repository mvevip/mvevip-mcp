/**
 * Administración local de usuarios (requiere acceso de red a la BD de autenticación).
 *   npx tsx scripts/auth-admin.ts create-user <usuario> <correo> [contraseña]
 *   npx tsx scripts/auth-admin.ts set-password <usuario> [contraseña]
 *   npx tsx scripts/auth-admin.ts disable-user|enable-user <usuario>
 *   npx tsx scripts/auth-admin.ts list-users | init
 * En producción (RDS privado) use: aws lambda invoke (ver docs/DEPLOY.md).
 */
import dotenv from 'dotenv';
import { runAdminCommand, AdminRequest } from '../src/admin/adminCommands';

dotenv.config();

const [command, a, b, c] = process.argv.slice(2);
const req: AdminRequest =
  command === 'create-user'
    ? { command, username: a, email: b, password: c }
    : command === 'set-password'
      ? { command, username: a, password: b }
      : { command: command as AdminRequest['command'], username: a };

runAdminCommand(req)
  .then((out) => { console.log(JSON.stringify(out, null, 2)); process.exit(0); })
  .catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
