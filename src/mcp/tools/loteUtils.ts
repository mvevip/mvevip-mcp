/**
 * Búsqueda por lista (hasta 100 valores en una sola llamada) para encontrar_cliente y encontrar_contacto.
 * Coincidencia EXACTA (no «contiene»): documento y correo iguales sin distinguir mayúsculas; teléfono igual por dígitos
 * (sin importar el 0 inicial, +593, espacios ni símbolos); nombres con todas las palabras en cualquier orden.
 * La consulta SQL trae un conjunto amplio y la coincidencia exacta se confirma aquí, para saber qué valor encontró a cada fila.
 */
export const LOTE_MAX_VALORES = 100;
export const LOTE_MAX_NOMBRES = 20;
export const LOTE_MIN_CARACTERES = 3;
export const LOTE_MAX_CARACTERES = 80;
export const LOTE_MIN_DIGITOS_TELEFONO = 7;

export type LoteCampo = 'todos' | 'documento' | 'telefono' | 'correo' | 'nombres';
export const LOTE_CAMPOS: readonly LoteCampo[] = ['todos', 'documento', 'telefono', 'correo', 'nombres'];

/**
 * Dígitos de un teléfono sin código de país ni ceros iniciales: "0969 816-358", "969816358" y "+593 969 816 358"
 * dan lo mismo. Los celulares se guardan con y sin el 0 inicial, con espacios y con símbolos.
 */
export const nucleoTelefono = (texto: string): string => {
  let d = texto.replace(/\D/g, '').replace(/^0+/, '');
  if (d.startsWith('593') && d.length >= 11) d = d.slice(3).replace(/^0+/, '');
  return d;
};

export interface ItemLote {
  /** Texto tal como lo escribió el usuario (sin espacios sobrantes). */
  consulta: string;
  documento?: string;
  telefono?: string;
  correo?: string;
  palabras?: string[];
}

export interface LotePreparado {
  items: ItemLote[];
  invalidos: Array<{ valor: string; motivo: string }>;
  recibidos: number;
  repetidos: number;
}

const SOLO_TELEFONO = /^[\d\s+().\/-]+$/;

export const prepararLote = (valores: unknown, campo: LoteCampo): LotePreparado => {
  if (!Array.isArray(valores) || valores.length === 0) throw new Error('Indique al menos un valor en la lista.');
  if (valores.length > LOTE_MAX_VALORES) throw new Error(`Máximo ${LOTE_MAX_VALORES} valores por consulta (recibidos ${valores.length}). Divida la lista en varias consultas.`);
  if (!(LOTE_CAMPOS as readonly string[]).includes(campo)) throw new Error(`campo inválido para una lista. Opciones: ${LOTE_CAMPOS.join(', ')}`);
  if (campo === 'nombres' && valores.length > LOTE_MAX_NOMBRES) {
    throw new Error(`Para buscar nombres en lista el máximo es ${LOTE_MAX_NOMBRES} valores por consulta (es una búsqueda más pesada).`);
  }

  const items: ItemLote[] = [];
  const invalidos: LotePreparado['invalidos'] = [];
  const vistos = new Set<string>();
  let repetidos = 0;

  for (const bruto of valores) {
    const v = String(bruto ?? '').trim().replace(/\s+/g, ' ');
    if (!v) { invalidos.push({ valor: '', motivo: 'valor vacío' }); continue; }
    if (v.length < LOTE_MIN_CARACTERES) { invalidos.push({ valor: v, motivo: `menos de ${LOTE_MIN_CARACTERES} caracteres` }); continue; }
    if (v.length > LOTE_MAX_CARACTERES) { invalidos.push({ valor: v.slice(0, 20) + '…', motivo: `más de ${LOTE_MAX_CARACTERES} caracteres` }); continue; }
    const clave = v.toLowerCase();
    if (vistos.has(clave)) { repetidos++; continue; }
    vistos.add(clave);

    const item: ItemLote = { consulta: v };
    const minusculas = v.toLowerCase();
    if (campo === 'documento') {
      item.documento = minusculas;
    } else if (campo === 'correo') {
      if (!v.includes('@')) { invalidos.push({ valor: v, motivo: 'no parece un correo (falta @)' }); continue; }
      item.correo = minusculas;
    } else if (campo === 'telefono') {
      const core = nucleoTelefono(v);
      if (core.length < LOTE_MIN_DIGITOS_TELEFONO) { invalidos.push({ valor: v, motivo: `teléfono con menos de ${LOTE_MIN_DIGITOS_TELEFONO} dígitos` }); continue; }
      item.telefono = core;
    } else if (campo === 'nombres') {
      item.palabras = minusculas.split(' ').filter(Boolean);
    } else if (v.includes('@')) {
      // todos: un valor con @ solo puede ser un correo
      item.correo = minusculas;
    } else {
      // todos: documento exacto y, si parece un teléfono (solo dígitos y signos), también teléfono
      item.documento = minusculas;
      if (SOLO_TELEFONO.test(v)) {
        const core = nucleoTelefono(v);
        if (core.length >= LOTE_MIN_DIGITOS_TELEFONO) item.telefono = core;
      }
    }
    items.push(item);
  }
  return { items, invalidos, recibidos: valores.length, repetidos };
};

export interface FilaParaLote {
  documento?: unknown;
  correo?: unknown;
  nombres?: unknown;
  telefonos?: Array<{ etiqueta: string; valor: unknown }>;
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** Con qué campos coincide exactamente la fila con el valor pedido (vacío = no coincide). */
export const coincidePor = (item: ItemLote, f: FilaParaLote): string[] => {
  const por: string[] = [];
  if (item.documento && norm(f.documento) === item.documento) por.push('documento');
  if (item.correo && norm(f.correo) === item.correo) por.push('correo');
  if (item.telefono) {
    for (const t of f.telefonos ?? []) {
      if (nucleoTelefono(String(t.valor ?? '')) === item.telefono) por.push(t.etiqueta);
    }
  }
  if (item.palabras?.length) {
    const nombre = norm(f.nombres);
    if (item.palabras.every((p) => nombre.includes(p))) por.push('nombres');
  }
  return por;
};

export const repartirLote = <T>(items: ItemLote[], filas: T[], aFila: (f: T) => FilaParaLote) =>
  items.map((item) => ({
    item,
    coincidencias: filas.map((fila) => ({ fila, por: coincidePor(item, aFila(fila)) })).filter((c) => c.por.length > 0)
  }));

export type RepartoLote<T> = ReturnType<typeof repartirLote<T>>;

export const marcas = (n: number): string => Array(n).fill('?').join(', ');

/** Cuerpo común de la respuesta de una búsqueda por lista. */
export const armarLote = <T>(
  prep: LotePreparado,
  reparto: RepartoLote<T>,
  nombreLista: 'clientes' | 'contactos',
  formatear: (f: T) => Record<string, unknown>,
  idDe: (f: T) => unknown
) => {
  const resultados = reparto.map((r) => ({
    consulta: r.item.consulta,
    encontrados: r.coincidencias.length,
    [nombreLista]: r.coincidencias.map((c) => ({ ...formatear(c.fila), coincide_por: c.por }))
  }));
  const distintos = new Set(reparto.flatMap((r) => r.coincidencias.map((c) => idDe(c.fila))));
  return {
    resumen: {
      valores_recibidos: prep.recibidos,
      valores_buscados: prep.items.length,
      con_resultado: reparto.filter((r) => r.coincidencias.length > 0).length,
      sin_resultado: reparto.filter((r) => r.coincidencias.length === 0).length,
      con_varios_resultados: reparto.filter((r) => r.coincidencias.length > 1).length,
      [`${nombreLista}_distintos`]: distintos.size
    },
    no_encontrados: reparto.filter((r) => r.coincidencias.length === 0).map((r) => r.item.consulta),
    valores_invalidos: prep.invalidos,
    resultados
  };
};
