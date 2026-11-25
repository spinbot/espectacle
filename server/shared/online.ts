// Online effects: drawn by the server (and previewed by the website) rather than the controllers, then
// streamed to the controllers' "online layer" with DDP (see ddp.cpp). Each one draws a flat picture as
// seen from the camera, like the 2D effects: LEDs come in with their place in the picture (across, up).
import { PALETTES } from './catalog.js';

export const ONLINE_FIRST = 200;
export const FX_MARQUEE = 200, FX_VIDEO = 201, FX_COUNTDOWN = 202;
export const isOnlineFx = (fx: number) => fx >= ONLINE_FIRST && fx <= 209;

/** Decoded video, ready to sample: `count` frames of w x h RGB. */
export interface MediaFrames { w: number; h: number; fps: number; count: number; data: Uint8Array }

export interface OnlineParams {
  fx: number; pal: number; c1: number; c2: number; scl: number; rate: number;
  text?: string | null;    // marquee
  media?: string | null;   // video file name
  target?: number | null;  // countdown: wall-clock ms to count down to (null: next Christmas)
  now?: number;            // countdown: the wall clock now (ms)
  timeZone?: string;       // countdown: where "Christmas morning" is
}

/** Epoch ms of a wall-clock time in an IANA time zone. */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 2; i++) {
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(t);
    } catch { return want; }
    const g = (k: string) => Number(parts.find(p => p.type === k)?.value ?? 0);
    const seen = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
    t += want - seen;
  }
  return t;
}

/** Midnight at the start of the next Christmas Day (still this year's during Christmas Day). */
export function nextChristmas(now: number, timeZone: string): number {
  const y = Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(now));
  const t = zonedTime(y, 12, 25, 0, 0, timeZone);
  return now >= t + 86400000 ? zonedTime(y + 1, 12, 25, 0, 0, timeZone) : t;
}

/** "24 DAYS", "05:12:09" on the last day, then the message (default "MERRY CHRISTMAS"). */
export function countdownText(target: number, now: number, after?: string | null): string {
  const ms = target - now;
  if (ms <= 0) return after?.length ? after : 'MERRY CHRISTMAS';
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days} DAY${days === 1 ? '' : 'S'}`;
  const s = Math.floor(ms / 1000), two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

// 10-row bitmap font for ASCII 32..126: widths, then each column as a bit mask (bit 0 = top row).
const FONT: { w: number[]; c: number[] } = {"w":[4,3,4,6,6,6,6,4,4,4,5,6,4,6,3,5,6,7,6,6,7,6,6,6,6,6,3,4,5,5,5,6,7,7,6,6,6,6,6,6,7,5,6,7,6,6,7,6,6,6,7,6,6,7,7,7,7,7,6,4,5,4,6,7,4,7,6,6,7,6,6,7,6,7,5,7,7,6,6,6,6,7,7,7,7,7,6,7,7,7,6,5,2,5,6],"c":[0,0,0,0,188,188,0,28,0,28,0,72,510,72,510,72,0,204,222,411,250,118,0,78,42,254,168,228,0,232,188,244,228,160,0,8,6,2,0,120,252,258,0,258,252,120,0,20,12,14,20,0,16,16,124,16,16,0,512,384,128,0,16,16,16,16,16,0,128,128,0,384,96,24,6,0,124,254,130,254,124,0,132,132,254,254,128,128,0,196,230,178,222,204,0,68,214,146,254,108,0,48,56,36,254,254,32,0,222,158,138,250,114,0,124,254,146,246,100,0,6,198,242,62,14,0,108,254,146,254,108,0,76,222,146,254,124,0,144,144,0,512,400,144,0,16,56,108,68,0,40,40,40,40,0,68,108,56,16,0,8,164,180,28,8,0,252,390,306,330,124,64,0,228,252,44,252,224,128,0,252,252,148,252,104,0,120,252,132,204,76,0,252,252,132,252,120,0,252,252,148,212,196,0,252,252,148,20,4,0,120,252,164,236,232,0,252,252,16,252,252,132,0,132,252,252,132,0,224,132,252,124,4,0,252,252,176,108,196,128,0,252,252,132,192,192,0,252,56,224,56,252,0,252,252,24,100,252,4,0,120,252,132,252,120,0,252,252,164,60,24,0,120,252,132,508,376,0,252,252,164,124,216,128,0,216,156,180,244,108,0,132,252,252,132,12,0,124,252,128,252,124,4,0,12,124,224,124,12,4,0,60,224,124,224,60,4,0,132,204,120,120,204,132,0,12,156,240,240,156,12,0,204,236,180,220,204,0,510,510,258,0,6,24,96,384,0,258,510,510,0,8,12,6,12,8,0,512,512,512,512,512,512,0,2,6,8,0,208,248,168,248,240,128,0,254,254,136,248,112,0,112,248,136,216,80,0,112,248,138,254,254,128,0,112,248,168,184,176,0,136,252,254,138,138,0,624,760,648,1008,504,8,0,254,254,8,248,240,0,136,136,250,250,128,128,0,520,520,1018,506,0,254,254,112,216,136,128,0,130,130,254,254,128,128,0,248,24,248,24,240,0,248,240,8,248,240,0,112,248,136,248,112,0,1016,1016,648,248,112,0,112,248,648,1008,1016,520,0,136,248,240,152,8,24,0,144,184,184,232,232,64,0,8,126,254,136,200,64,0,120,248,128,248,248,128,0,24,120,224,120,24,0,56,224,120,224,120,8,0,136,216,120,240,216,136,0,568,1016,384,248,56,8,0,216,232,184,216,200,0,16,252,494,258,0,508,0,258,494,252,16,0,16,8,24,16,8,0]};
const FONT_START: number[] = [];
{ let n = 0; for (const w of FONT.w) { FONT_START.push(n); n += w; } }
const BASE_TOP = 1, BASE_ROWS = 8;   // capitals, digits and most of the descenders: fitted to the LEDs

const textCache = new Map<string, Uint16Array>();
/** The text as font columns, with a gap so it can loop. */
function textColumns(text: string): Uint16Array {
  let cols = textCache.get(text);
  if (cols) return cols;
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const i = code >= 32 && code <= 126 ? code - 32 : '?'.charCodeAt(0) - 32;
    for (let k = 0; k < FONT.w[i]; k++) out.push(FONT.c[FONT_START[i] + k]);
  }
  for (let k = 0; k < 8; k++) out.push(0);
  cols = Uint16Array.from(out);
  if (textCache.size > 50) textCache.clear();
  textCache.set(text, cols);
  return cols;
}

/** Palette colour at idx (0..255), as the firmware's palColor does it. */
export function palColor(pal: number, c1: number, c2: number, idx: number): number {
  const cols = pal === 0 ? [c1, c2] : PALETTES[pal]?.colors ?? [0xffffff];
  const pos = (idx & 255) * cols.length / 256;
  const k = Math.floor(pos), f = pos - k;
  const a = cols[k % cols.length], b = cols[(k + 1) % cols.length];
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Draws one online effect for `n` LEDs that share a picture. `pts` holds across/up pairs (about
 * +-2048); `ms` is the time since the effect started. Writes RGB (3 bytes per LED) into `out`.
 */
export function renderOnline(p: OnlineParams, ms: number, pts: ArrayLike<number>, n: number, out: Uint8Array, media?: MediaFrames | null) {
  out.fill(0, 0, n * 3);
  if (!n) return;
  let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i * 2], b = pts[i * 2 + 1];
    if (a < amin) amin = a; if (a > amax) amax = a;
    if (b < bmin) bmin = b; if (b > bmax) bmax = b;
  }
  const zoom = 0.25 + (p.scl / 255) * 1.5;          // 128 (the middle) = fits the LEDs
  const cyclesPerSec = (p.rate * 1000) / 16777216;
  const put = (i: number, c: number) => { out[i * 3] = (c >> 16) & 255; out[i * 3 + 1] = (c >> 8) & 255; out[i * 3 + 2] = c & 255; };

  if (p.fx === FX_MARQUEE || p.fx === FX_COUNTDOWN) {
    let text = p.text?.length ? p.text : 'Merry Christmas';
    if (p.fx === FX_COUNTDOWN) {
      const now = p.now ?? Date.now();
      text = countdownText(p.target ?? nextChristmas(now, p.timeZone ?? 'UTC'), now, p.text);
    }
    const cols = textColumns(text);
    // One font pixel per LED row when the text fills the picture's height (exact on a panel). A single
    // row of LEDs (a line) gets text about a sixth of its width tall.
    let h = bmax - bmin;
    if (h < (amax - amin) / 50) h = Math.max(amax - amin, 1e-3) / 6;
    const size = h / (BASE_ROWS - 1) * zoom;
    const bmid = (bmin + bmax) / 2;
    const scroll = (ms / 1000) * cyclesPerSec * 24;           // 24 columns (about 4 letters) per cycle
    // A countdown that fits stays still, centred; anything wider scrolls.
    const textW = cols.length - 8 - 1;
    const still = p.fx === FX_COUNTDOWN && textW * size <= (amax - amin) + size;
    const amid = (amin + amax) / 2;
    for (let i = 0; i < n; i++) {
      const fr = Math.round(BASE_TOP + (BASE_ROWS - 1) / 2 - (pts[i * 2 + 1] - bmid) / size);
      if (fr < 0 || fr > 9) continue;
      let fc: number;
      if (still) {
        fc = Math.floor((pts[i * 2] - amid) / size + textW / 2 + 0.5);
        if (fc < 0 || fc >= textW) continue;
      } else {
        fc = Math.floor((pts[i * 2] - amin) / size + 0.5 + scroll) % cols.length;
        if (fc < 0) fc += cols.length;
      }
      if ((cols[fc] >> fr) & 1) put(i, p.pal === 0 ? p.c1 : palColor(p.pal, p.c1, p.c2, fc * 5 + ms / 40));
    }
    return;
  }

  if (p.fx === FX_VIDEO) {
    if (!media || !media.count) return;
    const frame = Math.floor((ms / 1000) * media.fps) % media.count;
    const base = frame * media.w * media.h * 3;
    // Fill the LEDs' picture with the video (cropping the longer side), zoomed by the scale slider.
    const pw = Math.max(amax - amin, 1e-3), ph = Math.max(bmax - bmin, 1e-3);
    const s = Math.min(media.w / pw, media.h / ph) / zoom;    // video pixels per picture unit
    const amid = (amin + amax) / 2, bmid = (bmin + bmax) / 2;
    for (let i = 0; i < n; i++) {
      const x = Math.floor(media.w / 2 + (pts[i * 2] - amid) * s);
      const y = Math.floor(media.h / 2 - (pts[i * 2 + 1] - bmid) * s);
      if (x < 0 || y < 0 || x >= media.w || y >= media.h) continue;
      const o = base + (y * media.w + x) * 3;
      out[i * 3] = media.data[o]; out[i * 3 + 1] = media.data[o + 1]; out[i * 3 + 2] = media.data[o + 2];
    }
  }
}

/** Decoded-video file format sent to the website: "TLV1", w, h, fps*100, count (uint32 LE), then RGB. */
export function decodeMediaFrames(buf: ArrayBuffer): MediaFrames | null {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x31564c54) return null;
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true), fps = dv.getUint32(12, true) / 100, count = dv.getUint32(16, true);
  if (buf.byteLength < 20 + w * h * 3 * count) return null;
  return { w, h, fps, count, data: new Uint8Array(buf, 20, w * h * 3 * count) };
}
