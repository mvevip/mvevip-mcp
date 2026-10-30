export const REPORT_TIMEZONE = 'America/Guayaquil';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const parseIso = (s: string): Date => {
  if (!ISO_DATE.test(s)) throw new Error('La fecha debe tener formato YYYY-MM-DD.');
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.toISOString().slice(0, 10) !== s) throw new Error('La fecha no es válida.');
  return date;
};

export const toIso = (d: Date) => d.toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string => {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
};

/** Fecha de hoy en la zona horaria del negocio (el servidor corre en UTC). */
export const todayInTimezone = (now: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};

/** Mes y año vigentes en la zona horaria del negocio (no en la del servidor, que es UTC). */
export const currentMonthInTimezone = (now: Date = new Date()): { mes: number; anio: number } => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit' })
    .formatToParts(now);
  return {
    anio: Number(parts.find((p) => p.type === 'year')!.value),
    mes: Number(parts.find((p) => p.type === 'month')!.value)
  };
};

export const monthRange = (fecha: string): { desde: string; hastaExclusivo: string } => {
  const d = parseIso(fecha);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return { desde: toIso(new Date(Date.UTC(y, m, 1))), hastaExclusivo: toIso(new Date(Date.UTC(y, m + 1, 1))) };
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Período de un reporte: rango explícito (inclusive en ambos extremos) o un mes completo (por defecto el actual). */
export const resolveDateRange = (
  p: { mes?: number; anio?: number; fecha_desde?: string; fecha_hasta?: string },
  now: Date = new Date()
): { desde: string; hastaExclusivo: string } => {
  if (p.fecha_desde || p.fecha_hasta) {
    const desde = (p.fecha_desde ?? p.fecha_hasta)!;
    const hasta = (p.fecha_hasta ?? p.fecha_desde)!;
    parseIso(desde);
    parseIso(hasta);
    if (desde > hasta) throw new Error('fecha_desde no puede ser posterior a fecha_hasta.');
    return { desde, hastaExclusivo: addDays(hasta, 1) };
  }
  const current = currentMonthInTimezone(now);
  const mes = p.mes ?? current.mes;
  const anio = p.anio ?? current.anio;
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw new Error('El mes debe estar entre 1 y 12.');
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw new Error('El año no es válido.');
  return monthRange(`${anio}-${pad2(mes)}-01`);
};
