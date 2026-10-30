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

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
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
export const SalesReportInputSchema = z.object({
  mes: z.number().int().min(1).max(12).optional(),
  anio: z.number().int().min(2000).max(2100).optional(),
  agrupar_por: z.enum(['ninguno', 'asesor', 'lider', 'lider_asistente', 'ciudad', 'contrato', 'tipo_contrato']).optional(),
  ordenar_por: z.string().max(40).optional(),
  direccion: z.enum(['asc', 'desc']).optional(),
  incluir_requerimientos: z.boolean().optional(),
});

export const CuadroVentasInputSchema = z.object({
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato YYYY-MM-DD').optional(),
});

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato YYYY-MM-DD');
export const RequerimientosInputSchema = z.object({
  mes: z.number().int().min(1).max(12).optional(),
  anio: z.number().int().min(2000).max(2100).optional(),
  fecha_desde: IsoDate.optional(),
  fecha_hasta: IsoDate.optional(),
  agrupar_por: z.enum(['ninguno', 'asesor']).optional(),
  ordenar_por: z.string().max(40).optional(),
  direccion: z.enum(['asc', 'desc']).optional(),
});
