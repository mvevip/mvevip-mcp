import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';

export const handleTestDbConnection = async (): Promise<ToolResult> => {
  const result = await dbService.testConnection();

  if (result.ok) {
    const text = [
      '✅ [MVEVIP MCP] Prueba de conexión a la base de datos EXITOSA.',
      '',
      `• Host: ${result.host}`,
      `• Base de Datos: ${result.database}`,
      `• Versión Motor: ${result.serverVersion}`,
      `• Hora del Servidor: ${result.serverTime}`,
      `• Latencia de Conexión: ${result.latencyMs} ms`,
      '',
      'El servidor MCP está listo para recibir consultas y procesar datos corporativos con Claude.'
    ].join('\n');

    return {
      content: [{ type: 'text', text }]
    };
  } else {
    const text = [
      '⚠️ [MVEVIP MCP] Prueba de conexión a la base de datos FALLIDA.',
      '',
      `• Host Intentado: ${result.host}`,
      `• Error Detectado: ${result.error}`,
      `• Tiempo Transcurrido: ${result.latencyMs} ms`,
      '',
      'Sugerencia: Verifique las variables de entorno DB_HOST, DB_USER, DB_PASSWORD, DB_PORT en el archivo .env o en el contenedor Docker.'
    ].join('\n');

    return {
      content: [{ type: 'text', text }],
      isError: true
    };
  }
};
