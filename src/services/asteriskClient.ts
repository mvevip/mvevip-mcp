export interface LlamadasTelefono {
  llamadas: number;
  duracion: number;
  billsec: number;
  ultima_llamada: string | null;
}
export type LlamadasPorTelefono = Map<string, LlamadasTelefono>;

const CHUNK = 2000;
const TIMEOUT_MS = 20000;

/**
 * Consulta el servicio asterisk-gateway (HTTPS, solo lectura) y devuelve las llamadas por teléfono.
 * Un teléfono que no está en el mapa no tiene ningún registro en `cdr` en el rango.
 * `fetchImpl` permite inyectar un fetch falso en las pruebas.
 */
export const consultarLlamadas = async (
  telefonos: string[],
  desde: string,
  hasta: string,
  fetchImpl: typeof fetch = fetch
): Promise<LlamadasPorTelefono> => {
  const baseUrl = (process.env.ASTERISK_API_URL || '').replace(/\/+$/, '');
  const token = process.env.ASTERISK_API_TOKEN || '';
  if (!baseUrl || !token) {
    throw new Error('La consulta a Asterisk no está configurada (faltan ASTERISK_API_URL y ASTERISK_API_TOKEN).');
  }
  const out: LlamadasPorTelefono = new Map();
  for (let i = 0; i < telefonos.length; i += CHUNK) {
    const lote = telefonos.slice(i, i + CHUNK);
    let respuesta: Response;
    try {
      respuesta = await fetchImpl(`${baseUrl}/cdr/resumen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ telefonos: lote, desde, hasta }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch {
      throw new Error('No se pudo conectar con el servicio de Asterisk (sin respuesta). No se hizo ningún cambio.');
    }
    if (!respuesta.ok) {
      throw new Error(`El servicio de Asterisk respondió con error ${respuesta.status}. No se hizo ningún cambio.`);
    }
    const json: any = await respuesta.json();
    for (const r of json.registros ?? []) {
      out.set(String(r.dst), {
        llamadas: Number(r.llamadas),
        duracion: Number(r.duracion),
        billsec: Number(r.billsec),
        ultima_llamada: r.ultima_llamada ?? null
      });
    }
  }
  return out;
};
