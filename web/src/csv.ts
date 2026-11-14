/** CSV downloads. Comment lines start with "#" and cite the source. */
import { ymText } from './format';
import { selectionBBox } from './grid';
import type { Model } from './stats';
import type { Meta, Selection } from './types';

const SENSOR = ['MODIS Aqua', 'VIIRS S-NPP', 'VIIRS NOAA-20'];

export function headerLines(kind: string, sel: Selection, model: Model, meta: Meta, exact: boolean): string[] {
  const [w, s, e, n] = selectionBBox(sel);
  const { from, to } = model.options;
  return [
    `# Burn Calendar - ${kind}`,
    `# Region: ${meta.regions[sel.region].name}. Bounds (west, south, east, north): ${w}, ${s}, ${e}, ${n} degrees, snapped to the 0.1 degree grid.`,
    `# Months: ${ymText(from)} to ${ymText(to)}. Data through ${meta.data_through}. All dates are UTC.`,
    '# Source: NASA Fire Information for Resource Management System (FIRMS), https://firms.modaps.eosdis.nasa.gov/',
    '#   MODIS Collection 6.1 active fire product (Aqua), VIIRS S-NPP 375 m and VIIRS NOAA-20 375 m active fire products.',
    '# Harmonization: every value is on the VIIRS S-NPP scale ("what S-NPP would have reported").',
    '#   2003-01..2012-01 = MODIS Aqua x k; 2012-02..2026-10 = VIIRS S-NPP as observed; 2026-11 onward = VIIRS NOAA-20 x k.',
    '#   k is learned per subregion and calendar month from the years in which the sensors overlap.',
    '#   lo and hi are the 10% and 90% quantiles of the cross-validation error; observed months have no range.',
    `# Area values: ${exact ? 'computed from the daily 0.1 degree grid for the bounds above' : 'whole-region preset (daily grid not loaded)'}.`,
    '# NASA does not endorse this project. Methods: see the Methods page of the website.',
  ];
}

export function summaryCsv(sel: Selection, cd: Model, hs: Model, meta: Meta, exact: boolean): string {
  const lines = headerLines('calendar summary', sel, cd, meta, exact);
  lines.push(
    '# cd = active cell-days, hs = equivalent hotspots; *_lo and *_hi = range; *_raw = as counted by the primary sensor before conversion.',
    '# to_date: the month ends at the data cut-off. incomplete: 3 or more outage days of the primary sensor. A month with no fire is 0.',
    'year,month,primary_sensor,converted,cd,cd_lo,cd_hi,cd_raw,hs,hs_lo,hs_hi,hs_raw,nrt,incomplete,to_date',
  );
  cd.cells.forEach((c, i) => {
    const h = hs.cells[i];
    lines.push(
      [
        c.year, c.month, SENSOR[c.src], c.converted,
        round(c.value), round(c.lo), round(c.hi), c.raw,
        round(h.value), round(h.lo), round(h.hi), h.raw,
        c.nrt, c.incomplete, c.toDate,
      ].join(','),
    );
  });
  return lines.join('\n') + '\n';
}

function round(v: number): string {
  return String(Math.round(v * 10) / 10);
}

export function fileName(kind: string, sel: Selection, model: Model): string {
  const [w, s, e, n] = selectionBBox(sel);
  const box = [w, s, e, n].map((v) => v.toFixed(1)).join('_');
  return `burn-calendar_${kind}_${sel.region}_${box}_${ymText(model.options.from)}_${ymText(model.options.to)}.csv`;
}

export function saveBlob(parts: BlobPart[], name: string): void {
  const url = URL.createObjectURL(new Blob(parts, { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
