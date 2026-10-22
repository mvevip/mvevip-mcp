import { z } from 'zod';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

// Schemas Zod para validar argumentos de las herramientas
export const TestDbInputSchema = z.object({});

export const DescribeDatabaseInputSchema = z.object({});

export const GetTableSchemaInputSchema = z.object({
  tableName: z.string().min(1, 'El nombre de la tabla es requerido'),
});

export const QueryDatabaseInputSchema = z.object({
  query: z.string().min(5, 'La consulta SQL debe tener al menos 5 caracteres'),
  maxRows: z.number().int().positive().max(500).default(50).optional(),
});
