// Drawn plants: grids, cones (mega trees), polylines, circles and arches. Generates the same kind of map
// a scan produces (plant space, metres: origin on the ground under the middle, Y up, +Z towards the
// street), marked portable so it stays valid whatever strings the plant is wired to.
// Keep in step with ShapeGenerator.swift in the app.
import type { PlantMap, PlantShape, ShapeKind, MappedLED } from './project.js';

type P = [number, number, number];

export const SHAPE_NAMES: Record<ShapeKind, string> = {
  grid: 'Grid', cone: 'Cone (mega tree)', polyline: 'Polyline', circle: 'Circle', arch: 'Arch', panel: 'Panel (matrix)',
};

export function newShape(kind: ShapeKind): PlantShape {
  const s: PlantShape = {
    kind, count: 50, perMetre: null, width: 1, height: 1, topWidth: 0, rows: 10, columns: 10, start: 'left',
    vertical: false, zigzag: true, spiral: false, turns: 6, flat: false, startAngle: 270, clockwise: false,
    reverse: false, points: [],
  };
  switch (kind) {
    case 'grid': return { ...s, width: 1, height: 0.6, rows: 12, columns: 20, count: 240, start: 'bottomLeft' };
    case 'cone': return { ...s, width: 1.2, height: 2, columns: 16, count: 800, start: 'bottom' };
    case 'polyline': return { ...s, count: 60, perMetre: 30, points: [{ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] };
    case 'circle': return { ...s, width: 0.6, count: 60 };
    case 'arch': return { ...s, width: 1.5, height: 0.8, count: 50, start: 'left' };
    case 'panel': return { ...s, rows: 8, columns: 32, count: 256, pitch: 0.01, tilesX: 1, tilesY: 1, start: 'topLeft', vertical: true, zigzag: true };
  }
}

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const pathLength = (pts: P[]) => pts.reduce((n, p, i) => (i ? n + dist(pts[i - 1], p) : 0), 0);

/** `n` points evenly spaced along a path; a closed path doesn't repeat its first point at the end. */
function resample(pts: P[], n: number, closed = false): P[] {
  if (!pts.length || n <= 0) return [];
  const path = closed ? [...pts, pts[0]] : pts;
  const total = pathLength(path);
  if (n === 1 || total <= 0) return Array.from({ length: n }, () => [...path[0]] as P);
  const step = total / (closed ? n : n - 1);
  const out: P[] = [];
  let seg = 0, segStart = 0;
  for (let k = 0; k < n; k++) {
    const want = Math.min(k * step, total);
    while (seg < path.length - 2 && segStart + dist(path[seg], path[seg + 1]) < want) {
      segStart += dist(path[seg], path[seg + 1]);
      seg++;
    }
    const a = path[seg], b = path[seg + 1] ?? a;
    const len = dist(a, b);
    const t = len > 0 ? Math.min(Math.max((want - segStart) / len, 0), 1) : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

const countFor = (s: PlantShape, length: number) =>
  s.perMetre && s.perMetre > 0 ? Math.max(1, Math.round(length * s.perMetre)) : Math.max(1, Math.round(s.count));

/** The path of a single-wire shape (cone spiral, circle, arch, polyline), densely sampled. */
function wirePath(s: PlantShape): { pts: P[]; closed: boolean } {
  const N = 256;
  switch (s.kind) {
    case 'circle': {
      const r = s.width / 2, a0 = (s.startAngle * Math.PI) / 180, dir = s.clockwise ? -1 : 1;
      const pts: P[] = [];
      for (let i = 0; i < N; i++) {
        const a = a0 + dir * (2 * Math.PI * i) / N;
        pts.push(s.flat ? [r * Math.cos(a), 0, -r * Math.sin(a)] : [r * Math.cos(a), r + r * Math.sin(a), 0]);
      }
      return { pts, closed: true };
    }
    case 'arch': {
      const pts: P[] = [];
      for (let i = 0; i <= N; i++) {
        const a = Math.PI - (Math.PI * i) / N;           // left foot to right foot
        pts.push([(s.width / 2) * Math.cos(a), s.height * Math.sin(a), 0]);
      }
      if (s.start === 'right') pts.reverse();
      return { pts, closed: false };
    }
    case 'cone': {
      const pts: P[] = [], steps = Math.max(16, Math.ceil(Math.abs(s.turns) * 64));
      for (let i = 0; i <= steps; i++) {
        const u = i / steps, r = (s.width / 2) * (1 - u) + (s.topWidth / 2) * u, a = 2 * Math.PI * s.turns * u;
        pts.push([r * Math.sin(a), s.height * u, r * Math.cos(a)]);
      }
      if (s.start === 'top') pts.reverse();
      return { pts, closed: false };
    }
    default: {
      const pts = s.points.map(p => [p.x, p.y, p.z] as P);
      if (s.reverse) pts.reverse();
      return { pts: pts.length ? pts : [[0, 0, 0]], closed: false };
    }
  }
}

/** LED positions in wiring order. */
export function shapePoints(s: PlantShape): P[] {
  if (s.kind === 'panel') return panelPoints(s);
  if (s.kind === 'grid') {
    const R = Math.max(1, Math.round(s.rows)), C = Math.max(1, Math.round(s.columns));
    const x = (c: number) => (C > 1 ? s.width * (c / (C - 1) - 0.5) : 0);
    const y = (r: number) => (R > 1 ? (s.height * r) / (R - 1) : 0);
    const fromTop = s.start.startsWith('top'), fromRight = s.start.endsWith('Right');
    const out: P[] = [];
    const outer = s.vertical ? C : R, inner = s.vertical ? R : C;
    for (let o = 0; o < outer; o++) {
      const back = s.zigzag && o % 2 === 1;
      for (let i0 = 0; i0 < inner; i0++) {
        const i = back ? inner - 1 - i0 : i0;
        let c: number, r: number;
        if (s.vertical) { c = fromRight ? C - 1 - o : o; r = fromTop ? R - 1 - i : i; }
        else { r = fromTop ? R - 1 - o : o; c = fromRight ? C - 1 - i : i; }
        out.push([x(c), y(r), 0]);
      }
    }
    return out;
  }
  if (s.kind === 'cone' && !s.spiral) {
    const S = Math.max(1, Math.round(s.columns));
    const r0 = s.width / 2, r1 = s.topWidth / 2;
    const slant = Math.hypot(s.height, r0 - r1);
    const per = s.perMetre && s.perMetre > 0 ? Math.max(1, Math.round(slant * s.perMetre)) : Math.max(1, Math.floor(s.count / S));
    const out: P[] = [];
    for (let k = 0; k < S; k++) {
      const a = (2 * Math.PI * k) / S;
      const up = (s.start !== 'top') !== (s.zigzag && k % 2 === 1);
      for (let i = 0; i < per; i++) {
        const u0 = per > 1 ? i / (per - 1) : 0, u = up ? u0 : 1 - u0;
        const r = r0 * (1 - u) + r1 * u;
        out.push([r * Math.sin(a), s.height * u, r * Math.cos(a)]);
      }
    }
    return out;
  }
  const { pts, closed } = wirePath(s);
  return resample(pts, countFor(s, pathLength(closed ? [...pts, pts[0]] : pts)), closed);
}

/** LED order inside one rows x cols matrix, as (column, row) from the bottom left. */
function matrixOrder(R: number, C: number, start: string, vertical: boolean, zigzag: boolean): [number, number][] {
  const fromTop = start.startsWith('top'), fromRight = start.endsWith('Right');
  const out: [number, number][] = [];
  const outer = vertical ? C : R, inner = vertical ? R : C;
  for (let o = 0; o < outer; o++) {
    const back = zigzag && o % 2 === 1;
    for (let i0 = 0; i0 < inner; i0++) {
      const i = back ? inner - 1 - i0 : i0;
      if (vertical) out.push([fromRight ? C - 1 - o : o, fromTop ? R - 1 - i : i]);
      else out.push([fromRight ? C - 1 - i : i, fromTop ? R - 1 - o : o]);
    }
  }
  return out;
}

/** Matrix panels tiled tilesX x tilesY, chained from the start corner along rows of panels. */
function panelPoints(s: PlantShape): P[] {
  const R = Math.max(1, Math.round(s.rows)), C = Math.max(1, Math.round(s.columns));
  const TX = Math.max(1, Math.round(s.tilesX ?? 1)), TY = Math.max(1, Math.round(s.tilesY ?? 1));
  const pitch = Math.max(0.001, s.pitch ?? 0.01);
  const W = TX * C * pitch;
  const inPanel = matrixOrder(R, C, s.start, s.vertical, s.zigzag);
  const tiles = matrixOrder(TY, TX, s.start, false, false);       // panels: along each row of panels
  const out: P[] = [];
  for (const [tx, ty] of tiles) {
    for (const [c, r] of inPanel) out.push([(tx * C + c + 0.5) * pitch - W / 2, (ty * R + r) * pitch, 0]);
  }
  return out;
}

/** Seconds since 2001-01-01, as Swift encodes a Date. */
const swiftNow = () => Date.now() / 1000 - 978307200;

export function shapeMap(s: PlantShape): PlantMap {
  const pts = shapePoints(s);
  const leds: MappedLED[] = pts.map(([x, y, z]) => ({ x, y, z, quality: 3 }));
  const height = Math.max(0.01, ...pts.map(p => p[1]));
  const radius = Math.max(0.01, ...pts.map(p => Math.hypot(p[0], p[2])));
  return { date: swiftNow(), height, radius, layout: [], leds, portable: true };
}
