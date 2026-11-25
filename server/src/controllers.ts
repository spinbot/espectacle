import type { AppData, LightState } from '../shared/project.js';

/** Talks to the ESP32 controllers over their HTTP API (see firmware/src/main.cpp). */
export class Controllers {
  /** Latest /api/info reply per controller id (missing = not answering). */
  status = new Map<string, Record<string, unknown>>();
  private timer?: NodeJS.Timeout;

  constructor(private project: () => AppData) {}

  start(intervalMs = 5000) {
    const poll = () => this.poll().catch(() => {});
    poll();
    this.timer = setInterval(poll, intervalMs);
  }

  stop() { clearInterval(this.timer); }

  private async poll() {
    const list = this.project().controllers;
    await Promise.all(list.map(async c => {
      try {
        this.status.set(c.id, await request(c.host, 'GET', '/api/info') as Record<string, unknown>);
      } catch {
        this.status.delete(c.id);
      }
    }));
    for (const id of [...this.status.keys()]) if (!list.some(c => c.id === id)) this.status.delete(id);
  }

  /** Sends one look to every controller (like the app's Lights tab). */
  async setState(s: LightState) {
    const body = { ...s, t: Date.now() };
    const results = await Promise.allSettled(this.project().controllers.map(c => request(c.host, 'POST', '/api/state', body)));
    return results.map((r, i) => ({ id: this.project().controllers[i].id, ok: r.status === 'fulfilled', error: r.status === 'rejected' ? String(r.reason) : undefined }));
  }
}

export async function request(host: string, method: string, path: string, body?: unknown, timeoutMs = 3000): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}${path}`, {
      method, signal: ctl.signal,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(t);
  }
}
