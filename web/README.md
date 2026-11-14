# Web application

**Status: built.** A static site with two pages: the calendar (`index.html`)
and the methods page (`methods.html`). No backend.

## Run it

Requirements: Node 20 or newer.

```bash
cd web && npm install
```

```bash
npm run dev        # development server
```

```bash
npm run build      # type-check, then write the static site to web/dist/
```

```bash
npm test           # unit tests of the calculation rules (src/stats.test.ts)
```

The page works in two modes, and says which one it is in next to the map:

| Mode | When | What works |
|---|---|---|
| Daily grid | `public/data/cells_daily_<region>.parquet` exists (run the pipeline) | Any rectangle, exact month-to-date comparison, density layer, hotspot CSV |
| Presets only | No Parquet files, or DuckDB-WASM cannot start | The four whole regions from `presets.json`. The current month shows its value but no difference or rank: the same-days baseline needs daily data |

Only the JSON files are in git, so a fresh clone starts in "presets only" mode
until `pipeline/build_all.sh` has been run.

## Source layout

| File | Purpose |
|---|---|
| `src/main.ts` | Page state, wiring, the headline and facts |
| `src/stats.ts` | Calculation rules: baseline, median, rank, month to date, burn season, outlook |
| `src/db.ts` | DuckDB-WASM, loaded lazily: calendar, density and hotspot queries |
| `src/grid.ts` | Grid snapping with the pipeline's integer arithmetic; region lookup; covered cells from `coverage.json` |
| `src/calendar.ts` | Calendar table, legend, tooltip |
| `src/charts.ts` | ECharts: annual totals, spread by month |
| `src/map.ts` | Leaflet map, rectangle drawing, density image |
| `src/csv.ts` | CSV downloads with citation header lines |
| `src/methods.ts` | Methods page: renders `docs/METHODS.md` and the validation files |

## Feature status


The user picks an area and a date range and gets:

| ID | Priority | Feature |
|---|---|---|
| F-01 | must | Select an area: draw a rectangle on the map, type west/south/east/north, or pick a preset region. Snapped to the 0.1° grid. Outside the covered regions: a "not covered" message, never 0 |
| F-02 | must | Select a date range, default 2003-01 to the data cut-off month |
| F-03 | must | Burn calendar: years × months heat map with numbers. Converted months (before 2012-02, from 2026-11) are hatched. The current month is labelled "to date" |
| F-04 | must | Cell tooltip: harmonized value, range, primary sensor, raw value, coefficient, NRT and incomplete flags |
| F-05 | must | Month-to-date card: value, difference from the median of the same days in past years, rank |
| F-06 | must | Annual totals bar chart, converted years filled differently, top year marked |
| F-07 | must | Anomaly view: difference from the monthly median, blue-to-orange diverging ramp |
| F-08 | must | CSV downloads: calendar summary, and individual hotspots (warn above 500,000 rows). Header comment lines cite FIRMS and describe the harmonization |
| F-09 | must | Methods page, from [docs/METHODS.md](../docs/METHODS.md) |
| F-10..F-14 | should | Metric switch (`cd` / `hs`), monthly box plot, burn season and worst year, map density layer, baseline period choice |
| F-16, F-19 | could | State in the URL (shareable link); outlook for the next three months from history |

F-01 to F-14, F-16 and F-19 are implemented. Not built: polygon selection
(F-15) and PNG download (F-17).

The calculation rules are described in
[docs/DATA_FORMAT.md](../docs/DATA_FORMAT.md).

## Stack

| Part | Choice |
|---|---|
| Build | Vite, TypeScript |
| Map | Leaflet with OpenStreetMap tiles; rectangle drawing is a small pointer-event handler in `src/map.ts` |
| Queries | DuckDB-WASM, self-hosted in the bundle (about 8 MB gzipped, loaded after the first render). A region's `cells_daily` file is downloaded once and queried from memory; the `points` files are read with HTTP range requests on download |
| Charts | ECharts; the calendar itself is an HTML table, so every month is a focusable cell with a text label |
| Fonts | IBM Plex Sans, bundled with the site (no font CDN) |
| Colour | cividis for counts, blue-to-orange for anomalies; never red against green |
| Hosting | GitHub Pages (static; check that range requests work after deploying) |

## Constraints

- No external API at run time except map tiles. No FIRMS MAP_KEY anywhere in
  the front end.
- "Now" is `meta.json` → `data_through`, never the browser clock.
- If DuckDB-WASM fails to load, preset regions still render from
  `presets.json`.
- First interaction within 5 s on ordinary broadband; charts update within 2 s
  of changing the area.
- Below 768 px wide: one column, the calendar scrolls sideways.
- Colour is never the only carrier of information: numbers and hatching too.
  Text contrast meets WCAG AA.
- Footer: FIRMS citation and a link to this repository.

## Data

Run the pipeline first (see the [root README](../README.md)). It fills
`public/data/` with the JSON and Parquet files described in
[docs/DATA_FORMAT.md](../docs/DATA_FORMAT.md). Only the JSON files are in git.
