// Home Assistant over MQTT: announces ESPectacle with MQTT discovery (a light, a show select, a schedules
// switch, a message text, a stop button and a "now playing" sensor) and follows their commands.
// Configure the broker on the website (Settings tab); HA's Mosquitto add-on works out of the box.
import mqtt, { type MqttClient } from 'mqtt';
import type { Actions } from './actions.js';
import type { Settings, ServerSettings } from './settings.js';

const BASE = 'espectacle';
const OLD_BASE = 'treelights';        // before the rename: its entities are removed on connect
const NONE = 'None';

export class HomeAssistant {
  private client: MqttClient | null = null;
  private last = new Map<string, string>();
  private status = 'Off';
  private configKey = '';
  private timer?: NodeJS.Timeout;

  constructor(private settings: Settings, private actions: Actions) {}

  start() {
    this.settings.onChange(s => this.reconnect(s));
    this.actions.onChange(() => this.publishState());
    this.reconnect(this.settings.get());
    // Shows can be added or renamed in the app or website: refresh the discovery now and then.
    let n = 0;
    this.timer = setInterval(() => { if (++n % 12 === 0) this.publishDiscovery(); this.publishState(); }, 5000);
  }

  get statusText() { return this.status; }

  private reconnect(s: ServerSettings) {
    const m = s.mqtt;
    const key = JSON.stringify(m);
    if (key === this.configKey && this.client) return;
    this.configKey = key;
    this.client?.end(true);
    this.client = null;
    this.last.clear();
    if (!m.enabled || !m.host) { this.status = 'Off'; return; }
    this.status = 'Connecting…';
    const url = /^\w+:\/\//.test(m.host) ? m.host : `mqtt://${m.host}:${m.port || 1883}`;
    const c = mqtt.connect(url, {
      username: m.username || undefined, password: m.password || undefined,
      clientId: `espectacle-${Math.random().toString(16).slice(2, 8)}`, reconnectPeriod: 5000,
      will: { topic: `${BASE}/status`, payload: Buffer.from('offline'), retain: true, qos: 1 },
    });
    this.client = c;
    c.on('connect', () => {
      this.status = 'Connected';
      this.last.clear();
      c.publish(`${BASE}/status`, 'online', { retain: true, qos: 1 });
      c.subscribe([`${BASE}/+/set`, `${BASE}/stop/press`, `${m.prefix || 'homeassistant'}/status`]);
      this.removeOld();
      this.publishDiscovery();
      this.publishState();
    });
    c.on('error', e => { this.status = `Error: ${e.message}`; });
    c.on('close', () => { if (this.client === c && this.status === 'Connected') this.status = 'Reconnecting…'; });
    c.on('message', (topic, payload) => { void this.command(topic, payload.toString()); });
  }

  private get prefix() { return this.settings.get().mqtt.prefix || 'homeassistant'; }

  private device = { identifiers: ['espectacle_server'], name: 'ESPectacle', manufacturer: 'ESPectacle', model: 'Server' };

  private publishDiscovery() {
    const c = this.client;
    if (!c?.connected) return;
    const st = this.actions.state();
    const common = { availability_topic: `${BASE}/status`, device: this.device };
    const conf = (component: string, id: string, body: object) => {
      const payload = JSON.stringify({ ...common, unique_id: `espectacle_${id}`, object_id: `espectacle_${id}`, ...body });
      this.pub(`${this.prefix}/${component}/${BASE}/${id}/config`, payload, true);
    };
    conf('light', 'lights', {
      name: 'Lights', schema: 'json', command_topic: `${BASE}/light/set`, state_topic: `${BASE}/light/state`,
      brightness: true, effect: true, effect_list: this.actions.effectNames, supported_color_modes: ['rgb'],
    });
    conf('select', 'show', {
      name: 'Show', icon: 'mdi:movie-play', command_topic: `${BASE}/show/set`, state_topic: `${BASE}/show/state`,
      options: [NONE, ...st.shows],
    });
    conf('switch', 'schedules', {
      name: 'Schedules', icon: 'mdi:calendar-clock', command_topic: `${BASE}/schedules/set`, state_topic: `${BASE}/schedules/state`,
    });
    conf('text', 'message', {
      name: 'Message', icon: 'mdi:message-text', command_topic: `${BASE}/message/set`, state_topic: `${BASE}/message/state`, max: 200,
    });
    conf('button', 'stop', { name: 'Stop show', icon: 'mdi:stop', command_topic: `${BASE}/stop/press` });
    conf('sensor', 'playing', { name: 'Now playing', icon: 'mdi:play-circle', state_topic: `${BASE}/playing/state` });
  }

  /**
   * Removes the entities announced under the old name (treelights_…) and their retained state, so Home
   * Assistant doesn't keep a second, unavailable set. Empty retained messages delete them.
   */
  private removeOld() {
    const c = this.client;
    if (!c?.connected) return;
    const old: [string, string][] = [['light', 'lights'], ['select', 'show'], ['switch', 'schedules'], ['text', 'message'], ['button', 'stop'], ['sensor', 'playing']];
    for (const [component, id] of old) c.publish(`${this.prefix}/${component}/${OLD_BASE}/${id}/config`, '', { retain: true, qos: 1 });
    for (const t of ['status', 'light/state', 'show/state', 'schedules/state', 'message/state', 'playing/state']) c.publish(`${OLD_BASE}/${t}`, '', { retain: true, qos: 1 });
  }

  private publishState() {
    if (!this.client?.connected) return;
    const st = this.actions.state();
    this.pub(`${BASE}/light/state`, JSON.stringify({
      state: st.on ? 'ON' : 'OFF', brightness: st.bri, effect: st.effect, color_mode: 'rgb',
      color: { r: st.rgb[0], g: st.rgb[1], b: st.rgb[2] },
    }), true);
    this.pub(`${BASE}/show/state`, st.show && st.shows.includes(st.show) ? st.show : NONE, true);
    this.pub(`${BASE}/schedules/state`, st.schedules ? 'ON' : 'OFF', true);
    this.pub(`${BASE}/message/state`, st.message ?? '', true);
    this.pub(`${BASE}/playing/state`, st.show ? `${st.show}${st.schedule && !st.showManual ? ` (${st.schedule})` : ''}` : st.on ? st.effect : 'Off', true);
  }

  /** Publishes only when the payload changed. */
  private pub(topic: string, payload: string, retain: boolean) {
    if (this.last.get(topic) === payload) return;
    this.last.set(topic, payload);
    this.client?.publish(topic, payload, { retain, qos: 0 });
  }

  private async command(topic: string, payload: string) {
    try {
      if (topic === `${this.prefix}/status`) {         // Home Assistant restarted: announce again
        if (payload === 'online') { this.last.clear(); this.publishDiscovery(); this.publishState(); }
        return;
      }
      switch (topic) {
        case `${BASE}/light/set`: {
          const j = JSON.parse(payload);
          await this.actions.setLook({
            on: j.state ? j.state === 'ON' : undefined,
            bri: typeof j.brightness === 'number' ? j.brightness : undefined,
            effect: j.effect, rgb: j.color ? [j.color.r, j.color.g, j.color.b] : undefined,
          });
          break;
        }
        case `${BASE}/show/set`:
          if (payload === NONE) await this.actions.stopShow(); else await this.actions.playShow(payload);
          break;
        case `${BASE}/schedules/set`: await this.actions.setSchedules(payload === 'ON'); break;
        case `${BASE}/message/set`: this.actions.message(payload); break;
        case `${BASE}/stop/press`: await this.actions.stopShow(); break;
      }
    } catch (e) {
      console.error(`homeassistant: ${topic}:`, (e as Error).message);
    }
    this.publishState();
  }

  stop() { clearInterval(this.timer); this.client?.end(true); }
}
