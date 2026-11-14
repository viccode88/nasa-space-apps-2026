/**
 * Calculation rules of the website (spec section 8, docs/DATA_FORMAT.md).
 * Everything here works on monthly rows; "now" is the data cut-off, never
 * the browser clock.
 */
import { daysInMonth, ymIndex } from './format';
import type { Baseline, Metric, MissingDays, MonthRow } from './types';

export interface Cutoff {
  year: number;
  month: number;
  day: number;
}

export interface ModelOptions {
  metric: Metric;
  baseline: Baseline;
  /** Inclusive month range as year * 12 + (month - 1). */
  from: number;
  to: number;
  cutoff: Cutoff;
  /** Rows carry `mtd` values from daily data, so same-day comparison is exact. */
  exactMtd: boolean;
  missing?: MissingDays;
}

export interface Cell {
  year: number;
  month: number;
  value: number;
  lo: number;
  hi: number;
  raw: number;
  src: number;
  converted: boolean;
  /** Harmonized value divided by raw value; null when there is no raw value. */
  k: number | null;
  nrt: boolean;
  incomplete: boolean;
  outageDays: number;
  toDate: boolean;
  median: number;
  /** (value - median) / median; null when the median is 0. */
  diff: number | null;
  rank: number;
  n: number;
  /** Month in progress with no daily data: no baseline, so no difference or rank. */
  uncompared: boolean;
}

export interface AnnualTotal {
  year: number;
  observed: number;
  converted: number;
  total: number;
  /** All twelve months are inside the date range and complete. */
  full: boolean;
}

export interface MonthStats {
  month: number;
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  p10: number;
  p90: number;
}

export interface Season {
  /** First month, 1..12. */
  start: number;
  length: number;
  share: number;
}

export interface Outlook extends MonthStats {
  /** Years in which this month was above that year's monthly mean. */
  aboveMean: number;
  years: number;
}

export interface Model {
  options: ModelOptions;
  years: number[];
  cell(year: number, month: number): Cell | null;
  cells: Cell[];
  annual: AnnualTotal[];
  topYear: AnnualTotal | null;
  monthStats: MonthStats[];
  season: Season | null;
  current: Cell | null;
  outlook: Outlook[];
  baselineYears: number[];
  total: number;
  maxValue: number;
  /** Lowest complete month; the colour scale starts here so busy regions keep their contrast. */
  minValue: number;
  /** Historical monthly median of active cell-days is below 30. */
  smallSelection: boolean;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

/**
 * Shortest run of consecutive months (may cross the year end) that holds at
 * least `share` of the sum of the twelve values. Ties go to the larger sum.
 */
export function burnSeason(monthly: number[], share = 0.6): Season | null {
  const total = monthly.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  for (let length = 1; length <= 12; length++) {
    let best: Season | null = null;
    for (let start = 0; start < 12; start++) {
      let sum = 0;
      for (let i = 0; i < length; i++) sum += monthly[(start + i) % 12];
      const s = sum / total;
      if (s >= share - 1e-12 && (!best || s > best.share)) best = { start: start + 1, length, share: s };
    }
    if (best) return best;
  }
  return null;
}

function isoMonthPrefix(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-`;
}

export function buildModel(rows: MonthRow[], options: ModelOptions): Model {
  const { metric, cutoff, exactMtd } = options;
  const cutYM = ymIndex(cutoff.year, cutoff.month);
  const from = options.from;
  const to = Math.min(options.to, cutYM);
  const byYM = new Map<number, MonthRow>();
  for (const r of rows) byYM.set(ymIndex(r.year, r.month), r);

  const partialCutoffMonth = cutoff.day < daysInMonth(cutoff.year, cutoff.month);
  const inRange = (y: number, m: number) => {
    const i = ymIndex(y, m);
    return i >= from && i <= to;
  };
  const isCurrent = (y: number, m: number) => partialCutoffMonth && ymIndex(y, m) === cutYM;
  const value = (y: number, m: number) => byYM.get(ymIndex(y, m))?.[metric] ?? 0;

  const firstYear = Math.floor(from / 12);
  const lastYear = Math.floor(to / 12);
  const years: number[] = [];
  for (let y = firstYear; y <= lastYear; y++) years.push(y);

  const periodYears =
    options.baseline === 'last10' ? years.filter((y) => y >= cutoff.year - 10 && y <= cutoff.year - 1) : years;

  /** Baseline years for month m: in the period, in range, complete. */
  const baseYears = (m: number, exclude?: number) =>
    periodYears.filter((y) => y !== exclude && inRange(y, m) && !isCurrent(y, m));

  /** Value of a baseline year restricted to days 1..D, for month-to-date comparison. */
  const sameDays = (y: number, m: number) => byYM.get(ymIndex(y, m))?.mtd?.[metric] ?? 0;

  const outage = (src: number, y: number, m: number) => {
    const days = options.missing?.sensors[String(src)];
    if (!days) return 0;
    const prefix = isoMonthPrefix(y, m);
    return days.reduce((c, d) => c + (d.startsWith(prefix) ? 1 : 0), 0);
  };

  const srcOf = (y: number, m: number) => {
    const i = ymIndex(y, m);
    if (i < ymIndex(2012, 2)) return 0;
    if (i < ymIndex(2026, 11)) return 1;
    return 2;
  };

  const cellMap = new Map<number, Cell>();
  const cells: Cell[] = [];
  for (const y of years) {
    for (let m = 1; m <= 12; m++) {
      if (!inRange(y, m)) continue;
      const row = byYM.get(ymIndex(y, m));
      const toDate = isCurrent(y, m);
      const v = row?.[metric] ?? 0;
      // Without daily data there is no like-for-like baseline for a month in progress.
      // Scaling whole months by the number of days was tried and misleads: fires are
      // not spread evenly through a month.
      const comparable = !toDate || exactMtd;
      const base = comparable ? baseYears(m, y).map((b) => (toDate ? sameDays(b, m) : value(b, m))) : [];
      const med = median(base);
      const src = row?.src ?? srcOf(y, m);
      const raw = row ? (metric === 'cd' ? row.cd_raw : row.hs_raw) : 0;
      const outageDays = outage(src, y, m);
      const cell: Cell = {
        year: y,
        month: m,
        value: v,
        lo: row ? (metric === 'cd' ? row.cd_lo : row.hs_lo) : 0,
        hi: row ? (metric === 'cd' ? row.cd_hi : row.hs_hi) : 0,
        raw,
        src,
        converted: src !== 1,
        k: raw > 0 ? v / raw : null,
        nrt: row?.nrt ?? false,
        incomplete: outageDays >= 3,
        outageDays,
        toDate,
        median: med,
        diff: base.length > 0 && med > 0 ? (v - med) / med : null,
        rank: 1 + base.filter((b) => b > v).length,
        n: base.length + 1,
        uncompared: !comparable,
      };
      cellMap.set(ymIndex(y, m), cell);
      cells.push(cell);
    }
  }

  const annual: AnnualTotal[] = years.map((y) => {
    const a: AnnualTotal = { year: y, observed: 0, converted: 0, total: 0, full: true };
    for (let m = 1; m <= 12; m++) {
      const c = cellMap.get(ymIndex(y, m));
      if (!c || c.toDate) {
        a.full = false;
        if (!c) continue;
      }
      if (c.converted) a.converted += c.value;
      else a.observed += c.value;
      a.total += c.value;
    }
    return a;
  });
  const fullYears = annual.filter((a) => a.full);
  const ranked = (fullYears.length > 0 ? fullYears : annual).filter((a) => a.total > 0);
  const topYear = ranked.reduce<AnnualTotal | null>((top, a) => (!top || a.total > top.total ? a : top), null);

  const monthStats: MonthStats[] = [];
  for (let m = 1; m <= 12; m++) {
    const vals = baseYears(m).map((y) => value(y, m)).sort((a, b) => a - b);
    monthStats.push({
      month: m,
      n: vals.length,
      min: vals[0] ?? 0,
      q1: quantile(vals, 0.25),
      median: quantile(vals, 0.5),
      q3: quantile(vals, 0.75),
      max: vals[vals.length - 1] ?? 0,
      p10: quantile(vals, 0.1),
      p90: quantile(vals, 0.9),
    });
  }
  const season = burnSeason(monthStats.map((s) => s.median));

  const completeYears = periodYears.filter((y) => {
    for (let m = 1; m <= 12; m++) if (!inRange(y, m) || isCurrent(y, m)) return false;
    return true;
  });
  const outlook: Outlook[] = [];
  for (let i = 1; i <= 3; i++) {
    const m = ((cutoff.month - 1 + i) % 12) + 1;
    let above = 0;
    for (const y of completeYears) {
      let sum = 0;
      for (let k = 1; k <= 12; k++) sum += value(y, k);
      if (value(y, m) > sum / 12) above++;
    }
    outlook.push({ ...monthStats[m - 1], aboveMean: above, years: completeYears.length });
  }

  // The small-selection warning is defined on cell-days, whatever metric is shown.
  const cdHistory: number[] = [];
  for (const y of periodYears) {
    for (let m = 1; m <= 12; m++) {
      if (inRange(y, m) && !isCurrent(y, m)) cdHistory.push(byYM.get(ymIndex(y, m))?.cd ?? 0);
    }
  }

  return {
    options: { ...options, to },
    years,
    cell: (y, m) => cellMap.get(ymIndex(y, m)) ?? null,
    cells,
    annual,
    topYear,
    monthStats,
    season,
    current: cellMap.get(cutYM) ?? null,
    outlook,
    baselineYears: periodYears,
    total: cells.reduce((a, c) => a + c.value, 0),
    maxValue: cells.reduce((a, c) => Math.max(a, c.value), 0),
    minValue: cells.reduce((a, c) => (c.toDate ? a : Math.min(a, c.value)), cells.some((c) => !c.toDate) ? Infinity : 0),
    smallSelection: cdHistory.length > 0 && median(cdHistory) < 30,
  };
}
