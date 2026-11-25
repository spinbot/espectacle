// The Settings tab: Home Assistant (MQTT discovery and REST) and messages.
import type { AppData } from '../../shared/project.js';

interface ServerSettings {
  timeZone: string;
  mqtt: { enabled: boolean; host: string; port: number; username: string; password: string; prefix: string; passwordSet?: boolean };
  messages: { plants: string[]; seconds: number; color: number; scale: number };
  build: { wifiSsid: string; wifiPassword: string; serverUrl: string; wifiPasswordSet?: boolean };
  mqttStatus?: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const hex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
};

let statusTimer = 0;

export async function renderSettings(box: HTMLElement, data: () => AppData) {
  box.innerHTML = '<p class="hint">Loading…</p>';
  let s: ServerSettings;
  try { s = await api<ServerSettings>('/api/settings'); } catch (e) { box.innerHTML = `<p class="hint">${esc(String(e))}</p>`; return; }
  const d = data();
  const panels = d.plants.filter(p => p.shape?.kind === 'panel').map(p => p.id);
  const chosen = s.messages.plants.length ? s.messages.plants : [];
  box.innerHTML = `
    <h2>Backup &amp; restore</h2>
    <p class="hint">One file with everything the server keeps: the project (props, scans, shows, schedules), these
      settings, the yard scan, music, videos and firmware files. It includes the WiFi and MQTT passwords, so keep it
      somewhere safe. Restoring replaces the project and settings on this server and adds the files; every app and
      browser picks it up straight away.</p>
    <div class="row"><a class="button-like" href="/api/backup" data-backup download>Download backup</a>
      <label class="button-like">Restore from a backup…<input type="file" accept=".gz,.tgz,application/gzip" data-restore hidden></label></div>
    <p class="hint" data-restore-status></p>

    <h2>Firmware builds</h2>
    <p class="hint">Baked into firmware built here (Devices → Build firmware), so new controllers join your WiFi on
      their own and say hello to this server. Kept on the server only (and inside the firmware files it builds).</p>
    <div class="grid2">
      <label class="field">WiFi name <input data-b="wifiSsid" autocomplete="off" value="${esc(s.build.wifiSsid)}"></label>
      <label class="field">WiFi password <input data-b="wifiPassword" type="password" autocomplete="new-password" placeholder="${s.build.wifiPasswordSet ? '(unchanged)' : ''}"></label>
    </div>
    <label class="field">This server's address, as the controllers reach it
      <input data-b="serverUrl" placeholder="http://192.168.1.20:8080" value="${esc(s.build.serverUrl || (/^(localhost|127\.)/.test(location.hostname) ? '' : location.origin))}"></label>
    <p class="hint">Your Mac's network address, not localhost (System Settings → Wi-Fi → Details). Leave empty to skip the hello.</p>
    <div class="row"><button data-save-build>Save</button> <span class="sub" data-build-status></span></div>

    <h2>Home Assistant</h2>
    <p class="hint">With MQTT, ESPectacle appears in Home Assistant by itself (MQTT discovery): a light (on/off, brightness,
      effect, colour), a Show picker, a Schedules switch, a Message box, a Stop button and a Now-playing sensor.
      Use your broker, e.g. the Mosquitto add-on, and its login.</p>
    <label class="toggle"><input type="checkbox" data-k="enabled" ${s.mqtt.enabled ? 'checked' : ''}> Connect to MQTT</label>
    <div class="grid2">
      <label class="field">Broker <input data-k="host" placeholder="homeassistant.local" value="${esc(s.mqtt.host)}"></label>
      <label class="field">Port <input data-k="port" type="number" value="${s.mqtt.port}"></label>
      <label class="field">Username <input data-k="username" autocomplete="off" value="${esc(s.mqtt.username)}"></label>
      <label class="field">Password <input data-k="password" type="password" autocomplete="new-password" placeholder="${s.mqtt.passwordSet ? '(unchanged)' : ''}"></label>
      <label class="field">Discovery prefix <input data-k="prefix" value="${esc(s.mqtt.prefix)}"></label>
    </div>
    <div class="row"><button data-save-mqtt>Save</button> <span class="sub" data-mqtt-status>${esc(s.mqttStatus ?? '')}</span></div>

    <h2>Messages</h2>
    <p class="hint">A message (from Home Assistant, or below) scrolls over everything on these props – even with the lights
      off – then they go back to what they were doing. None ticked: every prop. Needs firmware 1.9.</p>
    <div class="msg-plants">${d.plants.map(p => `<label class="check"><input type="checkbox" data-plant="${p.id}" ${chosen.includes(p.id) ? 'checked' : ''}> ${esc(p.name)}${panels.includes(p.id) ? ' <span class="sub">panel</span>' : ''}</label>`).join('') || '<p class="hint">No props yet.</p>'}</div>
    <div class="grid2">
      <label class="field">Show for (seconds) <input data-m="seconds" type="number" min="1" max="3600" value="${s.messages.seconds}"></label>
      <label class="field">Colour <input data-m="color" type="color" value="${hex(s.messages.color)}"></label>
      <label class="field">Text size <input data-m="scale" type="range" min="0" max="255" value="${s.messages.scale}"></label>
    </div>
    <div class="row"><input data-test placeholder="Test message" value="Hello from ESPectacle"><button data-send>Send</button><button data-clear class="secondary">Clear</button></div>

    <h2>REST (rest_command)</h2>
    <p class="hint">Or call the server from Home Assistant scripts. Put the server password in secrets.yaml.</p>
    <pre class="code">rest_command:
  espectacle_message:
    url: "${esc(location.origin)}/api/ha/message"
    method: post
    headers: { Authorization: !secret espectacle_bearer }   # "Bearer &lt;password&gt;"
    content_type: application/json
    payload: '{"text": "{{ text }}", "seconds": {{ seconds | default(30) }}}'
  espectacle_look:
    url: "${esc(location.origin)}/api/ha/look"
    method: post
    headers: { Authorization: !secret espectacle_bearer }
    content_type: application/json
    payload: '{"on": true, "effect": "{{ effect }}"}'
  espectacle_show:
    url: "${esc(location.origin)}/api/ha/show"
    method: post
    headers: { Authorization: !secret espectacle_bearer }
    content_type: application/json
    payload: '{"show": "{{ show }}"}'</pre>
    <p class="hint">Also: <code>POST /api/ha/show/stop</code>, <code>POST /api/ha/schedules {"enabled": false}</code>,
      <code>DELETE /api/ha/message</code>, <code>GET /api/ha/state</code>. Look fields: on, bri (0–255), effect (name),
      rgb [r,g,b], pal, spd, scl, text, target.</p>`;

  const q = <T extends HTMLElement>(sel: string) => box.querySelector<T>(sel)!;
  const status = q('[data-mqtt-status]');
  q<HTMLInputElement>('[data-restore]').onchange = e => {
    const input = e.target as HTMLInputElement, file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!confirm(`Restore ${file.name}?\n\nThis replaces the project and settings on this server with the ones in the backup. Download a backup of the current state first if you might want it back.`)) return;
    const st = q('[data-restore-status]');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/restore');
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/gzip');
    xhr.upload.onprogress = ev => { if (ev.lengthComputable) st.textContent = `Uploading… ${Math.round(ev.loaded / ev.total * 100)}%`; };
    xhr.upload.onload = () => { st.textContent = 'Restoring…'; };
    xhr.onload = () => {
      let j: { restored?: string[]; error?: string } = {};
      try { j = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      st.textContent = xhr.status === 200 ? `Restored ${j.restored?.join(', ') ?? 'the backup'}.` : `Couldn't restore: ${j.error ?? xhr.status}`;
      if (xhr.status === 200) setTimeout(() => location.reload(), 1500);     // settings on this page changed too
    };
    xhr.onerror = () => { st.textContent = 'Couldn\'t reach the server.'; };
    xhr.send(file);
  };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  q<HTMLButtonElement>('[data-save-build]').onclick = async () => {
    const v = (k: string) => q<HTMLInputElement>(`[data-b="${k}"]`).value;
    const st = q('[data-build-status]');
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ timeZone: zone, build: { wifiSsid: v('wifiSsid').trim(), wifiPassword: v('wifiPassword'), serverUrl: v('serverUrl').trim() } }) });
      st.textContent = 'Saved.';
      q<HTMLInputElement>('[data-b="wifiPassword"]').value = '';
    } catch (e) { st.textContent = String((e as Error).message); }
  };
  q<HTMLButtonElement>('[data-save-mqtt]').onclick = async () => {
    const v = (k: string) => q<HTMLInputElement>(`[data-k="${k}"]`);
    try {
      const r = await api<ServerSettings>('/api/settings', { method: 'PUT', body: JSON.stringify({ timeZone: zone, mqtt: {
        enabled: v('enabled').checked, host: v('host').value.trim(), port: Number(v('port').value) || 1883,
        username: v('username').value, password: v('password').value, prefix: v('prefix').value.trim() || 'homeassistant' } }) });
      status.textContent = `Saved. ${r.mqttStatus ?? ''}`;
      v('password').value = '';
    } catch (e) { status.textContent = String((e as Error).message); }
  };
  const saveMessages = async () => {
    const plants = [...box.querySelectorAll<HTMLInputElement>('[data-plant]')].filter(x => x.checked).map(x => x.dataset.plant!);
    const m = (k: string) => q<HTMLInputElement>(`[data-m="${k}"]`);
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ timeZone: zone, messages: {
      plants, seconds: Math.max(1, Number(m('seconds').value) || 30), color: parseInt(m('color').value.slice(1), 16), scale: Number(m('scale').value) } }) })
      .catch(() => {});
  };
  box.querySelectorAll<HTMLInputElement>('[data-plant], [data-m]').forEach(el => el.onchange = saveMessages);
  q<HTMLButtonElement>('[data-send]').onclick = async () => {
    await saveMessages();
    await api('/api/ha/message', { method: 'POST', body: JSON.stringify({ text: q<HTMLInputElement>('[data-test]').value }) }).catch(e => alert(e.message));
  };
  q<HTMLButtonElement>('[data-clear]').onclick = () => { void api('/api/ha/message', { method: 'DELETE' }); };

  clearInterval(statusTimer);
  statusTimer = window.setInterval(async () => {
    if (box.hidden || !document.body.contains(status)) return;
    try { const r = await api<ServerSettings>('/api/settings'); if (!status.textContent?.startsWith('Saved')) status.textContent = r.mqttStatus ?? ''; } catch { /* later */ }
  }, 5000);
}
