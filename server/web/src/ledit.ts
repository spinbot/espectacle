// Fine-tuning a scanned prop's LED positions on the website: click an LED in the 3D view (it lights up
// on the real prop), then nudge it in the directions you see or type its position.
import type { AppData, MappedLED, Plant } from '../../shared/project.js';
import type { Layout } from '../../shared/layout.js';
import type { YardView } from './yard.js';

export interface LedEditHost {
  view: YardView;
  data(): AppData;
  layout(): Layout;
  /** The map changed: recompute the layout and save. */
  changed(): void;
}

const QUALITY = ['not found (guessed)', 'between neighbours', 'one view + LiDAR', 'scanned or set by hand'];
const STEPS = [0.005, 0.01, 0.02, 0.05, 0.1];

export class LedEditor {
  private sel = -1;
  private step = 0.02;
  private undo: { i: number; led: MappedLED }[][] = [];     // each step can change several LEDs
  private anchor = -1;                                      // the other end of a straight run
  private timer = 0;
  private stopped = false;

  constructor(private host: LedEditHost, readonly plant: Plant, private box: HTMLElement, private ended: () => void) {
    host.view.onClick = (x, y) => this.pick(x, y);
    document.addEventListener('keydown', this.keys, true);
    this.timer = window.setInterval(() => this.light(), 800);   // the controller takeover lasts 2.5 s
    this.render();
    // Look at the prop from its front (where it was scanned from), filling the view.
    const th = plant.rotation * Math.PI / 180;
    host.view.frameOn(this.placed().map(p => p.yard), [Math.sin(th), Math.cos(th)]);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.host.view.onClick) this.host.view.onClick = undefined;
    this.host.view.setMarker(null);
    this.host.view.setMarker(null, 1);
    document.removeEventListener('keydown', this.keys, true);
    clearInterval(this.timer);
    this.box.innerHTML = '';
    this.ended();
  }

  private alive() {
    // Stops when its prop card goes away or is hidden (closed, another tab) or the project was replaced.
    const ok = this.box.isConnected && this.box.offsetParent !== null && this.host.data().plants.includes(this.plant) && !!this.plant.map;
    if (!ok) this.stop();
    return ok;
  }

  private placed() { return this.host.layout().placed.filter(p => p.plantID === this.plant.id); }

  private pick(x: number, y: number) {
    if (!this.alive()) return;
    const list = this.placed();
    const i = this.host.view.nearest(list.map(p => p.yard), x, y);
    if (i >= 0) this.select(list[i].ledIndex);
  }

  private select(i: number) {
    const n = this.plant.map!.leds.length;
    this.sel = ((i % n) + n) % n;
    this.render();
    this.mark();
    this.light();
  }

  private mark() {
    const placed = this.placed();
    const p = placed.find(q => q.ledIndex === this.sel), a = placed.find(q => q.ledIndex === this.anchor);
    this.host.view.setMarker(p ? p.yard : null);
    this.host.view.setMarker(a && this.anchor !== this.sel ? a.yard : null, 1);
  }

  /** The run between the two ends (exclusive), when there is one to straighten. */
  private run() {
    if (this.anchor < 0 || this.sel < 0 || Math.abs(this.sel - this.anchor) < 2) return null;
    return { lo: Math.min(this.sel, this.anchor), hi: Math.max(this.sel, this.anchor) };
  }

  /** Spaces the LEDs between the two ends evenly along the straight line joining them. */
  private straighten() {
    const r = this.run(), leds = this.plant.map?.leds;
    if (!r || !leds) return;
    const a = leds[r.lo], b = leds[r.hi], step: { i: number; led: MappedLED }[] = [];
    const round = (n: number) => Math.round(n * 10000) / 10000;
    for (let i = r.lo + 1; i < r.hi; i++) {
      const t = (i - r.lo) / (r.hi - r.lo);
      step.push({ i, led: { ...leds[i] } });
      leds[i] = { ...leds[i], x: round(a.x + (b.x - a.x) * t), y: round(a.y + (b.y - a.y) * t), z: round(a.z + (b.z - a.z) * t), quality: 3, rescan: null };
    }
    this.undo.push(step);
    this.host.changed();
    this.render();
    this.mark();
  }

  /** Lights the selected LED white on the real prop; the rest of its controller goes dark meanwhile. */
  private light() {
    if (!this.alive() || this.sel < 0) return;
    const p = this.placed().find(q => q.ledIndex === this.sel);
    const c = p && this.host.layout().controllers.find(x => x.id === p.controllerID);
    if (!p || !c) return;
    const rgb = new Uint8Array(c.geo.length * 3);
    // A run being straightened: its LEDs dim blue, the other end white too.
    const r = this.run();
    if (r) {
      for (const q of this.placed()) {
        if (q.controllerID !== c.id || q.ledIndex < r.lo || q.ledIndex > r.hi) continue;
        if (q.ledIndex === r.lo || q.ledIndex === r.hi) rgb.fill(255, q.index * 3, q.index * 3 + 3);
        else rgb[q.index * 3 + 2] = 60;
      }
    }
    rgb.fill(255, p.index * 3, p.index * 3 + 3);
    fetch('/api/lights/frame', {
      method: 'POST', credentials: 'same-origin', body: rgb,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Controllers': `${c.id}:${c.geo.length}` },
    }).catch(() => {});
  }

  /** Moves the selected LED by a yard-space offset (metres). */
  private move(dx: number, dy: number, dz: number) {
    const led = this.plant.map?.leds[this.sel];
    if (!led) return;
    // Yard → prop space: undo the prop's turn (see placedLEDs in shared/layout.ts).
    const th = this.plant.rotation * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
    this.set({ x: led.x + dx * cs - dz * sn, y: led.y + dy, z: led.z + dx * sn + dz * cs });
  }

  private set(v: { x?: number; y?: number; z?: number }) {
    const leds = this.plant.map?.leds;
    const led = leds?.[this.sel];
    if (!leds || !led) return;
    this.undo.push([{ i: this.sel, led: { ...led } }]);
    const r = (n: number) => Math.round(n * 10000) / 10000;
    leds[this.sel] = { ...led, x: r(v.x ?? led.x), y: r(v.y ?? led.y), z: r(v.z ?? led.z), quality: 3, rescan: null };
    this.host.changed();
    this.mark();
    this.refreshValues();
  }

  private nudge(dir: 'left' | 'right' | 'up' | 'down' | 'closer' | 'further') {
    const { right, toward } = this.host.view.viewAxes();
    const s = this.step;
    if (dir === 'up') this.move(0, s, 0);
    else if (dir === 'down') this.move(0, -s, 0);
    else {
      const [ax, az] = dir === 'left' || dir === 'right' ? right : toward;
      const k = dir === 'right' || dir === 'closer' ? s : -s;
      this.move(ax * k, 0, az * k);
    }
  }

  private keys = (e: KeyboardEvent) => {
    if (this.stopped || !this.alive()) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const n = this.plant.map!.leds.length;
    let used = true;
    if (e.key === '[') this.select(this.sel < 0 ? n - 1 : this.sel - 1);
    else if (e.key === ']') this.select(this.sel + 1);
    else if (e.altKey && this.sel >= 0 && e.key === 'ArrowLeft') this.nudge('left');
    else if (e.altKey && this.sel >= 0 && e.key === 'ArrowRight') this.nudge('right');
    else if (e.altKey && this.sel >= 0 && e.key === 'ArrowUp') this.nudge(e.shiftKey ? 'further' : 'up');
    else if (e.altKey && this.sel >= 0 && e.key === 'ArrowDown') this.nudge(e.shiftKey ? 'closer' : 'down');
    else if ((e.metaKey || e.ctrlKey) && e.key === 'z') this.undoLast();
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); }
  };

  private undoLast() {
    const step = this.undo.pop();
    const leds = this.plant.map?.leds;
    if (!step || !leds) return;
    for (const u of step) if (u.i < leds.length) leds[u.i] = u.led;
    this.host.changed();
    const first = step[0]?.i ?? this.sel;
    if (step.length === 1 && first !== this.sel) this.select(first);
    else { this.render(); this.mark(); }
  }

  private refreshValues() {
    const led = this.plant.map?.leds[this.sel];
    if (!led) return;
    for (const k of ['x', 'y', 'z'] as const) {
      const inp = this.box.querySelector<HTMLInputElement>(`[data-v="${k}"]`);
      if (inp && document.activeElement !== inp) inp.value = (led[k]).toFixed(3);
    }
    const q = this.box.querySelector('[data-q]');
    if (q) q.textContent = QUALITY[led.quality] ?? '';
    const u = this.box.querySelector<HTMLButtonElement>('[data-undo]');
    if (u) u.disabled = !this.undo.length;
  }

  private render() {
    const map = this.plant.map!;
    const led = map.leds[this.sel];
    const btn = (d: string, label: string, title: string) => `<button data-n="${d}" title="${title}">${label}</button>`;
    this.box.innerHTML = `<div class="ledit">
      <p class="hint">Click an LED of this prop in the 3D view. It lights up white on the real prop (the rest of its
        controller goes dark while you edit) and gets a yellow ring here. Move it with the arrows: they follow the view,
        so ← moves it left as you see it.</p>
      ${led ? `
      <div class="row"><button data-prev title="Previous LED ([)">‹</button><b>LED <input data-goto type="number" min="1" max="${map.leds.length}" value="${this.sel + 1}" title="Go to LED number"> of ${map.leds.length}</b>
        <button data-next title="Next LED (])">›</button> <span class="sub" data-q></span></div>
      <div class="nudge">
        <span></span>${btn('up', '↑', 'Up (Alt+↑)')}<span></span>${btn('further', 'Further', 'Away from you (Alt+Shift+↑)')}
        ${btn('left', '←', 'Left (Alt+←)')}${btn('down', '↓', 'Down (Alt+↓)')}${btn('right', '→', 'Right (Alt+→)')}${btn('closer', 'Closer', 'Towards you (Alt+Shift+↓)')}
      </div>
      <label class="field">Step <select data-step>${STEPS.map(s => `<option value="${s}" ${s === this.step ? 'selected' : ''}>${s * 100} cm</option>`).join('')}</select></label>
      <div class="grid">${(['x', 'y', 'z'] as const).map(k => `<label>${k.toUpperCase()} (m, prop) <input data-v="${k}" type="number" step="0.005"></label>`).join('')}</div>
      <h4>Straight run</h4>
      ${this.anchor < 0 ? `<p class="hint">For a straight section: put each end in the right place, mark one end, select the other, then straighten.</p>
        <div class="row"><button data-anchor>Mark LED ${this.sel + 1} as one end</button></div>` : `
        <p class="hint">One end: LED ${this.anchor + 1} (cyan ring). ${this.run() ? `Other end: LED ${this.sel + 1}.` : 'Now select the other end (click it, or use ‹ ›).'}</p>
        <div class="row">${this.run() ? `<button data-straighten>Straighten the ${this.run()!.hi - this.run()!.lo - 1} LEDs between</button>` : ''}
          <button data-anchor-clear>Clear the end</button></div>`}` : ''}
      <div class="row"><button data-undo title="Undo (Ctrl/⌘+Z)">Undo</button><button data-done>Done</button></div>
      <p class="hint">Keys: [ and ] previous / next LED; Alt+arrows move it; Alt+Shift+↑/↓ further / closer.
        Moved LEDs count as good (green), so a partial scan in the app leaves them alone.</p></div>`;
    const q = <T extends Element = HTMLElement>(s: string) => this.box.querySelector<T>(s);
    q<HTMLButtonElement>('[data-done]')!.onclick = () => this.stop();
    q<HTMLButtonElement>('[data-undo]')!.onclick = () => this.undoLast();
    if (led) {
      q<HTMLButtonElement>('[data-prev]')!.onclick = () => this.select(this.sel - 1);
      q<HTMLButtonElement>('[data-next]')!.onclick = () => this.select(this.sel + 1);
      const go = q<HTMLInputElement>('[data-goto]')!;
      go.onchange = () => { const v = Math.round(Number(go.value)); if (v >= 1 && v <= map.leds.length) this.select(v - 1); };
      this.box.querySelectorAll<HTMLButtonElement>('[data-n]').forEach(b => b.onclick = () => this.nudge(b.dataset.n as 'up'));
      q<HTMLButtonElement>('[data-anchor]')?.addEventListener('click', () => { this.anchor = this.sel; this.render(); this.mark(); });
      q<HTMLButtonElement>('[data-anchor-clear]')?.addEventListener('click', () => { this.anchor = -1; this.render(); this.mark(); this.light(); });
      q<HTMLButtonElement>('[data-straighten]')?.addEventListener('click', () => this.straighten());
      q<HTMLSelectElement>('[data-step]')!.onchange = e => { this.step = Number((e.target as HTMLSelectElement).value); };
      this.box.querySelectorAll<HTMLInputElement>('[data-v]').forEach(inp => {
        // No accidental changes from the scroll wheel; a big jump is probably a typo (22.4 for 2.24).
        inp.addEventListener('wheel', e => { if (document.activeElement === inp) e.preventDefault(); }, { passive: false });
        inp.onchange = () => {
          const v = Number(inp.value), k = inp.dataset.v as 'x' | 'y' | 'z';
          const led = this.plant.map?.leds[this.sel];
          if (!Number.isFinite(v) || !led) return;
          if (Math.abs(v - led[k]) > 0.5 && !confirm(`Move LED ${this.sel + 1} by ${(v - led[k]).toFixed(2)} m along ${k.toUpperCase()}?`)) {
            inp.value = led[k].toFixed(3);
            return;
          }
          this.set({ [k]: v });
        };
      });
    }
    this.refreshValues();
  }
}
