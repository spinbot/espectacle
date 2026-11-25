// The things outside systems (Home Assistant over MQTT or REST) can ask for: change the look, show a
// message, play or stop a show, turn the schedules on or off, and read what's happening.
import type { LightState } from '../shared/project.js';
import { ALL_EFFECTS, PALETTES, fxInfo } from '../shared/catalog.js';
import { showsOf } from '../shared/show.js';
import type { Storage } from './storage.js';
import type { Controllers } from './controllers.js';
import type { Scheduler } from './scheduler.js';
import type { Streamer } from './streamer.js';
import type { Settings } from './settings.js';

export interface LookUpdate {
  on?: boolean;
  bri?: number;                       // 0..255
  effect?: string | number;           // name ("Spiral") or id
  pal?: number | string;              // palette id or name
  rgb?: [number, number, number];     // colour 1 (also switches to the Custom palette for palette effects)
  spd?: number; scl?: number;
  text?: string; media?: string; target?: number | null;
}

export class Actions {
  private listeners: (() => void)[] = [];

  constructor(private storage: Storage, private controllers: Controllers, private scheduler: Scheduler,
              private streamer: Streamer, private settings: Settings, private announce: () => void) {}

  /** Called after anything changes (so Home Assistant gets the new state). */
  onChange(f: () => void) { this.listeners.push(f); }
  changed() { for (const l of this.listeners) l(); }

  get effectNames() { return ALL_EFFECTS.map(e => e.name); }

  state() {
    const d = this.storage.get().data;
    const s = d.state;
    const st = this.scheduler.status();
    const playing = st.show ? st.show.name : null;
    return {
      on: s.on !== false,
      bri: s.bri,
      effect: fxInfo(s.fx)?.name ?? String(s.fx),
      rgb: [(s.c1 >> 16) & 255, (s.c1 >> 8) & 255, s.c1 & 255] as [number, number, number],
      text: s.text ?? null,
      show: playing,
      showManual: !!st.manual,
      schedule: st.active?.name ?? null,
      schedules: st.enabled,
      message: this.streamer.message?.text ?? null,
      shows: showsOf(d).map(x => x.name),
    };
  }

  /** Changes the normal look: saved to the project (the app and website follow) and sent to the lights. */
  async setLook(u: LookUpdate) {
    const env = this.storage.get();
    const data = structuredClone(env.data);
    const s: LightState = { ...data.state };
    if (u.on !== undefined) s.on = !!u.on;
    if (u.bri !== undefined) s.bri = clamp(Math.round(u.bri), 0, 255);
    if (u.effect !== undefined) {
      const e = typeof u.effect === 'number' ? fxInfo(u.effect)
        : ALL_EFFECTS.find(x => x.name.toLowerCase() === String(u.effect).trim().toLowerCase());
      if (!e) throw new Error(`unknown effect "${u.effect}"`);
      s.fx = e.id;
    }
    if (u.pal !== undefined) {
      const p = typeof u.pal === 'number' ? PALETTES[u.pal] : PALETTES.find(x => x.name.toLowerCase() === String(u.pal).toLowerCase());
      if (p) s.pal = p.id;
    }
    if (u.rgb) {
      s.c1 = ((u.rgb[0] & 255) << 16) | ((u.rgb[1] & 255) << 8) | (u.rgb[2] & 255);
      if (fxInfo(s.fx)?.usesPalette) s.pal = 0;
    }
    if (u.spd !== undefined) s.spd = clamp(Math.round(u.spd), 0, 255);
    if (u.scl !== undefined) s.scl = clamp(Math.round(u.scl), 0, 255);
    if (u.text !== undefined) s.text = u.text;
    if (u.media !== undefined) s.media = u.media;
    if (u.target !== undefined) s.target = u.target;
    if (s.on) s.bri = s.bri || 128;
    data.state = s;
    const saved = await this.storage.put(data, env.revision, true);
    if (saved) this.announce();
    this.streamer.setLive(s);
    await this.controllers.setState(s);
    this.changed();
    return this.state();
  }

  /** Scrolls a message over the chosen plants (Settings → Home Assistant) for a while. */
  message(text: string, seconds?: number, rgb?: [number, number, number]) {
    const m = this.settings.get().messages;
    const color = rgb ? ((rgb[0] & 255) << 16) | ((rgb[1] & 255) << 8) | (rgb[2] & 255) : m.color;
    this.streamer.showMessage(String(text ?? ''), seconds ?? m.seconds, color, m.plants, m.scale);
    this.changed();
    setTimeout(() => this.changed(), (seconds ?? m.seconds) * 1000 + 500);
    return this.state();
  }

  clearMessage() { this.streamer.clearMessage(); this.changed(); return this.state(); }

  /** Plays a show (by name or id) once, lights only. */
  async playShow(nameOrId: string) {
    const shows = showsOf(this.storage.get().data);
    const key = String(nameOrId).trim().toLowerCase();
    const show = shows.find(x => x.id.toLowerCase() === key) ?? shows.find(x => x.name.toLowerCase() === key);
    if (!show) throw new Error(`no show called "${nameOrId}"`);
    await this.scheduler.playNow(show.id);
    this.changed();
    setTimeout(() => this.changed(), show.duration * 1000 + 3000);
    return this.state();
  }

  async stopShow() { await this.scheduler.stopNow(); this.changed(); return this.state(); }

  async setSchedules(enabled: boolean) {
    const env = this.storage.get();
    const data = structuredClone(env.data);
    data.schedule = { enabled: true, timeZone: this.settings.get().timeZone, items: [], ...(data.schedule ?? {}) };
    data.schedule.enabled = !!enabled;
    if (await this.storage.put(data, env.revision, true)) this.announce();
    this.scheduler.poke();
    this.changed();
    return this.state();
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
