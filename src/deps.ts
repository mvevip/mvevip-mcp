import { AuthStore, MysqlAuthStore } from './services/authStore';
import { Mailer, createMailerFromEnv } from './services/mailer';

let store: AuthStore | null = null;
let mailer: Mailer | null = null;

export const getStore = (): AuthStore => (store ??= new MysqlAuthStore());
export const getMailer = (): Mailer => (mailer ??= createMailerFromEnv());

/** Permite a las pruebas y a los scripts inyectar implementaciones. */
export const setStore = (s: AuthStore) => { store = s; };
export const setMailer = (m: Mailer) => { mailer = m; };
