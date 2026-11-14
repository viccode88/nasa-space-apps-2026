/** Colour ramps. cividis for counts, blue to orange for anomalies; never red against green. */
type RGB = [number, number, number];

const CIVIDIS = ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8678', '#a59c74', '#c3b369', '#e1cc55', '#fee838'];
const DIVERGING = ['#0f4585', '#3f78b8', '#9dbfe0', '#eeece4', '#f5c48c', '#e2872b', '#a85200'];

function hex(c: string): RGB {
  return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as RGB;
}

function ramp(stops: string[]) {
  const rgb = stops.map(hex);
  return (t: number): RGB => {
    const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (rgb.length - 1);
    const i = Math.min(rgb.length - 2, Math.floor(x));
    const f = x - i;
    return [0, 1, 2].map((k) => Math.round(rgb[i][k] + (rgb[i + 1][k] - rgb[i][k]) * f)) as RGB;
  };
}

export const cividis = ramp(CIVIDIS);
export const diverging = ramp(DIVERGING);
export const css = ([r, g, b]: RGB) => `rgb(${r} ${g} ${b})`;

/** Square-root scale: fire counts are skewed, a linear ramp would hide all but the peak months. */
export function countScale(value: number, max: number, min = 0): number {
  return max > min ? Math.sqrt(Math.min(1, Math.max(0, (value - min) / (max - min)))) : 0;
}

/** Anomaly position on the diverging ramp: a quarter of the median to four times it. */
export const ANOMALY_STOPS = [-0.75, -0.5, 0, 1, 3];
export function anomalyScale(diff: number): number {
  const log = Math.log2(Math.max(1 + diff, 1 / 4));
  return 0.5 + Math.min(2, Math.max(-2, log)) / 4;
}

/**
 * True when black text reads better than white text on this colour. At the
 * crossover (relative luminance 0.179) both give 4.58:1, so every cell meets WCAG AA.
 */
export function isLight([r, g, b]: RGB): boolean {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.179;
}

export function gradientCss(fn: (t: number) => RGB, steps = 12): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) parts.push(`${css(fn(i / steps))} ${((i / steps) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}
