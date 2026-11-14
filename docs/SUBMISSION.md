# Project page text (draft)

Draft text for three fields of the Space Apps project page. Numbers are from the
2026-11-14 data build (data through 2026-11-13); update them if the data is rebuilt.

**Check before pasting**

- [ ] Replace `[PROJECT NAME]` with the final project name.
- [ ] Section "The web application" describes the website as specified. Remove
      any feature that is not in the deployed site.
- [ ] Replace `[WEBSITE URL]` and `[REPOSITORY URL]`.
- [ ] Add the official FIRMS citation in the NASA Data field.

---

## High-Level Project Summary

Satellites have recorded active fires for more than two decades, but the record
is split between two instruments that cannot be compared. VIIRS has smaller
pixels than MODIS, so it reports several times more hotspots for the same fire
activity. In the contiguous United States the raw record jumps by a factor of
6.6 in 2012, the year the instrument changes, and a fire manager cannot tell
whether this month is unusual or the sensor is simply more sensitive.

[PROJECT NAME] harmonizes NASA FIRMS hotspots from MODIS Aqua, VIIRS S-NPP and
VIIRS NOAA-20 into one consistent record from 2003 to today, and presents it as
an interactive burn calendar. Using the years when the instruments observed the
same places, we learn a conversion for each region and calendar month and
express every value on a single scale. A user selects an area and a date range
and sees a year-by-month calendar, how the current month compares with the
historical median for the same days, which years and seasons burned most, and
can download the results as CSV.

This matters now. S-NPP stopped producing fire data on 2 November 2026 and MODIS
is near the end of its mission. Without harmonization, twenty years of history
are cut off from every future observation. We validate the conversion with
leave-one-year-out cross-validation, show an uncertainty range on every
converted value, and state plainly where the method is weak.

---

## Detailed Project Description

### What it does

[PROJECT NAME] is a static web application that answers three questions for any
area inside four regions (the contiguous United States, Taiwan, Myanmar with
Thailand and Laos, and Argentina):

- Is this month worse than usual?
- Which months are the burning season, and which years were the worst?
- Where does each number come from, and how certain is it?

The user never needs to know which satellite produced a number. Values converted
from another instrument are marked, and the original value is one click away.

### How the harmonization works

1. **Filter.** We keep presumed vegetation fires (FIRMS type 0) with MODIS
   confidence of 30 or more, or VIIRS confidence nominal or high. For MODIS we
   use Aqua only, because Aqua and the VIIRS satellites pass at about the same
   local time (13:30 and 01:30). Terra passes in the morning.
2. **Grid.** Hotspots are assigned to 0.1 degree cells and UTC days. We report
   two metrics: active cell-days (a cell with at least one hotspot on a day) and
   equivalent hotspots. Cell-days are less sensitive to pixel size: the raw gap
   between instruments is 3.6 times for cell-days and 6.6 times for hotspots.
3. **Learn the conversion.** In the overlap period, the conversion coefficient
   is the ratio of the S-NPP total to the other instrument's total. We compute
   one coefficient per subregion and calendar month, because the ratio changes
   with fire type and season. It ranges from 2.7 to 9.2 for MODIS Aqua
   cell-days. Aqua is trained on 2012-2021 only, before its orbit began to
   drift. NOAA-20 is trained on 2018-2025.
4. **Build one series.** 2003-01 to 2012-01 is MODIS Aqua multiplied by its
   coefficient. 2012-02 to 2026-10 is S-NPP as observed. From 2026-11 it is
   NOAA-20 multiplied by its coefficient. All values are on the S-NPP scale.

### How we know it works

Leave-one-year-out cross-validation: for each year, the coefficients are
computed without that year and used to predict it.

- Bias is within 1.1% in the four large subregions (target: 10%).
- Monthly error is 9% to 21% (target: 30%).
- For NOAA-20, bias is within 0.3% and monthly error is 5% to 10% in the same
  subregions.
- After harmonization the United States averages 116,582 active cell-days per
  year in 2003-2011 and 108,250 in 2013-2025. Before, the figures were 29,921
  and 108,250.

We also report what does not work. The ranking of years by total fire activity
misses our target (rank correlation of 0.8) for cell-days in the western United
States (0.46) and in Myanmar, Thailand and Laos (0.79 and 0.62). Taiwan has too
few fires to fit a seasonal conversion, so its values before 2012 carry a very
wide range. Every converted value is shown with the 10% to 90% range from
cross-validation, and the methods page lists eleven limitations.

### The web application

- Select an area by drawing a rectangle on the map, entering coordinates, or
  choosing a preset region, and select a date range.
- **Burn calendar**: a year-by-month heat map from 2003 to today. Converted
  months are hatched so that color is never the only signal.
- **Month to date**: the current month compared with the median of the same
  days in previous years, with its rank among all years.
- **Anomaly view**: the difference from the historical median for each month,
  on a blue-to-orange scale.
- Annual totals, the distribution of each calendar month, and the burning
  season.
- **CSV download** of the calendar summary and of the hotspots in the selected
  area, with the instrument recorded for each row.
- A methods page with the validation figures and tables.

Color scales are chosen for color-vision deficiency (cividis and blue-orange, no
red-green contrast).

### Benefits

Early warning and emergency responders can see within seconds whether current
activity is unusual for the time of year. Land managers can identify burning
seasons and compare years across the whole record. Scientists can inspect the
coefficients, the uncertainty and the original detections, and reproduce every
data file with one command.

The regions were chosen to test the method under different conditions: summer
forest fires in the western United States, prescribed and agricultural burning
in the east, spring agricultural burning in mainland Southeast Asia, whose smoke
affects air quality in Taiwan, a Southern Hemisphere fire season in Argentina,
and Taiwan as a low-fire case that shows the limits of the method.

### Tools and languages

- Data pipeline: Python, pandas, NumPy, PyArrow, SciPy, Shapely, Matplotlib.
- Web application: TypeScript, Vite, Leaflet, DuckDB-WASM, Apache ECharts.
- Data format: Apache Parquet, queried in the browser. The site has no server
  and calls no external API at run time, apart from map tiles.
- Hosting: GitHub Pages.

Website: [WEBSITE URL]
Code: [REPOSITORY URL]

### What comes next

- Extend coverage from four regions to the globe.
- Add NOAA-21 as a second continuing instrument.
- Flag sensor outage days in the calendar.
- Test regression-based conversions where the ratio method ranks years poorly.

---

## NASA Data

All fire data in this project comes from the NASA Fire Information for Resource
Management System (FIRMS), https://firms.modaps.eosdis.nasa.gov/ . Three active
fire products are used:

| Product | Period used | Role |
|---|---|---|
| MODIS Collection 6.1 active fire, Aqua, 1 km | 2002-07 to 2026-11 | The long historical record. Values for 2003-01 to 2012-01 in the calendar are converted from it. Also used in 2012-2021 to learn the conversion. |
| VIIRS S-NPP 375 m active fire | 2012-01 to 2026-11-02 | The reference scale. Values for 2012-02 to 2026-10 are shown as observed. |
| VIIRS NOAA-20 375 m active fire | 2018-04 to 2026-11 | The continuing record after S-NPP ended. Values from 2026-11 are converted from it, using a conversion learned in 2018-2025. |

How the data was obtained:

- **FIRMS country files** (standard processing), 2002 to 2025, for the United
  States, Taiwan, Myanmar, Thailand, Laos and Argentina: 276 files, about 3 GB.
- **FIRMS area API**, 2026-01-01 to 2026-11-13: standard-processing data where
  available, near-real-time data after that.
- **FIRMS data availability API**, to determine the data cut-off date and where
  near-real-time data begins.

About 40 million detections were processed. After filtering, the application
serves 18.6 million hotspots and 6.4 million active cell-days.

How the data inspired the project: FIRMS publishes all three products in the
same format, with the same fields and overlapping years. That overlap is what
makes the project possible. Because two instruments observed the same fires at
nearly the same time for more than a decade, the difference between them can be
measured directly from NASA's own open data, without any model of the sensors.
The FIRMS `type` field made it possible to separate vegetation fires from
volcanoes and industrial heat sources, and to build a mask of fixed heat sources
for recent data that does not yet carry that field.

[ADD THE OFFICIAL FIRMS CITATION HERE]
