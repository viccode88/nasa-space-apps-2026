/** Leaflet map: covered regions, the snapped selection, rectangle drawing, density layer. */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { cividis, countScale } from './colors';
import type { Density } from './db';
import { regionEdges, selectionBBox } from './grid';
import type { BBox, RegionCode, RegionMeta, Selection } from './types';

export interface MapApi {
  setSelection(sel: Selection, fit: boolean): void;
  setDensity(d: Density | null, visible: boolean): void;
  setDrawing(on: boolean): void;
}

function bounds([w, s, e, n]: BBox): L.LatLngBoundsExpression {
  return [[s, w], [n, e]];
}

export function createMap(
  el: HTMLElement,
  regions: Record<RegionCode, RegionMeta>,
  onDraw: (bbox: BBox) => void,
  onDrawingChange: (on: boolean) => void,
): MapApi {
  const map = L.map(el, { worldCopyJump: false, boxZoom: false, scrollWheelZoom: false, zoomSnap: 0.25, minZoom: 1 });
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 12,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  for (const r of Object.values(regions)) {
    const e = regionEdges(r);
    L.rectangle(bounds([e.w / 10, e.s / 10, e.e / 10, e.n / 10]), {
      color: '#4a556b', weight: 1, dashArray: '4 4', fill: false, interactive: false,
    }).addTo(map);
  }

  const selection = L.rectangle([[0, 0], [0, 0]], {
    color: '#1d3f77', weight: 2, fillColor: '#1d3f77', fillOpacity: 0.08, interactive: false,
  }).addTo(map);
  const rubber = L.rectangle([[0, 0], [0, 0]], {
    color: '#b35806', weight: 1.5, dashArray: '5 4', fillOpacity: 0.05, interactive: false,
  });
  let densityLayer: L.ImageOverlay | null = null;

  // Rectangle drawing with pointer events, so mouse, pen and touch all work.
  let drawing = false;
  let start: L.LatLng | null = null;
  const latLngOf = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return map.containerPointToLatLng([e.clientX - r.left, e.clientY - r.top]);
  };
  const setDrawing = (on: boolean) => {
    drawing = on;
    start = null;
    rubber.remove();
    el.classList.toggle('is-drawing', on);
    if (on) map.dragging.disable();
    else map.dragging.enable();
    onDrawingChange(on);
  };
  el.addEventListener('pointerdown', (e) => {
    if (!drawing || (e.target as HTMLElement).closest('.leaflet-control')) return;
    start = latLngOf(e);
    rubber.setBounds(L.latLngBounds(start, start)).addTo(map);
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (drawing && start) rubber.setBounds(L.latLngBounds(start, latLngOf(e)));
  });
  el.addEventListener('pointerup', (e) => {
    if (!drawing || !start) return;
    const b = L.latLngBounds(start, latLngOf(e));
    const moved = map.latLngToContainerPoint(b.getNorthEast()).distanceTo(map.latLngToContainerPoint(b.getSouthWest()));
    setDrawing(false);
    if (moved > 6) onDraw([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  });
  el.addEventListener('pointercancel', () => drawing && setDrawing(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawing) setDrawing(false);
  });

  map.fitWorld();

  return {
    setDrawing,
    setSelection(sel, fit) {
      const b = bounds(selectionBBox(sel));
      selection.setBounds(b);
      if (fit) map.fitBounds(b, { padding: [18, 18], animate: false });
    },
    setDensity(d, visible) {
      densityLayer?.remove();
      densityLayer = null;
      if (!d || !visible || d.max <= 0) return;
      densityLayer = L.imageOverlay(densityImage(d), bounds([d.gx0 / 10, d.gy0 / 10, (d.gx0 + d.nx) / 10, (d.gy0 + d.ny) / 10]), {
        opacity: 0.85, interactive: false, className: 'density-image',
      }).addTo(map);
      selection.bringToFront();
    },
  };
}

const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const inverseMercator = (y: number) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;

/**
 * Paint the cell grid to an image. Rows are resampled so the image is linear
 * in Web Mercator, which is how Leaflet stretches an image overlay; otherwise
 * tall selections drift north-south against the base map.
 */
function densityImage(d: Density): string {
  const scale = Math.max(1, Math.min(4, Math.floor(1200 / Math.max(d.nx, d.ny))));
  const width = d.nx * scale;
  const yNorth = mercator((d.gy0 + d.ny) / 10);
  const ySouth = mercator(d.gy0 / 10);
  const height = Math.max(1, Math.round((width * (yNorth - ySouth)) / (((d.nx / 10) * Math.PI) / 180)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  for (let j = 0; j < height; j++) {
    const lat = inverseMercator(yNorth + ((ySouth - yNorth) * (j + 0.5)) / height);
    const row = Math.min(d.ny - 1, Math.max(0, Math.floor(lat * 10 - d.gy0)));
    for (let i = 0; i < width; i++) {
      const v = d.values[row * d.nx + Math.floor(i / scale)];
      if (v <= 0) continue;
      const [r, g, b] = cividis(countScale(v, d.max));
      const o = (j * width + i) * 4;
      image.data[o] = r;
      image.data[o + 1] = g;
      image.data[o + 2] = b;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}
