// Streams the online effects (marquee, video...) to the controllers' online layer with DDP (destination
// 2, see firmware/src/ddp.cpp), about 30 times a second, while the normal look or a playing show uses
// one. The controllers only show the layer on LEDs whose current effect is an online one.
import dgram from 'dgram';
import { env } from './env.js';
import type { AppData, LightState } from '../shared/project.js';
import { computeLayout, yardFront, zoneOfPlantAt } from '../shared/layout.js';
import { compileShow, normaliseShow, showsOf, type Segment, type Show } from '../shared/show.js';
import { fxInfo } from '../shared/catalog.js';
import { FX_MARQUEE, isOnlineFx } from '../shared/online.js';
import { OnlineFrame, lookSource, showSources, type OnlineSource } from '../shared/onlineframe.js';
import type { Media } from './media.js';

const DDP_PORT = 4048;
const FPS = 30;
const OTHER_ZONE = 31;

export class Streamer {
  private frame = new OnlineFrame();
  private socket = dgram.createSocket('udp4');
  private layoutFor?: AppData;
  private live: LightState | null = null;
  private show: { show: Show; t0: number; segs: Segment[]; data?: AppData } | null = null;
  private seq = 0;
  private timer?: NodeJS.Timeout;
  private msg: { text: string; until: number; color: number; scale: number; plants: string[]; started: number } | null = null;

  constructor(private project: () => AppData, private media: Media, private timeZone: () => string = () => 'UTC') {}

  /**
   * Shows a message over everything (even with the lights off) on some plants for a while: scrolling
   * text on a dark background, sent to the controllers' overlay (DDP destination 3, firmware 1.9+).
   * No plants: every plant.
   */
  showMessage(text: string, seconds: number, color: number, plants: string[], scale = 128) {
    const now = Date.now();
    this.msg = text.trim() ? { text: text.trim(), until: now + Math.max(1, seconds) * 1000, color, scale, plants, started: now } : null;
  }

  clearMessage() { this.msg = null; }

  get message() { return this.msg && this.msg.until > Date.now() ? { text: this.msg.text, until: this.msg.until } : null; }

  async init() {
    this.frame = new OnlineFrame();
    this.socket.on('error', e => console.error('streamer:', e.message));
    this.live = this.project().state ?? null;     // the last saved look, until someone sends a new one
    this.timer = setInterval(() => this.tick(), 1000 / FPS);
  }

  stop() { clearInterval(this.timer); }

  /** The normal look shown on the lights (website "show on the real lights", or the app). */
  setLive(state: LightState) { this.live = state; }

  /** A show started at wall-clock `t0` (ms) on the controllers: stream its online clips. */
  playShow(show: Show, t0: number) {
    this.show = { show: normaliseShow(show), t0, segs: [] };
  }

  /** By id from the project (the app tells the server when it plays a show). */
  playShowById(id: string, t0: number): boolean {
    const s = showsOf(this.project()).find(x => x.id === id);
    if (!s) return false;
    this.playShow(s, t0);
    return true;
  }

  stopShow() { this.show = null; }

  private projected = 0;
  /**
   * A frame drawn somewhere else (the website's show editor) for one controller: sent as DDP to
   * destination 1, which takes the controller over completely, like xLights. It goes back to its own
   * look 2.5 s after the frames stop.
   */
  projectFrame(host: string, rgb: Uint8Array) {
    this.projected = Date.now();
    this.send(host, rgb, 1);
  }

  status() {
    return {
      ready: true,
      look: this.live && isOnlineFx(this.live.fx) && this.live.on !== false ? fxInfo(this.live.fx)?.name ?? null : null,
      message: this.message,
      show: this.show ? { id: this.show.show.id, name: this.show.show.name, t0: this.show.t0 } : null,
      projecting: Date.now() - this.projected < 2500,
    };
  }

  private sources(data: AppData, now: number): OnlineSource[] {
    if (this.show) {
      const t = now - this.show.t0;
      if (t > this.show.show.duration * 1000 + 2000) { this.show = null; return this.sources(data, now); }
      if (this.show.data !== data) {         // compile (again after any change to the project)
        const layout = computeLayout(data);
        this.show.segs = compileShow(this.show.show, data.plants, zoneOfPlantAt, OTHER_ZONE, layout.groupFrame);
        this.show.data = data;
      }
      return t >= 0 ? showSources(this.show.segs, t, now, this.timeZone()) : [];
    }
    const look = lookSource(this.live, now, this.timeZone());
    return look ? [look] : [];
  }

  private tick() {
    const data = this.project();
    const now = Date.now();
    const sources = this.sources(data, now);
    if (this.msg && this.msg.until <= now) this.msg = null;
    if (!sources.length && !this.msg) return;
    if (this.layoutFor !== data) {
      const layout = computeLayout(data);
      this.frame.setLayout(layout, yardFront(data));
      this.layoutFor = data;
    }
    if (sources.length) {
      const { rgb } = this.frame.render(sources, name => this.media.peek(name));
      data.controllers.forEach((c, ci) => { const buf = rgb[ci]; if (buf) this.send(c.host, buf, 2); });
    }
    if (this.msg) {
      // The message's plants, each with its own picture (from the street); the rest see-through.
      const index = new Map(data.plants.map((p, i) => [p.id, i]));
      const ids = this.msg.plants.length ? this.msg.plants.filter(id => index.has(id)) : data.plants.map(p => p.id);
      const srcs: OnlineSource[] = ids.map(id => ({
        params: { fx: FX_MARQUEE, pal: 0, c1: this.msg!.color, c2: 0, scl: this.msg!.scale, rate: 4128, text: this.msg!.text },
        mode: 1, group: [0, 0, 0, 2048, -2048, 4096, 2048], dir: null, ms: now - this.msg!.started,
        zones: new Set([zoneOfPlantAt(index.get(id)!)]),
      }));
      const { rgb, mask } = this.frame.render(srcs, () => null);
      data.controllers.forEach((c, ci) => {
        const buf = rgb[ci], m = mask[ci];
        if (!buf || !m) return;
        for (let i = 0; i < m.length; i++) {
          if (m[i] && !(buf[i * 3] | buf[i * 3 + 1] | buf[i * 3 + 2])) buf.fill(1, i * 3, i * 3 + 3);   // dark, not see-through
        }
        this.send(c.host, buf, 3);
      });
    }
  }

  /** DDP to destination 1 (takeover), 2 (the online layer) or 3 (the overlay), 480 LEDs per packet, PUSH on the last. */
  private send(host: string, rgb: Uint8Array, dest: number) {
    const addr = host.replace(/:\d+$/, '');
    const port = Number(env('DDP_PORT') ?? DDP_PORT);
    const chunk = 1440;
    this.seq = (this.seq % 15) + 1;
    for (let off = 0; off < rgb.length; off += chunk) {
      const len = Math.min(chunk, rgb.length - off);
      const last = off + len >= rgb.length;
      const p = Buffer.alloc(10 + len);
      p[0] = 0x40 | (last ? 0x01 : 0);
      p[1] = this.seq;
      p[2] = 0x0b;                 // RGB, 8 bits per channel
      p[3] = dest;
      p.writeUInt32BE(off, 4);
      p.writeUInt16BE(len, 8);
      Buffer.from(rgb.buffer, rgb.byteOffset + off, len).copy(p, 10);
      this.socket.send(p, port, addr);
    }
  }
}
