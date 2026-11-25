// Builds the online layer for every controller: which LEDs show an online effect right now and what
// colour. Used by the server (to stream it) and the website (to preview it).
import type { Layout } from './layout.js';
import type { Segment } from './show.js';
import { activeSegments } from './show.js';
import { isOnlineFx, renderOnline, type MediaFrames, type OnlineParams } from './online.js';
import { dirVector, fxInfo, rateFromSpeed } from './catalog.js';
import type { LightState } from './project.js';

/** One online effect showing on some zones (null = every LED, for the normal look). */
export interface OnlineSource {
  params: OnlineParams;
  mode: number;            // FRAME_*: 0 yard, 1 each plant, 2 group
  group: number[];
  dir: number[] | null;    // where the camera looks
  ms: number;              // time since it started
  zones: Set<number> | null;
}

const UNIT = [0, 0, 0, 2048, -2048, 4096, 2048];

/** The normal look as an online source (null when its effect isn't an online one). */
export function lookSource(s: LightState | null | undefined, now: number, timeZone = 'UTC'): OnlineSource | null {
  if (!s || s.on === false || !isOnlineFx(s.fx)) return null;
  const dir = fxInfo(s.fx)?.usesView && s.dirYaw != null && s.dirPitch != null ? dirVector(s.dirYaw, s.dirPitch) : null;
  return { params: { fx: s.fx, pal: s.pal, c1: s.c1, c2: s.c2, scl: s.scl, rate: rateFromSpeed(s.spd), text: s.text, media: s.media,
    target: s.target, now, timeZone }, mode: 0, group: UNIT, dir, ms: now, zones: null };
}

/** The online sources in a show at `tMs`: one per clip (zones sharing a clip share a picture). */
export function showSources(segs: Segment[], tMs: number, now = Date.now(), timeZone = 'UTC'): OnlineSource[] {
  const groups = new Map<string, OnlineSource>();
  for (const [zone, s] of activeSegments(segs, tMs)) {
    if (!isOnlineFx(s.fx)) continue;
    const key = [s.p0, s.fx, s.pal, s.c1, s.c2, s.scl, s.rate, s.mode, s.mode === 2 ? s.group.join() : zone, String(s.dir), s.text, s.media, s.target].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { params: { fx: s.fx, pal: s.pal, c1: s.c1, c2: s.c2, scl: s.scl, rate: s.rate, text: s.text, media: s.media, target: s.target, now, timeZone },
        mode: s.mode, group: s.group, dir: s.dir, ms: tMs - s.p0, zones: new Set() };
      groups.set(key, g);
    }
    g.zones!.add(zone);
  }
  return [...groups.values()];
}

/**
 * The camera's picture axes (right, up) for a look direction, as the firmware works them out for the
 * 2D effects (fxPrepare): right = look x up; looking (nearly) straight down or up, "up" in the picture
 * is away from the street. No direction: looking from the street.
 */
export function cameraAxes(dir: number[] | null): { right: number[]; up: number[] } {
  let [dx, dy, dz] = dir ?? [0, 0, -4096];
  const l = Math.hypot(dx, dy, dz) || 1;
  dx /= l; dy /= l; dz /= l;
  const [hx, hy, hz] = Math.abs(dy) > 3900 / 4096 ? [0, 0, -1] : [0, 1, 0];
  let rx = dy * hz - dz * hy, ry = dz * hx - dx * hz, rz = dx * hy - dy * hx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  return { right: [rx, ry, rz], up: [ry * dz - rz * dy, rz * dx - rx * dz, rx * dy - ry * dx] };
}

export class OnlineFrame {
  private coords = new Map<string, Float32Array>();
  private layout?: Layout;
  private pos: Float32Array[] = [];          // per controller: x, y, z (NaN where an LED has no position)

  /**
   * Exact LED positions (metres, turned so the street is +Z like the controllers see it), so small
   * things such as a matrix panel keep their pixel grid. `front` is the yard front (degrees).
   */
  setLayout(layout: Layout, front = 0) {
    this.layout = layout;
    this.coords.clear();
    const th = (front * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
    const index = new Map(layout.controllers.map((c, i) => [c.id, i]));
    this.pos = layout.controllers.map(c => new Float32Array(c.geo.length * 3).fill(NaN));
    for (const p of layout.placed) {
      const ci = index.get(p.controllerID);
      if (ci === undefined || p.index >= layout.controllers[ci].geo.length) continue;
      const [x, y, z] = p.yard;
      this.pos[ci].set([x * cs - z * sn, y, x * sn + z * cs], p.index * 3);
    }
  }

  private view(ci: number, dir: number[] | null) {
    const key = `${ci}|${dir ?? ''}`;
    let v = this.coords.get(key);
    if (!v) {
      const { right, up } = cameraAxes(dir);
      const p = this.pos[ci];
      v = new Float32Array((p.length / 3) * 2);
      for (let i = 0; i < p.length / 3; i++) {
        const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
        v[i * 2] = x * right[0] + y * right[1] + z * right[2];
        v[i * 2 + 1] = x * up[0] + y * up[1] + z * up[2];
      }
      if (this.coords.size > 200) this.coords.clear();
      this.coords.set(key, v);
    }
    return v;
  }
  /**
   * Renders the sources. Returns, per controller, RGB for every LED (null when none of its LEDs is
   * online) and a mask of the LEDs that are.
   */
  render(sources: OnlineSource[], media: (name: string) => MediaFrames | null): { rgb: (Uint8Array | null)[]; mask: (Uint8Array | null)[] } {
    const L = this.layout;
    const n = L?.controllers.length ?? 0;
    const rgb: (Uint8Array | null)[] = new Array(n).fill(null), mask: (Uint8Array | null)[] = new Array(n).fill(null);
    if (!L) return { rgb, mask };
    for (const src of sources) {
      // Every LED in this picture, across all controllers.
      const refs: number[] = [];          // controller, led pairs
      const pts: number[] = [];
      L.controllers.forEach((c, ci) => {
        if (!c.geo.length || !this.pos[ci]) return;
        let v: Float32Array | null = null;
        for (let i = 0; i < c.geo.length; i++) {
          if (src.zones && !src.zones.has(c.geo[i][7])) continue;
          v ??= this.view(ci, src.dir);
          if (Number.isNaN(v[i * 2])) continue;        // not on a mapped plant: no place in the picture
          refs.push(ci, i);
          pts.push(v[i * 2], v[i * 2 + 1]);
        }
      });
      const count = refs.length / 2;
      if (!count) continue;
      const out = new Uint8Array(count * 3);
      renderOnline(src.params, src.ms, pts, count, out, src.params.media ? media(src.params.media) : null);
      for (let k = 0; k < count; k++) {
        const ci = refs[k * 2], i = refs[k * 2 + 1];
        const leds = L.controllers[ci].geo.length;
        const buf = rgb[ci] ??= new Uint8Array(leds * 3);
        const m = mask[ci] ??= new Uint8Array(leds);
        buf[i * 3] = out[k * 3]; buf[i * 3 + 1] = out[k * 3 + 1]; buf[i * 3 + 2] = out[k * 3 + 2];
        m[i] = 1;
      }
    }
    return { rgb, mask };
  }
}
