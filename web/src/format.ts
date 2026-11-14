export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Counts: whole numbers, one decimal below 10 so small converted values stay visible. */
export function num(v: number): string {
  if (v === 0) return '0';
  return Math.abs(v) < 10 && !Number.isInteger(Math.round(v * 10) / 10) ? one.format(v) : int.format(v);
}

export function pct(v: number, digits = 0): string {
  const p = v * 100;
  const s = Math.abs(p) >= 1000 ? int.format(p) : p.toFixed(digits);
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${s.replace('-', '')}%`;
}

export function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

export function degrees(v: number, axis: 'lat' | 'lon'): string {
  const hemi = axis === 'lat' ? (v < 0 ? 'S' : 'N') : v < 0 ? 'W' : 'E';
  return `${Math.abs(v).toFixed(1)}° ${hemi}`;
}

export const METRIC_LABEL = { cd: 'active cell-days', hs: 'equivalent hotspots' } as const;
export const METRIC_SHORT = { cd: 'Cell-days', hs: 'Hotspots' } as const;

export function ymIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}
export function ymParts(ym: number): { year: number; month: number } {
  return { year: Math.floor(ym / 12), month: (ym % 12) + 1 };
}
export function ymText(ym: number): string {
  const { year, month } = ymParts(ym);
  return `${year}-${String(month).padStart(2, '0')}`;
}
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
