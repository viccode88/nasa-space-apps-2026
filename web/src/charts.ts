/** ECharts figures: annual totals and the spread of each calendar month. */
import { BarChart, BoxplotChart, CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, MarkAreaComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { METRIC_LABEL, MONTHS, MONTHS_LONG, num } from './format';
import type { Model } from './stats';

echarts.use([
  BarChart, BoxplotChart, CustomChart, LineChart, ScatterChart,
  AriaComponent, GridComponent, LegendComponent, MarkAreaComponent, TooltipComponent, CanvasRenderer,
]);

export { echarts };

export const INK = '#16233b';
export const INK_2 = '#4a556b';
export const LINE = '#dcdcd3';
export const NAVY = '#1d3f77';
export const NAVY_LIGHT = '#8ea3c4';
export const GOLD = '#b88a00';
export const FONT = '"IBM Plex Sans", system-ui, sans-serif';

export const HATCH = {
  symbol: 'rect',
  dashArrayX: [1, 0],
  dashArrayY: [2, 4],
  rotation: -Math.PI / 4,
  color: 'rgba(255,255,255,0.55)',
};

export function baseOption() {
  return {
    animationDuration: 200,
    animationDurationUpdate: 200,
    textStyle: { fontFamily: FONT, color: INK_2 },
    grid: { left: 8, right: 12, top: 34, bottom: 4, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    tooltip: {
      confine: true,
      backgroundColor: '#fff',
      borderColor: LINE,
      padding: [8, 10],
      textStyle: { fontFamily: FONT, color: INK, fontSize: 13 },
      extraCssText: 'box-shadow: 0 6px 20px -8px rgb(22 35 59 / 0.35); border-radius: 6px;',
    },
  };
}

export function axisStyle() {
  return {
    axisLine: { lineStyle: { color: LINE } },
    axisTick: { show: false },
    axisLabel: { color: INK_2, fontFamily: FONT, fontSize: 12 },
    splitLine: { lineStyle: { color: '#ecece5' } },
  };
}

const charts = new Map<HTMLElement, echarts.ECharts>();

export function chartFor(el: HTMLElement): echarts.ECharts {
  let chart = charts.get(el);
  if (!chart) {
    chart = echarts.init(el);
    charts.set(el, chart);
    const instance = chart;
    new ResizeObserver(() => instance.resize()).observe(el);
  }
  return chart;
}

function compact(v: number): string {
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return String(v);
}

export function renderAnnual(el: HTMLElement, model: Model): string {
  const { metric, cutoff } = model.options;
  const years = model.annual.map((a) => String(a.year));
  const top = model.topYear;
  const label = {
    show: true,
    position: 'top' as const,
    color: INK,
    fontFamily: FONT,
    fontWeight: 600,
    fontSize: 12,
    formatter: (p: { dataIndex: number }) => {
      const a = model.annual[p.dataIndex];
      return top && a.year === top.year ? `Highest: ${num(a.total)}` : '';
    },
  };
  chartFor(el).setOption(
    {
      ...baseOption(),
      aria: { enabled: true },
      legend: {
        top: 0, left: 0, itemWidth: 14, itemHeight: 10, selectedMode: false,
        textStyle: { fontFamily: FONT, color: INK_2, fontSize: 12 },
        data: ['VIIRS S-NPP as observed', 'Converted (Aqua × k, NOAA-20 × k)'],
      },
      tooltip: {
        ...baseOption().tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgb(22 35 59 / 0.06)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const a = model.annual[ps[0].dataIndex];
          const partial = a.full ? '' : a.year === cutoff.year ? ' (to date)' : ' (partial year in range)';
          const lines = [`<strong>${a.year}${partial}</strong>`, `${num(a.total)} ${METRIC_LABEL[metric]}`];
          if (a.converted > 0 && a.observed > 0) lines.push(`of which converted: ${num(a.converted)}`);
          else if (a.converted > 0) lines.push('all months converted');
          return lines.join('<br>');
        },
      },
      xAxis: { type: 'category', data: years, ...axisStyle(), axisLabel: { ...axisStyle().axisLabel, interval: (i: number) => Number(years[i]) % 5 === 0 || years.length <= 12 } },
      yAxis: { type: 'value', ...axisStyle(), axisLine: { show: false }, axisLabel: { ...axisStyle().axisLabel, formatter: compact } },
      series: [
        {
          name: 'VIIRS S-NPP as observed',
          type: 'bar',
          stack: 'year',
          barCategoryGap: '22%',
          itemStyle: { color: NAVY },
          data: model.annual.map((a) => ({ value: a.observed, itemStyle: a.full ? undefined : { opacity: 0.55 } })),
        },
        {
          name: 'Converted (Aqua × k, NOAA-20 × k)',
          type: 'bar',
          stack: 'year',
          itemStyle: { color: NAVY_LIGHT, decal: HATCH },
          label,
          data: model.annual.map((a) => ({ value: a.converted, itemStyle: a.full ? undefined : { opacity: 0.55 } })),
        },
      ],
    },
    true,
  );
  const span = `${years[0]}–${years[years.length - 1]}`;
  return top
    ? `Bar chart of annual ${METRIC_LABEL[metric]}, ${span}. Highest full year: ${top.year} with ${num(top.total)}.`
    : `Bar chart of annual ${METRIC_LABEL[metric]}, ${span}. No fire recorded.`;
}

export function renderBox(el: HTMLElement, model: Model): string {
  const { metric } = model.options;
  const season = model.season;
  const inSeason = (m: number) => !!season && (m - season.start + 12) % 12 < season.length;
  const latestYear = model.years[model.years.length - 1];
  const latest = MONTHS.map((_, i) => model.cell(latestYear, i + 1));

  // Shade the burn season; it may wrap around the year end, so mark runs of adjacent months.
  const areas: [{ xAxis: string; name?: string }, { xAxis: string }][] = [];
  let run: number[] = [];
  for (let m = 1; m <= 13; m++) {
    if (m <= 12 && inSeason(m)) run.push(m);
    else if (run.length) {
      areas.push([{ xAxis: MONTHS[run[0] - 1], name: areas.length ? undefined : 'Burn season' }, { xAxis: MONTHS[run[run.length - 1] - 1] }]);
      run = [];
    }
  }

  chartFor(el).setOption(
    {
      ...baseOption(),
      aria: { enabled: true },
      legend: {
        top: 0, right: 0, itemWidth: 14, itemHeight: 10, selectedMode: false,
        textStyle: { fontFamily: FONT, color: INK_2, fontSize: 12 },
        data: ['Baseline years', String(latestYear)],
      },
      tooltip: {
        ...baseOption().tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgb(22 35 59 / 0.06)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0].dataIndex;
          const s = model.monthStats[i];
          const c = latest[i];
          const lines = [
            `<strong>${MONTHS_LONG[i]}</strong> · ${s.n} years`,
            `Median ${num(s.median)}`,
            `Middle half ${num(s.q1)} – ${num(s.q3)}`,
            `Lowest ${num(s.min)} · highest ${num(s.max)}`,
          ];
          if (c) lines.push(`${latestYear}${c.toDate ? ' to date' : ''}: ${num(c.value)}`);
          return lines.join('<br>');
        },
      },
      xAxis: { type: 'category', data: MONTHS, ...axisStyle() },
      yAxis: { type: 'value', ...axisStyle(), axisLine: { show: false }, axisLabel: { ...axisStyle().axisLabel, formatter: compact } },
      series: [
        {
          name: 'Baseline years',
          type: 'boxplot',
          boxWidth: ['35%', '55%'],
          itemStyle: { color: '#e4e9f2', borderColor: NAVY, borderWidth: 1.25 },
          data: model.monthStats.map((s) => [s.min, s.q1, s.median, s.q3, s.max]),
          markArea: {
            silent: true,
            itemStyle: { color: 'rgb(254 232 56 / 0.22)' },
            label: { color: INK, fontFamily: FONT, fontSize: 12, fontWeight: 600, position: 'top', distance: 6 },
            data: areas,
          },
        },
        {
          name: String(latestYear),
          type: 'scatter',
          symbol: 'diamond',
          symbolSize: 9,
          itemStyle: { color: GOLD, borderColor: '#fff', borderWidth: 1 },
          data: latest.map((c) => (c ? c.value : null)),
          z: 5,
        },
      ],
    },
    true,
  );
  const seasonText = season
    ? ` Burn season: ${MONTHS_LONG[season.start - 1]} to ${MONTHS_LONG[(season.start + season.length - 2) % 12]}.`
    : '';
  return `Box plot of ${METRIC_LABEL[metric]} for each calendar month across the baseline years.${seasonText}`;
}
