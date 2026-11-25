// Choosing (and uploading) a video for the Video online effect, and loading decoded frames for previews.
import { decodeMediaFrames, type MediaFrames } from '../../shared/online.js';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const frames = new Map<string, MediaFrames | null | 'loading'>();

/** Decoded frames for previews (null until loaded; loading starts on first ask). */
export function previewFrames(name: string): MediaFrames | null {
  const f = frames.get(name);
  if (f === undefined) {
    frames.set(name, 'loading');
    fetch(`/api/media/${encodeURIComponent(name)}/frames`, { credentials: 'same-origin' })
      .then(r => (r.ok ? r.arrayBuffer() : null))
      .then(b => { frames.set(name, b ? decodeMediaFrames(b) : null); })
      .catch(() => frames.set(name, null));
    return null;
  }
  return f === 'loading' ? null : f;
}

/** A select of the server's videos plus an upload button. `changed` gets the chosen file name. */
export function mediaPicker(box: HTMLElement, current: string | null | undefined, changed: (name: string | null) => void) {
  box.innerHTML = `<h2>Video</h2><div class="row media-row"><select data-media><option value="">Loading…</option></select>
    <label class="button-like">Upload…<input type="file" accept="video/*,image/gif" hidden></label></div>
    <p class="hint" data-mstatus>Videos are stored on the server and shrunk to LED size. Up to 2 minutes is used; it loops.</p>`;
  const sel = box.querySelector<HTMLSelectElement>('[data-media]')!, status = box.querySelector<HTMLElement>('[data-mstatus]')!;
  const load = async (pick?: string | null) => {
    try {
      const r = await fetch('/api/media', { credentials: 'same-origin' });
      const list = (await r.json()) as { name: string; seconds?: number; error?: string }[];
      const want = pick ?? current ?? '';
      sel.innerHTML = `<option value="">${list.length ? 'Choose a video…' : 'No videos yet – upload one'}</option>` +
        list.map(m => `<option value="${esc(m.name)}" ${m.name === want ? 'selected' : ''}>${esc(m.name)}${m.seconds ? ` (${Math.round(m.seconds)} s)` : m.error ? ' (can’t read)' : ''}</option>`).join('');
    } catch { sel.innerHTML = '<option value="">Can’t reach the server</option>'; }
  };
  sel.onchange = () => changed(sel.value || null);
  box.querySelector<HTMLInputElement>('input[type=file]')!.onchange = async e => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const name = file.name.replace(/[^\w .()-]/g, '_').slice(0, 100);
    status.textContent = `Uploading ${name}…`;
    try {
      const r = await fetch(`/api/media/${encodeURIComponent(name)}`, { method: 'PUT', body: file, credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      status.textContent = `Uploaded ${name}. Preparing it for the LEDs…`;
      frames.delete(name);
      const f = await fetch(`/api/media/${encodeURIComponent(name)}/frames`, { credentials: 'same-origin' });
      status.textContent = f.ok ? `${name} is ready.` : `The server couldn’t read ${name}: ${(await f.json().catch(() => ({}))).error ?? ''}`;
      await load(name);
      changed(name);
    } catch (err) {
      status.textContent = `Upload failed: ${(err as Error).message}`;
    }
  };
  void load();
}
