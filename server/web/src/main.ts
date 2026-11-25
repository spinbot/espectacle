import { api, AuthError, ConflictError, decodeArea } from './api.js';
import { Effects, FRAME_YARD } from './fx.js';
import { YardView } from './yard.js';
import { ShowEditor, renderShowList } from './showeditor.js';
import { computeLayout, mapIsCurrent, yardFront, type Layout } from '../../shared/layout.js';
import { EFFECTS, ALL_EFFECTS, PALETTES, rateFromSpeed, dirVector, hasDirSetting, fxInfo } from '../../shared/catalog.js';
import type { AppData, LightState } from '../../shared/project.js';
import { dirPicker, onDirArrow, onLookThrough, showDirArrow } from './dirpicker.js';
import { renderPlants } from './plants.js';
import { LedEditor } from './ledit.js';
import { OnlineFrame, lookSource } from '../../shared/onlineframe.js';
import { mediaPicker, previewFrames } from './mediapicker.js';
import { renderSchedules, pollScheduleStatus } from './schedule.js';
import { renderSettings } from './settings.js';
import { renderDevices } from './devices.js';
import { toLocalInput, fromLocalInput } from './dates.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const unhex = (s: string) => parseInt(s.slice(1), 16);
// Same plant colours as the app (PointCloudGeometry.plantColor).
const PLANT_HUES = [0.33, 0.0, 0.58, 0.12, 0.83, 0.48, 0.07, 0.7];
const plantColor = (i: number) => hsvToInt(PLANT_HUES[i % PLANT_HUES.length], 0.85, 1);

let data: AppData;
let revision = 0;
let layout: Layout;
let look: LightState;
let fx: Effects;
let view: YardView;
let packed: { base: number; geo: Uint8Array; ledSlots: Int32Array }[] = [];
let ledCount = 0;
let saveTimer = 0, liveTimer = 0, saving = false, dirty = false;
let editor: ShowEditor | null = null;
let online: OnlineFrame;

async function main() {
  try {
    await load();
  } catch (e) {
    if (e instanceof AuthError) return showLogin();
    throw e;
  }
}

function showLogin() {
  $('login').hidden = false;
  $('login-form').onsubmit = async ev => {
    ev.preventDefault();
    try {
      await api.login($<HTMLInputElement>('password').value);
      $('login').hidden = true;
      await load();
    } catch {
      $('login-error').textContent = 'Wrong password';
    }
  };
}

async function load() {
  const env = await api.project();
  data = env.data;
  revision = env.revision;
  look = { ...data.state };
  if (!fx) {
    fx = await Effects.load();
    online = new OnlineFrame();
    view = new YardView($('view'));
    onDirArrow((v, cam) => view.setDirArrow(v, cam));
    onLookThrough(v => view.lookAlong(v));
    $('vc-reset').onclick = () => view.resetView();
    viewControls();
    buildLookControls();
    document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => b.onclick = () => selectTab(b.dataset.tab!));
    requestAnimationFrame(tick);
    watchForChanges();
    pollStatus();
    pollScheduleStatus($('tab-schedule'));
    selectTab((() => { try { return localStorage.getItem('tl-tab') ?? 'look'; } catch { return 'look'; } })());
  }
  rebuildLayout();
  buildPlants();
  syncLookControls();
  projectReplaced();
  await loadAreaIfChanged();
  setSync();
}

// ---------- view controls (remembered in this browser) ----------

function viewControls() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('tl-view') ?? '{}'); } catch { return {}; } })();
  const set = { scan: saved.scan ?? view.scanLevel, glow: saved.glow ?? view.glow, unlit: saved.unlit ?? view.unlitLevel };
  const apply = () => {
    view.setScanLevel(set.scan);
    view.glow = set.glow;
    view.unlitLevel = set.unlit;
    try { localStorage.setItem('tl-view', JSON.stringify(set)); } catch { /* private window */ }
  };
  for (const [id, key] of [['vc-scan', 'scan'], ['vc-glow', 'glow'], ['vc-unlit', 'unlit']] as const) {
    const el = $<HTMLInputElement>(id);
    el.value = String(set[key]);
    el.oninput = () => { set[key] = Number(el.value); apply(); };
  }
  apply();
}

// ---------- shows ----------

function showList() {
  renderShowList($('tab-shows'), data, openShow, scheduleSave);
}

function openShow(id: string) {
  editor?.close();
  selectTab('shows');
  editor = new ShowEditor({
    data: () => data,
    layout: () => layout,
    save: scheduleSave,
    plantColor: i => hex(plantColor(i)),
    closed: closeShow,
  }, id, $('editor-pane'), $('tab-shows'));
}

function closeShow() {
  editor?.close();
  editor = null;
  showList();
  const le = fxInfo(look.fx);
  showDirArrow(le?.usesView ? lookDir() ?? dirVector(90, 0) : lookDir(), !!le?.usesView);
}

/** After the project was swapped for a newer copy (another device, or a conflict). */
function projectReplaced() {
  if (editor) editor.refresh(); else showList();
  if (!$('tab-schedule').hidden) buildSchedule();
}

/** Fetches the yard scan when the project says there's a newer one than the one shown. */
let shownAreaDate: number | null = null, triedArea = false;
async function loadAreaIfChanged() {
  const date = data.area?.date ?? null;
  if (date === shownAreaDate && triedArea) return;
  if (date === null && triedArea) return;
  triedArea = true;
  const area = await api.area();
  const decoded = area && decodeArea(area);
  if (decoded) {
    view.setArea(decoded.positions, decoded.colors);
    shownAreaDate = date;
  }
}

// ---------- layout and preview ----------

function rebuildLayout() {
  layout = computeLayout(data);
  view.setFront(yardFront(data));
  fx.setZoneFrames(layout.zoneFrames);
  // Display slot for each controller LED that has a position.
  const slot = new Map<string, number>();
  layout.placed.forEach((p, i) => slot.set(`${p.controllerID}#${p.index}`, i));
  packed = layout.controllers.map(c => {
    const slots = new Int32Array(c.geo.length).fill(-1);
    for (let i = 0; i < c.geo.length; i++) slots[i] = slot.get(`${c.id}#${i}`) ?? -1;
    return { base: c.base, geo: Effects.packGeo(c.geo), ledSlots: slots };
  });
  ledCount = layout.placed.length;
  online.setLayout(layout, yardFront(data));
  // Drawn or copied plants that aren't wired yet still show (faintly) so they can be placed.
  const ghost: number[] = [];
  for (const p of data.plants) {
    if (!p.map?.portable || mapIsCurrent(data, p)) continue;
    const th = (p.rotation * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
    for (const m of p.map.leds) ghost.push(m.x * cs + m.z * sn + p.x, m.y + p.y, -m.x * sn + m.z * cs + p.z);
  }
  view.setGhosts(new Float32Array(ghost));
  view.setLEDs(layout.placed.map(p => ({ x: p.yard[0], y: p.yard[1], z: p.yard[2] })));
  view.setPlantRings(data.plants.map((p, i) => ({ p, i })).filter(({ p }) => mapIsCurrent(data, p))
    .map(({ p, i }) => ({ x: p.x, y: p.y, z: p.z, r: p.map!.radius, color: plantColor(i) })));
  $('empty').hidden = ledCount > 0;
}

// ---------- projecting the show editor onto the real lights ----------

// The controllers apply this curve to what they draw themselves, but not to frames sent to them.
const GAMMA = Uint8Array.from({ length: 256 }, (_, i) => Math.round(255 * Math.pow(i / 255, 2.2)));
let projectBusy = false;

function sendProjected(frames: { id: string; rgb: Uint8Array }[]) {
  if (projectBusy || !frames.length) return;          // the last frame is still on its way: skip this one
  const total = frames.reduce((n, f) => n + f.rgb.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const f of frames) { for (let i = 0; i < f.rgb.length; i++) body[off + i] = GAMMA[f.rgb[i]]; off += f.rgb.length; }
  projectBusy = true;
  fetch('/api/lights/frame', {
    method: 'POST', credentials: 'same-origin', body,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Controllers': frames.map(f => `${f.id}:${f.rgb.length / 3}`).join(',') },
  }).then(r => { if (!r.ok && r.status !== 204) throw new Error(`${r.status}`); })
    .catch(e => editor?.setProjecting(false, String((e as Error).message)))
    .finally(() => { projectBusy = false; });
}

let lastFrame = 0;
function tick(t: number) {
  requestAnimationFrame(tick);
  if (t - lastFrame >= 24 && ledCount) {     // ~40 fps, like the controllers
    lastFrame = t;
    const rgb = new Float32Array(ledCount * 3);
    const scale = look.on ? look.bri / 255 : 0;
    const p = { fx: look.fx, pal: look.pal, bri: 255, scl: look.scl, rate: rateFromSpeed(look.spd), c1: look.c1, c2: look.c2, dir: lookDir() };
    const now = Date.now();                    // controllers animate from the shared wall clock too
    if (editor) {                              // show editor: every plant follows its track
      editor.tick();
      fx.setZones(editor.zonesNow());
    }
    const showScale = (data.state.bri ?? 255) / 255;
    // Online effects (marquee, video) are drawn here as the server would draw them.
    const ls = editor ? null : lookSource(look, now, Intl.DateTimeFormat().resolvedOptions().timeZone);
    const sources = editor ? editor.onlineNow() : ls ? [ls] : [];
    const onl = sources.length ? online.render(sources, previewFrames) : null;
    const projecting = !!editor?.projecting;
    const frames: { id: string; rgb: Uint8Array }[] = [];
    for (const [ci, c] of packed.entries()) {
      if (!c.geo.length) continue;
      let out = editor ? fx.renderZones(c.geo, c.base) : fx.render(c.geo, p, now, c.base, FRAME_YARD);
      const om = onl?.mask[ci], orgb = onl?.rgb[ci];
      if (om && orgb) {
        out = out.slice();
        for (let i = 0; i < om.length && i * 3 < out.length; i++) if (om[i]) { out[i * 3] = orgb[i * 3]; out[i * 3 + 1] = orgb[i * 3 + 1]; out[i * 3 + 2] = orgb[i * 3 + 2]; }
      }
      if (projecting) frames.push({ id: layout.controllers[ci].id, rgb: out.slice() });   // (the controller applies its own brightness)
      const k = editor ? showScale : scale;
      for (let i = 0; i < c.ledSlots.length; i++) {
        const s = c.ledSlots[i];
        if (s < 0) continue;
        rgb[s * 3] = out[i * 3] * k; rgb[s * 3 + 1] = out[i * 3 + 1] * k; rgb[s * 3 + 2] = out[i * 3 + 2] * k;
      }
    }
    view.setColors(rgb);
    if (projecting) sendProjected(frames);
  }
  view.render();
}

// ---------- look controls ----------

function buildLookControls() {
  const grid = $('effects');
  for (const e of ALL_EFFECTS) {
    const b = document.createElement('button');
    b.textContent = e.name;
    b.dataset.fx = String(e.id);
    if (e.online) { b.classList.add('online'); b.title = 'Online: drawn by the server and streamed to the lights'; }
    b.onclick = () => {
      // A direction of travel and a camera view mean different things: start afresh when switching.
      if (!!fxInfo(look.fx)?.usesView !== !!e.usesView) { look.dirYaw = null; look.dirPitch = null; }
      look.fx = e.id; lookChanged();
    };
    grid.appendChild(b);
  }
  const pals = $('palettes');
  for (const p of PALETTES) {
    const b = document.createElement('button');
    b.dataset.pal = String(p.id);
    b.innerHTML = `<div class="swatch"></div><span class="name">${p.name}</span>`;
    b.onclick = () => { look.pal = p.id; lookChanged(); };
    pals.appendChild(b);
  }
  for (const id of ['bri', 'spd', 'scl'] as const) {
    $<HTMLInputElement>(id).oninput = ev => { look[id] = Number((ev.target as HTMLInputElement).value); lookChanged(); };
  }
  for (const id of ['c1', 'c2'] as const) {
    $<HTMLInputElement>(id).oninput = ev => { look[id] = unhex((ev.target as HTMLInputElement).value); lookChanged(); };
  }
  $<HTMLInputElement>('look-target').onchange = ev => { look.target = fromLocalInput((ev.target as HTMLInputElement).value); lookChanged(true); };
  $('look-xmas').onclick = () => { look.target = null; lookChanged(); };
  $<HTMLInputElement>('look-text').oninput = ev => { look.text = (ev.target as HTMLInputElement).value; lookChanged(true); };
  $<HTMLInputElement>('live').onchange = () => { if ($<HTMLInputElement>('live').checked) sendLive(); };
  $('load-look').onclick = () => { look = { ...data.state }; syncLookControls(); };
}

/** The look's direction vector for the effect (null: the effect's default). */
function lookDir() {
  return hasDirSetting(look.fx) && look.dirYaw != null && look.dirPitch != null ? dirVector(look.dirYaw, look.dirPitch) : null;
}

let dirPickerFx = -1;
function syncLookControls(keepDirPicker = false) {
  const e = fxInfo(look.fx) ?? EFFECTS[0];
  const dirRow = $('dir-row');
  const hasDir = hasDirSetting(look.fx);
  dirRow.hidden = !hasDir;
  if (!hasDir) { dirPickerFx = -1; if (!editor) showDirArrow(null); }
  else if (!keepDirPicker || dirPickerFx !== look.fx) {
    dirPickerFx = look.fx;
    dirPicker(dirRow, { yaw: look.dirYaw ?? null, pitch: look.dirPitch ?? null }, { camera: e.usesView, defaultLabel: e.dirDefault }, d => {
      look.dirYaw = d.yaw; look.dirPitch = d.pitch;
      lookChanged(true);
    });
  }
  document.querySelectorAll<HTMLButtonElement>('#effects button').forEach(b => b.classList.toggle('active', Number(b.dataset.fx) === look.fx));
  document.querySelectorAll<HTMLButtonElement>('#palettes button').forEach(b => {
    const p = PALETTES[Number(b.dataset.pal)];
    const cols = p.id === 0 ? [look.c1, look.c2] : p.colors;
    (b.querySelector('.swatch') as HTMLElement).style.background = `linear-gradient(90deg, ${cols.map(hex).join(', ')})`;
    b.classList.toggle('active', p.id === look.pal);
  });
  $('palette-row').hidden = !e.usesPalette;
  const custom = e.usesPalette && look.pal === 0;
  $('c1-row').hidden = !(e.usesColor1 || custom);
  $('c2-row').hidden = !(e.usesColor2 || custom);
  $<HTMLInputElement>('c1').value = hex(look.c1);
  $<HTMLInputElement>('c2').value = hex(look.c2);
  $<HTMLInputElement>('bri').value = String(look.bri);
  $<HTMLInputElement>('spd').value = String(look.spd);
  $<HTMLInputElement>('scl').value = String(look.scl);
  $('scl-label').textContent = e.scaleLabel ?? 'Scale';
  $('text-row').hidden = !e.usesText;
  $('text-row').firstChild!.textContent = e.usesTarget ? 'When it gets there, show ' : 'Text ';
  $<HTMLInputElement>('look-text').placeholder = e.usesTarget ? 'MERRY CHRISTMAS' : 'Merry Christmas';
  $('target-row').hidden = !e.usesTarget;
  if (document.activeElement !== $('look-target')) $<HTMLInputElement>('look-target').value = look.target ? toLocalInput(look.target) : '';
  if ($<HTMLInputElement>('look-text').value !== (look.text ?? '')) $<HTMLInputElement>('look-text').value = look.text ?? '';
  $('online-note').hidden = !e.online;
  const mediaRow = $('media-row');
  if (e.usesMedia && mediaRow.dataset.fx !== String(look.fx)) {
    mediaRow.dataset.fx = String(look.fx);
    mediaPicker(mediaRow, look.media, name => { look.media = name; lookChanged(true); });
  }
  if (!e.usesMedia) mediaRow.dataset.fx = '';
  mediaRow.hidden = !e.usesMedia;
}

function lookChanged(keepDirPicker = false) {
  syncLookControls(keepDirPicker);
  if ($<HTMLInputElement>('live').checked) {
    clearTimeout(liveTimer);
    liveTimer = window.setTimeout(sendLive, 120);
  }
}

async function sendLive() {
  try {
    const r = await api.setLights({ ...look, on: true, dir: lookDir() } as LightState);
    const bad = r.filter(x => !x.ok).length;
    $('live-status').textContent = bad ? `${bad} of ${r.length} controllers didn't respond` : `Sent to ${r.length} controller${r.length === 1 ? '' : 's'}`;
  } catch (e) {
    $('live-status').textContent = String((e as Error).message);
  }
}

// ---------- plants ----------

let ledEditor: LedEditor | null = null;

function buildPlants() {
  renderPlants($('plants'), {
    editLEDs: (p, box, ended) => {
      ledEditor?.stop();
      ledEditor = new LedEditor({ view, data: () => data, layout: () => layout, changed: () => { rebuildLayout(); scheduleSave(); } },
        p, box, () => { ledEditor = null; ended(); });
    },
    data: () => data,
    changed: () => { rebuildLayout(); scheduleSave(); },
    plantColor: i => hex(plantColor(i)),
    lookFromStreet: () => view.lookAlong([0, 0, -4096]),
  });
}

function scheduleSave() {
  dirty = true;
  setSync();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 800);
}

async function save() {
  if (saving) { scheduleSave(); return; }
  saving = true;
  try {
    const r = await api.saveProject(data, revision);
    revision = r.revision;
    dirty = false;
  } catch (e) {
    if (e instanceof ConflictError) {
      // Someone (usually the app) saved first: take their copy.
      data = e.current.data;
      revision = e.current.revision;
      dirty = false;
      rebuildLayout();
      buildPlants();
      projectReplaced();
      setSync('The project changed elsewhere, so your last edit was replaced by the newer copy.');
    } else {
      setSync(`Couldn't save: ${(e as Error).message}`);
    }
  } finally {
    saving = false;
    setSync();
  }
}

function watchForChanges() {
  const es = new EventSource('/api/events');
  es.onmessage = async ev => {
    const { revision: r } = JSON.parse(ev.data);
    if (r > revision && !dirty && !saving) {
      const env = await api.project();
      data = env.data;
      revision = env.revision;
      rebuildLayout();
      buildPlants();
      projectReplaced();
      await loadAreaIfChanged();     // a new yard scan from the app
      setSync();
    }
  };
}

async function pollStatus() {
  try {
    const st = await api.status();
    const dots = $('controllers');
    dots.innerHTML = '';
    for (const c of data.controllers) {
      const d = document.createElement('span');
      d.className = 'dot' + (st[c.id] ? ' on' : '');
      d.title = `${c.name} – ${st[c.id] ? 'online' : 'offline'}`;
      dots.appendChild(d);
    }
  } catch { /* shown on next poll */ }
  setTimeout(pollStatus, 5000);
}

let syncNote = '';
function setSync(note?: string) {
  if (note !== undefined) syncNote = note;
  const leds = data ? layout?.placed.length ?? 0 : 0;
  $('sync').innerHTML = (syncNote ? `<span class="banner">${escapeHtml(syncNote)}</span><br>` : '') +
    `${dirty || saving ? 'Saving…' : `Saved · revision ${revision}`} · ${leds} mapped LEDs`;
}

const TAB_TITLES: Record<string, string> = { look: 'Look', plants: 'Props', shows: 'Shows', schedule: 'Schedule', devices: 'Devices', settings: 'Settings' };
function selectTab(name: string) {
  if (!TAB_TITLES[name]) name = 'look';
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  });
  for (const t of Object.keys(TAB_TITLES)) $(`tab-${t}`).hidden = t !== name;
  $('tab-title').textContent = TAB_TITLES[name];
  document.title = `${TAB_TITLES[name]} · ESPectacle`;
  if (name === 'schedule') buildSchedule();
  if (name === 'settings') void renderSettings($('tab-settings'), () => data);
  if (name === 'devices') renderDevices($('tab-devices'));
  try { localStorage.setItem('tl-tab', name); } catch { /* private window */ }
}

function buildSchedule() {
  renderSchedules($('tab-schedule'), { data: () => data, changed: scheduleSave });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function hsvToInt(h: number, s: number, v: number) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

main();
