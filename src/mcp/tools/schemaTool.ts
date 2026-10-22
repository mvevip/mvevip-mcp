import { dbService } from '../../services/dbService';
import { ToolResult } from '../types';

export const handleDescribeDatabase = async (): Promise<ToolResult> => {
  try {
    const overview = await dbService.getDatabaseOverview();

    if (overview.totalTables === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'ℹ️ No se encontraron tablas en la base de datos configurada o no se poseen permisos de lectura sobre information_schema.'
          }
        ]
      };
    }

    const tableLines = overview.tables.map((t, idx) => {
      const commentPart = t.comment ? ` | Comentario: "${t.comment}"` : '';
      return `${idx + 1}. \`${t.tableName}\` (~${t.estimatedRows} filas, ${t.dataSizeKb} KB)${commentPart}`;
    });

    const text = [
      `📊 [MVEVIP MCP] Catálogo de Tablas en la Base de Datos (${overview.totalTables} tablas detectadas):`,
      '',
      ...tableLines,
      '',
      'Para conocer las columnas y tipos de datos de cualquier tabla, use la herramienta `get_table_schema` indicando el `tableName`.'
    ].join('\n');

    return {
      content: [{ type: 'text', text }]
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error al explorar la base de datos: ${error?.message || String(error)}`
        }
      ],
      isError: true
    };
  }
};

export const handleGetTableSchema = async (
  tableName: string
): Promise<ToolResult> => {
  try {
    const columns = await dbService.getTableSchema(tableName);

    if (columns.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `⚠️ No se encontraron columnas para la tabla '${tableName}'. Verifique si el nombre está escrito correctamente.`
          }
        ]
      };
    }

    const columnLines = columns.map((col) => {
      const nullPart = col.isNullable ? 'NULL' : 'NOT NULL';
      const keyPart = col.columnKey ? ` [${col.columnKey}]` : '';
      const commentPart = col.comment ? ` // ${col.comment}` : '';
      return `• \`${col.columnName}\`: ${col.dataType} (${nullPart}${keyPart})${commentPart}`;
    });

    const text = [
      `📑 [MVEVIP MCP] Estructura de la tabla \`${tableName}\` (${columns.length} campos):`,
      '',
      ...columnLines
    ].join('\n');

    return {
      content: [{ type: 'text', text }]
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error al obtener el esquema de la tabla '${tableName}': ${error?.message || String(error)}`
        }
      ],
      isError: true
    };
  }
};
