/** The burn calendar: a years × months table with numbers, colour and hatching. */
import { ANOMALY_STOPS, anomalyScale, cividis, countScale, css, diverging, gradientCss, isLight } from './colors';
import { METRIC_LABEL, METRIC_SHORT, MONTHS, MONTHS_LONG, num, ordinal, pct } from './format';
import type { Cell, Model } from './stats';
import type { View } from './types';

const SENSOR = ['MODIS Aqua', 'VIIRS S-NPP', 'VIIRS NOAA-20'];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function cellText(cell: Cell, view: View): string {
  if (view === 'abs') return num(cell.value);
  if (cell.diff === null) return cell.value > 0 && cell.n > 1 ? `#${cell.rank}` : '–';
  return pct(cell.diff);
}

function cellColour(cell: Cell, view: View, model: Model) {
  if (view === 'abs') return cividis(countScale(cell.value, model.maxValue, model.minValue));
  return diverging(cell.diff === null ? 0.5 : anomalyScale(cell.diff));
}

function ariaLabel(cell: Cell, model: Model): string {
  const parts = [
    `${MONTHS_LONG[cell.month - 1]} ${cell.year}${cell.toDate ? ' to date' : ''}`,
    `${num(cell.value)} ${METRIC_LABEL[model.options.metric]}`,
  ];
  if (cell.diff !== null) parts.push(`${pct(cell.diff)} against the median`);
  if (cell.n > 1) parts.push(`${ordinal(cell.rank)} highest of ${cell.n} years`);
  if (cell.converted) parts.push(`converted from ${SENSOR[cell.src]}`);
  if (cell.incomplete) parts.push('incomplete month');
  return parts.join(', ');
}

export function renderCalendar(root: HTMLElement, model: Model, view: View): void {
  const { cutoff } = model.options;
  const head = `<thead><tr><th scope="col" class="cal__corner">Year</th>${MONTHS.map(
    (m, i) => `<th scope="col"><abbr title="${MONTHS_LONG[i]}">${m}</abbr></th>`,
  ).join('')}</tr></thead>`;

  const rows = model.years
    .map((y) => {
      const tds: string[] = [];
      for (let m = 1; m <= 12; m++) {
        const cell = model.cell(y, m);
        if (!cell) {
          const after = y === cutoff.year && m === cutoff.month + 1 && model.current;
          tds.push(
            after
              ? `<td class="cal__blank cal__blank--label"><span>to date</span></td>`
              : `<td class="cal__blank"></td>`,
          );
          continue;
        }
        const colour = cellColour(cell, view, model);
        const cls = [
          'cell',
          isLight(colour) ? 'cell--light' : 'cell--dark',
          cell.converted ? 'cell--hatch' : '',
          cell.toDate ? 'cell--todate' : '',
          cell.incomplete ? 'cell--incomplete' : '',
        ];
        tds.push(
          `<td><button type="button" class="${cls.filter(Boolean).join(' ')}" style="--c:${css(colour)}" ` +
            `data-y="${y}" data-m="${m}" aria-label="${esc(ariaLabel(cell, model))}">${cellText(cell, view)}</button></td>`,
        );
      }
      return `<tr><th scope="row">${y}</th>${tds.join('')}</tr>`;
    })
    .join('');

  root.innerHTML = `<table class="cal">${head}<tbody>${rows}</tbody></table>`;
}

export function renderLegend(root: HTMLElement, model: Model, view: View): void {
  const { cutoff, metric } = model.options;
  let scale: string;
  if (view === 'abs') {
    const { maxValue: max, minValue: min } = model;
    const ticks = [0, 0.0625, 0.25, 0.5625, 1].map(
      (f) => `<span style="left:${Math.sqrt(f) * 100}%">${num(min + (max - min) * f)}</span>`,
    );
    scale = `<div class="scale"><div class="scale__label">${esc(METRIC_SHORT[metric])} per month, square-root scale</div>
      <div class="scale__bar" style="background:${gradientCss(cividis)}"></div>
      <div class="scale__ticks">${ticks.join('')}</div></div>`;
  } else {
    const ticks = ANOMALY_STOPS.map(
      (d) => `<span style="left:${anomalyScale(d) * 100}%">${d === 0 ? 'median' : pct(d)}</span>`,
    );
    scale = `<div class="scale"><div class="scale__label">Difference from the month's median</div>
      <div class="scale__bar" style="background:${gradientCss(diverging)}"></div>
      <div class="scale__ticks">${ticks.join('')}</div></div>`;
  }
  const keys = [
    `<li><span class="key key--hatch"></span>Converted month: MODIS Aqua × k before 2012-02, NOAA-20 × k from 2026-11</li>`,
    `<li><span class="key key--plain"></span>VIIRS S-NPP as observed</li>`,
  ];
  if (model.current) {
    keys.push(
      `<li><span class="key key--todate"></span>${MONTHS_LONG[cutoff.month - 1]} ${cutoff.year} to date (days 1–${cutoff.day}), compared with the same days of other years</li>`,
    );
  }
  if (model.cells.some((c) => c.incomplete)) {
    keys.push(`<li><span class="key key--incomplete"></span>Incomplete: 3 or more sensor outage days</li>`);
  }
  if (view === 'anom') keys.push(`<li><span class="key key--rank">#2</span>Median is 0: rank shown instead of a percentage</li>`);
  root.innerHTML = `${scale}<ul class="keys">${keys.join('')}</ul>`;
}

export function tooltipHtml(cell: Cell, model: Model): string {
  const metric = model.options.metric;
  const title = `${MONTHS_LONG[cell.month - 1]} ${cell.year}${cell.toDate ? `, days 1–${model.options.cutoff.day}` : ''}`;
  const range = cell.converted && cell.value > 0 ? `${num(cell.lo)} – ${num(cell.hi)}` : 'none (observed directly)';
  const compare =
    cell.uncompared
      ? 'needs the daily grid, which is not loaded'
      : cell.n <= 1
        ? 'no baseline years'
      : `${cell.diff === null ? 'median is 0' : `${pct(cell.diff)} vs median ${num(cell.median)}`}; ${ordinal(cell.rank)} highest of ${cell.n}`;
  const flags: string[] = [];
  if (cell.toDate) flags.push('Month to date');
  if (cell.nrt) flags.push('Includes near-real-time detections');
  if (cell.incomplete) flags.push(`Incomplete: ${cell.outageDays} sensor outage days`);
  const rows: [string, string][] = [
    ['Harmonized', `<strong>${num(cell.value)}</strong> ${METRIC_LABEL[metric]}`],
    ['Range (10–90%)', range],
    ['Primary sensor', SENSOR[cell.src] ?? '—'],
    ['Raw value', num(cell.raw)],
    ['Coefficient', cell.converted ? (cell.k === null ? '—' : `× ${cell.k.toFixed(2)}`) : '× 1 (reference sensor)'],
    [cell.toDate ? 'Same days, other years' : 'Same month, other years', compare],
    ['Flags', flags.length ? flags.join('<br>') : 'None'],
  ];
  return `<p class="tip__title">${title}</p><dl>${rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('')}</dl>`;
}

/** Hover, focus and tap all open the same tooltip; Escape closes it. */
export function attachTooltip(root: HTMLElement, tip: HTMLElement, getModel: () => Model | null): void {
  let open: HTMLElement | null = null;

  const place = (target: HTMLElement) => {
    const r = target.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const gap = 8;
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(gap, Math.min(left, window.innerWidth - t.width - gap));
    let top = r.top - t.height - gap;
    if (top < gap) top = r.bottom + gap;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const show = (target: HTMLElement) => {
    const model = getModel();
    const cell = model?.cell(Number(target.dataset.y), Number(target.dataset.m));
    if (!model || !cell) return;
    tip.innerHTML = tooltipHtml(cell, model);
    tip.hidden = false;
    target.setAttribute('aria-describedby', 'tip');
    open = target;
    place(target);
  };

  const hide = () => {
    open?.removeAttribute('aria-describedby');
    open = null;
    tip.hidden = true;
  };

  const cellOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('.cell');

  root.addEventListener('pointerover', (e) => {
    const c = cellOf(e);
    if (c && c !== open) show(c);
  });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('focusin', (e) => {
    const c = cellOf(e);
    if (c) show(c);
  });
  root.addEventListener('focusout', hide);
  root.addEventListener('click', (e) => {
    const c = cellOf(e);
    if (c) show(c);
  });
  const follow = () => {
    if (!open) return;
    const r = open.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    if (r.right < box.left || r.left > box.right || r.bottom < 0 || r.top > window.innerHeight) hide();
    else place(open);
  };
  root.addEventListener('scroll', follow, { passive: true });
  window.addEventListener('scroll', follow, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });

  // Arrow keys move between months and years, as in a grid.
  root.addEventListener('keydown', (e) => {
    const c = cellOf(e);
    if (!c) return;
    const step: Record<string, [number, number]> = {
      ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0],
    };
    const d = step[e.key];
    if (!d) return;
    const next = root.querySelector<HTMLElement>(
      `.cell[data-y="${Number(c.dataset.y) + d[0]}"][data-m="${Number(c.dataset.m) + d[1]}"]`,
    );
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });
}
