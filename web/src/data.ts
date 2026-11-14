import type { Coefficient, Coverage, Meta, MissingDays, Preset, RegionCode } from './types';
import type { Cutoff } from './stats';

export interface StaticData {
  meta: Meta;
  presets: Record<RegionCode, Preset>;
  coefficients: Coefficient[];
  missing: MissingDays;
  /** null for builds made before coverage.json existed. */
  coverage: Coverage | null;
  cutoff: Cutoff;
}

export function dataUrl(file: string): string {
  return new URL(`data/${file}`, document.baseURI).href;
}

async function json<T>(file: string): Promise<T> {
  const res = await fetch(dataUrl(file));
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function parseCutoff(dataThrough: string): Cutoff {
  const [year, month, day] = dataThrough.split('-').map(Number);
  return { year, month, day };
}

/** The small JSON files: enough to draw every preset region with no query engine. */
export async function loadStatic(): Promise<StaticData> {
  const [meta, presets, coefficients, missing, coverage] = await Promise.all([
    json<Meta>('meta.json'),
    json<Record<RegionCode, Preset>>('presets.json'),
    json<Coefficient[]>('coefficients.json'),
    json<MissingDays>('missing_days.json').catch(() => ({ available: false, sensors: {} })),
    json<Coverage>('coverage.json').catch(() => null),
  ]);
  return { meta, presets, coefficients, missing, coverage, cutoff: parseCutoff(meta.data_through) };
}
