// Runs the schedules (shared/schedule.ts): during a schedule's window, plays its shows on the real lights
// one after another, looping; when the window ends, turns the lights off or back to the normal look.
// Does what the app's ShowPlayer does (geometry, compile, upload, start every controller at the same
// moment), but lights only: no music.
import type { AppData } from '../shared/project.js';
import { computeLayout, zoneOfPlantAt, type Layout } from '../shared/layout.js';
import { compileShow, normaliseShow, showsOf, type Show, type Segment } from '../shared/show.js';
import { activeSchedule, nextStart, type Schedule, type ScheduleStatus } from '../shared/schedule.js';
import { Controllers, request } from './controllers.js';
import type { Streamer } from './streamer.js';

const OTHER_ZONE = 31;
const LEAD_MS = 1200;          // start shows this far ahead, so every controller is ready
const GAP_MS = 300;             // pause between shows

/** Same hash as the app's FNV1a (each Int as 8 little-endian bytes). */
function fnv(values: Iterable<number>): number {
  let h = 2166136261;
  for (const v of values) {
    let x = BigInt.asUintN(64, BigInt(Math.trunc(v)));
    for (let i = 0; i < 8; i++) {
      h = Math.imul((h ^ Number(x & 0xffn)) >>> 0, 16777619) >>> 0;
      x >>= 8n;
    }
  }
  return Math.max(h >>> 0, 1);
}

const fwAtLeast = (fw: unknown, major: number, minor: number) => {
  const v = String(fw ?? '0').split('.').map(Number).concat([0, 0]);
  return v[0] > major || (v[0] === major && v[1] >= minor);
};

/** Segment as the firmware's integers: 19, or 23 with the direction (ShowCompiler.Segment.ints). */
function segmentInts(s: Segment, withDir: boolean): number[] {
  const base = [s.zone, s.t0, s.t1, s.p0, s.fx, s.pal, s.bri, s.scl, s.rate, s.c1, s.c2, s.mode, ...s.group];
  return withDir ? base.concat(s.dir ? [1, ...s.dir] : [0, 0, 0, 0]) : base;
}

export class Scheduler {
  private showTimer?: NodeJS.Timeout;
  private busy = false;
  private activeId: string | null = null;
  private current: { show: Show; id: number; ints: number[][]; per: number; t0: number; endsAt: number } | null = null;
  private pausedId: string | null = null;      // "stop for now": this window stays off until it ends
  private manual: Show | null = null;          // a show started by hand (Home Assistant, API): plays once
  private online = new Set<string>();
  private message: string | null = null;
  private nextCache: { minute: number; value: ScheduleStatus['next'] } = { minute: -1, value: null };

  constructor(private project: () => AppData, private controllers: Controllers, private streamer?: Streamer) {}

  start() {
    setInterval(() => this.tick().catch(e => console.error('scheduler:', e)), 5000);
    setTimeout(() => this.tick().catch(() => {}), 3000);
  }

  status(): ScheduleStatus {
    const settings = this.project().schedule;
    const active = this.activeId ? settings?.items.find(s => s.id === this.activeId) : null;
    const minute = Math.floor(Date.now() / 60000);
    if (this.nextCache.minute !== minute) {
      const n = nextStart(settings, new Date());
      this.nextCache = { minute, value: n ? { id: n.schedule.id, name: n.schedule.name, at: n.at.getTime() } : null };
    }
    return {
      enabled: !!settings?.enabled,
      active: active ? { id: active.id, name: active.name } : null,
      show: this.current ? { id: this.current.show.id, name: this.current.show.name, startedAt: this.current.t0, endsAt: this.current.endsAt } : null,
      manual: !!this.manual,
      next: this.nextCache.value,
      pausedUntilEnd: !!this.pausedId && this.pausedId === activeSchedule(settings, new Date())?.id,
      message: this.message,
    };
  }

  /** Stops the running schedule until its window ends (the next window starts as normal). */
  async pause() {
    const s = activeSchedule(this.project().schedule, new Date());
    if (!s) return;
    this.pausedId = s.id;
    await this.finish(s);
  }

  /** Starts the current window again after a pause. */
  async resume() {
    this.pausedId = null;
    await this.tick();
  }

  /** Something changed (a save): re-check now rather than within 5 s. */
  poke() { this.tick().catch(() => {}); }

  private geoTimer?: NodeJS.Timeout;
  /**
   * After the project changes (e.g. LED positions edited on the website), sends the new geometry to the
   * controllers that are online and hold an older copy, so their own effects use it. Debounced.
   */
  syncGeometry() {
    clearTimeout(this.geoTimer);
    this.geoTimer = setTimeout(async () => {
      const data = this.project();
      const layout = computeLayout(data);
      for (const c of data.controllers) {
        if (!this.controllers.status.has(c.id)) continue;
        try { await this.sendGeometry(c.id, c.host, layout); } catch (e) { console.error(`geometry: ${c.name}:`, (e as Error).message); }
      }
    }, 2000);
  }

  /** Plays one show now (lights only), then goes back to the schedule or the normal look. */
  async playNow(showId: string): Promise<boolean> {
    const show = showsOf(this.project()).find(x => x.id === showId);
    if (!show) return false;
    await this.waitIdle();
    this.busy = true;
    try {
      clearTimeout(this.showTimer);
      this.manual = show;
      this.current = null;
      const cur = await this.startShow(normaliseShow(show));
      const ends = cur ? cur.endsAt : Date.now() + 1000;
      this.showTimer = setTimeout(() => { void this.manualEnded(); }, ends - Date.now() + GAP_MS);
    } finally {
      this.busy = false;
    }
    return true;
  }

  /** Stops a show started by hand (or the running schedule's show, until its window ends). */
  async stopNow() {
    if (this.manual) { await this.manualEnded(); return; }
    if (this.activeId) await this.pause();
  }

  private async manualEnded() {
    clearTimeout(this.showTimer);
    this.manual = null;
    this.current = null;
    this.streamer?.stopShow();
    const data = this.project();
    if (activeSchedule(data.schedule, new Date())) { this.activeId = null; await this.tick(); return; }
    await Promise.allSettled(data.controllers.map(c => request(c.host, 'POST', '/api/state', { ...data.state, t: Date.now() })));
  }

  private async waitIdle() {
    for (let i = 0; i < 100 && this.busy; i++) await new Promise(r => setTimeout(r, 100));
  }

  private async tick() {
    if (this.busy || this.manual) return;
    this.busy = true;
    try {
      const data = this.project();
      const now = new Date();
      let s = activeSchedule(data.schedule, now);
      if (this.pausedId && s?.id !== this.pausedId) this.pausedId = null;     // that window is over
      if (s && s.id === this.pausedId) s = null;

      if (!s) {
        if (this.activeId) {
          const old = data.schedule?.items.find(x => x.id === this.activeId);
          await this.finish(old ?? null);
        }
        return;
      }
      if (s.id !== this.activeId) {
        this.activeId = s.id;
        this.current = null;
        console.log(`scheduler: "${s.name}" started`);
        await this.next(s);
        return;
      }
      if (!this.current) { await this.next(s); return; }

      // Controllers that have come back (e.g. after a power cut) join the show where it is.
      const back = data.controllers.filter(c => this.controllers.status.has(c.id) && !this.online.has(c.id));
      this.online = new Set(data.controllers.filter(c => this.controllers.status.has(c.id)).map(c => c.id));
      if (back.length && this.current.endsAt - Date.now() > 3000) {
        const layout = computeLayout(data);
        for (const c of back) {
          try {
            await this.sendGeometry(c.id, c.host, layout);
            await this.load(c.id, c.host, this.current);
            await this.play(c.host, this.current.id, this.current.t0);
          } catch (e) { console.error(`scheduler: ${c.name}:`, e); }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** The window has ended (or was paused): lights off or back to the normal look. */
  private async finish(s: Schedule | null) {
    if (this.current) this.streamer?.stopShow();
    clearTimeout(this.showTimer);
    const was = this.activeId;
    this.activeId = null;
    this.current = null;
    this.message = null;
    if (!was && !s) return;
    const data = this.project();
    console.log(`scheduler: "${s?.name ?? 'schedule'}" ended`);
    await Promise.allSettled(data.controllers.map(c => s?.after === 'look'
      ? request(c.host, 'POST', '/api/state', { ...data.state, t: Date.now() })
      : request(c.host, 'POST', '/api/show/stop?dark=1')));
  }

  /** Plays the schedule's next show (after the current one, looping). */
  private async next(s: Schedule) {
    clearTimeout(this.showTimer);
    const data = this.project();
    const shows = showsOf(data);
    const list = s.shows.map(id => shows.find(x => x.id === id)).filter((x): x is Show => !!x && x.duration > 0);
    if (!list.length) { this.message = 'None of this schedule\'s shows exist any more.'; return; }
    const at = this.current ? list.findIndex(x => x.id === this.current!.show.id) : -1;
    const show = normaliseShow(list[(at + 1) % list.length]);
    const cur = await this.startShow(show);
    const ends = cur ? cur.endsAt : Date.now() + 5000;
    this.showTimer = setTimeout(() => this.advance(s.id), ends - Date.now() + GAP_MS);
  }

  /** Compiles, loads and starts one show on every ready controller (lights only). */
  private async startShow(show: Show) {
    const data = this.project();
    const layout = computeLayout(data);
    const segs = compileShow(show, data.plants, zoneOfPlantAt, OTHER_ZONE, layout.groupFrame);
    if (!segs.length) {
      this.message = `"${show.name}" is empty.`;
      this.current = { show, id: 0, ints: [], per: 19, t0: Date.now(), endsAt: Date.now() + 5000 };
      return this.current;
    }
    const withDir = segs.some(x => x.dir);
    const ints = segs.map(x => segmentInts(x, withDir));
    const id = fnv(ints.flat());
    const needs = segs.some(x => x.fx >= 200) ? [1, 8] : segs.some(x => x.fx >= 19) ? [1, 7] : withDir || segs.some(x => x.fx >= 15) ? [1, 6] : [1, 3];

    const online = data.controllers.filter(c => this.controllers.status.has(c.id));
    this.online = new Set(online.map(c => c.id));
    const old = online.filter(c => !fwAtLeast(this.controllers.status.get(c.id)?.fw, needs[0], needs[1]));
    this.message = old.length ? `${old.map(c => c.name).join(', ')} need${old.length === 1 ? 's' : ''} firmware ${needs.join('.')} or later for "${show.name}".` : null;
    const ready = online.filter(c => !old.includes(c));

    const cur = { show, id, ints, per: withDir ? 23 : 19, t0: 0, endsAt: 0 };
    await Promise.allSettled(ready.map(async c => {
      await this.sendGeometry(c.id, c.host, layout);
      await this.load(c.id, c.host, cur);
    }));
    cur.t0 = Date.now() + LEAD_MS;
    cur.endsAt = cur.t0 + show.duration * 1000;
    this.current = cur;
    this.streamer?.playShow(show, cur.t0);       // its online clips (marquee, video)
    await Promise.allSettled(ready.map(c => this.play(c.host, id, cur.t0)));
    console.log(`scheduler: playing "${show.name}" (${Math.round(show.duration)} s) on ${ready.length} controller(s)`);
    return cur;
  }

  private async advance(scheduleId: string) {
    if (this.activeId !== scheduleId) return;
    const s = this.project().schedule?.items.find(x => x.id === scheduleId);
    if (!s || this.busy) { this.showTimer = setTimeout(() => this.advance(scheduleId), 1000); return; }
    this.busy = true;
    try { await this.next(s); } catch (e) { console.error('scheduler:', e); } finally { this.busy = false; }
  }

  /** Uploads the show's segments unless the controller already holds it. */
  private async load(cid: string, host: string, cur: { id: number; ints: number[][]; per: number }) {
    if (this.controllers.status.get(cid)?.showId === cur.id) return;
    for (let offset = 0; offset < cur.ints.length; offset += 50) {
      const end = Math.min(offset + 50, cur.ints.length);
      const q = new URLSearchParams({ offset: String(offset), total: String(cur.ints.length), id: String(cur.id) });
      if (end === cur.ints.length) q.set('final', '1');
      if (cur.per === 23) q.set('per', '23');
      await request(host, 'POST', `/api/show?${q}`, { s: cur.ints.slice(offset, end).flat() }, 8000);
    }
  }

  /** Starts the loaded show so that show time 0 is at wall-clock `t0` (measured against its uptime clock). */
  private async play(host: string, id: number, t0: number) {
    const a = Date.now();
    const r = await request(host, 'GET', '/api/time', undefined, 2000) as { up: number };
    const b = Date.now();
    const start = Math.round(r.up + (t0 - (a + b) / 2));
    await request(host, 'POST', '/api/show/play', { id, start }, 2000);
  }

  /** Sends the LED geometry (as the app does) when the controller's copy is out of date. */
  private async sendGeometry(cid: string, host: string, layout: Layout) {
    const g = layout.controllers.find(x => x.id === cid);
    if (!g || !g.geo.length) return;
    const id = fnv([g.base, ...g.geo.flat(), ...layout.zoneFrames]);
    if (this.controllers.status.get(cid)?.geoId === id) return;
    for (let offset = 0; offset < g.geo.length; offset += 60) {
      const end = Math.min(offset + 60, g.geo.length);
      const q = new URLSearchParams({ offset: String(offset), total: String(g.geo.length) });
      const body: Record<string, unknown> = { g8: g.geo.slice(offset, end).flat() };
      if (end === g.geo.length) {
        q.set('final', '1'); q.set('base', String(g.base)); q.set('id', String(id));
        body.zf = layout.zoneFrames;
      }
      await request(host, 'POST', `/api/positions?${q}`, body, 8000);
    }
    const st = this.controllers.status.get(cid);
    if (st) st.geoId = id;                     // until the next poll says so
  }
}
