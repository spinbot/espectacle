// The Devices tab: every controller, its status and LED strings, adding controllers, and firmware updates.
const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

interface FirmwareFile { name: string; bytes: number; date: number; version: string | null; board: string | null; chip: string | null }
interface Update { state: 'uploading' | 'restarting' | 'done' | 'failed'; progress: number; file: string; from: string | null; to: string | null; message: string | null }
interface Device {
  id: string; name: string; host: string; strings: { pin: number; count: number; order: string }[]; maxMilliamps: number; leds: number; online: boolean;
  info: Record<string, any> | null; update: Update | null; best: { name: string; version: string | null } | null;
  updateAvailable: boolean; compatible: string[];
}

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
};
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const uptime = (ms: number) => { const m = Math.floor(ms / 60000); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor(m / 60) % 24} h`; };

let timer = 0;
const picks = new Map<string, string>();      // device id -> chosen firmware file
let build: { id: string; log: string[]; state: string; error: string | null; firmware: string | null; version: string | null; options: any } | null = null;
let buildTimer = 0;
let boards: { ok: boolean; reason?: string; boards: { id: string; label: string }[]; settings: { wifiSsid: string; serverUrl: string } } | null = null;
let form = { board: '', name: '', pin: '16', leds: '50' };

// Setting up one controller (name, LED strings, current limit): the draft being edited.
interface Draft { name: string; strings: { pin: number; count: number; order: string }[]; amps: number }
let editing: { id: string; draft: Draft; saving: boolean; message: string } | null = null;
let addHost = '';
/** Colour orders: the usual ones first, then every other RGBW order (firmware 1.11+). */
const ORDERS = (() => {
  const common = ['GRB', 'RGB', 'BRG', 'RBG', 'GBR', 'BGR', 'GRBW', 'RGBW'];
  const perms = (s: string): string[] => s.length <= 1 ? [s] : [...s].flatMap((c, i) => perms(s.slice(0, i) + s.slice(i + 1)).map(r => c + r));
  return common.concat(perms('RGBW').filter(o => !common.includes(o)));
})();
const S2_PINS = [...Array.from({ length: 18 }, (_, i) => i + 1), 21, ...Array.from({ length: 13 }, (_, i) => i + 33)];

/** Loads ESP Web Tools (the browser USB installer) once. */
let espLoaded: Promise<unknown> | null = null;
const loadEsp = () => (espLoaded ??= import(/* @vite-ignore */ (location.origin + '/espweb/install-button.js') as string));

export function renderDevices(box: HTMLElement) {
  clearTimeout(timer);
  const refresh = async () => {
    if (box.hidden) return;
    try { last = await api<DevicesReply>('/api/devices'); if (!editing) draw(last); }
    catch (e) { box.querySelector('[data-error]')!.textContent = String((e as Error).message); }
    const busy = box.querySelector('.ota-progress');
    timer = window.setTimeout(refresh, busy ? 1000 : 5000);
  };
  type DevicesReply = { devices: Device[]; firmware: FirmwareFile[]; found?: { id: string; name: string; ip: string; fw: string; board: string }[] };
  let last: DevicesReply | null = null;
  const redraw = () => { if (last) draw(last, true); };
  box.innerHTML = '<p class="hint" data-error>Loading…</p>';
  void api<typeof boards>('/api/builds/boards').then(b => { boards = b; if (!form.board && b?.boards[0]) form.board = b.boards[0].id; }).catch(() => {}).finally(() => refresh());

  function draw({ devices, firmware, found = [] }: DevicesReply, force = false) {
    // Don't rebuild while the user is typing or choosing.
    const ae = document.activeElement;
    if (!force && box.contains(ae) && (ae?.tagName === 'SELECT' || ae?.tagName === 'INPUT')) return;
    const outdated = devices.filter(d => d.updateAvailable && !busy(d));
    box.innerHTML = `
      <p class="hint" data-error></p>
      ${found.length ? `<div class="found"><h2>New controllers</h2>${found.map(f => `<div class="row"><span><b>${esc(f.name)}</b> <span class="sub">${esc(f.ip)} · ${esc(f.board)} · ${esc(f.fw)}</span></span>
        <button data-add="${esc(f.id)}">Add</button></div>`).join('')}</div>` : ''}
      <p class="hint">Controllers you build below say hello and appear at the top of this tab, under New controllers. Add any other one by its address, then use
        <b>Set up</b> for its name, LED strings and current limit.</p>
      <div class="row add-host"><input data-add-host placeholder="192.168.1.40 or front-tree.local" value="${esc(addHost)}" aria-label="Controller address">
        <button data-add-by-host>Add controller</button></div>
      ${outdated.length > 1 ? `<button data-all>Update ${outdated.length} controllers</button>` : ''}
      <div class="devices">${devices.map(card).join('') || '<p class="hint">No controllers yet: build firmware below, or add one by its address.</p>'}</div>
      ${buildPanel()}
      <h2>Firmware</h2>
      <p class="hint">Building in PlatformIO puts the firmware here automatically (it copies <code>firmware.bin</code> into the
        server's data folder). Or upload a <code>firmware.bin</code> from <code>firmware/.pio/build/&lt;board&gt;/</code>.
        Controllers need firmware 1.10 or later (flashed once over USB) to update over WiFi.</p>
      <table class="fw-table"><thead><tr><th>Version</th><th>Board</th><th>Size</th><th>Added</th><th></th></tr></thead><tbody>
        ${firmware.map(f => `<tr><td>${esc(f.version ?? '?')}</td><td>${esc(f.board ?? f.chip ?? '?')}</td><td>${kb(f.bytes)}</td>
          <td>${new Date(f.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</td>
          <td><button data-del="${esc(f.name)}" class="secondary" title="Delete ${esc(f.name)}">✕</button></td></tr>`).join('') ||
          '<tr><td colspan="5" class="hint">No firmware files yet.</td></tr>'}
      </tbody></table>
      <label class="button-like">Upload firmware.bin…<input type="file" accept=".bin" hidden data-upload></label>
      <span class="sub" data-upstatus></span>`;

    box.querySelectorAll<HTMLButtonElement>('[data-update]').forEach(b => b.onclick = () => start(b.dataset.update!));
    const hostInput = box.querySelector<HTMLInputElement>('[data-add-host]')!;
    hostInput.oninput = () => { addHost = hostInput.value; };
    const addByHost = async () => {
      const btn = box.querySelector<HTMLButtonElement>('[data-add-by-host]')!;
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        const r = await api<{ updated: boolean }>('/api/devices/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: addHost }) });
        addHost = '';
        if (r.updated) alert('That controller was already added; its address is updated.');
        void refresh();
      } catch (e) { alert((e as Error).message); btn.disabled = false; btn.textContent = 'Add controller'; }
    };
    box.querySelector<HTMLButtonElement>('[data-add-by-host]')!.onclick = addByHost;
    hostInput.onkeydown = e => { if (e.key === 'Enter') void addByHost(); };
    box.querySelectorAll<HTMLButtonElement>('[data-setup]').forEach(b => b.onclick = () => {
      const d = devices.find(x => x.id === b.dataset.setup)!;
      editing = { id: d.id, saving: false, message: '', draft: { name: d.name, strings: d.strings.map(s => ({ ...s, order: s.order ?? 'GRB' })), amps: (d.maxMilliamps ?? 0) / 1000 } };
      redraw();
    });
    wireSetup(devices);
    box.querySelectorAll<HTMLButtonElement>('[data-add]').forEach(b => b.onclick = async () => {
      try { await api('/api/devices/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.add }) }); void refresh(); }
      catch (e) { alert((e as Error).message); }
    });
    box.querySelectorAll<HTMLButtonElement>('[data-rebuild]').forEach(b => b.onclick = () => {
      const d = devices.find(x => x.id === b.dataset.rebuild)!;
      if (!confirm(`Build the firmware for ${d.name} (${d.info?.board}) with your WiFi, then send it over WiFi?`)) return;
      void startBuild({ board: d.info?.board, updateController: d.id });
    });
    wireBuildPanel();
    box.querySelectorAll<HTMLSelectElement>('[data-pick]').forEach(s => s.onchange = () => picks.set(s.dataset.pick!, s.value));
    box.querySelectorAll<HTMLButtonElement>('[data-identify]').forEach(b => b.onclick = () => api(`/api/devices/${b.dataset.identify}/identify`, { method: 'POST' }).catch(e => alert(e.message)));
    box.querySelectorAll<HTMLButtonElement>('[data-reboot]').forEach(b => b.onclick = () => {
      if (confirm('Restart this controller?')) api(`/api/devices/${b.dataset.reboot}/reboot`, { method: 'POST' }).catch(e => alert(e.message));
    });
    box.querySelector<HTMLButtonElement>('[data-all]')?.addEventListener('click', async () => {
      for (const d of outdated) await start(d.id, true);
    });
    box.querySelectorAll<HTMLButtonElement>('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm(`Delete ${b.dataset.del}?`)) return;
      await api(`/api/firmware/${encodeURIComponent(b.dataset.del!)}`, { method: 'DELETE' }).catch(e => alert(e.message));
      void refresh();
    });
    box.querySelector<HTMLInputElement>('[data-upload]')!.onchange = async e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const st = box.querySelector('[data-upstatus]')!;
      st.textContent = `Uploading ${file.name}…`;
      const name = file.name === 'firmware.bin' ? `upload-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.bin` : file.name.replace(/[^\w .()+-]/g, '_');
      try { await api(`/api/firmware/${encodeURIComponent(name)}`, { method: 'PUT', body: file }); st.textContent = 'Uploaded.'; void refresh(); }
      catch (err) { st.textContent = String((err as Error).message); }
    };

    function card(d: Device) {
      const i = d.info ?? {};
      const u = d.update;
      const chosen = picks.get(d.id) ?? d.best?.name ?? d.compatible[0] ?? '';
      const options = d.compatible.map(n => { const f = firmware.find(x => x.name === n)!; return `<option value="${esc(n)}" ${n === chosen ? 'selected' : ''}>${esc(f.version ?? n)} · ${esc(f.board ?? f.chip ?? '?')}</option>`; }).join('');
      if (editing?.id === d.id) return setupCard(d);
      return `<div class="device ${d.online ? 'on' : ''}">
        <div class="title"><span class="dot ${d.online ? 'on' : ''}"></span><b>${esc(d.name)}</b>
          <span class="sub">${esc(d.host)}</span>${d.updateAvailable ? `<span class="badge">update ${esc(d.best?.version ?? '')}</span>` : ''}</div>
        <div class="facts">
          <span>Firmware <b>${esc(i.fw ?? '–')}</b></span>
          <span>${esc(i.board && i.board !== 'unknown' ? i.board : i.chip ?? '–')}${i.psram ? ` · ${Math.round(i.psram / 1048576)} MB PSRAM` : ''}</span>
          <span>${d.leds} LEDs on ${d.strings.length} string${d.strings.length === 1 ? '' : 's'} (GPIO ${d.strings.map(s => s.pin).join(', ')})</span>
          ${d.online ? `<span>WiFi ${i.ap ? 'setup hotspot' : `${esc(i.ssid ?? '')} ${i.rssi ?? ''} dBm`}</span><span>Up ${uptime(i.up ?? 0)}</span>` : '<span>Not responding</span>'}
          ${i.playing ? '<span>Playing a show</span>' : ''}
        </div>
        ${u && (u.state === 'uploading' || u.state === 'restarting')
          ? `<div class="ota-progress"><div style="width:${Math.round(u.progress * 100)}%"></div></div>
             <div class="sub">${u.state === 'uploading' ? `Sending ${esc(u.to ?? '')}… ${Math.round(u.progress * 100)}%` : esc(u.message ?? 'Restarting…')}</div>`
          : `${u?.state === 'failed' ? `<div class="warn">Update failed: ${esc(u.message ?? '')}</div>` : u?.state === 'done' ? `<div class="sub">${esc(u.message ?? 'Updated')}</div>` : ''}
             ${d.online ? `<div class="row">
               ${options ? `<select data-pick="${d.id}">${options}</select><button data-update="${d.id}">Update</button>`
                         : '<span class="sub">No firmware for this board yet.</span>'}
               ${boards?.ok && i.board && i.board !== 'unknown' && boards.boards.some(b => b.id === i.board) ? `<button data-rebuild="${d.id}" class="secondary" title="Build its firmware here (with your WiFi) and send it">Build &amp; update</button>` : ''}
               <button data-setup="${d.id}" class="secondary" title="Name, LED strings and current limit">Set up</button>
               <button data-identify="${d.id}" class="secondary" title="Flash its LEDs">Identify</button>
               <button data-reboot="${d.id}" class="secondary">Restart</button></div>` : ''}
             ${!d.online ? `<div class="row"><button data-setup="${d.id}" class="secondary">Set up</button></div>` : ''}
             ${d.online && !i.ota ? '<div class="sub">This firmware can\'t update over WiFi yet: flash 1.10 or later over USB once.</div>' : ''}
             ${d.online && (!i.board || i.board === 'unknown') && options ? '<div class="sub">This firmware doesn\'t say which board it is: pick the file built for this board (e.g. N8R2 vs N16R8).</div>' : ''}`}
      </div>`;
    }

    async function start(id: string, quiet = false) {
      const d = devices.find(x => x.id === id);
      const file = picks.get(id) ?? d?.best?.name ?? d?.compatible[0];
      if (!file) return;
      if (!quiet && !confirm(`Update ${d?.name} to ${firmware.find(f => f.name === file)?.version ?? file}? Its lights go dark for about a minute.`)) return;
      try { await api(`/api/devices/${id}/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) }); }
      catch (e) { alert((e as Error).message); }
      clearTimeout(timer);
      timer = window.setTimeout(refresh, 300);
    }
  }
  function buildPanel() {
    if (!boards) return '';
    const canUsb = window.isSecureContext && 'serial' in navigator;
    const b = build;
    return `<h2>Build firmware</h2>
      ${!boards.ok ? `<p class="warn">${esc(boards.reason ?? 'Building isn\'t available.')}</p>` : `
      <p class="hint">Builds ESPectacle for a board with your WiFi${boards.settings.wifiSsid ? ` (<b>${esc(boards.settings.wifiSsid)}</b>)` : ' (none set: Settings → Firmware builds)'} baked in,
        so a new controller joins your network straight away. Then install it over USB from this browser.</p>
      <div class="grid2 build-form">
        <label class="field">Board <select data-f="board">${boards.boards.map(x => `<option value="${esc(x.id)}" ${x.id === form.board ? 'selected' : ''}>${esc(x.id)}</option>`).join('')}</select></label>
        <label class="field">Name <input data-f="name" placeholder="Front tree" value="${esc(form.name)}"></label>
        <label class="field">LED data pin <input data-f="pin" type="number" min="0" max="48" value="${esc(form.pin)}"></label>
        <label class="field">LEDs on it <input data-f="leds" type="number" min="1" max="1500" value="${esc(form.leds)}"></label>
      </div>
      <p class="sub">${esc(boards.boards.find(x => x.id === form.board)?.label ?? '')}</p>
      <div class="row"><button data-build ${b && (b.state === 'building' || b.state === 'queued') ? 'disabled' : ''}>Build</button>
        ${b ? `<span class="sub">${b.state === 'building' ? 'Building…' : b.state === 'queued' ? 'Waiting…' : b.state === 'done' ? `Built ${esc(b.version ?? '')}` : `Failed: ${esc(b.error ?? '')}`}</span>` : ''}</div>
      ${b ? `<pre class="code build-log" data-log>${esc(b.log.slice(-400).join('\n'))}</pre>` : ''}
      ${b?.state === 'done' && !b.options?.updateController ? `<div class="row install">
        ${canUsb ? `<esp-web-install-button manifest="/api/builds/${b.id}/manifest.json"><button slot="activate">Install over USB…</button></esp-web-install-button>`
                 : `<span class="hint">USB install works in Chrome or Edge at http://localhost:8080 on the computer the board is plugged into.</span>`}
        <a class="button-like" href="/api/builds/${b.id}/files/factory.bin" download="espectacle-${esc(b.version ?? '')}-${esc(b.options?.board ?? '')}-factory.bin">Download (flash at 0x0)</a>
      </div><p class="hint">Plug the board into this computer with USB first (S2 Mini: hold button 0 and tap RST to get into the bootloader). After installing it joins your WiFi and appears above under New controllers.</p>` : ''}`}`;
  }

  function wireBuildPanel() {
    box.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.build-form [data-f]').forEach(el => {
      el.oninput = el.onchange = () => { (form as any)[el.dataset.f!] = el.value; if (el.dataset.f === 'board') { const s = box.querySelector('.build-form + .sub'); if (s) s.textContent = boards?.boards.find(x => x.id === el.value)?.label ?? ''; } };
    });
    box.querySelector<HTMLButtonElement>('[data-build]')?.addEventListener('click', () => void startBuild({ board: form.board, name: form.name, pin: form.pin, leds: form.leds }));
    const log = box.querySelector<HTMLElement>('[data-log]');
    if (log) log.scrollTop = log.scrollHeight;
    if (box.querySelector('esp-web-install-button')) void loadEsp();
  }

  async function startBuild(o: Record<string, unknown>) {
    try {
      const j = await api<typeof build>('/api/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
      build = j;
      pollBuild();
    } catch (e) { alert((e as Error).message); }
  }

  function pollBuild() {
    clearTimeout(buildTimer);
    if (!build) return;
    const from = build.log.length;
    api<any>(`/api/builds/${build.id}?from=${from}`).then(j => {
      build = { ...j, log: build!.log.concat(j.log) };
      const log = box.querySelector<HTMLElement>('[data-log]');
      if (log && j.state === 'building') {
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
        log.textContent = build!.log.slice(-400).join('\n');
        if (atEnd) log.scrollTop = log.scrollHeight;
      } else {
        void refresh();
      }
      if (j.state === 'building' || j.state === 'queued') buildTimer = window.setTimeout(pollBuild, 1000);
    }).catch(() => { buildTimer = window.setTimeout(pollBuild, 3000); });
  }

  /** The set-up form for one controller, in place of its card. */
  function setupCard(d: Device) {
    const e = editing!, dr = e.draft, i = d.info ?? {};
    const pins = [...new Set([...((i.pins as number[] | undefined) ?? S2_PINS), ...dr.strings.map(s => s.pin)])].sort((a, b) => a - b);
    const rows = dr.strings.map((s, k) => `<div class="srow" data-k="${k}">
        <label class="field">GPIO <select data-s="pin">${pins.map(p => `<option value="${p}" ${p === s.pin ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        <label class="field">LEDs <input data-s="count" type="number" min="1" max="1500" inputmode="numeric" value="${s.count}"></label>
        <label class="field">Colour order <select data-s="order">${ORDERS.map(o => `<option ${o === s.order ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
        <button data-s-del class="secondary" title="Remove string ${k + 1}" aria-label="Remove string ${k + 1}" ${dr.strings.length < 2 ? 'disabled' : ''}>✕</button>
      </div>`).join('');
    return `<div class="device setup on" data-setup-card="${d.id}">
      <div class="title"><span class="dot ${d.online ? 'on' : ''}"></span><b>Set up ${esc(d.name)}</b><span class="sub">${esc(d.host)}</span></div>
      <label class="field">Name <input data-s="name" maxlength="31" value="${esc(dr.name)}"></label>
      <div class="strings-head"><span>LED strings</span><span class="sub" data-s-total></span></div>
      <div class="srows">${rows}</div>
      ${dr.strings.length < 4 ? '<button data-s-add class="secondary">+ String</button>' : ''}
      <label class="field">Current limit in amps (0 = off) <input data-s="amps" type="number" min="0" max="60" step="0.25" inputmode="decimal" value="${dr.amps}"></label>
      <p class="sub">The controller dims everything to stay under this estimate. Set it a little below what its power supply gives.</p>
      <p class="hint warn-text" data-s-why></p>
      <div class="row">
        <button data-s-save>${e.saving ? 'Saving…' : 'Save to controller'}</button>
        <button data-s-cancel class="secondary">Cancel</button>
        <button data-s-forget class="danger" title="Remove this controller from the project">Remove…</button>
      </div>
      ${e.message ? `<p class="hint">${esc(e.message)}</p>` : ''}
      <p class="sub">WS2812B strips are usually GRB, WS2811 bullet pixels RGB, and SK6812 RGBW GRBW. If the colours look wrong, try
        another order. Moving a string to another pin keeps its prop's scan; if you change its LED count, the prop asks which LEDs changed.</p>
    </div>`;
  }

  function wireSetup(devices: Device[]) {
    const card = box.querySelector<HTMLElement>('[data-setup-card]');
    if (!card || !editing) return;
    const e = editing, d = devices.find(x => x.id === e.id);
    if (!d) { editing = null; return; }
    const why = () => {
      const dr = e.draft, total = dr.strings.reduce((n, s) => n + (s.count || 0), 0), max = Number(d.info?.maxLeds) || 1500;
      const pins = dr.strings.map(s => s.pin);
      const same = JSON.stringify({ n: dr.name, s: dr.strings, a: dr.amps }) === JSON.stringify({ n: d.name, s: d.strings.map(s => ({ ...s, order: s.order ?? 'GRB' })), a: (d.maxMilliamps ?? 0) / 1000 });
      card.querySelector('[data-s-total]')!.textContent = `${total} of ${max} LEDs`;
      return !dr.name.trim() ? 'Give the controller a name.'
        : new Set(pins).size !== pins.length ? 'Two strings use the same GPIO pin; each needs its own.'
        : dr.strings.some(s => !(s.count >= 1)) ? 'Each string needs at least 1 LED.'
        : total > max ? `${total} LEDs in total; a controller can drive at most ${max}.`
        : !(dr.amps >= 0 && dr.amps <= 60) ? 'The current limit must be between 0 and 60 A.'
        : !d.online ? 'It isn\'t responding, so changes can\'t be sent to it right now.'
        : same ? 'No changes to save.' : '';
    };
    const check = () => {
      const w = why();
      card.querySelector('[data-s-why]')!.textContent = w;
      card.querySelector<HTMLButtonElement>('[data-s-save]')!.disabled = !!w || e.saving;
    };
    card.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-s]').forEach(inp => {
      inp.oninput = inp.onchange = () => {
        const k = inp.closest<HTMLElement>('.srow')?.dataset.k, f = inp.dataset.s!;
        if (f === 'name') e.draft.name = inp.value;
        else if (f === 'amps') e.draft.amps = Number(inp.value);
        else if (k !== undefined) {
          const s = e.draft.strings[Number(k)];
          if (f === 'pin' || f === 'count') s[f] = Math.round(Number(inp.value));
          else s.order = inp.value;
        }
        check();
      };
    });
    card.querySelectorAll<HTMLButtonElement>('[data-s-del]').forEach(b => b.onclick = () => {
      e.draft.strings.splice(Number(b.closest<HTMLElement>('.srow')!.dataset.k), 1); redraw();
    });
    card.querySelector<HTMLButtonElement>('[data-s-add]')?.addEventListener('click', () => {
      const used = new Set(e.draft.strings.map(s => s.pin));
      const pins = ((d.info?.pins as number[] | undefined) ?? S2_PINS);
      e.draft.strings.push({ pin: pins.find(p => !used.has(p) && p >= 16) ?? pins.find(p => !used.has(p)) ?? 17, count: 50, order: e.draft.strings[0]?.order ?? 'GRB' });
      redraw();
    });
    card.querySelector<HTMLButtonElement>('[data-s-cancel]')!.onclick = () => { editing = null; redraw(); };
    card.querySelector<HTMLButtonElement>('[data-s-forget]')!.onclick = async () => {
      if (!confirm(`Remove ${d.name} from the project? Its props keep their scans; add it again any time.`)) return;
      try { await api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' }); editing = null; void refresh(); }
      catch (err) { alert((err as Error).message); }
    };
    card.querySelector<HTMLButtonElement>('[data-s-save]')!.onclick = async () => {
      e.saving = true; e.message = ''; redraw();
      try {
        await api(`/api/devices/${encodeURIComponent(d.id)}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: e.draft.name.trim(), maxMilliamps: Math.round(e.draft.amps * 1000), strings: e.draft.strings }) });
        editing = null;
        void refresh();
      } catch (err) { e.saving = false; e.message = `Couldn't save: ${(err as Error).message}`; redraw(); }
    };
    check();
  }

  function busy(d: Device) { return d.update?.state === 'uploading' || d.update?.state === 'restarting'; }
}
