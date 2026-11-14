import type { BBox, Coverage, RegionCode, RegionMeta, Selection } from './types';

/**
 * Grid cell index of a coordinate, exactly as in the pipeline:
 * g = floor(round(deg * 100000) / 10000). Integer arithmetic on purpose,
 * so a point never lands in a different cell than in Python.
 */
export function cellIndex(deg: number): number {
  return Math.floor(Math.round(deg * 100000) / 10000);
}

/** Smallest grid line (in tenths of a degree) at or above the coordinate. */
export function ceilIndex(deg: number): number {
  return Math.ceil(Math.round(deg * 100000) / 10000);
}

export function regionEdges(r: RegionMeta): Omit<Selection, 'region'> {
  const [w, s, e, n] = r.bbox;
  return { w: cellIndex(w), s: cellIndex(s), e: ceilIndex(e), n: ceilIndex(n) };
}

export function wholeRegion(code: RegionCode, r: RegionMeta): Selection {
  return { region: code, ...regionEdges(r) };
}

export function isWholeRegion(sel: Selection, r: RegionMeta): boolean {
  const b = regionEdges(r);
  return sel.w === b.w && sel.s === b.s && sel.e === b.e && sel.n === b.n;
}

export function selectionBBox(sel: Selection): BBox {
  return [sel.w / 10, sel.s / 10, sel.e / 10, sel.n / 10];
}

/** Inclusive cell index ranges for SQL. */
export function cellRange(sel: Selection) {
  return { gx0: sel.w, gx1: sel.e - 1, gy0: sel.s, gy1: sel.n - 1 };
}

export interface Resolved {
  sel: Selection;
  /** Part of the requested rectangle lay outside the covered region. */
  clipped: boolean;
}

/**
 * Snap a rectangle outward to the grid and clip it to the covered region it
 * overlaps most. Returns null when it touches no covered region.
 */
export function resolveBBox(bbox: BBox, regions: Record<RegionCode, RegionMeta>): Resolved | null {
  let [w, s, e, n] = bbox;
  if (![w, s, e, n].every(Number.isFinite)) return null;
  if (w > e) [w, e] = [e, w];
  if (s > n) [s, n] = [n, s];
  const req = { w: cellIndex(w), s: cellIndex(s), e: ceilIndex(e), n: ceilIndex(n) };
  if (req.e <= req.w) req.e = req.w + 1;
  if (req.n <= req.s) req.n = req.s + 1;

  let best: Resolved | null = null;
  let bestArea = 0;
  for (const [code, r] of Object.entries(regions)) {
    const b = regionEdges(r);
    const c = {
      w: Math.max(req.w, b.w),
      s: Math.max(req.s, b.s),
      e: Math.min(req.e, b.e),
      n: Math.min(req.n, b.n),
    };
    const area = (c.e - c.w) * (c.n - c.s);
    if (c.e > c.w && c.n > c.s && area > bestArea) {
      bestArea = area;
      const clipped = c.w !== req.w || c.s !== req.s || c.e !== req.e || c.n !== req.n;
      best = { sel: { region: code, ...c }, clipped };
    }
  }
  return best;
}

/**
 * Covered cells inside a selection. The data only covers land inside the
 * listed countries, so a cell without rows is "no fire" only when it is
 * covered. Returns null when the build has no coverage file.
 */
export function coverageOf(sel: Selection, coverage: Coverage | null): { covered: number; total: number } | null {
  const region = coverage?.regions[sel.region];
  if (!region) return null;
  let covered = 0;
  for (let gy = sel.s; gy < sel.n; gy++) {
    for (const [a, b] of region.rows[gy] ?? []) {
      const lo = Math.max(a, sel.w);
      const hi = Math.min(b, sel.e - 1);
      if (hi >= lo) covered += hi - lo + 1;
    }
  }
  return { covered, total: (sel.e - sel.w) * (sel.n - sel.s) };
}
