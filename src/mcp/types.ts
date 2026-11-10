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

export const AsistenciaInputSchema = z.object({
  mes: z.number().int().min(1).max(12).optional(),
  anio: z.number().int().min(2000).max(2100).optional(),
  fecha_desde: IsoDate.optional(),
  fecha_hasta: IsoDate.optional(),
  departamento: z.string().max(60).optional(),
  empleado: z.string().max(60).optional(),
  dispositivo: z.string().max(60).optional(),
  agrupar_por: z.enum(['ninguno', 'empleado', 'dia', 'departamento']).optional(),
  todas_las_marcaciones: z.boolean().optional(),
  tolerancia_minutos: z.number().int().min(0).max(120).optional(),
  ordenar_por: z.string().max(40).optional(),
  direccion: z.enum(['asc', 'desc']).optional(),
});

export const ValidarCruceVentasInputSchema = z.object({
  mes: z.number().int().min(1).max(12).optional(),
  anio: z.number().int().min(2000).max(2100).optional(),
  fecha_desde: IsoDate.optional(),
  fecha_hasta: IsoDate.optional(),
  asesor: z.string().max(60).optional(),
});

const EstadoRef = z.union([z.string().min(1).max(60), z.number().int().min(0).max(1000)]);
const BaseShape = {
  mes: z.number().int().min(1).max(12).optional(),
  anio: z.number().int().min(2000).max(2100).optional(),
  fecha_desde: IsoDate.optional(),
  fecha_hasta: IsoDate.optional(),
  banco: z.number().int().min(1).max(100000).optional(),
  estados_incluir: z.array(EstadoRef).max(30).optional(),
  estados_excluir: z.array(EstadoRef).max(30).optional(),
  ciudad: z.string().max(60).optional(),
  filtrar_identificador: z.string().max(100).optional(),
  filtrar_identificador_original: z.string().max(100).optional(),
  excluir_bloq: z.boolean().optional(),
  asterisk_desde: IsoDate.optional(),
  asterisk_hasta: IsoDate.optional(),
  billsec_max: z.number().int().min(0).max(3600).optional(),
  incluir_sin_registro: z.boolean().optional(),
  para_predictivo: z.boolean().optional(),
  nombre_identificador: z.string().max(100).optional(),
};
export const BuscarBaseInputSchema = z.object(BaseShape);
export const AplicarBaseInputSchema = z.object({ ...BaseShape, codigo_confirmacion: z.string().min(10).max(80) });
export const EncerarCuposInputSchema = z.object({ codigo_confirmacion: z.string().min(10).max(80).optional() });
