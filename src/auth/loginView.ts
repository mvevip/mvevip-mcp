export interface LoginViewParams {
  actionPath: string;
  redirectUri: string;
  state: string;
  clientId: string;
  error?: string;
}

export const renderLoginScreen = (params: LoginViewParams): string => {
  const esc = (s: string) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const errorMessageHtml = params.error
    ? `<div class="alert-error">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span>${esc(params.error)}</span>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autorización de Conector MCP — MVEVIP</title>
  <style>
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
    .btn-submit:active {
      transform: scale(0.99);
    }
    .footer {
      margin-top: 24px;
      font-size: 12px;
      color: #64748b;
    }
  </style>
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
    <p class="subtitle">Claude solicita autorización para consultar la base de datos empresarial. Ingrese la clave corporativa para confirmar el uso.</p>

    ${errorMessageHtml}

    <form method="POST" action="${esc(params.actionPath)}">
      <input type="hidden" name="redirect_uri" value="${esc(params.redirectUri)}">
      <input type="hidden" name="state" value="${esc(params.state)}">
      <input type="hidden" name="client_id" value="${esc(params.clientId)}">

      <div class="form-group">
        <label class="label" for="access_key">Clave o Código de Autorización</label>
        <div class="input-wrapper">
          <input 
            type="password" 
            id="access_key" 
            name="access_key" 
            class="input-field" 
            placeholder="Ingrese la clave corporativa" 
            required 
            autofocus
          >
        </div>
      </div>

      <div class="client-info">
        <span>Cliente solicitante:</span>
        <strong>Claude / Anthropic</strong>
      </div>

      <button type="submit" class="btn-submit">Confirmar y Autorizar Conexión</button>
    </form>

    <div class="footer">
      MVEVIP System © 2026 • Acceso Protegido
    </div>
  </div>
</body>
</html>`;
};

export const renderSuccessScreen = (code: string): string => {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autorización Exitosa — MVEVIP MCP</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at 50% 0%, #1e293b 0%, #0b1120 100%);
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
    }
    .container {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      width: 100%;
      max-width: 440px;
      padding: 36px 32px;
      text-align: center;
    }
    .icon-success {
      width: 60px;
      height: 60px;
      margin: 0 auto 16px;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #10b981;
    }
    h1 { font-size: 24px; margin-bottom: 8px; color: #fff; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin-bottom: 20px; }
    .box {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 12px;
      font-family: monospace;
      font-size: 12px;
      color: #38bdf8;
      word-break: break-all;
      margin-bottom: 20px;
    }
    .tip {
      font-size: 13px;
      background: rgba(2, 132, 199, 0.1);
      border-left: 3px solid #0284c7;
      padding: 10px 12px;
      text-align: left;
      color: #cbd5e1;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon-success">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M20 6L9 17l-5-5"></path>
      </svg>
    </div>
    <h1>¡Clave Verificada con Éxito!</h1>
    <p>La clave corporativa es correcta. El conector MCP de MVEVIP está activo y funcionando.</p>
    
    <div class="box">
      <strong>Código generado:</strong><br>${code}
    </div>

    <div class="tip">
      ℹ️ <strong>Nota para Claude:</strong> Cuando conectes este MCP desde la interfaz de Claude (Personalizar > Conectores), Claude incluirá su parámetro de sesión automáticamente y la conexión se confirmará de forma inmediata.
    </div>
  </div>
</body>
</html>`;
};
