// Builds firmware in the container with PlatformIO, like ESPHome: your WiFi, the controller's name, LED
// pin and count, and the server's address are baked in (src/espectacle_build_config.h), for the board you
// pick. The results go to the firmware library (for updates over WiFi) and, for a first install over USB
// from the browser, into a set of files with an ESP Web Tools manifest.
//
// Needs the firmware source mounted at /firmware (docker-compose: "- ../firmware:/firmware:ro"); PlatformIO
// keeps its tools in <data>/platformio, downloaded on the first build.
import { spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { Settings } from './settings.js';
import { env } from './env.js';

export interface BuildOptions {
  board: string;                  // PlatformIO environment
  name?: string;
  pin?: number;
  leds?: number;
  updateController?: string;      // when done, send it to this controller over WiFi
}

export interface BuildJob {
  id: string;
  options: BuildOptions;
  state: 'queued' | 'building' | 'done' | 'failed';
  log: string[];
  started: number;
  finished: number | null;
  firmware: string | null;        // file name in the firmware library
  version: string | null;
  chip: string | null;
  error: string | null;
}

/** LEDs one controller can drive (MAX_LEDS in firmware/src/settings.h). */
export const MAX_LEDS = 1500;

const CHIPS: Record<number, { name: string; bootloader: number }> = {
  0: { name: 'ESP32', bootloader: 0x1000 }, 2: { name: 'ESP32-S2', bootloader: 0x1000 },
  5: { name: 'ESP32-C3', bootloader: 0 }, 9: { name: 'ESP32-S3', bootloader: 0 },
};

/** A C string literal for any text (bytes outside printable ASCII as octal escapes). */
function cString(s: string): string {
  let out = '"';
  for (const b of Buffer.from(s, 'utf8')) {
    if (b === 0x22 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b >= 0x20 && b < 0x7f && b !== 0x3f) out += String.fromCharCode(b);   // ? escaped: no trigraphs
    else out += '\\' + b.toString(8).padStart(3, '0');
  }
  return out + '"';
}

export class Builder {
  readonly jobs = new Map<string, BuildJob>();
  private queue: BuildJob[] = [];
  private running = false;
  onDone?: (job: BuildJob) => void;

  constructor(private dataDir: string, private settings: Settings, private source = env('FIRMWARE_SRC') ?? '/firmware') {}

  private get work() { return path.join(this.dataDir, 'build', 'project'); }
  private get out() { return path.join(this.dataDir, 'build', 'out'); }
  private get core() { return process.env.PLATFORMIO_CORE_DIR ?? path.join(this.dataDir, 'platformio'); }

  /** Whether builds can run here, and why not. */
  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (!existsSync(path.join(this.source, 'platformio.ini'))) {
      return { ok: false, reason: `The firmware source isn't mounted. Add "- ../firmware:/firmware:ro" under volumes in docker-compose.yml, then docker compose up -d.` };
    }
    try { await run('pio', ['--version'], {}, () => {}); } catch {
      return { ok: false, reason: 'PlatformIO isn\'t installed in this container (rebuild the image).' };
    }
    return { ok: true };
  }

  /** Boards (PlatformIO environments) in platformio.ini, with the comment above each as a description. */
  async boards(): Promise<{ id: string; label: string }[]> {
    try {
      const ini = await fs.readFile(path.join(this.source, 'platformio.ini'), 'utf8');
      const out: { id: string; label: string }[] = [];
      const lines = ini.split('\n');
      lines.forEach((l, i) => {
        const m = /^\[env:([^\]]+)\]/.exec(l.trim());
        if (!m) return;
        let label = '';
        for (let k = i - 1; k >= 0 && lines[k].trim().startsWith(';'); k--) label = lines[k].trim().replace(/^;\s*/, '') + (label ? ' ' + label : '');
        out.push({ id: m[1], label: label.split(/[.(]/)[0].trim() || m[1] });
      });
      return out;
    } catch { return []; }
  }

  start(options: BuildOptions): BuildJob {
    if (!/^[\w.-]+$/.test(options.board)) throw new Error('bad board name');
    if (options.leds != null && (!Number.isInteger(options.leds) || options.leds < 1 || options.leds > MAX_LEDS)) throw new Error(`LEDs must be 1–${MAX_LEDS}`);
    if (options.pin != null && (!Number.isInteger(options.pin) || options.pin < 0 || options.pin > 48)) throw new Error('LED pin must be a GPIO number (0–48)');
    const job: BuildJob = { id: randomBytes(6).toString('hex'), options, state: 'queued', log: [], started: Date.now(), finished: null,
      firmware: null, version: null, chip: null, error: null };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    for (const old of [...this.jobs.values()].filter(j => j.finished && Date.now() - j.finished > 6 * 3600e3)) this.jobs.delete(old.id);
    void this.next();
    return job;
  }

  /** Files for ESP Web Tools / a full flash, once a job is done. */
  async manifest(id: string, base: string) {
    const dir = path.join(this.out, id);
    return JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8').then(s => s.replaceAll('{base}', base)));
  }

  outFile(id: string, name: string) {
    if (!/^[0-9a-f]{12}$/.test(id) || !/^[\w.-]+\.bin$/.test(name)) throw new Error('bad file');
    return path.join(this.out, id, name);
  }

  private async next() {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    job.state = 'building';
    const log = (s: string) => { for (const line of s.split(/\r?\n/)) if (line.trim()) job.log.push(line); if (job.log.length > 3000) job.log.splice(0, job.log.length - 3000); };
    try {
      await this.build(job, log);
      job.state = 'done';
    } catch (e) {
      job.state = 'failed';
      job.error = (e as Error).message;
      log(`✗ ${job.error}`);
    } finally {
      job.finished = Date.now();
      this.running = false;
      this.onDone?.(job);
      void this.next();
    }
  }

  private async build(job: BuildJob, log: (s: string) => void) {
    const avail = await this.available();
    if (!avail.ok) throw new Error(avail.reason);
    const o = job.options, s = this.settings.get();

    // A private copy of the source (PlatformIO writes into the project folder; /firmware is read-only).
    log(`Preparing ${o.board}…`);
    await fs.mkdir(this.work, { recursive: true });
    for (const part of ['src', 'include', 'lib', 'tools']) {
      await fs.rm(path.join(this.work, part), { recursive: true, force: true });
      if (existsSync(path.join(this.source, part))) await fs.cp(path.join(this.source, part), path.join(this.work, part), { recursive: true });
    }
    await fs.copyFile(path.join(this.source, 'platformio.ini'), path.join(this.work, 'platformio.ini'));

    const defs: string[] = ['// Written by the ESPectacle server for this build. Do not edit.', '#pragma once'];
    if (s.build.wifiSsid) defs.push(`#define ESPECTACLE_WIFI_SSID ${cString(s.build.wifiSsid)}`, `#define ESPECTACLE_WIFI_PASS ${cString(s.build.wifiPassword)}`);
    if (o.name?.trim()) defs.push(`#define ESPECTACLE_NAME ${cString(o.name.trim().slice(0, 31))}`);
    if (o.pin != null && Number.isInteger(o.pin)) defs.push(`#define ESPECTACLE_LED_PIN ${o.pin}`);
    if (o.leds != null && Number.isInteger(o.leds) && o.leds > 0) defs.push(`#define ESPECTACLE_LED_COUNT ${Math.min(o.leds, MAX_LEDS)}`);
    if (s.build.serverUrl) defs.push(`#define ESPECTACLE_SERVER ${cString(s.build.serverUrl.replace(/\/+$/, ''))}`);
    await fs.writeFile(path.join(this.work, 'src', 'espectacle_build_config.h'), defs.join('\n') + '\n', { mode: 0o600 });
    log(s.build.wifiSsid ? `WiFi: ${s.build.wifiSsid}` : 'No WiFi set (Settings → Firmware builds): it will start its setup hotspot.');

    const firmwareDir = path.join(this.dataDir, 'firmware');
    await fs.mkdir(firmwareDir, { recursive: true });
    log(`pio run -e ${o.board}  (the first build downloads the ESP32 tools: a few minutes)`);
    await run('pio', ['run', '-e', o.board], {
      cwd: this.work,
      env: { ...process.env, PLATFORMIO_CORE_DIR: this.core, ESPECTACLE_FIRMWARE_DIR: firmwareDir, PLATFORMIO_NO_ANSI: 'true', PLATFORMIO_DISABLE_PROGRESSBAR: 'true' },
    }, log);

    // Collect the pieces for a full (USB) install.
    const bdir = path.join(this.work, '.pio', 'build', o.board);
    const app = await fs.readFile(path.join(bdir, 'firmware.bin'));
    const chip = CHIPS[app.readUInt16LE(12)] ?? CHIPS[0];
    job.chip = chip.name;
    const tag = /(?:ESPECTACLE|TREELIGHTS)_FW\|([^|\0]{1,32})\|/.exec(app.toString('latin1'));
    job.version = tag?.[1] ?? null;
    job.firmware = job.version ? `espectacle-${job.version}-${o.board}.bin` : null;
    const bootApp0 = path.join(this.core, 'packages', 'framework-arduinoespressif32', 'tools', 'partitions', 'boot_app0.bin');
    const parts = [
      { file: 'bootloader.bin', from: path.join(bdir, 'bootloader.bin'), offset: chip.bootloader },
      { file: 'partitions.bin', from: path.join(bdir, 'partitions.bin'), offset: 0x8000 },
      { file: 'boot_app0.bin', from: bootApp0, offset: 0xe000 },
      { file: 'firmware.bin', from: path.join(bdir, 'firmware.bin'), offset: 0x10000 },
    ];
    const dir = path.join(this.out, job.id);
    await fs.mkdir(dir, { recursive: true });
    let end = 0;
    const blobs: { offset: number; data: Buffer }[] = [];
    for (const p of parts) {
      const data = await fs.readFile(p.from);
      await fs.writeFile(path.join(dir, p.file), data);
      blobs.push({ offset: p.offset, data });
      end = Math.max(end, p.offset + data.length);
    }
    // One file to flash at 0x0 with esptool, for anyone not using the browser.
    const factory = Buffer.alloc(end, 0xff);
    for (const b of blobs) b.data.copy(factory, b.offset);
    await fs.writeFile(path.join(dir, 'factory.bin'), factory);
    const manifest = {
      name: `ESPectacle ${o.name?.trim() || o.board}`, version: job.version ?? 'dev', new_install_prompt_erase: true,
      builds: [{ chipFamily: chip.name, parts: parts.map(p => ({ path: `{base}/${p.file}`, offset: p.offset })) }],
    };
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    log(`✓ Built ESPectacle ${job.version ?? ''} for ${o.board} (${Math.round(app.length / 1024)} KB)`);
  }
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }, out: (s: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    p.stdout.on('data', (d: Buffer) => out(d.toString()));
    p.stderr.on('data', (d: Buffer) => out(d.toString()));
    p.on('error', e => reject(new Error(e.message.includes('ENOENT') ? `${cmd} isn't installed` : e.message)));
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} failed (exit ${code})`))));
  });
}
