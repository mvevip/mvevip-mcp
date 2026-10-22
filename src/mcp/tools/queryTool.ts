import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';

const MAX_OUTPUT_CHARS = 100_000;

export const handleQueryDatabase = async (
  query: string,
  maxRows: number = 50
): Promise<ToolResult> => {
  try {
    const result = await dbService.executeReadOnlyQuery(query, maxRows);

    let jsonSnippet = JSON.stringify(result.rows, null, 2);
    const outputTruncated = jsonSnippet.length > MAX_OUTPUT_CHARS;
    if (outputTruncated) jsonSnippet = `${jsonSnippet.slice(0, MAX_OUTPUT_CHARS)}\n... (salida recortada)`;
    const notes = result.truncated || outputTruncated
      ? ' — resultado limitado; use filtros o un LIMIT menor para ver el resto'
      : '';
    const text = [
      `🔍 [MVEVIP MCP] Consulta ejecutada con éxito (${result.rowCount} registros retornados${notes}):`,
      '',
      '```json',
      jsonSnippet,
      '```'
    ].join('\n');

    return {
      content: [{ type: 'text', text }]
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error al ejecutar consulta: ${error?.message || String(error)}`
        }
      ],
      isError: true
    };
  }
};
