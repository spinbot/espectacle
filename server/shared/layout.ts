// Port of the iOS app's layout maths (TreeStore.placedLEDs / uploadLayout / frame(of:)) so the
// server and website compute exactly the geometry the controllers hold. Swift uses Float, so
// every step is rounded to 32-bit with Math.fround to match.
import type { AppData, Plant, Controller, UUID, PlantMap } from './project.js';

const f = Math.fround;
const MAX_ZONES = 32, OTHER_ZONE = 31;
export const UNIT_FRAME = [0, 0, 0, 2048, -2048, 4096, 2048];

type V3 = [number, number, number];

/** Swift's `.rounded()`: to nearest, halves away from zero. */
const roundAway = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));
const clampI = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export const zoneOfPlantAt = (index: number) => Math.min(index, OTHER_ZONE - 1);

/** One run of a plant's LEDs: `count` LEDs from `start` on one string. */
export interface PlantPiece { controller: Controller; stringIndex: number; start: number; count: number }

/**
 * A plant's LEDs in order (TreeStore.strings(of:)): its parts when it has them, otherwise the whole
 * strings assigned to it (controller order, then string order). This is the scan / map order.
 */
export function stringsOf(data: AppData, plant: Plant): PlantPiece[] {
  const out: PlantPiece[] = [];
  if (plant.parts?.length) {
    for (const p of plant.parts) {
      const c = data.controllers.find(x => x.id === p.controller);
      const s = c?.strings[p.string];
      if (!c || !s) continue;
      const start = clampI(Math.trunc(p.start) || 0, 0, s.count);
      const count = clampI(Math.trunc(p.count) || 0, 0, s.count - start);
      if (count > 0) out.push({ controller: c, stringIndex: p.string, start, count });
    }
    return out;
  }
  for (const c of data.controllers) {
    c.strings.forEach((s, i) => { if (s.plantID === plant.id) out.push({ controller: c, stringIndex: i, start: 0, count: s.count }); });
  }
  return out;
}

export const ledCountOf = (data: AppData, plant: Plant) => stringsOf(data, plant).reduce((n, p) => n + p.count, 0);

/** Identifies the LEDs a scan was made with (whole strings keep the original "id/string/count" form). */
export function layoutKey(data: AppData, plant: Plant) {
  return stringsOf(data, plant).map(p => p.start === 0 && p.count === p.controller.strings[p.stringIndex].count
    ? `${p.controller.id}/${p.stringIndex}/${p.count}` : `${p.controller.id}/${p.stringIndex}/${p.start}+${p.count}`);
}

/**
 * A prop's map (scanned or drawn) belongs to its LEDs in wiring order, not to particular controllers or
 * strings, so it stays valid through any rewiring that keeps the same number of LEDs in the same order.
 */
export function mapIsCurrent(data: AppData, plant: Plant) {
  if (!plant.map) return false;
  const n = ledCountOf(data, plant);
  return n > 0 && n === plant.map.leds.length;
}

/**
 * Fits a scan to `n` LEDs after the wiring changed: keeps the first (or last) n positions, or adds
 * unlocated LEDs at the end (or start). Added LEDs sit at the nearest scanned one until a
 * "scan the LEDs that aren't green" pass finds them. Mirrors TreeStore.fitMap in the app.
 */
export function fitMap(map: PlantMap, n: number, keepStart: boolean): PlantMap {
  let leds = map.leds.slice();
  if (n <= 0) return map;
  if (leds.length > n) leds = keepStart ? leds.slice(0, n) : leds.slice(leds.length - n);
  else if (leds.length < n) {
    const edge = keepStart ? leds[leds.length - 1] : leds[0];
    const pad = Array.from({ length: n - leds.length }, () => ({ x: edge?.x ?? 0, y: edge?.y ?? 0, z: edge?.z ?? 0, quality: 0 }));
    leds = keepStart ? leds.concat(pad) : pad.concat(leds);
  }
  return { ...map, leds };
}

/** The same LEDs wired from the other end. */
export function reverseMap(map: PlantMap): PlantMap {
  return { ...map, leds: map.leds.slice().reverse() };
}

/** Which plant each LED of each controller belongs to (null: none). Later plants win any overlap. */
export function ledOwners(data: AppData): Map<string, (UUID | null)[]> {
  const m = new Map<string, (UUID | null)[]>();
  const firstLED = new Map<string, number[]>();
  for (const c of data.controllers) {
    let n = 0;
    firstLED.set(c.id, c.strings.map(s => { const v = n; n += s.count; return v; }));
    m.set(c.id, new Array(n).fill(null));
  }
  for (const plant of data.plants) {
    for (const p of stringsOf(data, plant)) {
      const list = m.get(p.controller.id)!, first = firstLED.get(p.controller.id)![p.stringIndex];
      for (let i = 0; i < p.count; i++) list[first + p.start + i] = plant.id;
    }
  }
  return m;
}

export interface PlacedLED {
  controllerID: string;
  index: number;          // LED index within its controller
  yard: V3;               // metres, yard space
  local: V3;              // plant space after the plant's rotation
  plantHeight: number;
  plantRadius: number;
  quality: number;
  plantID: UUID;
  ledIndex: number;       // index within the plant's map
}

export function placedLEDs(data: AppData): PlacedLED[] {
  const firstLED = new Map<string, number[]>();
  for (const c of data.controllers) {
    let n = 0;
    firstLED.set(c.id, c.strings.map(s => { const v = n; n += s.count; return v; }));
  }
  const out: PlacedLED[] = [];
  for (const plant of data.plants) {
    if (!mapIsCurrent(data, plant)) continue;
    const map = plant.map!;
    const th = f(f(f(plant.rotation) * f(Math.PI)) / 180);
    const cs = f(Math.cos(th)), sn = f(Math.sin(th));
    let k = 0;
    for (const ps of stringsOf(data, plant)) {
      const first = firstLED.get(ps.controller.id)?.[ps.stringIndex] ?? 0;
      for (let i = 0; i < ps.count; i++) {
        if (k >= map.leds.length) break;
        const m = map.leds[k++];
        const mx = f(m.x), my = f(m.y), mz = f(m.z);
        const local: V3 = [f(f(mx * cs) + f(mz * sn)), my, f(f(-mx * sn) + f(mz * cs))];
        out.push({
          controllerID: ps.controller.id, index: first + ps.start + i,
          yard: [f(local[0] + f(plant.x)), f(local[1] + f(plant.y)), f(local[2] + f(plant.z))], local,
          plantHeight: Math.max(f(map.height), f(0.01)), plantRadius: Math.max(f(map.radius), f(0.01)),
          quality: m.quality, plantID: plant.id, ledIndex: k - 1,
        });
      }
    }
  }
  return out;
}

/** The yard's front: degrees the street side is turned from the scan's +Z (positive turns it to the right). */
export const yardFront = (data: AppData) => {
  const v = Number(data.yard?.front ?? 0);
  return Number.isFinite(v) ? v : 0;
};

/**
 * LED positions as the controllers see them: the yard turned so that its front (the street) is +Z.
 * Mirrors TreeStore.controllerSpace in the app.
 */
function controllerSpace(placed: PlacedLED[], front: number): PlacedLED[] {
  if (!front) return placed;
  const th = f(f(f(front) * f(Math.PI)) / 180);
  const cs = f(Math.cos(th)), sn = f(Math.sin(th));
  return placed.map(p => {
    const [x, y, z] = p.yard;
    return { ...p, yard: [f(f(x * cs) - f(z * sn)), y, f(f(x * sn) + f(z * cs))] as V3 };
  });
}

interface YardScale { centre: V3; half: number }

function yardScale(placed: PlacedLED[]): YardScale | null {
  if (!placed.length) return null;
  const lo = [...placed[0].yard] as V3, hi = [...placed[0].yard] as V3;
  for (const p of placed) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p.yard[a]); hi[a] = Math.max(hi[a], p.yard[a]); }
  const centre = lo.map((v, a) => f(f(v + hi[a]) / 2)) as V3;
  const ext = Math.max(...hi.map((v, a) => f(v - lo[a])));
  return { centre, half: Math.max(f(ext / 2), f(0.05)) };
}

const q12 = (y: YardScale, v: number) => clampI(roundAway(f(f(v / y.half) * 2048)), -32767, 32767);
const q12v = (y: YardScale, p: V3) =>
  p.map((v, a) => clampI(f(f(f(v - y.centre[a]) / y.half) * 2048), -32767, 32767)) as V3;
const u16 = (v: number) => clampI(roundAway(f(v * 65535)), 0, 65535);

/** A box around some LEDs in controller units (see Frame in effects.h). */
function frameOf(leds: PlacedLED[], y: YardScale): number[] {
  if (!leds.length) return UNIT_FRAME.slice();
  const first = q12v(y, leds[0].yard);
  const lo = [...first] as V3, hi = [...first] as V3;
  for (const p of leds) { const q = q12v(y, p.yard); for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]); } }
  const c = lo.map((v, a) => f(f(v + hi[a]) / 2)) as V3;
  let radius = f(16);
  for (const p of leds) {
    const q = q12v(y, p.yard);
    const dx = f(q[0] - c[0]), dz = f(q[2] - c[2]);
    radius = Math.max(radius, f(Math.sqrt(f(f(dx * dx) + f(dz * dz)))));
  }
  const i = (v: number) => clampI(roundAway(v), -32767, 32767);
  const ext = Math.max(...hi.map((v, a) => f(v - lo[a])));
  return [i(c[0]), i(c[1]), i(c[2]), i(Math.max(f(ext / 2), 64)), i(lo[1]), i(Math.max(f(hi[1] - lo[1]), 16)), i(radius)];
}

export interface ControllerGeometry {
  id: string;
  base: number;           // global index of its first LED
  geo: number[][];        // per LED: x, y, z, h, ang, rad, d3, zone
}

export interface Layout {
  placed: PlacedLED[];
  controllers: ControllerGeometry[];
  zoneFrames: number[];   // MAX_ZONES * 7
  groupFrame: (plants: UUID[]) => number[];
}

/** Geometry for every LED on every controller, exactly as the app uploads it. */
export function computeLayout(data: AppData): Layout {
  const placed = placedLEDs(data);
  const gp = controllerSpace(placed, yardFront(data));   // geometry is measured from the yard's front
  const plantIndex = new Map(data.plants.map((p, i) => [p.id, i]));
  const yard = yardScale(gp);

  const geo = new Map<string, number[][]>();
  const owners = ledOwners(data);
  for (const c of data.controllers) {
    const list: number[][] = [];
    const own = owners.get(c.id)!;
    c.strings.forEach(s => {
      for (let i = 0; i < s.count; i++) {
        const o = own[list.length];
        const pi = o ? plantIndex.get(o) : undefined;
        const zone = pi !== undefined ? zoneOfPlantAt(pi) : OTHER_ZONE;
        list.push([0, 0, 0, s.count > 1 ? Math.trunc(i * 65535 / (s.count - 1)) : 0, (i * 2185) & 0xffff, 32768, 0, zone]);
      }
    });
    geo.set(c.id, list);
  }

  let zoneFrames: number[] = [];
  if (yard) {
    const centre = yard.centre;
    const dist = (p: V3) => { const d = p.map((v, a) => f(v - centre[a])); return f(Math.sqrt(f(f(f(d[0] * d[0]) + f(d[1] * d[1])) + f(d[2] * d[2])))); };
    const maxDist = Math.max(gp.reduce((m, p) => Math.max(m, dist(p.yard)), 0), f(0.05));
    for (const p of gp) {
      const list = geo.get(p.controllerID);
      if (!list || p.index >= list.length) continue;
      const d = p.yard.map((v, a) => f(v - centre[a])) as V3;
      let ang = f(f(Math.atan2(p.local[2], p.local[0])) / f(2 * Math.PI));
      if (ang < 0) ang = f(ang + 1);
      const zone = list[p.index][7];
      list[p.index] = [
        q12(yard, d[0]), q12(yard, d[1]), q12(yard, d[2]),
        u16(f(p.local[1] / p.plantHeight)),
        Math.trunc(f(ang * 65536)) & 0xffff,
        u16(f(f(Math.sqrt(f(f(p.local[0] * p.local[0]) + f(p.local[2] * p.local[2])))) / p.plantRadius)),
        u16(f(dist(p.yard) / maxDist)),
        zone,
      ];
    }
    for (let z = 0; z < MAX_ZONES; z++) {
      const ids = new Set(data.plants.filter((_, i) => zoneOfPlantAt(i) === z && z !== OTHER_ZONE).map(p => p.id));
      zoneFrames = zoneFrames.concat(frameOf(gp.filter(p => ids.has(p.plantID)), yard));
    }
  } else {
    for (let z = 0; z < MAX_ZONES; z++) zoneFrames = zoneFrames.concat(UNIT_FRAME);
  }

  let base = 0;
  const controllers = data.controllers.map(c => {
    const g = { id: c.id, base, geo: geo.get(c.id)! };
    base += c.strings.reduce((n, s) => n + s.count, 0);
    return g;
  });

  return {
    placed, controllers, zoneFrames,
    groupFrame: (plants: UUID[]) => {
      if (!yard) return UNIT_FRAME.slice();
      const ids = new Set(plants);
      return frameOf(plants.length ? gp.filter(p => ids.has(p.plantID)) : gp, yard);
    },
  };
}
