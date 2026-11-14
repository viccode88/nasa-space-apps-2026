# Data pipeline

Turns NASA FIRMS active fire detections from MODIS Aqua, VIIRS S-NPP and VIIRS
NOAA-20 into one harmonized record on the VIIRS S-NPP scale, and writes the
files the website reads.

## Run

```bash
uv venv .venv && uv pip install -p .venv -r pipeline/requirements.txt
pipeline/build_all.sh            # all four regions, about 3 GB of downloads, 1 minute of processing
pipeline/build_all.sh twn        # one region only (Taiwan is 3 MB, good for testing)
```

| Step | Script | Output |
|---|---|---|
| 1 | `01_download.py` | `data/raw/<product>/*.csv`, FIRMS per-country annual files 2002-2025 |
| 1b | `01b_download_current_year.py` | 2026 from the FIRMS area API (needs a MAP_KEY) |
| 2 | `02_clean.py` | `data/work/clean/`, filtered hotspots; `data/work/mask_<region>.parquet` |
| 3 | `03_grid.py` | `data/work/grid/`, hotspots per 0.1 degree cell per UTC day |
| 4 | `04_harmonize.py` | `data/work/coefficients.parquet`, `validation_<region>.json`, `missing_days.json`, `docs/figures/` |
| 5 | `05_export.py` | everything else in `web/public/data/` |

`data/` and the Parquet files are not committed. They are rebuilt by the command above.

## Method in short

1. **Filter.** MODIS: Aqua only, confidence >= 30, type 0. VIIRS: confidence
   nominal or high, type 0. Aqua and the VIIRS satellites share the same
   early-afternoon overpass, Terra does not.
2. **Grid.** `g = floor(round(deg * 100000) / 10000)` gives the 0.1 degree cell.
   A cell with at least one hotspot on a UTC day is one *active cell-day*.
3. **Coefficients.** For each stratum (subregion x calendar month) and each metric,
   `k = sum(S-NPP) / sum(source)` over the training period:
   Aqua to S-NPP on 2012-02..2021-12, NOAA-20 to S-NPP on 2018-04..2025-12.
   A stratum with fewer than 200 source cell-days in training uses the
   all-months coefficient of its subregion (`fallback: true`).
   Outage days of either sensor in a pair are left out of the totals. A day is
   an outage when a sensor's active cell count is below 10% of its own 31-day
   median in at least two of the regions usa, sea and arg.
4. **Series.** 2003-01..2012-01 is Aqua x k, 2012-02..2026-10 is S-NPP as
   observed, 2026-11 onward is NOAA-20 x k. Sensors never mix within a month.
5. **Validation.** Leave-one-year-out: coefficients are fitted without a year
   and used to predict it. Reported: bias, monthly MAPE (months with at least 50
   source units), Spearman correlation of annual totals. The 10% and 90%
   quantiles of `(actual - predicted) / predicted` give the displayed range
   `value * (1 + q10) .. value * (1 + q90)`.

## Output files

| File | Content |
|---|---|
| `cells_daily_<region>.parquet` | `gx, gy, date, src, stratum, hs_raw, hs, cd, nrt`, sorted by `gy, gx, date` |
| `points_<region>_<year>.parquet` | primary-sensor hotspots for CSV download |
| `coefficients.parquet`, `.json` | `stratum, region, subregion, month, conversion, metric, k, q10, q90, n_train, fallback` |
| `validation_<region>.json` | cross-validation table, yearly ratios, scatter data, monthly raw and harmonized series |
| `presets.json` | whole-region calendar per region, used when DuckDB-WASM cannot load |
| `coverage.json` | which 0.1 degree cells are covered, to tell "no fire" from "no data" |
| `meta.json` | data cut-off date, region bounds, strata, sensor periods, source files |
| `missing_days.json` | sensor outage days per `src`, derived from the hotspot record |

`src`: 0 = MODIS Aqua, 1 = VIIRS S-NPP, 2 = VIIRS NOAA-20.
`stratum` = subregion index x 12 + (month - 1); the list is in `meta.json`.

## Notes for the website

### No fire or no data

The data only covers land inside the listed countries, but each region is
described by a rectangle. Only 18% (Taiwan) to 57% (United States) of the cells
in those rectangles are covered; the rest is other countries or sea. A cell
without rows in `cells_daily_<region>.parquet` is therefore ambiguous on its
own. `coverage.json` resolves it:

- covered cell, no rows: no fire was detected there;
- cell not covered: no data, show "This area is not covered yet", never 0.

`regions.<region>.rows[gy]` lists inclusive `[gx_start, gx_end]` runs of covered
cells. To count the covered cells of a selection:

```js
function coveredCells(region, x0, y0, x1, y1) {   // inclusive cell indices
  let n = 0;
  for (let gy = y0; gy <= y1; gy++) {
    for (const [a, b] of region.rows[gy] || []) {
      const lo = Math.max(a, x0), hi = Math.min(b, x1);
      if (hi >= lo) n += hi - lo + 1;
    }
  }
  return n;
}
const total = (x1 - x0 + 1) * (y1 - y0 + 1);
const covered = coveredCells(coverage.regions.sea, x0, y0, x1, y1);
// covered === 0      -> "This area is not covered yet", show no numbers
// covered <  total   -> show numbers, with "N% of the selection is outside the covered area"
```

A cell is covered when it touches a country polygon, so coastal and border
cells count as covered. Every cell that holds data is covered.

### DuckDB-WASM (tested with 1.29.0)

- Cast aggregates: `sum(hs_raw)::INTEGER`, `count(*)::INTEGER`,
  `sum(cd)::DOUBLE`. Without the cast, `sum(hs_raw)` is a `HUGEINT` and
  `count(*)` a `BigInt`, which are not JavaScript numbers.
- Prefer loading each `cells_daily` file once (`fetch`, then
  `db.registerFileBuffer`) and querying it from memory. With HTTP range reads a
  mid-sized box transferred more than the whole file (9.0 MB for a 6.8 MB
  file) and nothing was cached between queries. From memory, queries took 10 to
  360 ms with no network traffic. The four files total 20 MB.
- Range reads are fine for the `points` files, which are read only on download.
- Filter cells with `gy BETWEEN .. AND gx BETWEEN ..` on integer indices
  computed with `floor(round(deg * 100000) / 10000)`.

## Current year and FIRMS MAP_KEY

FIRMS publishes annual country files through 2025 only. `01b_download_current_year.py`
fetches 2026 from the FIRMS area API, which needs a free MAP_KEY
(https://firms.modaps.eosdis.nasa.gov/api/map_key/). Put it in the environment
variable `FIRMS_MAP_KEY` or in a `.env` file at the repository root (see
`.env.example`). The key is never committed and never used by the website.

The area API returns everything inside a bounding box, so detections are
clipped to country polygons from Natural Earth (1:10m, public domain). Checked
against the 2025 country files: identical for Taiwan, Argentina and the United
States, 28 of 40,586 detections missing on the border for Myanmar, Thailand and Laos.

Near-real-time rows have no `type`, so fixed heat sources are removed with a
mask built from the standard data, separately for MODIS and VIIRS: 0.01 degree
cells with type 1, 2 or 3 detections on at least 3 days and on at least half of
their detection days, plus their 8 neighbours. `docs/METHODS.md` explains why
the mask is not simply every cell that ever showed a fixed source.

## Not done yet

- **Official outage list.** `missing_days.json` is derived from the data and
  misses partial-day outages; the FIRMS missing-data table is not used. Outage
  detection needs the three large regions, so a single-region build finds none.

## Source

NASA FIRMS, https://firms.modaps.eosdis.nasa.gov/ : MODIS Collection 6.1,
VIIRS S-NPP 375 m and VIIRS NOAA-20 375 m active fire products.
