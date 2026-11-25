// Videos for the Video online effect: stored in <data>/media, decoded with ffmpeg into small frames
// (LED displays are low resolution) and kept in memory while in use.
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import type { MediaFrames } from '../shared/online.js';

export const MEDIA_WIDTH = 64;       // decoded width in pixels (height follows the aspect ratio)
export const MEDIA_FPS = 20;
export const MEDIA_MAX_SECONDS = 120;

export class Media {
  private cache = new Map<string, { frames: MediaFrames | null; loading?: Promise<MediaFrames | null>; used: number; error?: string }>();
  constructor(readonly dir: string) {}

  async init() { await fs.mkdir(this.dir, { recursive: true }); }

  filePath(name: string) {
    if (!/^[\w][\w .()-]{0,120}$/.test(name)) throw new Error('bad file name');
    return path.join(this.dir, name);
  }

  async list(): Promise<{ name: string; bytes: number; frames?: number; seconds?: number; error?: string }[]> {
    const names = (await fs.readdir(this.dir)).filter(n => !n.startsWith('.'));
    return Promise.all(names.sort().map(async name => {
      const c = this.cache.get(name);
      return {
        name, bytes: (await fs.stat(path.join(this.dir, name))).size,
        frames: c?.frames?.count, seconds: c?.frames ? c.frames.count / c.frames.fps : undefined, error: c?.error,
      };
    }));
  }

  async put(name: string, bytes: Buffer) {
    await fs.writeFile(this.filePath(name), bytes);
    this.cache.delete(name);
    void this.frames(name);            // decode now so it's ready
  }

  async remove(name: string) {
    this.cache.delete(name);
    await fs.unlink(this.filePath(name));
  }

  /** Decoded frames, or null while decoding (it starts in the background) or if it can't be decoded. */
  peek(name: string): MediaFrames | null {
    const c = this.cache.get(name);
    if (c) { c.used = Date.now(); return c.frames; }
    void this.frames(name);
    return null;
  }

  async frames(name: string): Promise<MediaFrames | null> {
    let c = this.cache.get(name);
    if (c?.frames) { c.used = Date.now(); return c.frames; }
    if (c?.loading) return c.loading;
    if (c?.error) return null;
    c = { frames: null, used: Date.now() };
    this.cache.set(name, c);
    const entry = c;
    entry.loading = decode(this.filePath(name)).then(f => { entry.frames = f; return f; },
      e => { entry.error = String(e.message ?? e); console.error(`media: ${name}: ${entry.error}`); return null; })
      .finally(() => { entry.loading = undefined; });
    this.evict();
    return entry.loading;
  }

  /** The decoded file format the website reads (see decodeMediaFrames in shared/online.ts). */
  static encode(f: MediaFrames): Buffer {
    const head = Buffer.alloc(20);
    head.writeUInt32LE(0x31564c54, 0); head.writeUInt32LE(f.w, 4); head.writeUInt32LE(f.h, 8);
    head.writeUInt32LE(Math.round(f.fps * 100), 12); head.writeUInt32LE(f.count, 16);
    return Buffer.concat([head, Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength)]);
  }

  private evict() {
    const loaded = [...this.cache.entries()].filter(([, v]) => v.frames).sort((a, b) => a[1].used - b[1].used);
    while (loaded.length > 6) this.cache.delete(loaded.shift()![0]);
  }
}

/** Runs ffprobe for the size, then ffmpeg to raw RGB frames at MEDIA_WIDTH x (aspect), MEDIA_FPS. */
async function decode(file: string): Promise<MediaFrames> {
  const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]);
  const m = /(\d+)x(\d+)/.exec(probe.toString());
  if (!m) throw new Error('not a video ffmpeg can read');
  const w = MEDIA_WIDTH, h = Math.max(2, Math.round((MEDIA_WIDTH * Number(m[2])) / Number(m[1]) / 2) * 2);
  const raw = await run('ffmpeg', ['-v', 'error', '-i', file, '-t', String(MEDIA_MAX_SECONDS), '-an',
    '-vf', `fps=${MEDIA_FPS},scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], 512 * 1024 * 1024);
  const count = Math.floor(raw.length / (w * h * 3));
  if (!count) throw new Error('no frames');
  return { w, h, fps: MEDIA_FPS, count, data: new Uint8Array(raw.buffer, raw.byteOffset, count * w * h * 3) };
}

function run(cmd: string, args: string[], max = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    const out: Buffer[] = [];
    let size = 0, err = '';
    p.stdout.on('data', (d: Buffer) => { size += d.length; if (size <= max) out.push(d); });
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', e => reject(new Error(e.message.includes('ENOENT') ? `${cmd} isn't installed` : e.message)));
    p.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.trim().split('\n').pop() || `${cmd} failed`)));
  });
}
