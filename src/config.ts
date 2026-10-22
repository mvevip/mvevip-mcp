export interface AppConfig {
  signingSecret: string;
  publicUrl?: string;
  originVerifySecret?: string;
  clientId: string;
  allowedRedirectUris: string[];
  allowedOrigins: string[];
  trustProxyHops: number;
}

const DEFAULT_REDIRECT_URIS = [
  // Claude
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  // ChatGPT (conectores MCP y GPTs con acciones)
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://platform.openai.com/apps-manage/oauth'
];
const CHATGPT_GPT_REDIRECT = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/aip\/g-[a-z0-9-]+\/oauth\/callback$/;
const DEFAULT_ORIGINS = ['https://claude.ai', 'https://claude.com', 'https://chatgpt.com', 'https://chat.openai.com'];
const LOOPBACK_REDIRECT = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/[^\s#]*$/;

const MIN_SIGNING_SECRET_LENGTH = 32;

const list = (value: string | undefined): string[] =>
  (value || '').split(',').map((v) => v.trim()).filter(Boolean);

let cached: AppConfig | null = null;

/**
 * Lee y valida la configuración de seguridad. No hay valores por defecto para
 * los secretos: si faltan o son débiles el servidor no arranca.
 */
export const getConfig = (): AppConfig => {
  if (cached) return cached;

  const signingSecret = process.env.MCP_SIGNING_SECRET || '';

  if (signingSecret.length < MIN_SIGNING_SECRET_LENGTH) {
    throw new Error(`MCP_SIGNING_SECRET es obligatoria y debe tener al menos ${MIN_SIGNING_SECRET_LENGTH} caracteres (ej: openssl rand -hex 32).`);
  }

  cached = {
    signingSecret,
    publicUrl: process.env.MCP_PUBLIC_URL?.replace(/\/+$/, '') || undefined,
    originVerifySecret: process.env.ORIGIN_VERIFY_SECRET || undefined,
    clientId: process.env.MCP_CLIENT_ID || 'mvevip_claude_connector',
    allowedRedirectUris: [...DEFAULT_REDIRECT_URIS, ...list(process.env.MCP_ALLOWED_REDIRECT_URIS)],
    allowedOrigins: [...DEFAULT_ORIGINS, ...list(process.env.MCP_ALLOWED_ORIGINS)],
    trustProxyHops: Number(process.env.TRUST_PROXY_HOPS) || 0
  };
  return cached;
};

export const isAllowedRedirectUri = (uri: string): boolean => {
  const { allowedRedirectUris } = getConfig();
  return allowedRedirectUris.includes(uri) || LOOPBACK_REDIRECT.test(uri) || CHATGPT_GPT_REDIRECT.test(uri);
};
