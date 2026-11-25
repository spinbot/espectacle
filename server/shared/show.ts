// Shows, as the app stores them (ShowModels.swift), and a port of the app's ShowCompiler so the
// website plays a show exactly as the controllers will. When writing shows, every field must be
// present: the app's decoder requires them.
import type { AppData, Plant, UUID } from './project.js';
import { dirVector, hasDirSetting } from './catalog.js';
import { isOnlineFx } from './online.js';

export interface ShowClip {
  id: UUID;
  start: number;          // seconds
  duration: number;       // seconds
  fx: number; pal: number; bri: number; scl: number;
  c1: number; c2: number;
  beats: number | null;   // cycle length in beats (when the show has a tempo)
  seconds: number;        // cycle length in seconds (no tempo, or beats null)
  dirYaw?: number | null;   // direction of travel in degrees (see dirVector); null = effect default
  dirPitch?: number | null;
  text?: string | null;     // online effects: marquee text
  media?: string | null;    //   video file
  target?: number | null;   //   countdown to (ms); null = next Christmas
}

export interface ShowTrack {
  id: UUID;
  targets: UUID[];        // empty = every plant
  together: boolean;      // plants treated as one big plant
  muted: boolean;
  clips: ShowClip[];
}

export interface Show {
  id: UUID;
  name: string;
  audioFile?: string | null;
  audioName?: string | null;
  duration: number;
  bpm?: number | null;
  beatOffset: number;
  latencyMs: number;
  tracks: ShowTrack[];
}

/**
 * A new id in the app's format (upper-case UUID). crypto.randomUUID only exists on secure pages (https
 * or localhost), and the website is usually opened over plain http on the LAN, so build one from
 * getRandomValues, which works everywhere.
 */
export const uuid = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;      // version 4
  b[8] = (b[8] & 0x3f) | 0x80;      // RFC 4122 variant
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const newTrack = (): ShowTrack => ({ id: uuid(), targets: [], together: false, muted: false, clips: [] });

export const newShow = (name: string): Show => ({
  id: uuid(), name, duration: 60, beatOffset: 0, latencyMs: 0, tracks: [newTrack()],
});

export const newClip = (start: number, duration: number, template?: Partial<ShowClip>): ShowClip => ({
  fx: 1, pal: 2, bri: 255, scl: 128, c1: 0xff0000, c2: 0x00a000, beats: 4, seconds: 2, dirYaw: null, dirPitch: null, text: null, media: null, target: null,
  ...template, id: uuid(), start, duration,
});

/** Fills in anything missing (older or hand-edited data) so the app can always read it back. */
export function normaliseShow(s: Partial<Show> & { id: UUID }): Show {
  return {
    id: s.id, name: s.name ?? 'Show', audioFile: s.audioFile ?? null, audioName: s.audioName ?? null,
    duration: s.duration ?? 60, bpm: s.bpm ?? null, beatOffset: s.beatOffset ?? 0, latencyMs: s.latencyMs ?? 0,
    tracks: (s.tracks ?? []).map(t => ({
      id: t.id ?? uuid(), targets: t.targets ?? [], together: t.together ?? false, muted: t.muted ?? false,
      clips: (t.clips ?? []).map(c => ({ ...newClip(c.start ?? 0, c.duration ?? 1), ...c })),
    })),
  };
}

export const clipCycle = (c: ShowClip, bpm?: number | null) =>
  c.beats != null && bpm != null && bpm > 0 ? c.beats * 60 / bpm : c.seconds;

/** One cycle takes 16777216 / rate ms on the controller. */
export const rateForCycle = (seconds: number) =>
  Math.min(Math.max(Math.round(16777216 / (Math.max(seconds, 0.001) * 1000)), 1), 65535);

export interface Segment {
  zone: number; t0: number; t1: number; p0: number;
  fx: number; pal: number; bri: number; scl: number; rate: number; c1: number; c2: number;
  mode: number; group: number[];
  dir: number[] | null;   // direction of travel (4096 == 1), null = effect default
  text?: string | null;   // online effects only (drawn by the server; not sent to the controllers)
  media?: string | null;
  target?: number | null;
}

const UNIT = [0, 0, 0, 2048, -2048, 4096, 2048];
const roundAway = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));
const ms = (s: number) => Math.max(0, roundAway(s * 1000));

/** A clip's direction vector, or null when it uses the effect's default. */
export const clipDir = (c: ShowClip) =>
  hasDirSetting(c.fx) && c.dirYaw != null && c.dirPitch != null ? dirVector(c.dirYaw, c.dirPitch) : null;

/** Port of ShowCompiler.compile (iOS app). */
export function compileShow(show: Show, plants: Plant[], zoneOf: (i: number) => number, otherZone: number,
                            groupFrame: (plants: UUID[]) => number[]): Segment[] {
  const frames = new Map<UUID, number[]>();
  for (const t of show.tracks) if (t.together) frames.set(t.id, groupFrame(t.targets));

  const seen = new Set<number>();
  const zones = [...plants.map((p, i) => ({ zone: zoneOf(i), plant: p.id as UUID | null })), { zone: otherZone, plant: null }]
    .filter(z => !seen.has(z.zone) && !!seen.add(z.zone))
    .sort((a, b) => a.zone - b.zone);

  const out: Segment[] = [];
  for (const { zone, plant } of zones) {
    const clips: { prio: number; clip: ShowClip; track: ShowTrack }[] = [];
    show.tracks.forEach((track, prio) => {
      if (track.muted) return;
      const plays = track.targets.length === 0 || (plant !== null && track.targets.includes(plant));
      if (!plays || (plant === null && track.targets.length > 0)) return;
      for (const c of track.clips) if (c.duration > 0.001) clips.push({ prio, clip: c, track });
    });
    if (!clips.length) continue;
    const times = [...new Set(clips.flatMap(c => [ms(c.clip.start), ms(c.clip.start + c.clip.duration)]))].sort((a, b) => a - b);
    for (let k = 0; k + 1 < times.length; k++) {
      const a = times[k], b = times[k + 1];
      if (b <= a) continue;
      let win: (typeof clips)[number] | undefined;
      for (const c of clips) {
        if (ms(c.clip.start) <= a && ms(c.clip.start + c.clip.duration) >= b) {
          if (!win || c.prio > win.prio || (c.prio === win.prio && c.clip.start > win.clip.start)) win = c;
        }
      }
      if (!win) continue;
      const c = win.clip;
      const seg: Segment = {
        zone, t0: a, t1: b, p0: ms(c.start), fx: c.fx, pal: c.pal, bri: c.bri, scl: c.scl,
        rate: rateForCycle(clipCycle(c, show.bpm)), c1: c.c1, c2: c.c2,
        mode: win.track.together ? 2 : 1, group: win.track.together ? frames.get(win.track.id) ?? UNIT : UNIT,
        dir: clipDir(c),
        ...(isOnlineFx(c.fx) ? { text: c.text ?? null, media: c.media ?? null, target: c.target ?? null } : {}),
      };
      const last = out[out.length - 1];
      if (last && last.zone === zone && last.t1 === a && last.p0 === seg.p0 && last.fx === seg.fx && last.pal === seg.pal &&
          last.bri === seg.bri && last.scl === seg.scl && last.rate === seg.rate && last.c1 === seg.c1 && last.c2 === seg.c2 &&
          last.mode === seg.mode && last.group.join() === seg.group.join() && String(last.dir) === String(seg.dir) &&
          last.text === seg.text && last.media === seg.media && last.target === seg.target) {
        last.t1 = b;
      } else {
        out.push(seg);
      }
    }
  }
  return out;
}

/** The segment showing on each zone at time `tMs` (as firmware/src/show.cpp picks it). */
export function activeSegments(segs: Segment[], tMs: number): Map<number, Segment> {
  const m = new Map<number, Segment>();
  if (tMs < 0) return m;
  for (const s of segs) if (s.t0 <= tMs && tMs < s.t1) m.set(s.zone, s);
  return m;
}

export const showsOf = (data: AppData) => (data.shows ?? []) as Show[];
