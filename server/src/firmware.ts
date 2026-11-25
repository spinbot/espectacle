// Firmware files for over-the-air updates (<data>/firmware/*.bin), and pushing them to controllers.
// PlatformIO copies each build here (firmware/tools/espectacle_build.py), or they can be uploaded on the
// website. Each file says which version and board it is ("ESPECTACLE_FW|1.14.0|esp32-s3-n8r2|"; files from before the rename say TREELIGHTS_FW).
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import http from 'http';
import path from 'path';
import { request } from './controllers.js';

export interface FirmwareFile {
  name: string;
  bytes: number;
  date: number;              // ms
  version: string | null;
  board: string | null;      // PlatformIO environment, e.g. "lolin_s2_mini"
  chip: string | null;       // from the image header, e.g. "ESP32-S3"
  md5: string;
}

export interface UpdateState {
  state: 'uploading' | 'restarting' | 'done' | 'failed';
  progress: number;          // 0..1 while uploading
  file: string;
  from: string | null;       // version before
  to: string | null;
  message: string | null;
  at: number;
}

const CHIPS: Record<number, string> = { 0: 'ESP32', 2: 'ESP32-S2', 5: 'ESP32-C3', 9: 'ESP32-S3', 12: 'ESP32-C2', 13: 'ESP32-C6', 16: 'ESP32-H2' };

/** Numeric version comparison: "1.10.0" > "1.9.2". */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const p = (v: string | null | undefined) => String(v ?? '0').split(/[.-]/).map(x => Number(x) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

export class Firmware {
  private cache = new Map<string, FirmwareFile & { mtime: number }>();
  readonly updates = new Map<string, UpdateState>();     // by controller id

  constructor(readonly dir: string) {}
  async init() { await fs.mkdir(this.dir, { recursive: true }); }

  filePath(name: string) {
    if (!/^[\w][\w .()+-]{0,120}\.bin$/i.test(name)) throw new Error('firmware files are .bin files with a plain name');
    return path.join(this.dir, name);
  }

  async list(): Promise<FirmwareFile[]> {
    const names = (await fs.readdir(this.dir).catch(() => [] as string[])).filter(n => n.toLowerCase().endsWith('.bin'));
    const out: FirmwareFile[] = [];
    for (const name of names) {
      try { out.push(await this.info(name)); } catch { /* unreadable */ }
    }
    return out.sort((a, b) => compareVersions(b.version, a.version) || b.date - a.date);
  }

  private async info(name: string): Promise<FirmwareFile> {
    const file = this.filePath(name);
    const st = await fs.stat(file);
    const c = this.cache.get(name);
    if (c && c.mtime === st.mtimeMs && c.bytes === st.size) return c;
    const buf = await fs.readFile(file);
    const tag = /(?:ESPECTACLE|TREELIGHTS)_FW\|([^|\0]{1,32})\|([^|\0]{1,64})\|/.exec(buf.toString('latin1'));
    const info: FirmwareFile & { mtime: number } = {
      name, bytes: st.size, date: st.mtimeMs, mtime: st.mtimeMs,
      version: tag?.[1] ?? null, board: tag?.[2] && tag[2] !== 'unknown' ? tag[2] : null,
      chip: buf[0] === 0xe9 && buf.length > 14 ? CHIPS[buf.readUInt16LE(12)] ?? null : null,
      md5: createHash('md5').update(buf).digest('hex'),
    };
    this.cache.set(name, info);
    return info;
  }

  async put(name: string, bytes: Buffer) {
    if (bytes.length < 1024 || bytes[0] !== 0xe9) throw new Error('that isn\'t an ESP32 firmware .bin (use firmware.bin, not firmware.elf or a merged image)');
    await fs.writeFile(this.filePath(name), bytes);
  }

  async remove(name: string) { await fs.unlink(this.filePath(name)); }

  /** Whether a file suits a controller (from its /api/info). `exact`: same board; otherwise same chip. */
  static suits(f: FirmwareFile, info: Record<string, unknown> | undefined): { ok: boolean; exact: boolean; why?: string } {
    if (!info) return { ok: false, exact: false, why: 'offline' };
    const board = typeof info.board === 'string' && info.board !== 'unknown' ? info.board : null;
    const chip = typeof info.chip === 'string' ? info.chip : null;
    if (f.chip && chip && f.chip !== chip) return { ok: false, exact: false, why: `for ${f.chip}, this is ${chip}` };
    if (f.board && board) return f.board === board ? { ok: true, exact: true } : { ok: false, exact: false, why: `for ${f.board}, this is ${board}` };
    return { ok: true, exact: false };
  }

  /** The newest file built for this controller's board (or chip, when one of them doesn't say). */
  async best(info: Record<string, unknown> | undefined): Promise<FirmwareFile | null> {
    const files = await this.list();
    return files.find(f => Firmware.suits(f, info).exact) ?? null;
  }

  /**
   * Sends a firmware file to a controller (POST /api/update, multipart), then waits for it to restart and
   * report the new version. Progress is in `updates`.
   */
  async push(id: string, host: string, name: string, before: Record<string, unknown> | undefined) {
    const cur = this.updates.get(id);
    if (cur && (cur.state === 'uploading' || cur.state === 'restarting')) throw new Error('already updating');
    const f = await this.info(name);
    const st: UpdateState = { state: 'uploading', progress: 0, file: name, from: (before?.fw as string) ?? null, to: f.version, message: null, at: Date.now() };
    this.updates.set(id, st);
    const bytes = await fs.readFile(this.filePath(name));
    void (async () => {
      try {
        await multipartPost(host, '/api/update', 'firmware.bin', bytes, p => { st.progress = p; });
        st.state = 'restarting';
        st.progress = 1;
        st.message = 'Restarting…';
        // Wait for it to come back with the new firmware.
        const t0 = Date.now();
        await new Promise(r => setTimeout(r, 4000));
        while (Date.now() - t0 < 120000) {
          try {
            const info = await request(host, 'GET', '/api/info', undefined, 2500) as Record<string, unknown>;
            if (!f.version || compareVersions(info.fw as string, f.version) === 0) {
              st.state = 'done';
              st.message = `Now on ${info.fw}`;
              st.at = Date.now();
              return;
            }
            if (Date.now() - t0 > 30000) throw new Error(`still on ${info.fw} after restarting (the update didn't take)`);
          } catch (e) {
            if ((e as Error).message.startsWith('still on')) throw e;
          }
          await new Promise(r => setTimeout(r, 2000));
        }
        throw new Error('didn\'t come back after restarting');
      } catch (e) {
        st.state = 'failed';
        st.message = (e as Error).message;
        st.at = Date.now();
      }
    })();
  }
}

/** HTTP POST of one file as multipart/form-data, reporting upload progress (0..1). */
function multipartPost(host: string, urlPath: string, filename: string, data: Buffer, progress: (p: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const [hostname, port] = host.includes(':') ? host.split(':') : [host, '80'];
    const boundary = `----ESPectacle${Date.now().toString(16)}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="update"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const total = head.length + data.length + tail.length;
    const req = http.request({ hostname, port: Number(port), path: urlPath, method: 'POST', timeout: 120000,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': total } }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else {
          let msg = body;
          try { msg = JSON.parse(body).error ?? body; } catch { /* plain text */ }
          reject(new Error(res.statusCode === 404 ? 'this controller\'s firmware is too old for updates over WiFi – flash 1.10 or later over USB once' : `controller said: ${msg || res.statusCode}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out sending the firmware')));
    req.on('error', reject);
    req.write(head);
    let sent = 0;
    const chunk = 4096;
    const writeMore = () => {
      while (sent < data.length) {
        const part = data.subarray(sent, Math.min(sent + chunk, data.length));
        sent += part.length;
        progress(sent / data.length);
        if (!req.write(part)) { req.once('drain', writeMore); return; }
      }
      req.end(tail);
    };
    writeMore();
  });
}
