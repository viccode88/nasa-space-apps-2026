import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans-condensed/latin-500.css';
import './style.css';

import { attachTooltip, renderCalendar, renderLegend } from './calendar';
import { renderAnnual, renderBox } from './charts';
import { cividis, gradientCss } from './colors';
import { fileName, headerLines, saveBlob, summaryCsv } from './csv';
import { loadStatic, type StaticData } from './data';
import { cellsFile, hasParquet, queryCalendar, queryDensity, streamPointsCsv, warmUp } from './db';
import { degrees, METRIC_LABEL, MONTHS, MONTHS_LONG, num, ordinal, pct, ymIndex, ymParts, ymText } from './format';
import { coverageOf, isWholeRegion, resolveBBox, selectionBBox, wholeRegion } from './grid';
import { createMap, type MapApi } from './map';
import { buildModel, type Model } from './stats';
import type { Baseline, BBox, Metric, MonthRow, Selection, View } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const POINTS_WARN = 500_000;
const FIRST_YM = ymIndex(2003, 1);

interface State {
  sel: Selection;
  from: number;
  to: number;
  metric: Metric;
  view: View;
  baseline: Baseline;
  density: boolean;
}

type Engine = 'checking' | 'ready' | 'missing' | 'failed';

let data: StaticData;
let state: State;
let map: MapApi;
let rows: MonthRow[] = [];
/** Rows come from the daily grid (true) or from presets.json (false). */
let exact = false;
let model: Model | null = null;
let engine: Engine = 'checking';
let queryToken = 0;

// ---------- state in the URL ----------

function readHash(): Partial<State> & { bbox?: BBox } {
  const p = new URLSearchParams(location.hash.slice(1));
  const out: Partial<State> & { bbox?: BBox } = {};
  const b = p.get('b')?.split(',').map(Number);
  if (b && b.length === 4 && b.every(Number.isFinite)) out.bbox = b as BBox;
  const ym = (v: string | null) => {
    const m = /^(\d{4})-(\d{2})$/.exec(v ?? '');
    return m ? ymIndex(Number(m[1]), Number(m[2])) : undefined;
  };
  out.from = ym(p.get('f'));
  out.to = ym(p.get('t'));
  if (p.get('m') === 'hs') out.metric = 'hs';
  if (p.get('v') === 'anom') out.view = 'anom';
  if (p.get('bl') === 'last10') out.baseline = 'last10';
  return out;
}

function writeHash(): void {
  const p = new URLSearchParams({
    b: selectionBBox(state.sel).join(','),
    f: ymText(state.from),
    t: ymText(state.to),
    m: state.metric,
    v: state.view,
    bl: state.baseline,
  });
  history.replaceState(null, '', `#${p}`);
}

// ---------- rendering ----------

function note(el: HTMLElement, text: string | null): void {
  el.hidden = !text;
  el.textContent = text ?? '';
}

function monthSpan(start: number, length: number): string {
  const end = ((start + length - 2) % 12) + 1;
  return length === 1 ? MONTHS_LONG[start - 1] : `${MONTHS_LONG[start - 1]} to ${MONTHS_LONG[end - 1]}`;
}

function yearSpan(years: number[]): string {
  if (years.length === 0) return 'no years';
  return years.length === 1 ? String(years[0]) : `${years[0]}–${years[years.length - 1]}`;
}

function renderFindings(m: Model): void {
  const region = data.meta.regions[state.sel.region];
  const [w, s, e, n] = selectionBBox(state.sel);
  const where = isWholeRegion(state.sel, region)
    ? `${region.name}, whole region`
    : `${region.name}: ${degrees(w, 'lon')} to ${degrees(e, 'lon')}, ${degrees(s, 'lat')} to ${degrees(n, 'lat')}`;
  const cover = coverageOf(state.sel, data.coverage);
  const outside = cover ? 1 - cover.covered / cover.total : 0;
  const coverText =
    outside >= 0.005 ? ` · ${Math.round(outside * 100)}% of this rectangle is sea or another country, where there is no data` : '';
  $('selection-line').textContent = `${where} · ${ymText(m.options.from)} to ${ymText(m.options.to)}${coverText}`;

  const metric = METRIC_LABEL[state.metric];
  const { cutoff } = data;
  const monthName = MONTHS_LONG[cutoff.month - 1];
  const c = m.current;
  const headline = $('headline');
  const detail = $('headline-detail');

  if (c) {
    const baseline = yearSpan(m.baselineYears.filter((y) => y !== c.year));
    if (c.n <= 1) headline.textContent = `${monthName} to date: ${num(c.value)} ${metric}`;
    else if (c.diff === null) headline.textContent = `${monthName} to date ranks ${ordinal(c.rank)} highest of ${c.n} years`;
    else if (Math.abs(c.diff) < 0.05) headline.textContent = `${monthName} to date is close to the median`;
    else headline.textContent = `${monthName} to date is ${pct(Math.abs(c.diff)).slice(1)} ${c.diff > 0 ? 'above' : 'below'} the median`;

    const range = c.converted && c.value > 0 ? ` (range ${num(c.lo)}–${num(c.hi)})` : '';
    const parts = [
      `<strong>${num(c.value)}</strong> ${metric} from 1 to ${cutoff.day} ${monthName} ${cutoff.year}${range}.`,
    ];
    if (c.n > 1) {
      parts.push(
        `The median for the same days in ${baseline} is <strong>${num(c.median)}</strong>${c.diff === null ? ', so no percentage is shown' : ''}.`,
        `This year ranks <strong>${ordinal(c.rank)} highest of ${c.n}</strong>.`,
      );
    }
    detail.innerHTML = parts.join(' ');
    note(
      $('estimate-note'),
      c.uncompared
        ? `No comparison yet: setting ${monthName} 1 to ${cutoff.day} against the same days of past years needs the daily grid, which is not loaded.`
        : null,
    );
  } else {
    headline.textContent = `${num(m.total)} ${metric} in the selected months`;
    detail.textContent = `The month-to-date comparison appears when the range includes ${monthName} ${cutoff.year}.`;
    note($('estimate-note'), null);
  }

  note(
    $('small-note'),
    m.smallSelection
      ? 'Small selection: the typical month has fewer than 30 active cell-days, so percentages and ranks move a lot from a few fires.'
      : null,
  );

  const facts: [string, string, string][] = [];
  if (m.season) {
    facts.push([
      'Burn season',
      monthSpan(m.season.start, m.season.length),
      `${m.season.length} ${m.season.length === 1 ? 'month holds' : 'months hold'} ${Math.round(m.season.share * 100)}% of a median year`,
    ]);
  } else facts.push(['Burn season', 'None', 'The monthly medians are all 0']);
  if (m.topYear) {
    facts.push(['Highest year', String(m.topYear.year), `${num(m.topYear.total)} ${metric}${m.topYear.full ? ', full years only' : ''}`]);
  }
  facts.push(['Baseline', yearSpan(m.baselineYears), `${m.baselineYears.length} years; the compared year is left out`]);
  $('facts').innerHTML = facts
    .map(([k, v, sub]) => `<div><dt>${k}</dt><dd><strong>${v}</strong><span>${sub}</span></dd></div>`)
    .join('');

  const usable = m.outlook.some((o) => o.n > 0);
  $('outlook').innerHTML = !usable
    ? ''
    : `<h3>What the next three months looked like in the record</h3>
      <p class="sub">An outlook from history (${yearSpan(m.baselineYears)}), not a forecast.</p>
      <table class="mini">
        <thead><tr><th scope="col">Month</th><th scope="col">Median</th><th scope="col">8 in 10 years</th><th scope="col">Above the year's monthly mean</th></tr></thead>
        <tbody>${m.outlook
          .map(
            (o) => `<tr><th scope="row">${MONTHS_LONG[o.month - 1]}</th><td>${num(o.median)}</td><td>${num(o.p10)}–${num(o.p90)}</td>
            <td>${o.years > 0 ? `${o.aboveMean} of ${o.years} years` : '—'}</td></tr>`,
          )
          .join('')}</tbody>
      </table>`;
}

function hotspotsInRange(): number {
  let total = 0;
  for (const r of rows) {
    const i = ymIndex(r.year, r.month);
    if (i >= state.from && i <= state.to) total += r.hs_raw;
  }
  return total;
}

function renderDownloads(): void {
  const btn = $<HTMLButtonElement>('dl-points');
  const n = hotspotsInRange();
  $('dl-confirm').hidden = true;
  if (engine === 'ready') {
    btn.disabled = n === 0 || !exact;
    $('dl-points-note').textContent = !exact
      ? 'Counting…'
      : n === 0
        ? 'No hotspots in this area and period.'
        : `${num(n)} rows: one per detection, with coordinates, time, sensor, confidence and FRP.`;
  } else {
    btn.disabled = true;
    $('dl-points-note').textContent =
      engine === 'checking' ? 'Loading the daily data…' : 'Needs the hotspot files, which are not available on this server.';
  }
}

function render(): void {
  const options = {
    baseline: state.baseline, from: state.from, to: state.to,
    cutoff: data.cutoff, exactMtd: exact, missing: data.missing,
  };
  const m = (model = buildModel(rows, { ...options, metric: state.metric }));
  renderFindings(m);
  renderCalendar($('calendar'), m, state.view);
  renderLegend($('calendar-legend'), m, state.view);
  const what = state.view === 'abs' ? `Monthly ${METRIC_LABEL[state.metric]}` : `Difference from the median of the same month`;
  $('calendar-sub').textContent = `${what}, on the VIIRS S-NPP scale. Hover, focus or tap a month for its range, sensor and raw value.`;
  $('annual').setAttribute('aria-label', renderAnnual($('annual'), m));
  $('annual-sub').textContent = `${state.metric === 'cd' ? 'Active cell-days' : 'Equivalent hotspots'} per year. Faded bars are partial years.`;
  $('box').setAttribute('aria-label', renderBox($('box'), m));
  $('box-sub').textContent = `Each box is one calendar month across ${yearSpan(m.baselineYears)}: middle half of years, line at the median, whiskers at the lowest and highest year.`;
  renderDownloads();
  document.querySelectorAll<HTMLButtonElement>('[data-metric]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.metric === state.metric)));
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  writeHash();
}

function renderEngine(): void {
  const text: Record<Engine, string> = {
    checking: 'Loading the daily grid…',
    ready: 'Daily grid loaded: draw any rectangle',
    missing: 'Preset regions only: the daily grid files are not on this server',
    failed: 'Preset regions only: the query engine could not start',
  };
  const el = $('engine');
  el.textContent = text[engine];
  el.dataset.state = engine;
  $<HTMLButtonElement>('draw').disabled = engine === 'missing' || engine === 'failed';
}

function syncInputs(): void {
  const [w, s, e, n] = selectionBBox(state.sel);
  $<HTMLInputElement>('bw').value = w.toFixed(1);
  $<HTMLInputElement>('bs').value = s.toFixed(1);
  $<HTMLInputElement>('be').value = e.toFixed(1);
  $<HTMLInputElement>('bn').value = n.toFixed(1);
  const region = data.meta.regions[state.sel.region];
  $<HTMLSelectElement>('region').value = isWholeRegion(state.sel, region) ? state.sel.region : `${state.sel.region}:custom`;
  const f = ymParts(state.from);
  const t = ymParts(state.to);
  $<HTMLSelectElement>('from-y').value = String(f.year);
  $<HTMLSelectElement>('from-m').value = String(f.month);
  $<HTMLSelectElement>('to-y').value = String(t.year);
  $<HTMLSelectElement>('to-m').value = String(t.month);
  $<HTMLSelectElement>('baseline').value = state.baseline;
}

// ---------- queries ----------

function setStale(on: boolean): void {
  $('app').classList.toggle('is-stale', on);
}

async function refreshDensity(token: number): Promise<void> {
  try {
    const d = await queryDensity(state.sel, state.from, state.to);
    if (token !== queryToken) return;
    map.setDensity(d, state.density);
    $('density-toggle').hidden = false;
    const legend = $('density-legend');
    legend.hidden = !state.density || d.max <= 0;
    legend.innerHTML = `<span>Cell-days per 0.1° cell</span><i style="background:${gradientCss(cividis)}"></i><span>0</span><span>${num(d.max)}</span>`;
  } catch {
    map.setDensity(null, false);
    $('density-toggle').hidden = true;
    $('density-legend').hidden = true;
  }
}

/** Replace the rows with an exact query of the current selection, if the daily grid is there. */
async function refresh(): Promise<void> {
  const token = ++queryToken;
  const sel = state.sel;
  const region = data.meta.regions[sel.region];
  const whole = isWholeRegion(sel, region);

  const fallBack = (reason: Engine) => {
    engine = reason;
    renderEngine();
    if (!whole) {
      state.sel = wholeRegion(sel.region, region);
      rows = data.presets[sel.region].calendar;
      exact = false;
      map.setSelection(state.sel, true);
      syncInputs();
      note($('area-note'), `Custom rectangles need the daily grid files, which are not available here. Showing all of ${region.name} instead.`);
    }
    map.setDensity(null, false);
    $('density-toggle').hidden = true;
    $('density-legend').hidden = true;
    setStale(false);
    render();
  };

  if (!(await hasParquet(cellsFile(sel.region)))) {
    if (token === queryToken) fallBack('missing');
    return;
  }
  try {
    const result = await queryCalendar(sel, data.cutoff, data.coefficients);
    if (token !== queryToken) return;
    rows = result;
    exact = true;
    engine = 'ready';
    renderEngine();
    setStale(false);
    render();
    void refreshDensity(token);
  } catch (err) {
    console.error(err);
    if (token === queryToken) fallBack('failed');
  }
}

function select(sel: Selection, fit: boolean): void {
  const region = data.meta.regions[sel.region];
  state.sel = sel;
  map.setSelection(sel, fit);
  map.setDensity(null, false);
  $('density-legend').hidden = true;
  syncInputs();
  if (isWholeRegion(sel, region)) {
    // The preset draws at once; the exact query then replaces it.
    rows = data.presets[sel.region].calendar;
    exact = false;
    render();
  } else {
    setStale(true);
    writeHash();
  }
  void refresh();
}

function selectBBox(bbox: BBox, fit: boolean): void {
  const resolved = resolveBBox(bbox, data.meta.regions);
  if (!resolved) {
    const names = Object.values(data.meta.regions).map((r) => r.name).join('; ');
    note($('area-note'), `Not covered: that rectangle is outside the regions in this record (${names}). The selection was not changed.`);
    syncInputs();
    return;
  }
  if (coverageOf(resolved.sel, data.coverage)?.covered === 0) {
    note(
      $('area-note'),
      `This area is not covered yet: the rectangle lies in the sea or in a country outside this record, so there is no data to show (not zero fires). The selection was not changed.`,
    );
    syncInputs();
    return;
  }
  note(
    $('area-note'),
    resolved.clipped ? `Clipped to the covered area of ${data.meta.regions[resolved.sel.region].name}.` : null,
  );
  select(resolved.sel, fit);
}

// ---------- wiring ----------

function fillSelect(el: HTMLSelectElement, options: [string, string][]): void {
  el.innerHTML = options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
}

function setRange(from: number, to: number): void {
  const cut = ymIndex(data.cutoff.year, data.cutoff.month);
  from = Math.max(FIRST_YM, Math.min(from, cut));
  to = Math.max(FIRST_YM, Math.min(to, cut));
  if (from > to) [from, to] = [to, from];
  state.from = from;
  state.to = to;
  syncInputs();
  render();
  if (exact) void refreshDensity(queryToken);
}

async function downloadPoints(): Promise<void> {
  const btn = $<HTMLButtonElement>('dl-points');
  if (!model) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const parts: string[] = [
      headerLines('individual hotspots', state.sel, model, data.meta, true).join('\n') + '\n',
      '# One row per detection of the primary sensor of its month, after the filters on the Methods page. Counts here are raw, not converted.\n',
    ];
    for await (const chunk of streamPointsCsv(state.sel, model.options.from, model.options.to)) parts.push(chunk);
    saveBlob(parts, fileName('hotspots', state.sel, model));
  } catch (err) {
    console.error(err);
    $('dl-points-note').textContent = 'The hotspot files could not be read. Try a smaller area or period.';
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

function wire(): void {
  const regionSelect = $<HTMLSelectElement>('region');
  regionSelect.innerHTML = Object.entries(data.meta.regions)
    .map(([code, r]) => `<option value="${code}">${r.name}</option><option value="${code}:custom" hidden>${r.name}, custom rectangle</option>`)
    .join('');
  regionSelect.addEventListener('change', () => {
    const code = regionSelect.value.split(':')[0];
    note($('area-note'), null);
    select(wholeRegion(code, data.meta.regions[code]), true);
  });

  $('area-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = ['bw', 'bs', 'be', 'bn'].map((id) => Number($<HTMLInputElement>(id).value.replace(',', '.')));
    if (!v.every(Number.isFinite)) {
      note($('area-note'), 'Enter four numbers in degrees: west and east from −180 to 180, south and north from −90 to 90.');
      return;
    }
    selectBBox(v as BBox, true);
  });

  const years: [string, string][] = [];
  for (let y = 2003; y <= data.cutoff.year; y++) years.push([String(y), String(y)]);
  const months = MONTHS.map((m, i) => [String(i + 1), m] as [string, string]);
  for (const id of ['from-y', 'to-y']) fillSelect($<HTMLSelectElement>(id), years);
  for (const id of ['from-m', 'to-m']) fillSelect($<HTMLSelectElement>(id), months);
  for (const id of ['from-y', 'from-m', 'to-y', 'to-m']) {
    $(id).addEventListener('change', () => {
      const v = (k: string) => Number($<HTMLSelectElement>(k).value);
      setRange(ymIndex(v('from-y'), v('from-m')), ymIndex(v('to-y'), v('to-m')));
    });
  }

  document.querySelectorAll<HTMLButtonElement>('[data-metric]').forEach((b) =>
    b.addEventListener('click', () => {
      state.metric = b.dataset.metric as Metric;
      render();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      state.view = b.dataset.view as View;
      render();
    }),
  );
  $<HTMLSelectElement>('baseline').addEventListener('change', (e) => {
    state.baseline = (e.target as HTMLSelectElement).value as Baseline;
    render();
  });

  const draw = $<HTMLButtonElement>('draw');
  draw.addEventListener('click', () => map.setDrawing(draw.getAttribute('aria-pressed') !== 'true'));

  $<HTMLInputElement>('density').addEventListener('change', (e) => {
    state.density = (e.target as HTMLInputElement).checked;
    if (exact) void refreshDensity(queryToken);
  });

  $('dl-summary').addEventListener('click', () => {
    if (!model) return;
    const other = buildModel(rows, { ...model.options, metric: state.metric === 'cd' ? 'hs' : 'cd' });
    const [cd, hs] = state.metric === 'cd' ? [model, other] : [other, model];
    saveBlob([summaryCsv(state.sel, cd, hs, data.meta, exact)], fileName('summary', state.sel, model));
  });
  $('dl-points').addEventListener('click', () => {
    const n = hotspotsInRange();
    if (n > POINTS_WARN) {
      $('dl-confirm-text').textContent = `This file has ${num(n)} rows, roughly ${Math.round((n * 62) / 1e6)} MB. Preparing it can take a minute and uses a lot of memory.`;
      $('dl-confirm').hidden = false;
      $('dl-confirm-yes').focus();
    } else void downloadPoints();
  });
  $('dl-confirm-yes').addEventListener('click', () => {
    $('dl-confirm').hidden = true;
    void downloadPoints();
  });
  $('dl-confirm-no').addEventListener('click', () => {
    $('dl-confirm').hidden = true;
    $('dl-points').focus();
  });

  attachTooltip($('calendar'), $('tip'), () => model);
}

async function start(): Promise<void> {
  try {
    data = await loadStatic();
  } catch (err) {
    console.error(err);
    $('headline').textContent = 'The data files could not be loaded';
    $('headline-detail').textContent = 'Check the connection and reload the page. If you built the site yourself, run the data pipeline first.';
    $('app').removeAttribute('aria-busy');
    return;
  }
  $('data-through').textContent = data.meta.data_through;
  const hash = readHash();
  const cut = ymIndex(data.cutoff.year, data.cutoff.month);
  const fallback = Object.keys(data.meta.regions)[0];
  let fromHash = hash.bbox ? resolveBBox(hash.bbox, data.meta.regions) : null;
  if (fromHash && coverageOf(fromHash.sel, data.coverage)?.covered === 0) fromHash = null;
  state = {
    sel: fromHash?.sel ?? wholeRegion(fallback, data.meta.regions[fallback]),
    from: Math.max(FIRST_YM, Math.min(hash.from ?? FIRST_YM, cut)),
    to: Math.max(FIRST_YM, Math.min(hash.to ?? cut, cut)),
    metric: hash.metric ?? 'cd',
    view: hash.view ?? 'abs',
    baseline: hash.baseline ?? 'all',
    density: true,
  };
  if (state.from > state.to) [state.from, state.to] = [state.to, state.from];

  map = createMap(
    $('map'),
    data.meta.regions,
    (bbox) => selectBBox(bbox, false),
    (on) => {
      const draw = $('draw');
      draw.setAttribute('aria-pressed', String(on));
      draw.querySelector('span')!.textContent = on ? 'Drag on the map (Esc to cancel)' : 'Draw area';
    },
  );
  wire();
  renderEngine();

  // Something to read at once: the whole-region preset, even for a custom rectangle in the URL.
  rows = data.presets[state.sel.region].calendar;
  const region = data.meta.regions[state.sel.region];
  if (isWholeRegion(state.sel, region)) {
    select(state.sel, true);
  } else {
    const custom = state.sel;
    state.sel = wholeRegion(custom.region, region);
    render();
    select(custom, true);
  }
  $('app').removeAttribute('aria-busy');
  // A pasted or edited link: start again from that state.
  window.addEventListener('hashchange', () => location.reload());
  void warmUp().catch(() => undefined);
}

void start();
