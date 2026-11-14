/** Methods page: docs/METHODS.md rendered as is, plus the validation numbers of every region. */
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './style.css';

import { marked } from 'marked';
import source from '../../docs/METHODS.md?raw';
import { axisStyle, baseOption, chartFor, FONT, GOLD, INK_2, NAVY } from './charts';
import { dataUrl } from './data';
import { num } from './format';
import type { Meta, Metric, Validation } from './types';

const figures = import.meta.glob<string>('../../docs/figures/*.png', { eager: true, query: '?url', import: 'default' });
const figureUrl = new Map(Object.entries(figures).map(([path, url]) => [path.split('/').pop()!, url]));
const REPO = 'https://github.com/viccode88/nasa-space-apps-2026/blob/main/docs/';

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function renderMarkdown(md: string): string {
  return (marked.parse(md, { async: false }) as string)
    .replace(/<table>/g, '<div class="table-wrap" tabindex="0"><table>')
    .replace(/<\/table>/g, '</table></div>')
    .replace(/src="figures\/([^"]+)"/g, (_, file: string) => `src="${figureUrl.get(file) ?? ''}" loading="lazy"`)
    .replace(/href="(?!https?:|#|mailto:)([^"]+)"/g, (_, path: string) => `href="${REPO}${path}"`);
}

const SUBREGION: Record<string, string> = {
  usa_w: 'United States, west of 100° W', usa_e: 'United States, east of 100° W',
  twn: 'Taiwan', sea: 'Myanmar, Thailand and Laos', arg: 'Argentina',
};
const CONVERSION: Record<string, string> = { aqua_to_snpp: 'Aqua → S-NPP', n20_to_snpp: 'NOAA-20 → S-NPP' };

let metric: Metric = 'cd';
let validation: Validation | null = null;

function annual(v: Validation, key: string): (number | null)[] {
  const series = v.series[key] ?? [];
  const byYear = new Map<number, number | null>();
  v.series.months.forEach((ym, i) => {
    const year = Number(ym.slice(0, 4));
    const x = series[i];
    if (!byYear.has(year)) byYear.set(year, null);
    if (x !== null && x !== undefined) byYear.set(year, (byYear.get(year) ?? 0) + x);
  });
  return [...byYear.values()];
}

function renderExplore(): void {
  const v = validation;
  if (!v) return;
  const years = [...new Set(v.series.months.map((m) => m.slice(0, 4)))];
  const lo = annual(v, `harmonized_lo_${metric}`);
  const hi = annual(v, `harmonized_hi_${metric}`);
  const line = (name: string, key: string, color: string, dash?: number[]) => ({
    name, type: 'line', data: annual(v, key), symbol: 'circle', symbolSize: 5, connectNulls: false,
    lineStyle: { color, width: 1.75, type: dash ?? 'solid' }, itemStyle: { color },
  });
  const el = document.getElementById('explore-chart')!;
  chartFor(el).setOption(
    {
      ...baseOption(),
      aria: { enabled: true },
      legend: {
        top: 0, left: 0, itemWidth: 18, itemHeight: 8,
        textStyle: { fontFamily: FONT, color: INK_2, fontSize: 12 },
        data: ['MODIS Aqua, raw', 'VIIRS S-NPP, raw', 'VIIRS NOAA-20, raw', 'Harmonized', 'Range (10–90%)'],
      },
      tooltip: {
        ...baseOption().tooltip,
        trigger: 'axis',
        valueFormatter: (x: unknown) => (typeof x === 'number' ? num(x) : '–'),
      },
      grid: { ...baseOption().grid, top: 56 },
      xAxis: { type: 'category', data: years, boundaryGap: false, ...axisStyle() },
      yAxis: { type: 'value', ...axisStyle(), axisLine: { show: false } },
      series: [
        { name: 'range-base', type: 'line', stack: 'range', data: lo, symbol: 'none', lineStyle: { opacity: 0 }, tooltip: { show: false }, silent: true },
        {
          name: 'Range (10–90%)', type: 'line', stack: 'range', symbol: 'none', lineStyle: { opacity: 0 },
          data: hi.map((h, i) => (h === null || lo[i] === null ? null : h - (lo[i] as number))),
          areaStyle: { color: 'rgb(29 63 119 / 0.16)' }, itemStyle: { color: 'rgb(29 63 119 / 0.3)' }, tooltip: { show: false }, silent: true,
        },
        line('MODIS Aqua, raw', `aqua_raw_${metric}`, '#8a8678', [4, 3]),
        line('VIIRS S-NPP, raw', `snpp_raw_${metric}`, GOLD, [4, 3]),
        line('VIIRS NOAA-20, raw', `n20_raw_${metric}`, '#a85200', [1, 3]),
        { ...line('Harmonized', `harmonized_${metric}`, NAVY), lineStyle: { color: NAVY, width: 2.5 }, z: 5 },
      ],
    },
    true,
  );
  el.setAttribute(
    'aria-label',
    `Line chart for ${v.name}: yearly ${metric === 'cd' ? 'active cell-days' : 'hotspots'} as counted by each sensor, and the harmonized series with its range.`,
  );

  const t = v.targets;
  const pctText = (x: number | null) => {
    if (x === null) return 'too few fires';
    const text = (x * 100).toFixed(1).replace(/^-(0\.0)$/, '$1');
    return `${x > 0 && text !== '0.0' ? '+' : ''}${text.replace('-', '−')}%`;
  };
  const verdict = (ok: boolean | null) =>
    ok === null ? '' : ok ? ' <span class="verdict">meets</span>' : ' <span class="verdict verdict--miss">misses</span>';
  document.getElementById('explore-cv')!.innerHTML = `<div class="table-wrap" tabindex="0"><table class="cv">
    <thead><tr><th>Subregion</th><th>Conversion</th><th>Training</th>
      <th class="num">Bias (target within ±${t.abs_bias_max * 100}%)</th>
      <th class="num">Monthly error (target ≤ ${t.mape_max * 100}%)</th>
      <th class="num">Year ranking (target ≥ ${t.spearman_min.toFixed(2)})</th></tr></thead>
    <tbody>${v.cv
      .filter((r) => r.metric === metric)
      .map(
        (r) => `<tr><td>${SUBREGION[r.subregion] ?? r.subregion}</td><td>${CONVERSION[r.conversion] ?? r.conversion}</td>
        <td style="white-space:nowrap">${r.train_from} to ${r.train_to}</td>
        <td class="num">${pctText(r.bias)}${verdict(r.bias === null ? null : Math.abs(r.bias) <= t.abs_bias_max)}</td>
        <td class="num">${r.mape === null ? 'too few fires' : `${(r.mape * 100).toFixed(1)}%`}${verdict(r.mape === null ? null : r.mape <= t.mape_max)}</td>
        <td class="num">${r.spearman_annual === null ? '–' : r.spearman_annual.toFixed(2)}${verdict(r.spearman_annual === null ? null : r.spearman_annual >= t.spearman_min)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
  document
    .querySelectorAll<HTMLButtonElement>('#explore [data-metric]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.metric === metric)));
}

async function loadRegion(code: string): Promise<void> {
  const res = await fetch(dataUrl(`validation_${code}.json`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  validation = (await res.json()) as Validation;
  renderExplore();
}

async function start(): Promise<void> {
  const article = document.getElementById('article')!;
  // The interactive block sits at the end of the validation section.
  const cut = source.indexOf('\n## 5.');
  const before = cut > 0 ? source.slice(0, cut) : source;
  const after = cut > 0 ? source.slice(cut) : '';
  article.innerHTML = `${renderMarkdown(before)}
    <section id="explore" class="explore" aria-labelledby="explore-title">
      <h3 id="explore-title">The same check for every region</h3>
      <p>Raw yearly counts of each sensor against the harmonized series, and the leave-one-year-out results. Drawn from the validation files the pipeline writes.</p>
      <div class="controls">
        <label class="field field--inline"><span>Region</span><select id="explore-region"></select></label>
        <div class="seg" role="group" aria-label="Metric">
          <button type="button" data-metric="cd" aria-pressed="true">Active cell-days</button>
          <button type="button" data-metric="hs" aria-pressed="false">Hotspots</button>
        </div>
      </div>
      <div id="explore-chart" class="chart" role="img"></div>
      <div id="explore-cv"></div>
      <p id="explore-error" class="note" hidden></p>
    </section>
    ${renderMarkdown(after)}`;

  const toc: string[] = [];
  article.querySelectorAll('h2').forEach((h) => {
    h.id = slug(h.textContent ?? '');
    toc.push(`<li><a href="#${h.id}">${h.textContent}</a></li>`);
  });
  document.getElementById('toc')!.innerHTML = toc.join('');

  const fail = (err: unknown) => {
    console.error(err);
    const el = document.getElementById('explore-error')!;
    el.hidden = false;
    el.textContent = 'The validation files could not be loaded. The figures and tables in the text are unaffected.';
  };
  try {
    const meta = (await (await fetch(dataUrl('meta.json'))).json()) as Meta;
    document.getElementById('data-through')!.textContent = meta.data_through;
    const select = document.getElementById('explore-region') as HTMLSelectElement;
    select.innerHTML = Object.entries(meta.regions).map(([code, r]) => `<option value="${code}">${r.name}</option>`).join('');
    select.addEventListener('change', () => loadRegion(select.value).catch(fail));
    document.querySelectorAll<HTMLButtonElement>('#explore [data-metric]').forEach((b) =>
      b.addEventListener('click', () => {
        metric = b.dataset.metric as Metric;
        renderExplore();
      }),
    );
    await loadRegion(select.value);
  } catch (err) {
    fail(err);
  }
}

void start();
