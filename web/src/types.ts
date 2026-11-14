export type Metric = 'cd' | 'hs';
export type Baseline = 'all' | 'last10';
export type View = 'abs' | 'anom';
export type RegionCode = string;

/** [west, south, east, north] in degrees. */
export type BBox = [number, number, number, number];

export interface RegionMeta {
  name: string;
  bbox: BBox;
  subregions: string[];
  data_bbox: BBox;
  data_through: string;
  cell_days: number;
  points: number;
}

export interface Meta {
  data_through: string;
  built_at: string;
  reference_sensor: string;
  src: Record<string, string>;
  primary_sensor: { from: string; to: string | null; src: number; conversion: string | null }[];
  strata: { stratum: number; subregion: string; month: number }[];
  regions: Record<RegionCode, RegionMeta>;
  sources: { provider?: string; url?: string } & Record<string, unknown>;
  si_use: string;
}

/** One month of one selection. Values are on the VIIRS S-NPP scale. */
export interface MonthRow {
  year: number;
  month: number;
  src: number;
  cd: number;
  cd_lo: number;
  cd_hi: number;
  hs: number;
  hs_lo: number;
  hs_hi: number;
  cd_raw: number;
  hs_raw: number;
  nrt: boolean;
  /** Days 1..D of the month, D = day of the data cut-off. Only from daily data. */
  mtd?: { cd: number; hs: number };
}

export interface Preset {
  name: string;
  bbox: BBox;
  calendar: MonthRow[];
}

export interface Coefficient {
  stratum: number;
  region: string;
  subregion: string;
  month: number;
  conversion: 'aqua_to_snpp' | 'n20_to_snpp';
  metric: Metric;
  k: number;
  q10: number;
  q90: number;
  n_train: number;
  fallback: boolean;
}

export interface MissingDays {
  available: boolean;
  sensors: Record<string, string[]>;
}

/** A selection snapped to the 0.1 degree grid. Edges are integer tenths of a degree. */
export interface Selection {
  region: RegionCode;
  w: number;
  s: number;
  e: number;
  n: number;
}

export interface Validation {
  region: string;
  name: string;
  targets: { abs_bias_max: number; mape_max: number; spearman_min: number; n20_k_range: [number, number] };
  cv: {
    subregion: string;
    conversion: string;
    metric: Metric;
    train_from: string;
    train_to: string;
    bias: number | null;
    mape: number | null;
    n_months_mape: number;
    spearman_annual: number | null;
    n_years: number;
  }[];
  series: { months: string[] } & Record<string, (number | null)[]>;
}

/** Which cells hold data: rows[gy] = inclusive [gx_start, gx_end] runs of covered cells. */
export interface Coverage {
  regions: Record<RegionCode, { cells: number; bbox_cells: number; rows: Record<string, [number, number][]> }>;
}
