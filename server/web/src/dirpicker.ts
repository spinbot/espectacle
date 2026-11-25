// Direction picker for effects that move (Sweep, Meteor, Clouds...): "default" or yaw/pitch,
// with presets. Directions are as seen from the street: right = +X, up = +Y, towards you = +Z.
import { DIR_PRESETS, VIEW_PRESETS, dirVector } from '../../shared/catalog.js';

export interface Dir { yaw: number | null; pitch: number | null }

type ArrowFn = (v: number[] | null, camera: boolean) => void;
let arrowHandler: ArrowFn = () => {};
let lookHandler: (v: number[]) => void = () => {};
/** The 3D view registers here to draw the chosen direction (an arrow, or a camera for 2D effects). */
export function onDirArrow(f: ArrowFn) { arrowHandler = f; }
export function showDirArrow(v: number[] | null, camera = false) { arrowHandler(v, camera); }
/** The 3D view registers here to jump to the camera's point of view. */
export function onLookThrough(f: (v: number[]) => void) { lookHandler = f; }

export interface PickerOptions { camera?: boolean; defaultLabel?: string }

/**
 * Direction picker. For moving effects it is the direction of travel; for 2D (camera) effects it is
 * where the camera looks from (stored the same way: the direction it looks in).
 */
export function dirPicker(box: HTMLElement, cur: Dir, opts: PickerOptions, changed: (d: Dir) => void) {
  const cam = !!opts.camera;
  const defaultLabel = opts.defaultLabel ?? (cam ? 'From the street' : 'default');
  const isDefault = cur.yaw == null || cur.pitch == null;
  const yaw = cur.yaw ?? (cam ? 90 : 0), pitch = cur.pitch ?? 0;
  const presets = cam ? VIEW_PRESETS : DIR_PRESETS;
  const vec = () => dirVector(cur.yaw ?? yaw, cur.pitch ?? pitch);
  box.innerHTML = `
    <h2>${cam ? 'Camera' : 'Direction'}</h2>
    <div class="dir-presets">
      <button data-def class="${isDefault ? 'active' : ''}" title="${cam ? 'Looking from the street' : "The effect's own movement"}">Default · ${defaultLabel}</button>
      ${presets.map(p => `<button data-yaw="${p.yaw}" data-pitch="${p.pitch}" class="${!isDefault && p.yaw === yaw && p.pitch === pitch ? 'active' : ''}">${p.name}</button>`).join('')}
    </div>
    <div class="dir-sliders" ${isDefault ? 'hidden' : ''}>
      <label class="slider">Turn <span class="val">${Math.round(yaw)}°</span><input data-k="yaw" type="range" min="0" max="359" value="${yaw}"></label>
      <label class="slider">Tilt <span class="val">${Math.round(pitch)}°</span><input data-k="pitch" type="range" min="-90" max="90" value="${pitch}"></label>
    </div>
    ${cam ? `<button data-look class="secondary">Look through the camera</button>
    <p class="hint">The picture is drawn as seen from the camera (shown in the 3D view). Turn moves it round the yard; tilt looks down from above or up from below.</p>`
          : '<p class="hint">As seen from the street. The arrow in the 3D view shows the way it moves.</p>'}`;
  const set = (d: Dir) => {
    changed(d);
    dirPicker(box, d, opts, changed);
  };
  const look = box.querySelector<HTMLButtonElement>('[data-look]');
  if (look) look.onclick = () => lookHandler(vec());
  box.querySelector<HTMLButtonElement>('[data-def]')!.onclick = () => set({ yaw: null, pitch: null });
  box.querySelectorAll<HTMLButtonElement>('[data-yaw]').forEach(b =>
    b.onclick = () => set({ yaw: Number(b.dataset.yaw), pitch: Number(b.dataset.pitch) }));
  box.querySelectorAll<HTMLInputElement>('input[data-k]').forEach(el => {
    el.oninput = () => {
      if (el.dataset.k === 'yaw') cur.yaw = Number(el.value); else cur.pitch = Number(el.value);
      const d: Dir = { yaw: cur.yaw ?? 0, pitch: cur.pitch ?? 0 };
      (el.previousElementSibling as HTMLElement).textContent = `${el.value}°`;
      changed(d);
      showDirArrow(dirVector(d.yaw!, d.pitch!), cam);
      box.querySelectorAll('[data-yaw]').forEach(b => b.classList.remove('active'));
    };
  });
  showDirArrow(isDefault && !cam ? null : dirVector(yaw, pitch), cam);
}
