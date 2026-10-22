export interface OAuthContext {
  actionPath: string;
  redirectUri: string;
  state: string;
  clientId: string;
  codeChallenge: string;
}

export interface LoginViewParams extends OAuthContext {
  error?: string;
}

export interface CodeViewParams {
  actionPath: string;
  challengeId: string;
  maskedEmail: string;
  error?: string;
}

const esc = (s: string): string =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const STYLES = `
    :root {
      --bg-color: #0b1120;
      --card-bg: #1e293b;
      --card-border: #334155;
      --accent: #0284c7;
      --accent-hover: #0369a1;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --danger: #ef4444;
      --success: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: radial-gradient(circle at 50% 0%, #1e293b 0%, #0b1120 100%);
      color: var(--text-main);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      width: 100%;
      max-width: 440px;
      padding: 36px 32px;
      text-align: center;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(2, 132, 199, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      margin-bottom: 20px;
    }
    .logo-title {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .alert-error {
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
      padding: 12px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 20px;
      text-align: left;
    }
    .form-group {
      text-align: left;
      margin-bottom: 20px;
    }
    .label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: #cbd5e1;
      margin-bottom: 8px;
    }
    .input-wrapper {
      position: relative;
    }
    .input-field {
      width: 100%;
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 14px 16px;
      font-size: 15px;
      color: var(--text-main);
      transition: all 0.2s ease;
      letter-spacing: 0.5px;
    }
    .input-field:focus {
      outline: none;
      border-color: #38bdf8;
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2);
    }
    .client-info {
      background: #0f172a;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      border: 1px solid #1e293b;
    }
    .client-info strong {
      color: #e2e8f0;
    }
    .btn-submit {
      width: 100%;
      background: #0284c7;
      color: #ffffff;
      border: none;
      border-radius: 10px;
      padding: 14px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s ease, transform 0.1s ease;
      box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4);
    }
    .btn-submit:hover {
      background: #0369a1;
    }
    .hint {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 16px;
    }
    .btn-submit:active {
      transform: scale(0.99);
    }
    .footer {
      margin-top: 24px;
      font-size: 12px;
      color: #64748b;
    }
  `;

const errorHtml = (error?: string): string =>
  error
    ? `<div class="alert-error">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span>${esc(error)}</span>
      </div>`
    : '';

const page = (subtitle: string, body: string): string => `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autorización de Conector MCP — MVEVIP</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="container">
    <div class="badge">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
      Conexión Segura MCP
    </div>
    <h1 class="logo-title">MVEVIP Corporate MCP</h1>
    <p class="subtitle">${subtitle}</p>
    ${body}
    <div class="footer">
      MVEVIP System © 2026 • Acceso Protegido
    </div>
  </div>
</body>
</html>`;

const field = (id: string, label: string, attrs: string): string => `
      <div class="form-group">
        <label class="label" for="${id}">${label}</label>
        <div class="input-wrapper">
          <input id="${id}" name="${id}" class="input-field" required ${attrs}>
        </div>
      </div>`;

/** Paso 1: usuario y contraseña. */
export const renderLoginScreen = (params: LoginViewParams): string =>
  page(
    'Un asistente de IA solicita autorización para consultar la información empresarial. Inicie sesión con su usuario corporativo; le enviaremos un código de verificación por correo.',
    `${errorHtml(params.error)}
    <form method="POST" action="${esc(params.actionPath)}" autocomplete="on">
      <input type="hidden" name="step" value="login">
      <input type="hidden" name="redirect_uri" value="${esc(params.redirectUri)}">
      <input type="hidden" name="state" value="${esc(params.state)}">
      <input type="hidden" name="client_id" value="${esc(params.clientId)}">
      <input type="hidden" name="code_challenge" value="${esc(params.codeChallenge)}">
      ${field('username', 'Usuario', 'type="text" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus maxlength="64"')}
      ${field('password', 'Contraseña', 'type="password" autocomplete="current-password" maxlength="256"')}
      <button type="submit" class="btn-submit">Continuar</button>
    </form>`
  );

/** Paso 2: código enviado por correo. */
export const renderCodeScreen = (params: CodeViewParams): string =>
  page(
    'Verificación en dos pasos',
    `<p class="hint">Enviamos un código de 6 dígitos a <strong>${esc(params.maskedEmail)}</strong>. Vence en 10 minutos.</p>
    ${errorHtml(params.error)}
    <form method="POST" action="${esc(params.actionPath)}" autocomplete="off">
      <input type="hidden" name="step" value="verify">
      <input type="hidden" name="challenge_id" value="${esc(params.challengeId)}">
      ${field('code', 'Código de verificación', 'type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" autofocus')}
      <button type="submit" class="btn-submit">Verificar y Autorizar</button>
    </form>`
  );
