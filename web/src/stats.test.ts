import { describe, expect, it } from 'vitest';
import { ymIndex } from './format';
import { cellIndex, resolveBBox } from './grid';
import { buildModel, burnSeason, median, type ModelOptions } from './stats';
import type { MonthRow, RegionMeta } from './types';

function row(year: number, month: number, cd: number, extra: Partial<MonthRow> = {}): MonthRow {
  return {
    year, month, src: 1, cd, cd_lo: cd, cd_hi: cd, hs: cd * 2, hs_lo: cd * 2, hs_hi: cd * 2,
    cd_raw: cd, hs_raw: cd * 2, nrt: false, ...extra,
  };
}

const base: ModelOptions = {
  metric: 'cd',
  baseline: 'all',
  from: ymIndex(2020, 1),
  to: ymIndex(2024, 6),
  cutoff: { year: 2024, month: 6, day: 10 },
  exactMtd: true,
};

describe('grid', () => {
  it('uses the pipeline integer arithmetic', () => {
    expect(cellIndex(-100.0)).toBe(-1000);
    expect(cellIndex(-100.00001)).toBe(-1001);
    expect(cellIndex(-99.95)).toBe(-1000);
    expect(cellIndex(0.3)).toBe(3);
    expect(cellIndex(-0.05)).toBe(-1);
  });

  const regions = {
    twn: { bbox: [118.0, 21.5, 122.5, 26.5] } as RegionMeta,
    usa: { bbox: [-125.0, 24.0, -66.5, 49.5] } as RegionMeta,
  };

  it('snaps outward and clips to the covered region', () => {
    const r = resolveBBox([120.04, 23.01, 121.33, 24.5], regions)!;
    expect(r.sel).toEqual({ region: 'twn', w: 1200, s: 230, e: 1214, n: 245 });
    expect(r.clipped).toBe(false);
    expect(resolveBBox([117, 20, 119, 22], regions)!.clipped).toBe(true);
  });

  it('returns null outside every covered region', () => {
    expect(resolveBBox([0, 0, 10, 10], regions)).toBeNull();
  });
});

describe('burn season', () => {
  it('finds the shortest run holding 60%', () => {
    expect(burnSeason([1, 1, 1, 1, 1, 1, 10, 10, 1, 1, 1, 1])).toMatchObject({ start: 7, length: 2 });
  });
  it('can cross the year end', () => {
    expect(burnSeason([10, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10])).toMatchObject({ start: 12, length: 2 });
  });
  it('is null when nothing burns', () => {
    expect(burnSeason(new Array(12).fill(0))).toBeNull();
  });
});

describe('model', () => {
  it('counts a month with no fire as 0 in the median', () => {
    expect(median([0, 0, 4])).toBe(0);
    const m = buildModel([row(2020, 3, 8), row(2023, 3, 5)], base);
    // March 2023 against 2020, 2021, 2022, 2024 = 8, 0, 0, 0 -> median 0.
    const c = m.cell(2023, 3)!;
    expect(c.median).toBe(0);
    expect(c.diff).toBeNull();
    expect(c.rank).toBe(2);
    expect(c.n).toBe(5);
  });

  it('excludes the compared year from its own baseline', () => {
    const rows = [row(2020, 1, 10), row(2021, 1, 20), row(2022, 1, 30), row(2023, 1, 40), row(2024, 1, 100)];
    const c = buildModel(rows, base).cell(2024, 1)!;
    expect(c.median).toBe(25);
    expect(c.diff).toBe(3);
    expect(c.rank).toBe(1);
  });

  it('compares the current month with the same days of past years', () => {
    const rows = [
      row(2021, 6, 300, { mtd: { cd: 50, hs: 100 } }),
      row(2022, 6, 600, { mtd: { cd: 150, hs: 300 } }),
      row(2023, 6, 900, { mtd: { cd: 100, hs: 200 } }),
      row(2024, 6, 120),
    ];
    const exact = buildModel(rows, base).current!;
    expect(exact.toDate).toBe(true);
    // 2020 has no fire in June: 0, 50, 150, 100 -> median 75.
    expect(exact.median).toBe(75);
    expect(exact.rank).toBe(2);
    expect(exact.uncompared).toBe(false);

    // Monthly data only: no same-days baseline, so no difference and no rank.
    const monthly = buildModel(rows, { ...base, exactMtd: false }).current!;
    expect(monthly.uncompared).toBe(true);
    expect(monthly.diff).toBeNull();
    expect(monthly.n).toBe(1);
  });

  it('leaves months outside the range and after the cut-off empty', () => {
    const m = buildModel([row(2024, 6, 1)], { ...base, from: ymIndex(2020, 4) });
    expect(m.cell(2020, 3)).toBeNull();
    expect(m.cell(2024, 7)).toBeNull();
    expect(m.annual.find((a) => a.year === 2024)!.full).toBe(false);
    expect(m.annual.find((a) => a.year === 2021)!.full).toBe(true);
  });

  it('splits annual totals into observed and converted', () => {
    const m = buildModel([row(2021, 1, 5, { src: 0 }), row(2021, 2, 7)], base);
    expect(m.annual.find((a) => a.year === 2021)).toMatchObject({ converted: 5, observed: 7, total: 12 });
  });

  it('flags a month with three outage days of its primary sensor', () => {
    const missing = { available: true, sensors: { '1': ['2022-07-27', '2022-07-28', '2022-07-29', '2022-08-01'] } };
    const m = buildModel([row(2022, 7, 5), row(2022, 8, 5)], { ...base, missing });
    expect(m.cell(2022, 7)!.incomplete).toBe(true);
    expect(m.cell(2022, 8)!.incomplete).toBe(false);
  });
});

describe('coverage', () => {
  const coverage = { regions: { twn: { cells: 5, bbox_cells: 9, rows: { '230': [[1200, 1201]], '231': [[1199, 1200], [1203, 1203]] } } } };
  it('counts covered cells inside the selection', async () => {
    const { coverageOf } = await import('./grid');
    expect(coverageOf({ region: 'twn', w: 1200, s: 230, e: 1203, n: 232 }, coverage as never)).toEqual({ covered: 3, total: 6 });
    expect(coverageOf({ region: 'twn', w: 1210, s: 230, e: 1212, n: 232 }, coverage as never)!.covered).toBe(0);
    expect(coverageOf({ region: 'twn', w: 1200, s: 230, e: 1203, n: 232 }, null)).toBeNull();
  });
});
