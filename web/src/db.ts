/**
 * DuckDB-WASM, loaded lazily. The daily grid of a region is downloaded once and
 * queried from memory; the hotspot files are read with HTTP range requests. Every caller must cope with this module failing: the
 * preset regions render from presets.json without it.
 */
import type * as duckdb from '@duckdb/duckdb-wasm';
import { dataUrl } from './data';
import { cellRange } from './grid';
import type { Cutoff } from './stats';
import type { Coefficient, MonthRow, RegionCode, Selection } from './types';

interface Engine {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
}

let connecting: Promise<Engine> | null = null;

function connect(): Promise<Engine> {
  connecting ??= (async () => {
    // The wasm (34 MB) is over Cloudflare's 25 MiB per-file limit for static
    // assets, so it and its worker come from jsDelivr, pinned to the installed
    // package version. A cross-origin script cannot start a Worker directly,
    // so the worker is wrapped in a same-origin blob that imports it.
    const lib = await import('@duckdb/duckdb-wasm');
    const bundle = lib.getJsDelivrBundles().eh!;
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
    );
    const db = new lib.AsyncDuckDB(new lib.VoidLogger(), new Worker(workerUrl));
    URL.revokeObjectURL(workerUrl);
    await db.instantiate(bundle.mainModule);
    return { db, conn: await db.connect() };
  })();
  connecting.catch(() => (connecting = null));
  return connecting;
}

const loadedCells = new Map<RegionCode, Promise<string>>();

/**
 * Download a region's daily grid once and query it from memory. The files are
 * small (20 MB for all four); range reads of a mid-sized box transferred more
 * than the whole file and nothing was cached between queries.
 */
export function loadCells(region: RegionCode): Promise<string> {
  let p = loadedCells.get(region);
  if (!p) {
    p = (async () => {
      const [{ db }, res] = await Promise.all([connect(), fetch(dataUrl(cellsFile(region)))]);
      if (!res.ok) throw new Error(`${cellsFile(region)}: HTTP ${res.status}`);
      await db.registerFileBuffer(cellsFile(region), new Uint8Array(await res.arrayBuffer()));
      return cellsFile(region);
    })();
    p.catch(() => loadedCells.delete(region));
    loadedCells.set(region, p);
  }
  return p;
}

const probes = new Map<string, Promise<boolean>>();

/** True when the file exists and really is Parquet (a dev server may answer 200 with HTML). */
export function hasParquet(file: string): Promise<boolean> {
  let p = probes.get(file);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(dataUrl(file), { headers: { Range: 'bytes=0-3' } });
        if (!res.ok) return false;
        const head = new Uint8Array(await res.arrayBuffer()).subarray(0, 4);
        return new TextDecoder().decode(head) === 'PAR1';
      } catch {
        return false;
      }
    })();
    probes.set(file, p);
  }
  return p;
}

export const cellsFile = (region: RegionCode) => `cells_daily_${region}.parquet`;
export const pointsFile = (region: RegionCode, year: number) => `points_${region}_${year}.parquet`;

/** Start downloading the engine so the first custom rectangle is fast. */
export function warmUp(): Promise<unknown> {
  return connect();
}

const CONVERSION: Record<number, string | undefined> = { 0: 'aqua_to_snpp', 2: 'n20_to_snpp' };

/**
 * Monthly calendar of a rectangle, with uncertainty ranges added over strata
 * and the same-days-of-month sums needed for the month-to-date comparison.
 */
export async function queryCalendar(
  sel: Selection,
  cutoff: Cutoff,
  coefficients: Coefficient[],
): Promise<MonthRow[]> {
  const [{ conn }, table] = await Promise.all([connect(), loadCells(sel.region)]);
  const { gx0, gx1, gy0, gy1 } = cellRange(sel);
  const day = Math.trunc(cutoff.day);
  const month = Math.trunc(cutoff.month);
  const result = await conn.query(`
    SELECT year(date)::INTEGER AS y, month(date)::INTEGER AS m, stratum::INTEGER AS stratum,
           any_value(src)::INTEGER AS src,
           sum(cd)::DOUBLE AS cd, sum(hs)::DOUBLE AS hs,
           count(*)::DOUBLE AS cd_raw, sum(hs_raw)::DOUBLE AS hs_raw,
           bool_or(nrt) AS nrt,
           coalesce(sum(cd) FILTER (WHERE day(date) <= ${day}), 0)::DOUBLE AS cd_mtd,
           coalesce(sum(hs) FILTER (WHERE day(date) <= ${day}), 0)::DOUBLE AS hs_mtd
    FROM read_parquet('${table}')
    WHERE gx BETWEEN ${gx0} AND ${gx1} AND gy BETWEEN ${gy0} AND ${gy1}
    GROUP BY y, m, stratum`);

  const quantiles = new Map<string, Coefficient>();
  for (const c of coefficients) quantiles.set(`${c.stratum}|${c.conversion}|${c.metric}`, c);

  const months = new Map<number, MonthRow>();
  for (const r of result.toArray() as Iterable<Record<string, number | boolean>>) {
    const y = r.y as number;
    const m = r.m as number;
    const src = r.src as number;
    const key = y * 12 + m;
    let row = months.get(key);
    if (!row) {
      row = {
        year: y, month: m, src, nrt: false,
        cd: 0, cd_lo: 0, cd_hi: 0, hs: 0, hs_lo: 0, hs_hi: 0, cd_raw: 0, hs_raw: 0,
      };
      if (m === month) row.mtd = { cd: 0, hs: 0 };
      months.set(key, row);
    }
    const conversion = CONVERSION[src];
    for (const metric of ['cd', 'hs'] as const) {
      const v = r[metric] as number;
      const q = conversion ? quantiles.get(`${r.stratum}|${conversion}|${metric}`) : undefined;
      row[metric] += v;
      row[`${metric}_lo`] += v * (1 + (q?.q10 ?? 0));
      row[`${metric}_hi`] += v * (1 + (q?.q90 ?? 0));
    }
    row.cd_raw += r.cd_raw as number;
    row.hs_raw += r.hs_raw as number;
    row.nrt ||= Boolean(r.nrt);
    if (row.mtd) {
      row.mtd.cd += r.cd_mtd as number;
      row.mtd.hs += r.hs_mtd as number;
    }
  }
  return [...months.values()].sort((a, b) => a.year - b.year || a.month - b.month);
}

export interface Density {
  gx0: number;
  gy0: number;
  nx: number;
  ny: number;
  /** Row-major from the south-west cell; harmonized cell-days per cell. */
  values: Float32Array;
  max: number;
}

function isoDate(ym: number, end: boolean): string {
  const year = Math.floor(ym / 12);
  const month = (ym % 12) + 1;
  const day = end ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Sum of harmonized cell-days per cell inside the selection and date range. */
export async function queryDensity(sel: Selection, from: number, to: number): Promise<Density> {
  const [{ conn }, table] = await Promise.all([connect(), loadCells(sel.region)]);
  const { gx0, gx1, gy0, gy1 } = cellRange(sel);
  const result = await conn.query(`
    SELECT gx::INTEGER AS gx, gy::INTEGER AS gy, sum(cd)::DOUBLE AS cd
    FROM read_parquet('${table}')
    WHERE gx BETWEEN ${gx0} AND ${gx1} AND gy BETWEEN ${gy0} AND ${gy1}
      AND date BETWEEN DATE '${isoDate(from, false)}' AND DATE '${isoDate(to, true)}'
    GROUP BY gx, gy`);
  const nx = gx1 - gx0 + 1;
  const ny = gy1 - gy0 + 1;
  const values = new Float32Array(nx * ny);
  const gx = result.getChild('gx')!.toArray() as Int32Array;
  const gy = result.getChild('gy')!.toArray() as Int32Array;
  const cd = result.getChild('cd')!.toArray() as Float64Array;
  let max = 0;
  for (let i = 0; i < cd.length; i++) {
    values[(gy[i] - gy0) * nx + (gx[i] - gx0)] = cd[i];
    if (cd[i] > max) max = cd[i];
  }
  return { gx0, gy0, nx, ny, values, max };
}

const POINT_COLUMNS = [
  'latitude', 'longitude', 'acq_date', 'acq_time', 'sensor', 'confidence', 'frp', 'daynight', 'nrt',
] as const;

/**
 * Individual hotspots inside the selection, as CSV text chunks. The cell of a
 * point is computed with the same integer arithmetic as the pipeline, so the
 * row count equals sum(hs_raw) of the calendar.
 */
export async function* streamPointsCsv(sel: Selection, from: number, to: number): AsyncGenerator<string> {
  const { conn } = await connect();
  const { gx0, gx1, gy0, gy1 } = cellRange(sel);
  const files: string[] = [];
  for (let y = Math.floor(from / 12); y <= Math.floor(to / 12); y++) {
    if (await hasParquet(pointsFile(sel.region, y))) files.push(`'${dataUrl(pointsFile(sel.region, y))}'`);
  }
  yield `${POINT_COLUMNS.join(',')}\n`;
  if (files.length === 0) return;
  const reader = await conn.send(`
    SELECT latitude, longitude, strftime(acq_date, '%Y-%m-%d') AS acq_date,
           acq_time::VARCHAR AS acq_time, sensor::VARCHAR AS sensor, confidence::VARCHAR AS confidence,
           frp::VARCHAR AS frp, daynight::VARCHAR AS daynight, nrt
    FROM read_parquet([${files.join(',')}], union_by_name = true)
    WHERE floor(round(longitude * 100000) / 10000) BETWEEN ${gx0} AND ${gx1}
      AND floor(round(latitude * 100000) / 10000) BETWEEN ${gy0} AND ${gy1}
      AND acq_date BETWEEN DATE '${isoDate(from, false)}' AND DATE '${isoDate(to, true)}'
    ORDER BY acq_date, acq_time`);
  for await (const batch of reader) {
    const cols = POINT_COLUMNS.map((c) => batch.getChild(c)!);
    const lines: string[] = [];
    for (let i = 0; i < batch.numRows; i++) {
      lines.push(
        cols
          .map((col, j) => {
            const v = col.get(i);
            if (v === null || v === undefined) return '';
            if (j === 3) return String(v).padStart(4, '0');
            if (j === 8) return v ? 'true' : 'false';
            return String(v);
          })
          .join(','),
      );
    }
    yield lines.join('\n') + '\n';
  }
}
