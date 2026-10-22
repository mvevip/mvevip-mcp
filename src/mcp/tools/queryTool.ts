import { dbService } from '../../services/dbService';

export const handleQueryDatabase = async (
  query: string,
  maxRows: number = 50
): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
  try {
    const result = await dbService.executeReadOnlyQuery(query, maxRows);

    const jsonSnippet = JSON.stringify(result.rows, null, 2);
    const text = [
      `🔍 [MVEVIP MCP] Consulta ejecutada con éxito (${result.rowCount} registros retornados):`,
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
      ]
    };
  }
};
