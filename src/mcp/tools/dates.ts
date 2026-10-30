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
