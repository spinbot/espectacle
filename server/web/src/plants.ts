// The Plants tab: position, wiring (whole strings or LED ranges), drawn shapes, cloning.
import type { AppData, Plant, PlantPart, PlantShape, ShapeKind } from '../../shared/project.js';
import { mapIsCurrent, ledCountOf, ledOwners, stringsOf, fitMap, reverseMap } from '../../shared/layout.js';
import { SHAPE_NAMES, newShape, shapeMap } from '../../shared/shapes.js';
import { uuid } from '../../shared/show.js';

export interface PlantsHost {
  data(): AppData;
  /** Something changed: recompute the layout and save. */
  changed(): void;
  plantColor(i: number): string;
  /** Moves the 3D view to look at the yard from the street. */
  lookFromStreet(): void;
  /** Starts fine-tuning this prop's LED positions in the 3D view, with its controls in `box`. */
  editLEDs(p: Plant, box: HTMLElement, ended: () => void): void;
}

const fmtFront = (v: number) => (v === 0 ? 'straight ahead' : `${Math.abs(v)}° ${v > 0 ? 'right' : 'left'}`);
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const open = new Set<string>();

export function renderPlants(box: HTMLElement, host: PlantsHost) {
  const d = host.data();
  const rerender = () => renderPlants(box, host);
  box.innerHTML = `
    <details class="plant yard" ${open.has('yard') ? 'open' : ''}>
      <summary class="title"><span class="name">Yard</span><span class="sub" data-front-sum>street ${fmtFront(d.yard?.front ?? 0)}</span></summary>
      <label class="field">Street direction
        <div class="front-row">
          <button data-nudge="-5">−5°</button><button data-nudge="-1">−1°</button>
          <input data-front type="range" min="-180" max="180" step="1" value="${d.yard?.front ?? 0}">
          <button data-nudge="1">+1°</button><button data-nudge="5">+5°</button>
          <input data-front-num type="number" step="1" min="-180" max="180" value="${d.yard?.front ?? 0}">
        </div>
      </label>
      <p class="hint">Turn the blue arrow in the 3D view until it points straight at the street. Effect directions and
        camera views (Street, Left side, Right…) are measured from it, so “Street” looks straight on. No LED moves and
        nothing needs scanning again.</p>
      <div class="row"><button data-look-street>Look from the street</button></div>
    </details>
    <div class="add-plant">
      <span class="sub">Add:</span>
      ${(['panel', 'grid', 'cone', 'polyline', 'circle', 'arch'] as ShapeKind[]).map(k => `<button data-add="${k}">${SHAPE_NAMES[k]}</button>`).join('')}
      <button data-add="scan" title="A prop you'll scan with the app">Prop to scan</button>
    </div>
    <div id="plant-list"></div>`;
  const yardEl = box.querySelector<HTMLDetailsElement>('details.yard')!;
  yardEl.ontoggle = () => { if (yardEl.open) open.add('yard'); else open.delete('yard'); };
  const slider = box.querySelector<HTMLInputElement>('[data-front]')!, num = box.querySelector<HTMLInputElement>('[data-front-num]')!;
  const setFront = (v: number) => {
    v = Math.round(((v + 540) % 360) - 180);            // keep it within -180..180
    d.yard = { ...(d.yard ?? {}), front: v };
    slider.value = num.value = String(v);
    box.querySelector('[data-front-sum]')!.textContent = `street ${fmtFront(v)}`;
    host.changed();
  };
  slider.oninput = () => setFront(Number(slider.value));
  num.onchange = () => { if (Number.isFinite(Number(num.value))) setFront(Number(num.value)); };
  box.querySelectorAll<HTMLButtonElement>('[data-nudge]').forEach(b => b.onclick = () => setFront((d.yard?.front ?? 0) + Number(b.dataset.nudge)));
  box.querySelector<HTMLButtonElement>('[data-look-street]')!.onclick = () => host.lookFromStreet();

  box.querySelectorAll<HTMLButtonElement>('[data-add]').forEach(b => b.onclick = () => {
    const kind = b.dataset.add!;
    const p: Plant = { id: uuid(), name: kind === 'scan' ? `Prop ${d.plants.length + 1}` : `${SHAPE_NAMES[kind as ShapeKind].split(' ')[0]} ${d.plants.length + 1}`,
      x: 0, y: 0, z: 0, rotation: 0, map: null };
    if (kind !== 'scan') {
      p.shape = newShape(kind as ShapeKind);
      p.map = shapeMap(p.shape);
      p.parts = [];
    }
    d.plants.push(p);
    open.add(p.id);
    host.changed();
    rerender();
  });
  const list = box.querySelector<HTMLElement>('#plant-list')!;
  d.plants.forEach((p, i) => list.appendChild(plantCard(p, i, host, rerender)));
  if (!d.plants.length) list.innerHTML = '<p class="hint">No props yet. Scan them in the app, or add a drawn shape above.</p>';
}

function plantCard(p: Plant, index: number, host: PlantsHost, rerender: () => void): HTMLElement {
  const d = host.data();
  const el = document.createElement('details');
  el.className = 'plant';
  el.open = open.has(p.id);
  el.ontoggle = () => { if (el.open) open.add(p.id); else open.delete(p.id); };
  const summary = () => {
    const n = ledCountOf(d, p), m = p.map?.leds.length ?? 0;
    if (mapIsCurrent(d, p)) return `${m} LEDs`;
    if (p.shape) return n ? `<span class="warn">wired ${n}, shape ${m}</span>` : '<span class="warn">not wired</span>';
    return p.map ? `<span class="warn">wired ${n}, scan ${m}</span>` : n ? 'not scanned' : 'no LEDs';
  };
  el.innerHTML = `<summary class="title"><span class="chip" style="background:${host.plantColor(index)}"></span>
      <span class="name">${esc(p.name)}</span><span class="sub" data-summary>${p.shape ? SHAPE_NAMES[p.shape.kind] + ' · ' : ''}${summary()}</span></summary>
    <label class="field">Name <input data-name value="${esc(p.name)}"></label>
    <div class="grid" data-pos></div>
    <div data-shape></div>
    <div data-wiring></div>
    <div data-ledit-wrap></div>
    <div class="row actions"><button data-clone>Clone</button><button data-delete class="danger">Delete</button></div>`;
  let renderWiringStatus = () => {};
  const refresh = () => {
    host.changed();
    const s = el.querySelector<HTMLElement>('[data-summary]')!;
    s.innerHTML = `${p.shape ? SHAPE_NAMES[p.shape.kind] + ' · ' : ''}${summary()}`;
    renderWiringStatus();
  };

  const name = el.querySelector<HTMLInputElement>('[data-name]')!;
  name.oninput = () => { p.name = name.value; el.querySelector('.name')!.textContent = p.name; host.changed(); };

  const pos = el.querySelector<HTMLElement>('[data-pos]')!;
  for (const [key, label, step] of [['x', 'X (m)', 0.05], ['y', 'Y (m)', 0.05], ['z', 'Z (m)', 0.05], ['rotation', 'Turn (°)', 5]] as const) {
    const l = document.createElement('label');
    l.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(step);
    input.value = String(Math.round(p[key] * 100) / 100);
    input.oninput = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      p[key] = v;
      host.changed();
    };
    l.appendChild(input);
    pos.appendChild(l);
  }

  if (p.shape) shapeEditor(el.querySelector<HTMLElement>('[data-shape]')!, p, () => { p.map = shapeMap(p.shape!); refresh(); });

  // ---- wiring ----
  const wiring = el.querySelector<HTMLElement>('[data-wiring]')!;
  const renderWiring = () => {
    const whole = stringsOf(d, p);
    const usesParts = !!p.parts?.length || (p.parts != null && !whole.length) || !!p.shape;
    wiring.innerHTML = `<h3>Wiring</h3>`;
    if (!usesParts) {
      const owner = new Map(d.plants.map(x => [x.id, x.name]));
      const all = d.controllers.flatMap(c => c.strings.map((s, si) => ({ c, s, si })));
      wiring.innerHTML += `<p class="hint">Tick the strings on this prop. A string belongs to one prop; to share one between props, use LED ranges.</p>
        <div class="string-pick">${all.map(({ c, s, si }) => {
          const other = s.plantID && s.plantID !== p.id ? owner.get(s.plantID) : null;
          return `<label class="check"><input type="checkbox" data-str="${esc(c.id)}#${si}" ${s.plantID === p.id ? 'checked' : ''}>
            <span>${esc(c.name)} · string ${si + 1} · ${s.count} LEDs <span class="sub">GPIO ${s.pin}${other ? ` · on ${esc(other)}` : ''}</span></span></label>`;
        }).join('') || '<p class="hint">No controllers yet: add them on the Devices tab.</p>'}</div>
        <button data-to-parts>Use LED ranges</button>
        <p class="hint" data-wstatus></p>`;
      wiring.querySelectorAll<HTMLInputElement>('[data-str]').forEach(cb => cb.onchange = () => {
        const [cid, si] = cb.dataset.str!.split('#');
        const s = d.controllers.find(c => c.id === cid)?.strings[Number(si)];
        if (!s) return;
        if (cb.checked && s.plantID && s.plantID !== p.id && !confirm(`That string is on ${owner.get(s.plantID) ?? 'another prop'}. Move it to ${p.name}?`)) { cb.checked = false; return; }
        s.plantID = cb.checked ? p.id : null;
        host.changed();
        rerender();                 // the prop it came from changes too
      });
      wiring.querySelector<HTMLButtonElement>('[data-to-parts]')!.onclick = () => {
        p.parts = whole.map(w => ({ controller: w.controller.id, string: w.stringIndex, start: 0, count: w.count }));
        if (!p.parts.length) p.parts.push(nextFreePart(d, p));
        refresh();
        renderWiring();
      };
    } else {
      const parts = p.parts ?? (p.parts = []);
      const rows = parts.map((part, k) => {
        const c = d.controllers.find(x => x.id === part.controller);
        return `<div class="part" data-k="${k}">
          <select data-f="controller">${d.controllers.map(x => `<option value="${esc(x.id)}" ${x.id === part.controller ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          <select data-f="string">${(c?.strings ?? []).map((s, si) => `<option value="${si}" ${si === part.string ? 'selected' : ''}>String ${si + 1} (${s.count})</option>`).join('')}</select>
          <label>From LED <input data-f="start" type="number" min="1" value="${part.start + 1}"></label>
          <label>Count <input data-f="count" type="number" min="1" value="${part.count}"></label>
          <button data-remove title="Remove this range">✕</button></div>`;
      }).join('');
      wiring.innerHTML += `<div class="parts">${rows}</div>
        <div class="row"><button data-add-part>+ LED range</button></div>
        <p class="hint" data-wstatus></p>
        <p class="hint">LEDs are numbered from 1 along each string. Ranges run one after another, in this order.${p.shape ? '' : ' A scan follows its LEDs: rewire freely (other controllers, strings or ranges) as long as the same LEDs stay in the same order.'}</p>`;
      wiring.querySelectorAll<HTMLElement>('.part').forEach(row => {
        const part = parts[Number(row.dataset.k)];
        row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach(inp => {
          inp.onchange = inp.oninput = () => {
            const f = inp.dataset.f as keyof PlantPart;
            if (f === 'controller') { part.controller = inp.value; part.string = 0; refresh(); renderWiring(); return; }
            const v = Math.max(0, Math.round(Number(inp.value)));
            if (!Number.isFinite(v)) return;
            if (f === 'start') part.start = Math.max(0, v - 1);
            else if (f === 'string') part.string = v;
            else part.count = Math.max(1, v);
            refresh();
          };
        });
        row.querySelector<HTMLButtonElement>('[data-remove]')!.onclick = () => {
          parts.splice(parts.indexOf(part), 1);
          refresh();
          renderWiring();
        };
      });
      wiring.querySelector<HTMLButtonElement>('[data-add-part]')!.onclick = () => {
        parts.push(nextFreePart(d, p));
        refresh();
        renderWiring();
      };
    }
    renderWiringStatus = () => {
      const st = wiring.querySelector<HTMLElement>('[data-wstatus]');
      if (!st) return;
      const n = ledCountOf(d, p), m = p.map?.leds.length ?? 0;
      const clash = overlaps(d, p);
      const msgs: string[] = [];
      if (p.map && n !== m) msgs.push(`<span class="warn">It's wired to ${n} LEDs but the ${p.shape ? 'shape' : p.map.portable ? 'copied shape' : 'scan'} has ${m}.</span>`);
      else if (n) msgs.push(`${n} LEDs.`);
      if (clash.length) msgs.push(`<span class="warn">Shares LEDs with ${clash.map(esc).join(', ')}.</span>`);
      st.innerHTML = msgs.join(' ');
      const button = (label: string, title: string, act: () => void) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.onclick = () => { act(); refresh(); renderWiring(); };
        st.append(' ', b);
      };
      // A scan follows its LEDs through any rewiring; when the count changes, choose which part to keep.
      if (p.map && !p.shape && n > 0 && n !== m) {
        const k = Math.abs(n - m);
        if (n < m) {
          button(`Use the first ${n}`, `Keep the positions of scanned LEDs 1–${n} (the strip was shortened at its far end)`, () => { p.map = fitMap(p.map!, n, true); });
          button(`Use the last ${n}`, `Keep the positions of scanned LEDs ${m - n + 1}–${m} (the strip was shortened where the data comes in)`, () => { p.map = fitMap(p.map!, n, false); });
        } else {
          button(`Add ${k} at the end`, 'LEDs were added at the far end; find them with "Scan the LEDs that aren\'t green" in the app', () => { p.map = fitMap(p.map!, n, true); });
          button(`Add ${k} at the start`, 'LEDs were added where the data comes in; find them with "Scan the LEDs that aren\'t green" in the app', () => { p.map = fitMap(p.map!, n, false); });
        }
      }
      if (p.map && !p.shape && !p.map.portable && n === m && n > 1) {
        button('Reverse LED order', 'The data now goes in at the other end of the same LEDs', () => { p.map = reverseMap(p.map!); });
      }
      const fix = p.map && n !== m && (p.parts?.length ?? 0) > 0;
      if (fix) {
        const b = document.createElement('button');
        b.textContent = `Make the last range fit (${m} LEDs)`;
        b.onclick = () => {
          const last = p.parts![p.parts!.length - 1];
          last.count = Math.max(1, last.count + m - n);
          refresh();
          renderWiring();
        };
        st.append(' ', b);
      }
    };
    renderWiringStatus();
  };
  renderWiring();

  // Fine-tuning a scan: not for drawn shapes (their LEDs come from the shape).
  const leditWrap = el.querySelector<HTMLElement>('[data-ledit-wrap]')!;
  const renderLedit = () => {
    if (p.shape || !mapIsCurrent(d, p)) { leditWrap.innerHTML = ''; return; }
    leditWrap.innerHTML = `<h3>LED positions</h3><div data-ledit></div>
      <button data-ledit-start>Fine-tune LED positions…</button>`;
    const start = leditWrap.querySelector<HTMLButtonElement>('[data-ledit-start]')!;
    start.onclick = () => {
      start.hidden = true;
      host.editLEDs(p, leditWrap.querySelector<HTMLElement>('[data-ledit]')!, () => { start.hidden = false; });
    };
  };
  renderLedit();

  el.querySelector<HTMLButtonElement>('[data-clone]')!.onclick = () => {
    const copy: Plant = JSON.parse(JSON.stringify(p));
    copy.id = uuid();
    copy.name = `${p.name} copy`;
    copy.x = p.x + 0.5;
    copy.parts = [];                         // it needs its own LEDs
    if (copy.map) copy.map.portable = true;  // the shape stays valid on whatever LEDs it is wired to
    d.plants.splice(index + 1, 0, copy);
    open.add(copy.id);
    host.changed();
    rerender();
  };
  el.querySelector<HTMLButtonElement>('[data-delete]')!.onclick = () => {
    if (!confirm(`Delete ${p.name}?`)) return;
    d.plants.splice(d.plants.indexOf(p), 1);
    for (const c of d.controllers) for (const s of c.strings) if (s.plantID === p.id) s.plantID = null;
    host.changed();
    rerender();
  };
  return el;
}

/** A range starting at the first free LED (after every other plant's LEDs) on the first string with room. */
function nextFreePart(d: AppData, p: Plant): PlantPart {
  const owners = ledOwners(d);
  const want = Math.max(1, (p.map?.leds.length ?? 0) - ledCountOf(d, p)) || 50;
  for (const c of d.controllers) {
    const own = owners.get(c.id)!;
    let first = 0;
    for (let si = 0; si < c.strings.length; si++) {
      const s = c.strings[si];
      let lastUsed = -1;
      for (let i = 0; i < s.count; i++) if (own[first + i] && own[first + i] !== p.id) lastUsed = i;
      if (lastUsed < s.count - 1) return { controller: c.id, string: si, start: lastUsed + 1, count: Math.min(want, s.count - lastUsed - 1) };
      first += s.count;
    }
  }
  const c = d.controllers[0];
  return { controller: c?.id ?? '', string: 0, start: 0, count: want };
}

/** Other plants that claim any of this plant's LEDs. */
function overlaps(d: AppData, p: Plant): string[] {
  const mine = new Set<string>();
  for (const s of stringsOf(d, p)) for (let i = 0; i < s.count; i++) mine.add(`${s.controller.id}/${s.stringIndex}/${s.start + i}`);
  const out: string[] = [];
  for (const o of d.plants) {
    if (o === p) continue;
    if (stringsOf(d, o).some(s => { for (let i = 0; i < s.count; i++) if (mine.has(`${s.controller.id}/${s.stringIndex}/${s.start + i}`)) return true; return false; })) out.push(o.name);
  }
  return out;
}

// ---------- shape editor ----------

function shapeEditor(box: HTMLElement, p: Plant, changed: () => void) {
  const s = p.shape!;
  const num = (key: keyof PlantShape, label: string, step = 0.05, min = 0) =>
    `<label>${label} <input data-n="${key}" type="number" step="${step}" min="${min}" value="${s[key] as number}"></label>`;
  const check = (key: keyof PlantShape, label: string) =>
    `<label class="check"><input data-c="${key}" type="checkbox" ${s[key] ? 'checked' : ''}> ${label}</label>`;
  const select = (key: keyof PlantShape, label: string, opts: [string, string][]) =>
    `<label>${label} <select data-s="${key}">${opts.map(([v, t]) => `<option value="${v}" ${String(s[key]) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
  const countRow = () => `<label>LEDs by <select data-countmode><option value="n" ${s.perMetre ? '' : 'selected'}>Number</option>
      <option value="m" ${s.perMetre ? 'selected' : ''}>Per metre</option></select></label>
    ${s.perMetre ? num('perMetre', 'LEDs per metre', 1, 1) : num('count', s.kind === 'cone' && !s.spiral ? 'LEDs (all strands)' : 'LEDs', 1, 1)}`;
  let fields = '';
  switch (s.kind) {
    case 'grid':
      fields = num('width', 'Width (m)') + num('height', 'Height (m)') + num('columns', 'Columns', 1, 1) + num('rows', 'Rows', 1, 1) +
        select('start', 'First LED', [['bottomLeft', 'Bottom left'], ['bottomRight', 'Bottom right'], ['topLeft', 'Top left'], ['topRight', 'Top right']]) +
        select('vertical', 'Wired along', [['false', 'Rows'], ['true', 'Columns']]) + check('zigzag', 'Zigzag (every other row runs back)');
      break;
    case 'cone':
      fields = num('height', 'Height (m)') + num('width', 'Bottom diameter (m)') + num('topWidth', 'Top diameter (m)') +
        select('spiral', 'Wired as', [['false', 'Strands, bottom to top'], ['true', 'One spiral']]) +
        (s.spiral ? num('turns', 'Turns', 0.5, 0.5) : num('columns', 'Strands', 1, 1) + check('zigzag', 'Zigzag (every other strand runs back)')) +
        select('start', 'First LED', [['bottom', 'Bottom'], ['top', 'Top']]) + countRow();
      break;
    case 'circle':
      fields = num('width', 'Diameter (m)') + num('startAngle', 'First LED at (°)', 15, -360) +
        check('clockwise', 'Clockwise') + check('flat', 'Lying flat (else standing, facing the street)') + countRow();
      break;
    case 'arch':
      fields = num('width', 'Span (m)') + num('height', 'Height (m)') + select('start', 'First LED', [['left', 'Left foot'], ['right', 'Right foot']]) + countRow();
      break;
    case 'polyline':
      fields = check('reverse', 'First LED at the last point') + countRow();
      break;
    case 'panel': {
      const preset = `${s.columns}x${s.rows}`;
      const presets = ['8x8', '16x16', '32x8', '8x32'];
      fields = `<label>Panel <select data-preset>${presets.map(x => `<option value="${x}" ${x === preset ? 'selected' : ''}>${x.replace('x', ' × ')}</option>`).join('')}
          <option value="" ${presets.includes(preset) ? '' : 'selected'}>Custom</option></select></label>` +
        `<label>LED spacing (mm) <input data-pitch type="number" step="0.5" min="1" value="${Math.round((s.pitch ?? 0.01) * 10000) / 10}"></label>` +
        num('columns', 'Columns (per panel)', 1, 1) + num('rows', 'Rows (per panel)', 1, 1) +
        num('tilesX', 'Panels across', 1, 1) + num('tilesY', 'Panels down', 1, 1) +
        select('start', 'First LED', [['topLeft', 'Top left'], ['topRight', 'Top right'], ['bottomLeft', 'Bottom left'], ['bottomRight', 'Bottom right']]) +
        select('vertical', 'Wired along', [['true', 'Columns'], ['false', 'Rows']]) + check('zigzag', 'Zigzag (serpentine)');
      break;
    }
  }
  const n = p.map?.leds.length ?? 0;
  box.innerHTML = `<h3>Shape</h3><div class="grid shape">${fields}</div>
    ${s.kind === 'polyline' ? `<div class="points">${s.points.map((pt, k) => `<div class="pt" data-k="${k}">
        <span class="sub">${k + 1}</span>${(['x', 'y', 'z'] as const).map(a => `<label>${a.toUpperCase()} <input data-a="${a}" type="number" step="0.05" value="${pt[a]}"></label>`).join('')}
        <button data-del title="Remove point">✕</button></div>`).join('')}
      <button data-addpt>+ Point</button></div>` : ''}
    <p class="hint" data-count>${n} LEDs. ${hint(s)}</p>`;
  const done = (redraw = false) => {
    changed();
    const c = box.querySelector('[data-count]');
    if (c) c.textContent = `${p.map?.leds.length ?? 0} LEDs. ${hint(s)}`;
    if (redraw) shapeEditor(box, p, changed);
  };
  box.querySelectorAll<HTMLInputElement>('[data-n]').forEach(inp => inp.oninput = () => {
    const v = Number(inp.value);
    if (!Number.isFinite(v) || inp.value === '') return;
    const k = inp.dataset.n as keyof PlantShape;
    const ints = ['count', 'rows', 'columns', 'tilesX', 'tilesY'];
    (s as unknown as Record<string, number>)[k] = ints.includes(k) ? Math.max(1, Math.round(v)) : v;
    done();
  });
  box.querySelectorAll<HTMLInputElement>('[data-c]').forEach(inp => inp.onchange = () => {
    (s as unknown as Record<string, boolean>)[inp.dataset.c!] = inp.checked;
    done();
  });
  box.querySelectorAll<HTMLSelectElement>('[data-s]').forEach(sel => sel.onchange = () => {
    const k = sel.dataset.s!;
    const v = sel.value === 'true' ? true : sel.value === 'false' ? false : sel.value;
    (s as unknown as Record<string, unknown>)[k] = v;
    done(true);
  });
  const ps = box.querySelector<HTMLSelectElement>('[data-preset]');
  if (ps) ps.onchange = () => {
    if (!ps.value) return;
    const [c, r] = ps.value.split('x').map(Number);
    s.columns = c; s.rows = r;
    done(true);
  };
  const pitch = box.querySelector<HTMLInputElement>('[data-pitch]');
  if (pitch) pitch.oninput = () => { const v = Number(pitch.value); if (v > 0) { s.pitch = v / 1000; done(); } };
  const cm = box.querySelector<HTMLSelectElement>('[data-countmode]');
  if (cm) cm.onchange = () => { s.perMetre = cm.value === 'm' ? 30 : null; done(true); };
  box.querySelectorAll<HTMLElement>('.pt').forEach(row => {
    const pt = s.points[Number(row.dataset.k)];
    row.querySelectorAll<HTMLInputElement>('[data-a]').forEach(inp => inp.oninput = () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v) || inp.value === '') return;
      pt[inp.dataset.a as 'x' | 'y' | 'z'] = v;
      done();
    });
    row.querySelector<HTMLButtonElement>('[data-del]')!.onclick = () => { s.points.splice(s.points.indexOf(pt), 1); done(true); };
  });
  const add = box.querySelector<HTMLButtonElement>('[data-addpt]');
  if (add) add.onclick = () => {
    const last = s.points[s.points.length - 1] ?? { x: 0, y: 0, z: 0 };
    s.points.push({ x: last.x + 0.5, y: last.y, z: last.z });
    done(true);
  };
}

function hint(s: PlantShape) {
  switch (s.kind) {
    case 'grid': return 'Standing up, facing the street, bottom edge at the prop\'s height (Y).';
    case 'cone': return 'Strands start at the front and go round to the right (seen from above).';
    case 'circle': return '0° is the right-hand side, 90° the top (away from the street when flat).';
    case 'arch': return 'Standing up, facing the street; turn the prop to angle it.';
    case 'polyline': return 'Points are in metres from the prop\'s position: X right, Y up, Z towards the street.';
    case 'panel': return 'Facing the street, bottom edge at the prop\'s height. Panels chain from the first-LED corner along each row of panels. Great for Marquee and Video.';
  }
}
