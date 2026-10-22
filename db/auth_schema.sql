-- Base de datos de autenticación del MCP (separada de la base de negocio).
-- Se crea sola al primer uso (ensureSchema); este archivo es la referencia.
CREATE TABLE IF NOT EXISTS mcp_users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until BIGINT NOT NULL DEFAULT 0,
  last_login_at BIGINT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE KEY uq_mcp_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_login_challenges (
  id CHAR(32) PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  code_hash CHAR(64) NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  consumed TINYINT(1) NOT NULL DEFAULT 0,
  client_id VARCHAR(128) NOT NULL,
  redirect_uri VARCHAR(512) NOT NULL,
  state VARCHAR(2048) NOT NULL,
  code_challenge CHAR(43) NOT NULL,
  created_at BIGINT NOT NULL,
  KEY idx_challenges_user (user_id, created_at),
  KEY idx_challenges_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
