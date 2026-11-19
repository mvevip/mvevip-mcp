-- Historial de liberaciones de base (aplicar_base / historial_base). Creadas por el usuario el 10-nov-2026 en vtgsa_ventas.
-- Permisos: GRANT INSERT sobre ambas tablas a mcp_base; la lectura (historial_base) la hace mcp_ro, que ya tiene SELECT sobre vtgsa_ventas.*.
-- DDL tomado de SHOW CREATE TABLE (verificado el 19-nov-2026).

CREATE TABLE `mcp_base_lotes` (
  `id_lote` int unsigned NOT NULL AUTO_INCREMENT,
  `fecha_hora` datetime NOT NULL COMMENT 'Hora de Ecuador (UTC-5) en que se aplicó la liberación',
  `usuario_mcp_id` varchar(64) NOT NULL COMMENT 'Id del usuario del MCP que la ejecutó',
  `usuario_mcp` varchar(100) NOT NULL COMMENT 'Usuario del MCP (correo/usuario)',
  `accion` varchar(20) NOT NULL COMMENT 'liberar | predictivo',
  `id_banco` int NOT NULL,
  `identificador_nuevo` varchar(100) NOT NULL,
  `cantidad` int NOT NULL COMMENT 'Contactos liberados',
  `cupos_creados` int DEFAULT NULL COMMENT 'Solo modo liberar',
  `predictivos_desmarcados` int DEFAULT NULL COMMENT 'Solo modo predictivo',
  `filtros` json DEFAULT NULL COMMENT 'Rango de fechas, estados, ciudad, criterio de Asterisk, etc.',
  PRIMARY KEY (`id_lote`),
  KEY `idx_lotes_fecha` (`fecha_hora`),
  KEY `idx_lotes_banco_identificador` (`id_banco`,`identificador_nuevo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `mcp_base_historial` (
  `id_historial` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_lote` int unsigned NOT NULL,
  `id_lista` int NOT NULL COMMENT 'notas_registros.id_lista',
  `fecha_hora` datetime NOT NULL COMMENT 'Misma hora del lote (Ecuador), para consultar sin unir tablas',
  `id_banco` int DEFAULT NULL,
  `asignado_anterior` int DEFAULT NULL COMMENT 'id_usuario al que estaba asignado antes',
  `estado_anterior` int DEFAULT NULL,
  `identificador_anterior` varchar(100) DEFAULT NULL,
  `observaciones_anterior` varchar(255) DEFAULT NULL,
  `fecha_asignacion_anterior` datetime DEFAULT NULL,
  PRIMARY KEY (`id_historial`),
  KEY `idx_historial_lista` (`id_lista`,`fecha_hora`),
  KEY `idx_historial_lote` (`id_lote`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
