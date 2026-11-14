# Data format

The contract between the data pipeline and the website. The pipeline writes
these files to `web/public/data/`; the website reads them and calls no other
API (map tiles excepted). Everything here is produced by
`pipeline/05_export.py` and `pipeline/04_harmonize.py`.

All dates are **UTC**. All harmonized values are on the **VIIRS S-NPP scale**.

## Files at a glance

| File | Format | In git | Loaded | Purpose |
|---|---|---|---|---|
| `meta.json` | JSON | yes | at start | Data cut-off date, regions, strata, sensor periods, sources |
| `presets.json` | JSON | yes | at start | Whole-region calendars; fallback when DuckDB-WASM cannot load |
| `coefficients.json` | JSON | yes | methods page, tooltips | Conversion coefficients and error quantiles |
| `missing_days.json` | JSON | yes | at start | Sensor outage days |
| `validation_<region>.json` | JSON | yes | methods page | Cross-validation table and series for the figures |
| `coefficients.parquet` | Parquet | no | with queries | Same rows as `coefficients.json`, for joins in DuckDB |
| `cells_daily_<region>.parquet` | Parquet | no | by query | One row per active cell-day; the source of every calendar |
| `points_<region>_<year>.parquet` | Parquet | no | on download | Individual hotspots for the CSV download |

Parquet files are rebuilt with `pipeline/build_all.sh`. Size limits from the
spec: 90 MB per file (GitHub Pages allows 100 MB), 30 MB for everything loaded
before the first calendar, 900 MB for the whole site.

## Codes used everywhere

| Field | Values |
|---|---|
| `src` | `0` MODIS Aqua, `1` VIIRS S-NPP, `2` VIIRS NOAA-20 |
| region | `usa`, `twn`, `sea`, `arg` |
| subregion | `usa_w` (west of 100° W), `usa_e`, `twn`, `sea`, `arg` |
| `stratum` | `subregion_index * 12 + (month - 1)`, subregion order as above, so 0..59. The full list is `meta.json` → `strata` |
| conversion | `aqua_to_snpp`, `n20_to_snpp` |
| metric | `cd` active cell-days, `hs` equivalent hotspots |

**Grid cell.** `gx = floor(round(lon * 100000) / 10000)`,
`gy = floor(round(lat * 100000) / 10000)`. The cell's south-west corner is
`(gx / 10, gy / 10)`. JavaScript must use exactly this integer arithmetic so a
point never lands in a different cell than in Python.

**Primary sensor by month.** Sensors switch on whole months and never mix.

| Months | `src` | Value |
|---|---|---|
| 2003-01 .. 2012-01 | 0 | Aqua × k (`aqua_to_snpp`) |
| 2012-02 .. 2026-10 | 1 | S-NPP as observed (k = 1) |
| 2026-11 onward | 2 | NOAA-20 × k (`n20_to_snpp`) |

## `cells_daily_<region>.parquet`

One row per 0.1° cell per UTC day with at least one hotspot of the primary
sensor. Sorted by `gy, gx, date` (row groups of 50,000), so a small bounding
box reads only a few row groups. Compression zstd.

| Column | Type | Meaning |
|---|---|---|
| `gx`, `gy` | int16 | Grid cell |
| `date` | date | UTC day |
| `src` | uint8 | Primary sensor |
| `stratum` | uint8 | Joins to `coefficients` |
| `hs_raw` | uint16 | Hotspots observed in the cell that day |
| `hs` | float32 | Equivalent hotspots = `hs_raw × k_hs` |
| `cd` | float32 | Harmonized cell-day = `k_cd` (1.0 for S-NPP rows) |
| `nrt` | bool | At least one near-real-time detection |

A calendar for any rectangle is a `GROUP BY year, month` over the rows inside
it. Raw cell-days are `COUNT(*)`.

```sql
SELECT year(date) AS y, month(date) AS m, any_value(src) AS src,
       sum(cd) AS cd, sum(hs) AS hs, count(*) AS cd_raw, sum(hs_raw) AS hs_raw,
       bool_or(nrt) AS nrt
FROM 'cells_daily_usa.parquet'
WHERE gx BETWEEN $gx0 AND $gx1 AND gy BETWEEN $gy0 AND $gy1
  AND date BETWEEN $from AND $to
GROUP BY y, m ORDER BY y, m;
```

**Uncertainty range** of a converted value: per stratum,
`lo = value × (1 + q10)`, `hi = value × (1 + q90)`, using the stratum's row in
`coefficients` for the same conversion and metric; then add over strata. Rows
with `src = 1` have no range (`lo = hi = value`).

## `points_<region>_<year>.parquet`

Filtered hotspots of the primary sensor, one file per region and year, sorted
by `acq_date, acq_time`. Used only for the CSV download.

| Column | Meaning |
|---|---|
| `latitude`, `longitude` | Pixel centre, degrees |
| `acq_date`, `acq_time` | UTC date and `HHMM` time, as in FIRMS |
| `sensor` | `MODIS Aqua`, `VIIRS S-NPP` or `VIIRS NOAA-20` |
| `confidence` | MODIS 0-100; VIIRS `n` or `h` |
| `frp` | Fire radiative power, MW |
| `daynight` | `D` or `N` |
| `nrt` | Near-real-time row |

The number of rows inside a selection equals the sum of `hs_raw` in
`cells_daily` for the same cells and dates.

## `coefficients.json` / `coefficients.parquet`

240 rows: 5 subregions × 12 months × 2 conversions × 2 metrics.

| Field | Meaning |
|---|---|
| `stratum`, `region`, `subregion`, `month` | Which stratum |
| `conversion`, `metric` | Which conversion and metric |
| `k` | `sum(S-NPP) / sum(source)` over the training period |
| `q10`, `q90` | 10% and 90% quantiles of `(observed − predicted) / predicted` from cross-validation |
| `n_train` | Source cell-days in training |
| `fallback` | `true` when `n_train < 200` and the subregion's all-months `k` is used |

## `presets.json`

Whole-region calendars, so the page can show something even if DuckDB-WASM
fails to load.

```json
{ "usa": { "name": "Contiguous United States", "bbox": [-125.0, 24.0, -66.5, 49.5],
           "calendar": [ { "year": 2026, "month": 11, "src": 2,
                           "cd": 19.1, "cd_lo": 16.1, "cd_hi": 23.8,
                           "hs": 23.1, "hs_lo": 19.4, "hs_hi": 28.8,
                           "cd_raw": 21, "hs_raw": 25, "nrt": true }, ... ] }, ... }
```

`bbox` is `[west, south, east, north]`. A month with no fire has no entry and
counts as 0, not as missing.

## `meta.json`

| Key | Meaning |
|---|---|
| `data_through` | Last complete UTC day. "Now" for the website; never use the browser clock |
| `built_at` | Build time |
| `timezone`, `grid_degrees`, `grid_formula`, `reference_sensor` | Constants |
| `src` | Labels for the `src` codes |
| `primary_sensor` | The sensor periods in the table above |
| `strata` | `{stratum, subregion, month}` for 0..59 |
| `regions.<code>` | `name`, `bbox` (selection limits), `subregions`, `data_bbox` (cells that have data), `data_through`, `cell_days`, `points` |
| `nrt_start` | First near-real-time day per FIRMS product |
| `sources` | Provider, URL and the list of FIRMS files used |
| `si_use` | Disclosure of AI tool use |

## `missing_days.json`

| Key | Meaning |
|---|---|
| `available` | `false` when the build could not derive outages (single-region build) |
| `source`, `method` | How the list was made: derived from the hotspot record, not an official FIRMS list |
| `sensors.<src>` | Outage dates (`YYYY-MM-DD`) per sensor |
| `labels` | Labels for the `src` codes |

A month is marked **incomplete** when its primary sensor has 3 or more outage
days in it. Values are shown as observed, never filled in.

## `validation_<region>.json`

Everything the methods page needs to draw the figures and the
cross-validation table.

| Key | Content |
|---|---|
| `region`, `name` | Region |
| `targets` | `abs_bias_max` 0.10, `mape_max` 0.30, `spearman_min` 0.80, expected `n20_k_range` |
| `cv[]` | Per subregion, conversion and metric: `train_from`, `train_to`, `bias`, `mape` (null when too few fires), `n_months_mape`, `spearman_annual`, `n_years` |
| `drift[]` | Yearly Aqua → S-NPP ratio per subregion: `year`, `k_cd`, `k_hs` |
| `scatter[]` | Overlap months: `ym`, `month`, `aqua_cd`, `snpp_cd`, `aqua_hs`, `snpp_hs` |
| `series` | Monthly arrays aligned with `months` (`YYYY-MM`): `{aqua,snpp,n20}_raw_{cd,hs}`, `harmonized_{cd,hs}`, `harmonized_{lo,hi}_{cd,hs}`; `null` where there is no data |

## Calculation rules for the website

Shared rules, so every consumer of the data computes the same numbers.

| Item | Rule |
|---|---|
| Baseline years | Years in the chosen baseline period, excluding the year being compared |
| Median | Median of `x(year, m)` over baseline years; a month with no fire is 0 |
| Difference | `(x − median) / median`; not shown when the median is 0 (rank only) |
| Rank | Position from the top among baseline years plus the current year: "r-th highest of N years" |
| Month to date | If `data_through` is day D of its month, the current year uses days 1..D and every baseline year also uses days 1..D of the same month |
| Burn season | Shortest run of consecutive months (may cross the year end) holding at least 60% of the sum of monthly medians |
| Small selection | Warn when the historical monthly median is below 30 cell-days |
