# Web application

**Status: not built yet.** This directory holds only the data files the
application will read (`public/data/`). The front end is the next step.

## What it will do

A single static page, in English, with no backend. The user picks an area and
a date range and gets:

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
| F-10..F-14 | should | Metric switch (`cd` / `hs`), monthly box plot, burn season and worst year cards, map density layer, baseline period choice |
| F-15..F-19 | could | Polygon selection, state in the URL, PNG download, seasonal outlook from history |

The full specification, including layout and acceptance checks, is in
(Traditional Chinese). The calculation rules are repeated in English in
[docs/DATA_FORMAT.md](../docs/DATA_FORMAT.md).

## Planned stack

| Part | Choice |
|---|---|
| Build | Vite, TypeScript |
| Map | Leaflet with a rectangle drawing plugin |
| Queries | DuckDB-WASM reading Parquet over HTTP range requests |
| Charts | ECharts |
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
