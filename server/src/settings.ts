// Server-only settings (not part of the project, so the app never sees or overwrites them, and the MQTT
// password stays on the server): <data>/settings.json.
import { promises as fs } from 'fs';
import path from 'path';

export interface ServerSettings {
  timeZone: string;                  // for countdowns (set from the browser that saves the settings)
  mqtt: { enabled: boolean; host: string; port: number; username: string; password: string; prefix: string };
  messages: { plants: string[]; seconds: number; color: number; scale: number };
  /** Baked into firmware built here (Devices → Build). */
  build: { wifiSsid: string; wifiPassword: string; serverUrl: string };
}

export const defaultSettings = (): ServerSettings => ({
  timeZone: 'UTC',
  mqtt: { enabled: false, host: '', port: 1883, username: '', password: '', prefix: 'homeassistant' },
  messages: { plants: [], seconds: 30, color: 0xffffff, scale: 128 },
  build: { wifiSsid: '', wifiPassword: '', serverUrl: '' },
});

export class Settings {
  private value = defaultSettings();
  private listeners: ((s: ServerSettings) => void)[] = [];
  constructor(private dir: string) {}

  private get file() { return path.join(this.dir, 'settings.json'); }

  async init() {
    try {
      const v = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.value = merge(defaultSettings(), v);
    } catch { /* first run */ }
  }

  get(): ServerSettings { return this.value; }

  /** The settings without the MQTT password (for the website). */
  public_(): ServerSettings & { mqtt: { passwordSet: boolean }; build: { wifiPasswordSet: boolean } } {
    const v = structuredClone(this.value) as ServerSettings & { mqtt: { passwordSet: boolean }; build: { wifiPasswordSet: boolean } };
    v.mqtt.passwordSet = !!this.value.mqtt.password;
    v.mqtt.password = '';
    v.build.wifiPasswordSet = !!this.value.build.wifiPassword;
    v.build.wifiPassword = '';
    return v;
  }

  /** Saves a partial update. An empty MQTT password keeps the old one. */
  async put(update: Partial<ServerSettings>) {
    const next = merge(structuredClone(this.value), update);
    if (update.mqtt && !update.mqtt.password) next.mqtt.password = this.value.mqtt.password;
    if (update.build && !update.build.wifiPassword && update.build.wifiSsid === this.value.build.wifiSsid) next.build.wifiPassword = this.value.build.wifiPassword;
    this.value = next;
    await fs.writeFile(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    for (const l of this.listeners) l(next);
  }

  /** Replaces every setting (restoring a backup), passwords included. */
  async replace(v: unknown) {
    const next = merge(defaultSettings(), v);
    this.value = next;
    await fs.writeFile(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    for (const l of this.listeners) l(next);
  }

  onChange(f: (s: ServerSettings) => void) { this.listeners.push(f); }
}

function merge<T>(base: T, v: unknown): T {
  if (!v || typeof v !== 'object') return base;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const cur = (base as Record<string, unknown>)[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && val && typeof val === 'object' && !Array.isArray(val)) {
      merge(cur, val);
    } else if (cur !== undefined && val !== undefined && (typeof cur === typeof val || cur === null)) {
      (base as Record<string, unknown>)[k] = val;
    }
  }
  return base;
}
