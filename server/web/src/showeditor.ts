// The web show editor: timeline, music, transport and the clip / track / show inspector.
// Shows are stored in the project exactly as the app saves them, so either can edit them.
import { Timeline, clock, LANE_H, RULER_H, WAVE_H, type Selection } from './timeline.js';
import { MusicPlayer, analyse } from './audio.js';
import type { ZoneFrame } from './fx.js';
import { compileShow, activeSegments, newTrack, normaliseShow, uuid, type Show, type ShowClip, type ShowTrack, type Segment } from '../../shared/show.js';
import { dirPicker, showDirArrow } from './dirpicker.js';
import { showSources, type OnlineSource } from '../../shared/onlineframe.js';
import { mediaPicker } from './mediapicker.js';
import { toLocalInput, fromLocalInput } from './dates.js';
import { EFFECTS, ALL_EFFECTS, PALETTES, fxInfo } from '../../shared/catalog.js';
import { zoneOfPlantAt, type Layout } from '../../shared/layout.js';
import type { AppData } from '../../shared/project.js';

export interface EditorHost {
  data(): AppData;
  layout(): Layout;
  save(): void;
  plantColor(i: number): string;
  closed(): void;
}

const OTHER_ZONE = 31;
const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const hex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class ShowEditor {
  private timeline: Timeline;
  private music = new MusicPlayer();
  private segments: Segment[] = [];
  private loadedAudio: string | null = null;
  private playing = false;
  /** Sending the preview to the real lights (the page draws the frames, see main.ts). */
  projecting = false;
  private analysedBpm: { bpm: number | null; offset: number } | null = null;

  constructor(private host: EditorHost, private showId: string, private pane: HTMLElement, private side: HTMLElement) {
    pane.hidden = false;
    pane.innerHTML = `
      <div class="transport">
        <button id="t-play" title="Play / pause (space)">▶</button>
        <button id="t-stop" title="Back to the start">⏮</button>
        <span id="t-time" class="time"></span>
        <button id="t-lights" class="lights" title="Show this on the real lights: this computer draws every frame and the server sends it to the controllers. They go back to normal a few seconds after you turn it off.">💡 On the lights</button>
        <span class="spacer"></span>
        <label class="toggle"><input id="t-snap" type="checkbox" checked> Snap to beats</label>
        <label class="toggle"><input id="t-follow" type="checkbox" checked> Follow</label>
        <button id="t-zoomout" title="Zoom out">−</button>
        <button id="t-zoomin" title="Zoom in">+</button>
      </div>
      <div class="tl-body">
        <div class="tl-labels"></div>
        <div class="tl-canvas"></div>
      </div>`;
    this.timeline = new Timeline({
      show: () => this.show,
      changed: () => this.changed(),
      selected: sel => this.renderInspector(sel),
      seek: t => this.seek(t),
      playing: () => this.playing,
    }, $('.tl-canvas', pane));

    $('#t-play', pane).onclick = () => this.toggle();
    $('#t-stop', pane).onclick = () => { this.stop(); this.seek(0); };
    $('#t-lights', pane).onclick = () => this.setProjecting(!this.projecting);
    $<HTMLInputElement>('#t-snap', pane).onchange = e => { this.timeline.snap = (e.target as HTMLInputElement).checked; };
    $<HTMLInputElement>('#t-follow', pane).onchange = e => { this.timeline.follow = (e.target as HTMLInputElement).checked; };
    $('#t-zoomin', pane).onclick = () => this.timeline.zoom(1.5);
    $('#t-zoomout', pane).onclick = () => this.timeline.zoom(1 / 1.5);
    document.addEventListener('keydown', this.keys);

    this.recompile();
    this.renderLabels();
    this.renderInspector(null);
    this.loadMusic();
    this.timeline.draw();
  }

  get show(): Show {
    const s = (this.host.data().shows as Show[]).find(x => x.id === this.showId);
    return s ?? { id: this.showId, name: '', duration: 60, beatOffset: 0, latencyMs: 0, tracks: [] };
  }

  get exists() { return (this.host.data().shows as Show[]).some(x => x.id === this.showId); }

  setProjecting(on: boolean, error?: string) {
    this.projecting = on;
    const b = this.pane.querySelector<HTMLButtonElement>('#t-lights');
    if (!b) return;
    b.classList.toggle('on', on);
    b.textContent = on ? '💡 On the lights ●' : '💡 On the lights';
    if (error) b.title = `Couldn't reach the server: ${error}`;
  }

  close() {
    this.projecting = false;
    this.stop();
    document.removeEventListener('keydown', this.keys);
    this.pane.hidden = true;
    this.pane.innerHTML = '';
    this.music.ctx.close();
  }

  /** The project was replaced (another device saved): redraw from the new copy. */
  refresh() {
    if (!this.exists) { this.host.closed(); return; }
    this.recompile();
    this.renderLabels();
    this.renderInspector(this.timeline.selection);
    this.loadMusic();
    this.timeline.draw();
  }

  private keys = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.timeline.selection?.clip) {
      e.preventDefault();
      this.deleteClip(this.timeline.selection.track, this.timeline.selection.clip);
    }
  };

  // ---------- simulation ----------

  private recompile() {
    const d = this.host.data(), layout = this.host.layout();
    this.segments = compileShow(this.show, d.plants, zoneOfPlantAt, OTHER_ZONE, layout.groupFrame);
  }

  private changed() {
    this.recompile();
    this.host.save();
  }

  /** What every zone shows right now (for the 3D preview). */
  zonesNow(): ZoneFrame[] {
    const tMs = Math.round(this.timeline.position * 1000);
    return [...activeSegments(this.segments, tMs).values()].map(s => ({
      zone: s.zone, fx: s.fx, pal: s.pal, bri: s.bri, scl: s.scl, rate: s.rate, c1: s.c1, c2: s.c2,
      mode: s.mode, group: s.group, ms: tMs - s.p0, dir: s.dir,
    }));
  }

  /** Online effects (marquee, video) showing right now, for the preview. */
  onlineNow(): OnlineSource[] {
    return showSources(this.segments, Math.round(this.timeline.position * 1000), Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  /** Called every animation frame by the page. */
  tick() {
    if (this.playing) {
      const t = this.music.position;
      if (t >= this.show.duration) { this.stop(); this.timeline.setPosition(this.show.duration); }
      else this.timeline.setPosition(Math.max(0, t));
    }
    $('#t-time', this.pane).textContent = `${clock(this.timeline.position)} / ${clock(this.show.duration)}`;
  }

  // ---------- transport ----------

  private toggle() { this.playing ? this.stop() : this.play(); }

  private play() {
    this.music.play(this.timeline.position);
    this.playing = true;
    $('#t-play', this.pane).textContent = '❚❚';
  }

  private stop() {
    if (this.playing) this.timeline.position = Math.max(0, this.music.position);
    this.music.stop();
    this.playing = false;
    const b = this.pane.querySelector('#t-play');
    if (b) b.textContent = '▶';
  }

  private seek(t: number) {
    t = Math.min(Math.max(0, t), this.show.duration);
    if (this.playing) this.music.play(t);
    this.timeline.setPosition(t);
  }

  // ---------- music ----------

  private async loadMusic() {
    const file = this.show.audioFile ?? null;
    if (file === this.loadedAudio) return;
    this.loadedAudio = file;
    this.timeline.envelope = undefined;
    this.music.buffer = undefined;
    this.timeline.draw();
    if (!file) return;
    try {
      const res = await fetch(`/api/audio/${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await this.music.load(await res.arrayBuffer());
      const a = analyse(buf);
      this.timeline.envelope = a.envelope;
      this.analysedBpm = { bpm: a.bpm, offset: a.beatOffset };
      const s = this.show;
      let edited = false;
      if (Math.abs(s.duration - a.duration) > 0.01) { s.duration = a.duration; edited = true; }
      if (s.bpm == null && a.bpm) { s.bpm = a.bpm; s.beatOffset = a.beatOffset; edited = true; }
      if (edited) this.changed();
      this.renderInspector(this.timeline.selection);
    } catch (e) {
      this.loadedAudio = null;
      alert(`Couldn't load the music: ${(e as Error).message}`);
    }
    this.timeline.draw();
  }

  private async uploadMusic(file: File) {
    const ext = (file.name.split('.').pop() ?? 'mp3').replace(/[^A-Za-z0-9]/g, '') || 'mp3';
    const name = `${uuid()}.${ext}`;
    const res = await fetch(`/api/audio/${name}`, { method: 'PUT', body: file });
    if (!res.ok) { alert(`Upload failed (HTTP ${res.status})`); return; }
    const s = this.show;
    s.audioFile = name;
    s.audioName = file.name.replace(/\.[^.]+$/, '');
    s.bpm = null;                // detected afresh
    s.beatOffset = 0;
    this.changed();
    await this.loadMusic();
  }

  // ---------- track labels ----------

  private renderLabels() {
    const box = $('.tl-labels', this.pane);
    const d = this.host.data();
    box.innerHTML = `<div class="tl-label head" style="height:${RULER_H}px">Time</div>
      <div class="tl-label head" style="height:${WAVE_H}px">${esc(this.show.audioName ?? 'No music')}</div>`;
    this.show.tracks.forEach(t => {
      const div = document.createElement('div');
      div.className = 'tl-label track' + (this.timeline.selection?.track === t.id && !this.timeline.selection.clip ? ' sel' : '');
      div.style.height = LANE_H + 'px';
      const names = t.targets.map(id => d.plants.findIndex(p => p.id === id)).filter(i => i >= 0);
      const name = t.targets.length === 0 ? 'All props' : names.length === 1 ? d.plants[names[0]].name : `${names.length} props`;
      const colour = names.length === 1 ? this.host.plantColor(names[0]) : '#e5e7eb';
      const grouped = t.targets.length === 0 || names.length > 1;
      div.innerHTML = `<span class="chip" style="background:${colour}"></span>
        <span><b>${esc(name)}</b>${grouped ? `<br><small>${t.together ? 'as one' : 'each own'}</small>` : ''}</span>
        ${t.muted ? '<span title="Muted">🔇</span>' : ''}`;
      div.onclick = () => this.timeline.select({ track: t.id });
      box.appendChild(div);
    });
    const add = document.createElement('button');
    add.textContent = '+ Track';
    add.className = 'add-track';
    add.onclick = () => { this.show.tracks.push(newTrack()); this.changed(); this.renderLabels(); this.timeline.draw(); };
    box.appendChild(add);
  }

  // ---------- inspector ----------

  private renderInspector(sel: Selection | null) {
    this.renderLabels();
    showDirArrow(null);
    const s = this.show;
    const track = sel ? s.tracks.find(t => t.id === sel.track) : undefined;
    const clip = sel?.clip ? track?.clips.find(c => c.id === sel.clip) : undefined;
    this.side.innerHTML = `
      <div class="show-head"><button id="i-back" class="secondary">← All shows</button></div>
      <div id="i-body"></div>
      <details id="i-show" ${clip || track ? '' : 'open'}><summary>Show settings</summary><div id="i-settings"></div></details>`;
    $('#i-back', this.side).onclick = () => this.host.closed();
    const body = $('#i-body', this.side);
    if (clip && track) this.clipInspector(body, track, clip);
    else if (track) this.trackInspector(body, track);
    else body.innerHTML = `<p class="hint">Click an empty spot on a track to add a clip. Drag a clip to move it (up or down to another track), drag its right edge to change its length, Delete removes it. Click the ruler to move the playhead; space plays. Scroll sideways with the trackpad (or shift + wheel) and pinch or ctrl + wheel to zoom.</p>
      <p class="hint">Tracks lower in the list win where they overlap.</p>`;
    this.settingsInspector($('#i-settings', this.side));
  }

  private clipInspector(box: HTMLElement, track: ShowTrack, c: ShowClip) {
    const e = fxInfo(c.fx) ?? EFFECTS[0];
    const bpm = this.show.bpm;
    const custom = e.usesPalette && c.pal === 0;
    box.innerHTML = `
      <h2>Effect</h2><div class="effect-grid">${ALL_EFFECTS.map(x => `<button data-fx="${x.id}" class="${x.id === c.fx ? 'active' : ''}${x.online ? ' online' : ''}" title="${x.online ? 'Online: drawn by the server' : ''}">${x.name}</button>`).join('')}</div>
      ${e.usesPalette ? `<h2>Palette</h2><div class="palettes">${PALETTES.map(p => {
        const cols = p.id === 0 ? [c.c1, c.c2] : p.colors;
        return `<button data-pal="${p.id}" class="${p.id === c.pal ? 'active' : ''}"><div class="swatch" style="background:linear-gradient(90deg,${cols.map(hex).join(',')})"></div><span class="name">${p.name}</span></button>`;
      }).join('')}</div>` : ''}
      <div class="row colors">
        ${e.usesColor1 || custom ? `<label>Colour 1 <input id="c-c1" type="color" value="${hex(c.c1)}"></label>` : ''}
        ${e.usesColor2 || custom ? `<label>Colour 2 <input id="c-c2" type="color" value="${hex(c.c2)}"></label>` : ''}
      </div>
      <label class="slider">Brightness <input id="c-bri" type="range" min="0" max="255" value="${c.bri}"></label>
      ${e.scaleLabel ? `<label class="slider">${e.scaleLabel} <input id="c-scl" type="range" min="0" max="255" value="${c.scl}"></label>` : ''}
      ${e.usesText ? `<label class="field">${e.usesTarget ? 'When it gets there, show' : 'Text'} <input id="c-text" maxlength="200" value="${esc(c.text ?? '')}" placeholder="${e.usesTarget ? 'MERRY CHRISTMAS' : 'Merry Christmas'}"></label>` : ''}
      ${e.usesTarget ? `<label class="field">Count down to <input id="c-target" type="datetime-local" value="${c.target ? toLocalInput(c.target) : ''}"></label><p class="hint">Empty: Christmas Day.</p>` : ''}
      ${e.usesMedia ? '<div id="c-media"></div>' : ''}
      ${e.online ? '<p class="hint">Online effect: drawn by the server and streamed to the lights, so the server must be running.</p>' : ''}
      ${e.usesDirection || e.usesView ? '<div id="c-dir"></div>' : ''}
      ${c.fx !== 0 ? `<h2>Speed</h2>${bpm ? `<label class="field">Cycle <select id="c-beats">
          ${[0.5, 1, 2, 4, 8, 16, 32].filter(b => b * 60 / bpm >= 0.26).map(b => `<option value="${b}" ${c.beats === b ? 'selected' : ''}>${b === 0.5 ? '½ beat' : b === 1 ? '1 beat' : `${b} beats`}</option>`).join('')}
          <option value="free" ${c.beats == null ? 'selected' : ''}>Free (seconds)</option></select></label>` : ''}
        ${c.beats == null || !bpm ? `<label class="field">Seconds per cycle <input id="c-secs" type="number" min="0.3" max="60" step="0.1" value="${c.seconds}"></label>` : ''}` : ''}
      <h2>Timing</h2>
      <div class="row"><label class="field">Start (s) <input id="c-start" type="number" step="0.05" min="0" value="${c.start.toFixed(2)}"></label>
      <label class="field">Length (s) <input id="c-dur" type="number" step="0.05" min="0.1" value="${c.duration.toFixed(2)}"></label></div>
      <div class="row"><button id="c-dup">Duplicate</button><button id="c-play">Play from here</button><button id="c-del" class="danger">Delete</button></div>`;
    const edit = (f: () => void, redraw = false) => {
      f();
      this.timeline.template = { fx: c.fx, pal: c.pal, bri: c.bri, scl: c.scl, c1: c.c1, c2: c.c2, beats: c.beats, seconds: c.seconds, dirYaw: c.dirYaw ?? null, dirPitch: c.dirPitch ?? null, text: c.text ?? null, media: c.media ?? null, target: c.target ?? null };
      this.changed();
      this.timeline.draw();
      if (redraw) this.renderInspector(this.timeline.selection);
    };
    box.querySelectorAll<HTMLButtonElement>('[data-fx]').forEach(b => b.onclick = () => edit(() => {
      const nf = Number(b.dataset.fx);
      // A direction of travel and a camera view mean different things: start afresh when switching.
      if (!!fxInfo(c.fx)?.usesView !== !!fxInfo(nf)?.usesView) { c.dirYaw = null; c.dirPitch = null; }
      c.fx = nf;
    }, true));
    box.querySelectorAll<HTMLButtonElement>('[data-pal]').forEach(b => b.onclick = () => edit(() => { c.pal = Number(b.dataset.pal); }, true));
    const num = (id: string, f: (v: number) => void, redraw = false) => {
      const el = box.querySelector<HTMLInputElement | HTMLSelectElement>(id);
      if (el) el.oninput = () => edit(() => f(Number(el.value)), redraw);
    };
    const col = (id: string, f: (v: number) => void) => {
      const el = box.querySelector<HTMLInputElement>(id);
      if (el) el.oninput = () => edit(() => f(parseInt(el.value.slice(1), 16)));
    };
    col('#c-c1', v => { c.c1 = v; });
    col('#c-c2', v => { c.c2 = v; });
    num('#c-bri', v => { c.bri = v; });
    num('#c-scl', v => { c.scl = v; });
    num('#c-secs', v => { if (v > 0) c.seconds = v; });
    num('#c-start', v => { if (v >= 0) c.start = v; });
    num('#c-dur', v => { if (v > 0) c.duration = v; });
    const beats = box.querySelector<HTMLSelectElement>('#c-beats');
    if (beats) beats.onchange = () => edit(() => { c.beats = beats.value === 'free' ? null : Number(beats.value); }, true);
    const textIn = box.querySelector<HTMLInputElement>('#c-text');
    if (textIn) textIn.oninput = () => edit(() => { c.text = textIn.value; });
    const targetIn = box.querySelector<HTMLInputElement>('#c-target');
    if (targetIn) targetIn.onchange = () => edit(() => { c.target = fromLocalInput(targetIn.value); });
    const mediaBox = box.querySelector<HTMLElement>('#c-media');
    if (mediaBox) mediaPicker(mediaBox, c.media, name => edit(() => { c.media = name; }));
    const dirBox = box.querySelector<HTMLElement>('#c-dir');
    if (dirBox) dirPicker(dirBox, { yaw: c.dirYaw ?? null, pitch: c.dirPitch ?? null }, { camera: e.usesView, defaultLabel: e.dirDefault },
      d => edit(() => { c.dirYaw = d.yaw; c.dirPitch = d.pitch; }));
    $('#c-dup', box).onclick = () => {
      const d: ShowClip = { ...c, id: uuid(), start: c.start + c.duration };
      track.clips.push(d);
      track.clips.sort((a, b) => a.start - b.start);
      this.changed();
      this.timeline.select({ track: track.id, clip: d.id });
    };
    $('#c-play', box).onclick = () => { this.seek(c.start); if (!this.playing) this.play(); };
    $('#c-del', box).onclick = () => this.deleteClip(track.id, c.id);
  }

  private deleteClip(trackId: string, clipId: string) {
    const t = this.show.tracks.find(x => x.id === trackId);
    if (!t) return;
    t.clips = t.clips.filter(c => c.id !== clipId);
    this.changed();
    this.timeline.select({ track: trackId });
  }

  private trackInspector(box: HTMLElement, t: ShowTrack) {
    const d = this.host.data();
    const idx = this.show.tracks.indexOf(t);
    box.innerHTML = `
      <h2>Plays on</h2>
      <label class="check"><input type="checkbox" data-all ${t.targets.length === 0 ? 'checked' : ''}> All props</label>
      ${d.plants.map((p, i) => `<label class="check"><input type="checkbox" data-plant="${p.id}" ${t.targets.includes(p.id) ? 'checked' : ''}>
        <span class="chip" style="background:${this.host.plantColor(i)}"></span>${esc(p.name)}</label>`).join('')}
      <h2>Animate</h2>
      <label class="check"><input type="radio" name="tog" value="0" ${t.together ? '' : 'checked'}> Each prop on its own</label>
      <label class="check"><input type="radio" name="tog" value="1" ${t.together ? 'checked' : ''}> All as one prop</label>
      <p class="hint">${t.together ? 'The props are treated as one big prop: spirals wind round the whole group, sweeps cross it.' : 'Every prop runs the effect by itself, fitted to its own size.'}</p>
      <label class="check"><input type="checkbox" id="t-mute" ${t.muted ? 'checked' : ''}> Mute</label>
      <div class="row">
        <button id="t-up" ${idx === 0 ? 'disabled' : ''}>Move up</button>
        <button id="t-down" ${idx === this.show.tracks.length - 1 ? 'disabled' : ''}>Move down</button>
        <button id="t-del" class="danger">Delete track</button>
      </div>`;
    const edit = (f: () => void) => { f(); this.changed(); this.renderInspector(this.timeline.selection); this.timeline.draw(); };
    $<HTMLInputElement>('[data-all]', box).onchange = () => edit(() => { t.targets = []; });
    box.querySelectorAll<HTMLInputElement>('[data-plant]').forEach(el => el.onchange = () => edit(() => {
      const id = el.dataset.plant!;
      t.targets = el.checked ? [...t.targets, id] : t.targets.filter(x => x !== id);
    }));
    box.querySelectorAll<HTMLInputElement>('[name=tog]').forEach(el => el.onchange = () => edit(() => { t.together = el.value === '1'; }));
    $<HTMLInputElement>('#t-mute', box).onchange = e => edit(() => { t.muted = (e.target as HTMLInputElement).checked; });
    const move = (dir: number) => edit(() => {
      const arr = this.show.tracks;
      [arr[idx], arr[idx + dir]] = [arr[idx + dir], arr[idx]];
    });
    $('#t-up', box).onclick = () => move(-1);
    $('#t-down', box).onclick = () => move(1);
    $('#t-del', box).onclick = () => {
      if (t.clips.length && !confirm(`Delete this track and its ${t.clips.length} clips?`)) return;
      this.show.tracks.splice(idx, 1);
      this.changed();
      this.timeline.select(null);
    };
  }

  private settingsInspector(box: HTMLElement) {
    const s = this.show;
    box.innerHTML = `
      <label class="field">Name <input id="s-name" type="text" value="${esc(s.name)}"></label>
      <label class="field">Music <span class="hint">${esc(s.audioName ?? 'None')}</span></label>
      <input id="s-file" type="file" accept="audio/*,.mp3,.m4a,.wav,.aiff" hidden>
      <div class="row"><button id="s-choose">${s.audioFile ? 'Replace music…' : 'Choose music…'}</button></div>
      ${s.audioFile ? '' : `<label class="field">Length (s) <input id="s-len" type="number" min="5" step="5" value="${Math.round(s.duration)}"></label>`}
      <h2>Beat grid</h2>
      <div class="row"><label class="field">Tempo (BPM) <input id="s-bpm" type="number" min="0" step="0.1" value="${s.bpm ?? ''}"></label>
      <label class="field">First beat (s) <input id="s-off" type="number" step="0.01" value="${s.beatOffset.toFixed(2)}"></label></div>
      <div class="row"><button id="s-half">Half</button><button id="s-double">Double</button><button id="s-detect" ${this.analysedBpm?.bpm ? '' : 'disabled'}>Detect</button><button id="s-here">Beat at playhead</button></div>
      <label class="slider">Lights delay: <span id="s-latv">${Math.round(s.latencyMs)}</span> ms <input id="s-lat" type="range" min="-500" max="500" step="10" value="${s.latencyMs}"></label>
      <p class="hint">Lights delay is used when the show plays on the real lights from the app.</p>`;
    const edit = (f: () => void, re = false) => { f(); this.changed(); this.timeline.draw(); if (re) this.renderInspector(this.timeline.selection); };
    $<HTMLInputElement>('#s-name', box).onchange = e => edit(() => { s.name = (e.target as HTMLInputElement).value || 'Show'; });
    const file = $<HTMLInputElement>('#s-file', box);
    $('#s-choose', box).onclick = () => file.click();
    file.onchange = () => { if (file.files?.[0]) this.uploadMusic(file.files[0]); };
    const len = box.querySelector<HTMLInputElement>('#s-len');
    if (len) len.onchange = () => edit(() => { s.duration = Math.max(5, Number(len.value)); });
    $<HTMLInputElement>('#s-bpm', box).onchange = e => edit(() => { const v = Number((e.target as HTMLInputElement).value); s.bpm = v > 0 ? v : null; });
    $<HTMLInputElement>('#s-off', box).onchange = e => edit(() => { s.beatOffset = Number((e.target as HTMLInputElement).value) || 0; });
    $('#s-half', box).onclick = () => edit(() => { if (s.bpm) s.bpm /= 2; }, true);
    $('#s-double', box).onclick = () => edit(() => { if (s.bpm) s.bpm *= 2; }, true);
    $('#s-detect', box).onclick = () => edit(() => { if (this.analysedBpm?.bpm) { s.bpm = this.analysedBpm.bpm; s.beatOffset = this.analysedBpm.offset; } }, true);
    $('#s-here', box).onclick = () => edit(() => {
      const t = this.timeline.position;
      s.beatOffset = s.bpm ? t % (60 / s.bpm) : t;
    }, true);
    const lat = $<HTMLInputElement>('#s-lat', box);
    lat.oninput = () => { $('#s-latv', box).textContent = lat.value; };
    lat.onchange = () => edit(() => { s.latencyMs = Number(lat.value); });
  }
}

/** List of shows in the sidebar, with New / Delete. */
export function renderShowList(box: HTMLElement, data: AppData, open: (id: string) => void, save: () => void) {
  const shows = data.shows as Show[];
  box.innerHTML = `<div class="show-list">${shows.map(s => {
    const clips = s.tracks.reduce((n, t) => n + t.clips.length, 0);
    return `<div class="show-item" data-id="${s.id}"><div><b>${esc(s.name)}</b><br><small>${esc(s.audioName ?? 'No music')} · ${clips} clip${clips === 1 ? '' : 's'}${s.bpm ? ` · ${Math.round(s.bpm)} BPM` : ''}</small></div>
      <button data-del="${s.id}" class="secondary" title="Delete show">✕</button></div>`;
  }).join('')}</div><button id="new-show">+ New show</button>
  <p class="hint">Shows made here appear in the app (and the other way round). Play them on the real lights from the app.</p>`;
  box.querySelectorAll<HTMLElement>('.show-item').forEach(el => el.onclick = e => {
    if ((e.target as HTMLElement).dataset.del) return;
    open(el.dataset.id!);
  });
  box.querySelectorAll<HTMLButtonElement>('[data-del]').forEach(b => b.onclick = () => {
    const s = shows.find(x => x.id === b.dataset.del);
    if (!s || !confirm(`Delete the show "${s.name}"?`)) return;
    data.shows = shows.filter(x => x !== s);
    save();
    renderShowList(box, data, open, save);
  });
  $('#new-show', box).onclick = () => {
    const s = normaliseShow({ id: uuid(), name: `Show ${shows.length + 1}`, tracks: [newTrack()] });
    data.shows = [...shows, s];
    save();
    open(s.id);
  };
}

