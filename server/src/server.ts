// ESPectacle server: keeps the project (plants, yard scan, shows, music) in one place for the
// app and the website, serves the web editor, and talks to the controllers.
//
// Environment:
//   PORT                 default 8080
//   ESPECTACLE_DATA      data folder, default ./data (/data in Docker)
//   ESPECTACLE_PASSWORD  password for the app and website (unset = no login)
// (The older TREELIGHTS_DATA / TREELIGHTS_PASSWORD names still work.)
import express from 'express';
import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { Storage } from './storage.js';
import { env } from './env.js';
import { writeBackup, backupName, unpackBackup, filesIn } from './backup.js';
import { Auth } from './auth.js';
import { Controllers } from './controllers.js';
import { Scheduler } from './scheduler.js';
import { Streamer } from './streamer.js';
import { Media } from './media.js';
import { Settings } from './settings.js';
import { Actions } from './actions.js';
import { HomeAssistant } from './homeassistant.js';
import { Firmware, compareVersions } from './firmware.js';
import { Builder } from './builder.js';
import { request } from './controllers.js';
import type { AppData, LightState } from '../shared/project.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8080);
const dataDir = path.resolve(env('DATA') ?? 'data');
const webDir = path.resolve(here, '../web/public');

const storage = new Storage(dataDir);
const auth = new Auth(env('PASSWORD') || undefined, dataDir);
const controllers = new Controllers(() => storage.get().data);
const media = new Media(path.join(dataDir, 'media'));
const settings = new Settings(dataDir);
const firmware = new Firmware(path.join(dataDir, 'firmware'));
const builder = new Builder(dataDir, settings);
// Controllers running server-built firmware say hello (firmware/src/main.cpp helloTick).
const found = new Map<string, { id: string; name: string; ip: string; fw: string; board: string; seen: number }>();
builder.onDone = job => {
  const cid = job.options.updateController;
  if (job.state !== 'done' || !cid || !job.firmware) return;
  const c = storage.get().data.controllers.find(x => x.id === cid);
  if (c) firmware.push(c.id, c.host, job.firmware, controllers.status.get(c.id)).catch(e => console.error('update after build:', e.message));
};
const timeZone = () => settings.get().timeZone !== 'UTC' ? settings.get().timeZone : storage.get().data.schedule?.timeZone ?? 'UTC';
const streamer = new Streamer(() => storage.get().data, media, timeZone);
const scheduler = new Scheduler(() => storage.get().data, controllers, streamer);
const actions = new Actions(storage, controllers, scheduler, streamer, settings, () => announce());
const homeAssistant = new HomeAssistant(settings, actions);

// Browsers watching for changes (Server-Sent Events): told the new revision when anyone saves.
const watchers = new Set<express.Response>();
function announce() {
  const msg = `data: ${JSON.stringify({ revision: storage.get().revision })}\n\n`;
  for (const w of watchers) w.write(msg);
}

export function makeApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/health', (_req, res) => { res.json({ ok: true, auth: auth.enabled }); });

  app.post('/api/login', express.json(), (req, res) => {
    if (!auth.enabled) { res.json({ ok: true }); return; }
    if (!auth.checkPassword(req.body?.password)) { res.status(401).json({ error: 'wrong password' }); return; }
    auth.login(res);
    res.json({ ok: true });
  });

  // Before the login check: controllers have no password. Only records who's out there.
  app.post('/api/hello', express.json(), async (req, res) => {
    const b = req.body ?? {};
    const id = String(b.id ?? ''), ip = String(b.ip ?? '');
    if (!/^[\w-]{1,32}$/.test(id) || !/^[\d.]{7,15}$/.test(ip)) { res.status(400).end(); return; }
    res.json({ ok: true });
    const env = storage.get();
    const c = env.data.controllers.find(x => x.id === id);
    if (c) {
      // It moved (DHCP): follow it, unless it's known by name rather than address.
      if (c.host !== ip && /^[\d.]+(:\d+)?$/.test(c.host)) {
        const data = structuredClone(env.data);
        data.controllers.find(x => x.id === id)!.host = ip;
        if (await storage.put(data, env.revision, true)) { announce(); console.log(`${c.name} is now at ${ip}`); }
      }
      found.delete(id);
    } else {
      found.set(id, { id, ip, name: String(b.name ?? id).slice(0, 40), fw: String(b.fw ?? ''), board: String(b.board ?? ''), seen: Date.now() });
    }
  });

  app.use('/api', auth.middleware);

  // ---- project ----
  app.get('/api/project', (_req, res) => { res.json(storage.get()); });
  app.get('/api/revision', (_req, res) => { const p = storage.get(); res.json({ revision: p.revision, updated: p.updated }); });

  /** Body: {baseRevision, data, force?}. 409 with the current project if someone saved in between. */
  app.put('/api/project', express.json({ limit: '64mb' }), async (req, res) => {
    const { baseRevision, data, force } = req.body ?? {};
    if (typeof data !== 'object' || !data || !Array.isArray((data as AppData).plants)) {
      res.status(400).json({ error: 'body must be {baseRevision, data}' });
      return;
    }
    const saved = await storage.put(data as AppData, Number(baseRevision), force === true);
    if (!saved) { res.status(409).json({ error: 'conflict', ...storage.get() }); return; }
    res.json({ revision: saved.revision, updated: saved.updated });
    announce();
    scheduler.poke();
    scheduler.syncGeometry();
    actions.changed();
  });

  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ revision: storage.get().revision })}\n\n`);
    watchers.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); watchers.delete(res); });
  });

  // ---- yard scan (binary, the app's area.bin format) ----
  app.get('/api/area', async (_req, res) => {
    const a = await storage.readArea();
    if (!a) { res.status(404).json({ error: 'no yard scan' }); return; }
    res.type('application/octet-stream').send(a);
  });
  app.put('/api/area', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 8 || body.readUInt32LE(0) !== 0x31414c54) {
      res.status(400).json({ error: 'not a ESPectacle yard scan' });
      return;
    }
    await storage.putArea(body);
    res.json({ ok: true, bytes: body.length });
    announce();
  });

  // ---- music ----
  app.get('/api/audio', async (_req, res) => { res.json(await storage.listAudio()); });
  app.get('/api/audio/:name', (req, res) => {
    let file: string;
    try { file = storage.audioPath(req.params.name); } catch { res.status(400).end(); return; }
    res.sendFile(file, err => { if (err && !res.headersSent) res.status(404).end(); });
  });
  app.put('/api/audio/:name', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
    try {
      await storage.putAudio(req.params.name, req.body as Buffer);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  // ---- controllers ----
  app.get('/api/status', (_req, res) => { res.json(Object.fromEntries(controllers.status)); });
  app.get('/api/schedule/status', (_req, res) => { res.json(scheduler.status()); });
  app.post('/api/schedule/pause', async (_req, res) => { await scheduler.pause(); res.json(scheduler.status()); });
  app.post('/api/schedule/resume', async (_req, res) => { await scheduler.resume(); res.json(scheduler.status()); });
  // ---- devices and firmware (over-the-air updates) ----
  app.get('/api/devices', async (_req, res) => {
    const files = await firmware.list();
    res.json({
      firmware: files,
      devices: storage.get().data.controllers.map(c => {
        const info = controllers.status.get(c.id);
        const best = files.find(f => Firmware.suits(f, info).exact) ?? null;
        return {
          id: c.id, name: c.name, host: c.host, maxMilliamps: c.maxMilliamps, strings: c.strings.map(s => ({ pin: s.pin, count: s.count, order: s.order })),
          leds: c.strings.reduce((n, s) => n + s.count, 0), online: !!info, info: info ?? null,
          update: firmware.updates.get(c.id) ?? null,
          best: best ? { name: best.name, version: best.version } : null,
          updateAvailable: !!(info && best && compareVersions(best.version, info.fw as string) > 0),
          compatible: files.filter(f => Firmware.suits(f, info).ok).map(f => f.name),
        };
      }),
      found: [...found.values()].filter(f => Date.now() - f.seen < 3600e3 && !storage.get().data.controllers.some(c => c.id === f.id)),
    });
  });
  // Adds a controller, as the app's "add controller" does: one that said hello ({id}) or any address ({host}).
  // Adding one that's already in the project just updates its address.
  app.post('/api/devices/add', express.json(), async (req, res) => {
    const f = req.body?.id ? found.get(String(req.body.id)) : undefined;
    const host = f?.ip ?? String(req.body?.host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!host) { res.status(404).json({ error: req.body?.id ? 'not found – is it switched on?' : 'enter its address' }); return; }
    if (!/^[\w.-]+(:\d+)?$/.test(host)) { res.status(400).json({ error: 'that isn\'t an address (e.g. 192.168.1.40 or front-tree.local)' }); return; }
    try {
      const info = await request(host, 'GET', '/api/info', undefined, 4000) as { id: string; name: string; strings?: { pin: number; count: number; order: string }[]; maxMilliamps?: number };
      if (!info?.id) throw new Error('it answered, but not as an ESPectacle controller');
      controllers.status.set(info.id, info as unknown as Record<string, unknown>);   // online straight away
      const env = storage.get();
      const data = structuredClone(env.data);
      const known = data.controllers.find(c => c.id === info.id);
      if (known) known.host = host;
      else data.controllers.push({ id: info.id, name: info.name, host, maxMilliamps: info.maxMilliamps ?? 2000,
        strings: (info.strings ?? []).map(s => ({ pin: s.pin, count: s.count, order: s.order })) });
      await storage.put(data, env.revision, true);
      announce();
      found.delete(info.id);
      if (!known) void request(host, 'POST', '/api/state', { ...data.state, t: Date.now() }).catch(() => {});
      scheduler.syncGeometry();
      res.json({ ok: true, id: info.id, updated: !!known });
    } catch (e) { res.status(502).json({ error: `${host}: ${controllerError(e)}` }); }
  });
  // Name, LED strings and current limit: written to the controller, then kept in the project (each string
  // keeps the prop it was on, by position).
  app.post('/api/devices/:id/config', express.json(), async (req, res) => {
    const env = storage.get();
    const c = env.data.controllers.find(x => x.id === req.params.id);
    if (!c) { res.status(404).json({ error: 'no such controller' }); return; }
    const b = req.body ?? {};
    const name = String(b.name ?? '').trim().slice(0, 31);
    const strings = Array.isArray(b.strings) ? b.strings.map((s: { pin: unknown; count: unknown; order: unknown }) =>
      ({ pin: Math.round(Number(s.pin)), count: Math.round(Number(s.count)), order: String(s.order ?? 'GRB') })) : [];
    const maxMilliamps = Math.max(0, Math.min(60000, Math.round(Number(b.maxMilliamps) || 0)));
    if (!name) { res.status(400).json({ error: 'give it a name' }); return; }
    if (!strings.length || strings.length > 4) { res.status(400).json({ error: 'between 1 and 4 strings' }); return; }
    try {
      const info = await request(c.host, 'POST', '/api/config', { name, maxMilliamps, strings }, 8000);
      if (info && typeof info === 'object') controllers.status.set(c.id, info as Record<string, unknown>);
      const fresh = storage.get();
      const data = structuredClone(fresh.data);
      const cur = data.controllers.find(x => x.id === c.id);
      if (cur) {
        cur.name = name;
        cur.maxMilliamps = maxMilliamps;
        cur.strings = strings.map((s: { pin: number; count: number; order: string }, i: number) => ({ ...s, plantID: cur.strings[i]?.plantID ?? null }));
      }
      await storage.put(data, fresh.revision, true);
      announce();
      scheduler.syncGeometry();
      res.json({ ok: true, info });
    } catch (e) { res.status(502).json({ error: controllerError(e) }); }
  });
  app.delete('/api/devices/:id', async (req, res) => {
    const env = storage.get();
    const data = structuredClone(env.data);
    const before = data.controllers.length;
    data.controllers = data.controllers.filter(c => c.id !== req.params.id);
    if (data.controllers.length === before) { res.status(404).json({ error: 'no such controller' }); return; }
    await storage.put(data, env.revision, true);
    announce();
    res.json({ ok: true });
  });

  // ---- building firmware (PlatformIO in the container) ----
  app.get('/api/builds/boards', async (_req, res) => {
    res.json({ ...(await builder.available()), boards: await builder.boards(), settings: settings.public_().build });
  });
  app.post('/api/builds', express.json(), (req, res) => {
    try {
      const b = req.body ?? {};
      const job = builder.start({ board: String(b.board ?? ''), name: b.name ? String(b.name) : undefined,
        pin: b.pin != null && b.pin !== '' ? Number(b.pin) : undefined, leds: b.leds != null && b.leds !== '' ? Number(b.leds) : undefined,
        updateController: b.updateController ? String(b.updateController) : undefined });
      res.json(job);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.get('/api/builds/:id', (req, res) => {
    const j = builder.jobs.get(req.params.id);
    if (!j) { res.status(404).json({ error: 'no such build' }); return; }
    const from = Number(req.query.from ?? 0) || 0;
    res.json({ ...j, log: j.log.slice(from), logFrom: from, logLength: j.log.length });
  });
  app.get('/api/builds/:id/manifest.json', async (req, res) => {
    try { res.json(await builder.manifest(req.params.id, 'files')); } catch { res.status(404).json({ error: 'not built' }); }
  });
  app.get('/api/builds/:id/files/:name', (req, res) => {
    let file: string;
    try { file = builder.outFile(req.params.id, req.params.name); } catch { res.status(400).end(); return; }
    res.sendFile(file, { headers: { 'Content-Type': 'application/octet-stream' } }, err => { if (err && !res.headersSent) res.status(404).end(); });
  });
  app.post('/api/devices/:id/update', express.json(), async (req, res) => {
    const c = storage.get().data.controllers.find(x => x.id === req.params.id);
    const info = c ? controllers.status.get(c.id) : undefined;
    if (!c) { res.status(404).json({ error: 'no such controller' }); return; }
    if (!info) { res.status(409).json({ error: `${c.name} isn't online` }); return; }
    try {
      const name = String(req.body?.file ?? '') || (await firmware.best(info))?.name;
      if (!name) throw new Error('no firmware file for this board yet – build one with PlatformIO or upload it');
      const f = (await firmware.list()).find(x => x.name === name);
      if (!f) throw new Error('no such firmware file');
      const fit = Firmware.suits(f, info);
      if (!fit.ok) throw new Error(`that file doesn't suit ${c.name}: ${fit.why}`);
      if (typeof info.sketchFree === 'number' && f.bytes > info.sketchFree) throw new Error(`too big for ${c.name} (${f.bytes} bytes, room for ${info.sketchFree})`);
      await firmware.push(c.id, c.host, name, info);
      res.json(firmware.updates.get(c.id));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  for (const action of ['identify', 'reboot']) {
    app.post(`/api/devices/:id/${action}`, async (req, res) => {
      const c = storage.get().data.controllers.find(x => x.id === req.params.id);
      if (!c) { res.status(404).json({ error: 'no such controller' }); return; }
      try { await request(c.host, 'POST', `/api/${action}`); res.json({ ok: true }); }
      catch (e) { res.status(502).json({ error: String((e as Error).message) }); }
    });
  }
  app.get('/api/firmware', async (_req, res) => { res.json(await firmware.list()); });
  app.put('/api/firmware/:name', express.raw({ type: () => true, limit: '16mb' }), async (req, res) => {
    try { await firmware.put(req.params.name, req.body as Buffer); res.json(await firmware.list()); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.delete('/api/firmware/:name', async (req, res) => {
    try { await firmware.remove(req.params.name); res.json(await firmware.list()); }
    catch (e) { res.status(404).json({ error: (e as Error).message }); }
  });

  // ---- settings (server only) and Home Assistant ----
  app.get('/api/settings', (_req, res) => { res.json({ ...settings.public_(), mqttStatus: homeAssistant.statusText }); });
  app.put('/api/settings', express.json(), async (req, res) => {
    try { await settings.put(req.body ?? {}); res.json({ ...settings.public_(), mqttStatus: homeAssistant.statusText }); }
    catch (e) { res.status(400).json({ error: String(e) }); }
  });
  // REST for Home Assistant (rest_command) or anything else; same password as the app (Bearer).
  const act = (f: (body: any) => unknown) => async (req: express.Request, res: express.Response) => {
    try { res.json(await f(req.body ?? {})); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  };
  app.get('/api/ha/state', (_req, res) => { res.json(actions.state()); });
  app.post('/api/ha/look', express.json(), act(b => actions.setLook(b)));
  app.post('/api/ha/message', express.json(), act(b => actions.message(String(b.text ?? ''), b.seconds != null ? Number(b.seconds) : undefined, b.rgb)));
  app.delete('/api/ha/message', act(() => actions.clearMessage()));
  app.post('/api/ha/show', express.json(), act(b => actions.playShow(String(b.show ?? b.name ?? b.id ?? ''))));
  app.post('/api/ha/show/stop', act(() => actions.stopShow()));
  app.post('/api/ha/schedules', express.json(), act(b => actions.setSchedules(b.enabled !== false)));

  // ---- online effects ----
  app.get('/api/media', async (_req, res) => { res.json(await media.list()); });
  app.put('/api/media/:name', express.raw({ type: () => true, limit: '1gb' }), async (req, res) => {
    try { await media.put(req.params.name, req.body as Buffer); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: String(e) }); }
  });
  app.delete('/api/media/:name', async (req, res) => {
    try { await media.remove(req.params.name); res.json({ ok: true }); } catch (e) { res.status(404).json({ error: String(e) }); }
  });
  app.get('/api/media/:name/frames', async (req, res) => {
    try {
      media.filePath(req.params.name);
      const f = await media.frames(req.params.name);
      if (!f) { res.status(422).json({ error: 'Could not decode that video.' }); return; }
      res.type('application/octet-stream').send(Media.encode(f));
    } catch (e) { res.status(400).json({ error: String(e) }); }
  });
  app.get('/api/online/status', (_req, res) => { res.json(streamer.status()); });
  // The app (or anyone) tells the server the look it just set on the lights, so online looks stream.
  app.post('/api/lights/live', express.json(), (req, res) => { streamer.setLive(req.body as LightState); res.json({ ok: true }); });
  // A show was started on the controllers (show time 0 = wall-clock ms `start`): stream its online clips.
  app.post('/api/online/show', express.json(), (req, res) => {
    const ok = streamer.playShowById(String(req.body?.id ?? ''), Number(req.body?.start ?? Date.now()));
    res.status(ok ? 200 : 404).json({ ok });
  });
  app.post('/api/online/stop', (_req, res) => { streamer.stopShow(); res.json({ ok: true }); });
  // The show editor projecting onto the real lights: one frame for every controller, as raw RGB one after
  // another; the X-Controllers header says whose and how many LEDs ("id:count,id:count").
  app.post('/api/lights/frame', express.raw({ type: () => true, limit: '2mb' }), (req, res) => {
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ctrls = storage.get().data.controllers;
    let off = 0;
    for (const part of String(req.headers['x-controllers'] ?? '').split(',')) {
      const [id, n] = part.split(':');
      const bytes = (Number(n) || 0) * 3;
      if (!id || bytes <= 0 || off + bytes > body.length) break;
      const c = ctrls.find(x => x.id === id);
      if (c?.host) streamer.projectFrame(c.host, new Uint8Array(body.buffer, body.byteOffset + off, bytes));
      off += bytes;
    }
    res.status(204).end();
  });
  app.post('/api/lights/state', express.json(), async (req, res) => {
    streamer.setLive(req.body as LightState);
    res.json(await controllers.setState(req.body as LightState));
  });

  // ---- backup and restore (everything the server keeps, as one .tar.gz) ----
  app.get('/api/backup', async (_req, res) => {
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${backupName()}"`);
    try { await writeBackup(dataDir, res); } catch (e) { console.error('backup:', e); res.destroy(e as Error); }
  });
  app.post('/api/restore', async (req, res) => {
    let dir: string | null = null;
    try {
      dir = await unpackBackup(dataDir, req);
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));
      const data = (raw?.data ?? raw) as AppData;
      if (!Array.isArray(data?.plants) || !Array.isArray(data?.controllers)) throw new Error('the project in that backup is damaged');
      // Saved as a revision newer than both this server's and the backup's, so every app and browser
      // (even one that last synced before the backup was made) takes it as the newest copy.
      const saved = await storage.put(data, 0, true, Number(raw?.revision) || 0);
      const restored: string[] = [`the project (${data.plants.length} props, ${data.controllers.length} controllers)`];
      const settingsFile = path.join(dir, 'settings.json');
      if (existsSync(settingsFile)) { await settings.replace(JSON.parse(await fs.readFile(settingsFile, 'utf8'))); restored.push('settings'); }
      const areaFile = path.join(dir, 'area.bin');
      if (existsSync(areaFile)) { await storage.putArea(await fs.readFile(areaFile)); restored.push('the yard scan'); }
      const copy = async (folder: string, put: (name: string, bytes: Buffer) => Promise<unknown>, label: string) => {
        const names = await filesIn(path.join(dir!, folder));
        let n = 0;
        for (const name of names) {
          try { await put(name, await fs.readFile(path.join(dir!, folder, name))); n++; } catch (e) { console.error(`restore ${folder}/${name}:`, (e as Error).message); }
        }
        if (n) restored.push(`${n} ${label}${n === 1 ? '' : 's'}`);
      };
      await copy('audio', (n, b) => storage.putAudio(n, b), 'music file');
      await copy('media', (n, b) => media.put(n, b), 'video');
      await copy('firmware', (n, b) => firmware.put(n, b), 'firmware file');
      res.json({ ok: true, revision: saved?.revision, restored });
      announce();
      scheduler.poke();
      scheduler.syncGeometry();
      actions.changed();
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ESP Web Tools (USB install from the browser), served from its npm package.
  app.use('/espweb', express.static(path.resolve(here, '../node_modules/esp-web-tools/dist/web'), { setHeaders: r => r.setHeader('Cache-Control', 'no-cache') }));

  // ---- website ----
  // Always revalidate (cheap, via ETag) so a rebuilt server's page is picked up on the next reload.
  app.use(express.static(webDir, { index: 'index.html', setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
  return app;
}

async function main() {
  await storage.init();
  await auth.init();
  controllers.start();
  await media.init();
  await settings.init();
  await firmware.init();
  await streamer.init();
  scheduler.start();
  homeAssistant.start();
  makeApp().listen(port, () => {
    console.log(`ESPectacle server on http://0.0.0.0:${port}  (data: ${dataDir})`);
    if (!auth.enabled) console.log('No ESPECTACLE_PASSWORD set: the app and website are open to anyone on the network.');
  });
}

main().catch(e => { console.error(e); process.exit(1); });

/** A controller request's failure in words: its own error message, or that it didn't answer. */
function controllerError(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  const http = /^HTTP (\d+): ([\s\S]*)$/.exec(m);
  if (http) { try { return JSON.parse(http[2]).error ?? m; } catch { return http[2] || m; } }
  if (/abort|fetch failed|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/i.test(m)) return 'it isn\'t responding (is it on, and on this network?)';
  return m;
}
