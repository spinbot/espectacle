// Canvas timeline for the show editor: ruler, waveform, beat grid, one lane per track, clips.
import type { Show, ShowClip, ShowTrack } from '../../shared/show.js';
import { newClip } from '../../shared/show.js';
import { PALETTES, fxInfo } from '../../shared/catalog.js';
import { ENVELOPE_RATE } from './audio.js';

export const RULER_H = 26, WAVE_H = 56, LANE_H = 54;
const HANDLE = 8;                 // px at a clip's right edge that resize instead of move

export interface Selection { track: string; clip?: string }

export interface TimelineHost {
  show(): Show;
  changed(): void;                // the show was edited (save + recompile)
  selected(sel: Selection | null): void;
  seek(t: number): void;
  playing(): boolean;
}

export class Timeline {
  readonly canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  pps = 60;                       // pixels per second
  scrollX = 0;                    // seconds at the left edge
  position = 0;
  snap = true;
  follow = true;
  envelope?: Float32Array;
  selection: Selection | null = null;
  template: Partial<ShowClip> = {};
  private drag?: {
    mode: 'move' | 'resize' | 'seek' | 'add';
    track: ShowTrack; clip?: ShowClip; x0: number; y0: number; start: number; duration: number; moved: boolean;
  };

  constructor(private host: TimelineHost, private holder: HTMLElement) {
    holder.appendChild(this.canvas);
    new ResizeObserver(() => this.draw()).observe(holder);
    this.canvas.addEventListener('pointerdown', e => this.down(e));
    this.canvas.addEventListener('pointermove', e => this.move(e));
    this.canvas.addEventListener('pointerup', e => this.up(e));
    this.canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
  }

  get width() { return this.holder.clientWidth; }
  get height() { return RULER_H + WAVE_H + this.host.show().tracks.length * LANE_H; }
  private x(t: number) { return (t - this.scrollX) * this.pps; }
  private t(x: number) { return this.scrollX + x / this.pps; }

  beat() { const b = this.host.show().bpm; return b && b > 0 ? 60 / b : null; }

  snapTime(t: number) {
    const s = this.host.show(), beat = this.beat();
    if (!this.snap) return Math.round(t * 20) / 20;
    if (beat) return s.beatOffset + Math.round((t - s.beatOffset) / beat) * beat;
    return Math.round(t * 4) / 4;
  }

  /** Page-turn following: scroll when the playhead nears the right edge or leaves the view. */
  setPosition(t: number) {
    this.position = t;
    if (this.follow && this.host.playing()) {
      const span = this.width / this.pps;
      if (t > this.scrollX + span * 0.9 || t < this.scrollX) this.scrollX = Math.max(0, t - span * 0.1);
    }
    this.draw();
  }

  zoom(factor: number, aroundX = this.width / 2) {
    const t = this.t(aroundX);
    this.pps = Math.min(400, Math.max(8, this.pps * factor));
    this.scrollX = Math.max(0, t - aroundX / this.pps);
    this.draw();
  }

  // ---------- drawing ----------

  draw() {
    const show = this.host.show();
    const dpr = window.devicePixelRatio || 1, w = this.width, h = this.height;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0d1320';
    g.fillRect(0, 0, w, h);
    const t0 = this.scrollX, t1 = this.t(w);

    // Beat grid (bars brighter) or seconds.
    const beat = this.beat();
    if (beat && beat * this.pps >= 4) {
      let k = Math.floor((t0 - show.beatOffset) / beat);
      for (let t = show.beatOffset + k * beat; t <= t1; t += beat, k++) {
        const bar = ((k % 4) + 4) % 4 === 0;
        g.fillStyle = bar ? 'rgba(148,163,184,0.35)' : 'rgba(148,163,184,0.14)';
        g.fillRect(Math.round(this.x(t)), RULER_H, bar ? 1 : 0.5, h - RULER_H);
      }
    } else {
      for (let t = Math.floor(t0); t <= t1; t++) {
        g.fillStyle = 'rgba(148,163,184,0.14)';
        g.fillRect(Math.round(this.x(t)), RULER_H, 0.5, h - RULER_H);
      }
    }

    // Ruler.
    g.fillStyle = '#111827';
    g.fillRect(0, 0, w, RULER_H);
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find(s => s * this.pps >= 64) ?? 300;
    g.font = '11px -apple-system, sans-serif';
    g.textBaseline = 'top';
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round(this.x(t));
      g.fillStyle = '#64748b';
      g.fillRect(x, RULER_H - 8, 1, 8);
      g.fillText(clock(t, true), x + 3, 4);
    }
    if (show.duration) {                       // end of the music
      g.fillStyle = 'rgba(248,113,113,0.5)';
      g.fillRect(Math.round(this.x(show.duration)), 0, 1, h);
    }

    // Waveform.
    const wy = RULER_H, mid = wy + WAVE_H / 2;
    g.fillStyle = 'rgba(30,41,59,0.6)';
    g.fillRect(0, wy, w, WAVE_H);
    if (this.envelope) {
      g.fillStyle = 'rgba(34,197,94,0.75)';
      const env = this.envelope;
      for (let x = 0; x < w; x += 2) {
        const a = Math.floor(this.t(x) * ENVELOPE_RATE), b = Math.max(a + 1, Math.floor(this.t(x + 2) * ENVELOPE_RATE));
        if (a < 0 || a >= env.length) continue;
        let v = 0;
        for (let i = a; i < Math.min(b, env.length); i++) v = Math.max(v, env[i]);
        const hh = Math.max(1, v * (WAVE_H - 8) / 2);
        g.fillRect(x, mid - hh, 1.5, hh * 2);
      }
    } else {
      g.fillStyle = '#64748b';
      g.fillText(show.audioFile ? 'Loading music…' : 'No music – choose some in the show settings', 10, wy + WAVE_H / 2 - 6);
    }

    // Lanes and clips.
    show.tracks.forEach((track, i) => {
      const y = RULER_H + WAVE_H + i * LANE_H;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.045)';
      g.fillRect(0, y, w, LANE_H);
      g.fillStyle = '#1f2937';
      g.fillRect(0, y + LANE_H - 1, w, 1);
      for (const c of track.clips) {
        const x0 = this.x(c.start), x1 = this.x(c.start + c.duration);
        if (x1 < 0 || x0 > w) continue;
        this.drawClip(c, x0, Math.max(x1, x0 + 6), y + 5, LANE_H - 10, track.muted,
          this.selection?.clip === c.id);
      }
      if (this.selection && !this.selection.clip && this.selection.track === track.id) {
        g.strokeStyle = 'rgba(34,197,94,0.6)';
        g.strokeRect(0.5, y + 0.5, w - 1, LANE_H - 2);
      }
    });

    // Playhead.
    g.fillStyle = '#ef4444';
    g.fillRect(Math.round(this.x(this.position)) - 1, 0, 2, h);
  }

  private drawClip(c: ShowClip, x0: number, x1: number, y: number, h: number, muted: boolean, selected: boolean) {
    const g = this.ctx;
    const cols = clipColours(c);
    const grad = g.createLinearGradient(x0, 0, x1, 0);
    cols.forEach((col, i) => grad.addColorStop(cols.length > 1 ? i / (cols.length - 1) : 0, col));
    g.globalAlpha = muted ? 0.35 : Math.max(0.35, c.bri / 255);
    g.fillStyle = grad;
    roundRect(g, x0, y, x1 - x0, h, 6);
    g.fill();
    g.globalAlpha = 1;
    g.lineWidth = selected ? 2.5 : 1;
    g.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.5)';
    roundRect(g, x0, y, x1 - x0, h, 6);
    g.stroke();
    if (x1 - x0 > 30) {
      g.save();
      g.beginPath();
      g.rect(x0, y, x1 - x0, h);
      g.clip();
      g.fillStyle = '#fff';
      g.shadowColor = '#000';
      g.shadowBlur = 3;
      g.font = '600 11px -apple-system, sans-serif';
      g.fillText(fxInfo(c.fx)?.name ?? '?', Math.max(x0, 0) + 5, y + 5);
      g.restore();
    }
    g.fillStyle = 'rgba(255,255,255,0.8)';               // resize grip
    g.fillRect(x1 - 5, y + h / 2 - 8, 2, 16);
  }

  // ---------- interaction ----------

  private hit(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const show = this.host.show();
    const lane = Math.floor((y - RULER_H - WAVE_H) / LANE_H);
    const track = y >= RULER_H + WAVE_H ? show.tracks[lane] : undefined;
    let clip: ShowClip | undefined, edge = false;
    if (track) {
      for (const c of track.clips) {
        const x0 = this.x(c.start), x1 = Math.max(this.x(c.start + c.duration), x0 + 6);
        if (x >= x0 && x <= x1) { clip = c; edge = x1 - x <= HANDLE; }
      }
    }
    return { x, y, track, clip, edge };
  }

  private down(e: PointerEvent) {
    const h = this.hit(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (h.y < RULER_H + WAVE_H) {
      this.drag = { mode: 'seek', track: undefined!, x0: h.x, y0: h.y, start: 0, duration: 0, moved: false };
      this.host.seek(Math.max(0, this.t(h.x)));
      return;
    }
    if (!h.track) return;
    if (h.clip) {
      this.select({ track: h.track.id, clip: h.clip.id });
      this.drag = { mode: h.edge ? 'resize' : 'move', track: h.track, clip: h.clip, x0: h.x, y0: h.y,
        start: h.clip.start, duration: h.clip.duration, moved: false };
    } else {
      this.drag = { mode: 'add', track: h.track, x0: h.x, y0: h.y, start: this.t(h.x), duration: 0, moved: false };
    }
  }

  private move(e: PointerEvent) {
    const h = this.hit(e);
    if (!this.drag) {
      this.canvas.style.cursor = h.clip ? (h.edge ? 'ew-resize' : 'grab') : h.y < RULER_H + WAVE_H ? 'pointer' : 'copy';
      return;
    }
    const d = this.drag;
    if (Math.abs(h.x - d.x0) > 3 || Math.abs(h.y - d.y0) > 3) d.moved = true;
    const dt = (h.x - d.x0) / this.pps;
    const beat = this.beat();
    if (d.mode === 'seek') {
      this.host.seek(Math.max(0, this.t(h.x)));
    } else if (d.mode === 'move' && d.clip && d.moved) {
      d.clip.start = Math.max(0, this.snapTime(d.start + dt));
      // Dragging up or down moves the clip to another track.
      const show = this.host.show();
      const lane = Math.floor((h.y - RULER_H - WAVE_H) / LANE_H);
      const target = show.tracks[lane];
      if (target && target !== d.track) {
        d.track.clips = d.track.clips.filter(c => c !== d.clip);
        target.clips.push(d.clip);
        d.track = target;
        this.selection = { track: target.id, clip: d.clip.id };
      }
      this.host.changed();
      this.draw();
    } else if (d.mode === 'resize' && d.clip) {
      const end = this.snapTime(d.start + d.duration + dt);
      d.clip.duration = Math.max((beat ?? 0.4) / 2, end - d.clip.start);
      this.host.changed();
      this.draw();
    }
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = undefined;
    this.canvas.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.mode === 'add' && !d.moved) {
      const beat = this.beat() ?? 0.5;
      const start = Math.max(0, this.snap ? this.snapTime(d.start - beat / 2) : d.start);
      const clip = newClip(start, beat * 4, this.template);
      d.track.clips.push(clip);
      d.track.clips.sort((a, b) => a.start - b.start);
      this.select({ track: d.track.id, clip: clip.id });
      this.host.changed();
    } else if (d.mode === 'add') {
      this.select({ track: d.track.id });
    } else if (d.clip) {
      d.track.clips.sort((a, b) => a.start - b.start);
    }
    this.draw();
  }

  private wheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {                       // trackpad pinch / ctrl+wheel: zoom
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.zoom(Math.exp(-e.deltaY * 0.01), e.clientX - r.left);
      return;
    }
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    if (Math.abs(dx) > 0) {
      e.preventDefault();
      this.scrollX = Math.max(0, this.scrollX + dx / this.pps);
      this.draw();
    }
  }

  select(sel: Selection | null) {
    this.selection = sel;
    this.host.selected(sel);
    this.draw();
  }
}

export function clipColours(c: ShowClip): string[] {
  const fx = fxInfo(c.fx);
  let hex: number[];
  if (c.fx === 11) hex = PALETTES[4].colors;
  else if (fx?.usesPalette && c.pal !== 0) hex = PALETTES[c.pal]?.colors ?? [c.c1];
  else if (fx?.usesColor2 || (fx?.usesPalette && c.pal === 0)) hex = [c.c1, c.c2];
  else hex = [c.c1];
  return hex.map(v => '#' + (v & 0xffffff).toString(16).padStart(6, '0'));
}

export function clock(t: number, short = false) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return short ? `${m}:${String(Math.floor(s)).padStart(2, '0')}` : `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}
