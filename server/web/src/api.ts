import type { AppData, LightState, ProjectEnvelope } from '../../shared/project.js';
import type { ScheduleStatus } from '../../shared/schedule.js';

export class AuthError extends Error {}
export class ConflictError extends Error {
  constructor(readonly current: ProjectEnvelope) { super('The project was changed somewhere else.'); }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.status === 401) throw new AuthError('login required');
  return res;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await call(path, init);
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) throw new ConflictError(body as ProjectEnvelope);
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  login: (password: string) =>
    json<{ ok: boolean }>('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }),
  project: () => json<ProjectEnvelope>('/api/project'),
  saveProject: (data: AppData, baseRevision: number) =>
    json<{ revision: number }>('/api/project', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision, data }) }),
  area: async (): Promise<ArrayBuffer | null> => {
    const res = await call('/api/area');
    return res.ok ? res.arrayBuffer() : null;
  },
  status: () => json<Record<string, { name?: string; ip?: string; fw?: string; ddp?: boolean }>>('/api/status'),
  scheduleStatus: () => json<ScheduleStatus>('/api/schedule/status'),
  schedulePause: () => json<ScheduleStatus>('/api/schedule/pause', { method: 'POST' }),
  scheduleResume: () => json<ScheduleStatus>('/api/schedule/resume', { method: 'POST' }),
  setLights: (s: LightState) =>
    json<{ id: string; ok: boolean; error?: string }[]>('/api/lights/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }),
};

/** Decodes the yard scan file (see AreaStore.swift): 16 bytes per point. */
export function decodeArea(buf: ArrayBuffer): { positions: Float32Array; colors: Uint8Array } | null {
  const dv = new DataView(buf);
  if (buf.byteLength < 8 || dv.getUint32(0, true) !== 0x31414c54) return null;
  const n = dv.getUint32(4, true);
  if (buf.byteLength < 8 + n * 16) return null;
  const positions = new Float32Array(n * 3), colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 16;
    positions[i * 3] = dv.getFloat32(o, true);
    positions[i * 3 + 1] = dv.getFloat32(o + 4, true);
    positions[i * 3 + 2] = dv.getFloat32(o + 8, true);
    colors[i * 3] = dv.getUint8(o + 12); colors[i * 3 + 1] = dv.getUint8(o + 13); colors[i * 3 + 2] = dv.getUint8(o + 14);
  }
  return { positions, colors };
}
