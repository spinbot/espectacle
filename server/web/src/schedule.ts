// The Schedule tab: play shows on the real lights on chosen days between two times. The server runs them.
import type { AppData } from '../../shared/project.js';
import { DAY_NAMES, emptySchedules, type Schedule, type ScheduleSettings, type ScheduleStatus } from '../../shared/schedule.js';
import { showsOf, uuid } from '../../shared/show.js';
import { api } from './api.js';

export interface ScheduleHost {
  data(): AppData;
  changed(): void;      // save
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];      // Monday first
const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

let lastStatus: ScheduleStatus | null = null;

function settingsOf(d: AppData): ScheduleSettings {
  if (!d.schedule) d.schedule = emptySchedules(browserZone());
  return d.schedule;
}

export function renderSchedules(box: HTMLElement, host: ScheduleHost) {
  const d = host.data();
  const st = d.schedule;
  const shows = showsOf(d);
  const rerender = () => renderSchedules(box, host);
  const touched = () => {
    const s = settingsOf(d);
    s.timeZone = browserZone();      // times are entered in this browser's time zone
    host.changed();
  };
  box.innerHTML = `
    <div class="sched-status" data-status></div>
    <label class="toggle"><input type="checkbox" data-master ${st?.enabled !== false ? 'checked' : ''}> Run schedules</label>
    <p class="hint">During a schedule's times the server plays its shows on the real lights, one after another,
      looping until the end time. Lights only – no music. Times are in ${esc(st?.timeZone ?? browserZone())}.
      If schedules overlap, the first one in the list wins.</p>
    <div data-list></div>
    <button data-add>+ Add schedule</button>`;
  box.querySelector<HTMLInputElement>('[data-master]')!.onchange = e => {
    settingsOf(d).enabled = (e.target as HTMLInputElement).checked;
    touched();
  };
  box.querySelector<HTMLButtonElement>('[data-add]')!.onclick = () => {
    const s = settingsOf(d);
    s.items.push({ id: uuid(), name: `Schedule ${s.items.length + 1}`, enabled: true, days: [0, 1, 2, 3, 4, 5, 6],
      start: '18:30', end: '22:00', shows: shows.slice(0, 1).map(x => x.id), after: 'off' });
    touched();
    rerender();
  };
  const list = box.querySelector<HTMLElement>('[data-list]')!;
  for (const s of st?.items ?? []) list.appendChild(card(s));
  if (!st?.items.length) list.innerHTML = '<p class="hint">No schedules yet.</p>';
  showStatus(box);

  function card(s: Schedule): HTMLElement {
    const el = document.createElement('div');
    el.className = 'sched';
    el.innerHTML = `
      <div class="row head"><input data-name value="${esc(s.name)}">
        <label class="check"><input type="checkbox" data-on ${s.enabled ? 'checked' : ''}> On</label></div>
      <div class="days">${DAY_ORDER.map(i => `<button data-day="${i}" class="${s.days.includes(i) ? 'active' : ''}">${DAY_NAMES[i]}</button>`).join('')}</div>
      <div class="row times"><label>From <input data-start type="time" value="${s.start}"></label>
        <label>To <input data-end type="time" value="${s.end}"></label>
        <span class="sub" data-overnight>${s.end <= s.start ? 'ends the next morning' : ''}</span></div>
      <h3>Shows, in order</h3>
      <div class="sched-shows">${s.shows.map((id, k) => {
        const sh = shows.find(x => x.id === id);
        return `<div class="sched-show" data-k="${k}"><span>${k + 1}. ${sh ? esc(sh.name) : '<i>deleted show</i>'}</span>
          <span class="sub">${sh ? mmss(sh.duration * 1000) : ''}</span>
          <button data-up title="Earlier" ${k === 0 ? 'disabled' : ''}>↑</button><button data-down title="Later" ${k === s.shows.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-remove title="Remove">✕</button></div>`;
      }).join('') || '<p class="hint">No shows yet.</p>'}</div>
      <div class="row"><select data-addshow><option value="">+ Add a show…</option>${shows.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
      <label class="field">When it ends <select data-after>
        <option value="off" ${s.after === 'off' ? 'selected' : ''}>All lights off</option>
        <option value="look" ${s.after === 'look' ? 'selected' : ''}>Back to the normal look</option></select></label>
      <div class="row"><button data-delete class="danger">Delete schedule</button></div>`;
    const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
    q<HTMLInputElement>('[data-name]').oninput = e => { s.name = (e.target as HTMLInputElement).value; touched(); };
    q<HTMLInputElement>('[data-on]').onchange = e => { s.enabled = (e.target as HTMLInputElement).checked; touched(); };
    el.querySelectorAll<HTMLButtonElement>('[data-day]').forEach(b => b.onclick = () => {
      const day = Number(b.dataset.day);
      s.days = s.days.includes(day) ? s.days.filter(x => x !== day) : [...s.days, day].sort();
      b.classList.toggle('active', s.days.includes(day));
      touched();
    });
    const times = () => { q('[data-overnight]').textContent = s.end <= s.start ? 'ends the next morning' : ''; touched(); };
    q<HTMLInputElement>('[data-start]').onchange = e => { s.start = (e.target as HTMLInputElement).value || s.start; times(); };
    q<HTMLInputElement>('[data-end]').onchange = e => { s.end = (e.target as HTMLInputElement).value || s.end; times(); };
    el.querySelectorAll<HTMLElement>('.sched-show').forEach(row => {
      const k = Number(row.dataset.k);
      const swap = (j: number) => { [s.shows[k], s.shows[j]] = [s.shows[j], s.shows[k]]; touched(); rerender(); };
      row.querySelector<HTMLButtonElement>('[data-up]')!.onclick = () => swap(k - 1);
      row.querySelector<HTMLButtonElement>('[data-down]')!.onclick = () => swap(k + 1);
      row.querySelector<HTMLButtonElement>('[data-remove]')!.onclick = () => { s.shows.splice(k, 1); touched(); rerender(); };
    });
    q<HTMLSelectElement>('[data-addshow]').onchange = e => {
      const v = (e.target as HTMLSelectElement).value;
      if (v) { s.shows.push(v); touched(); rerender(); }
    };
    q<HTMLSelectElement>('[data-after]').onchange = e => { s.after = (e.target as HTMLSelectElement).value as 'off' | 'look'; touched(); };
    q<HTMLButtonElement>('[data-delete]').onclick = () => {
      if (!confirm(`Delete ${s.name}?`)) return;
      const set = settingsOf(d);
      set.items = set.items.filter(x => x !== s);
      touched();
      rerender();
    };
    return el;
  }
}

/** Fills in the "now playing" box from the last status (refreshed by pollScheduleStatus). */
function showStatus(box: HTMLElement) {
  const el = box.querySelector<HTMLElement>('[data-status]');
  if (!el) return;
  const st = lastStatus;
  if (!st) { el.innerHTML = ''; return; }
  let html: string;
  if (!st.enabled) html = '<b>Schedules are off.</b>';
  else if (st.active && st.show) {
    html = `<b>Now: ${esc(st.active.name)}</b> – playing “${esc(st.show.name)}” (${mmss(Date.now() - st.show.startedAt)} of ${mmss(st.show.endsAt - st.show.startedAt)})
      <button data-pause class="secondary">Stop until this one ends</button>`;
  } else if (st.pausedUntilEnd) {
    html = '<b>Stopped</b> until the current schedule’s end time. <button data-resume class="secondary">Start again</button>';
  } else {
    html = st.next ? `Nothing scheduled right now. Next: <b>${esc(st.next.name)}</b>, ${fmtTime(st.next.at)}.` : 'Nothing scheduled in the next week.';
  }
  if (st.message) html += `<div class="warn">${esc(st.message)}</div>`;
  el.innerHTML = html;
  el.querySelector<HTMLButtonElement>('[data-pause]')?.addEventListener('click', async () => { lastStatus = await api.schedulePause(); showStatus(box); });
  el.querySelector<HTMLButtonElement>('[data-resume]')?.addEventListener('click', async () => { lastStatus = await api.scheduleResume(); showStatus(box); });
}

/** Keeps the status box current while the page is open. */
export function pollScheduleStatus(box: HTMLElement) {
  const run = async () => {
    try { lastStatus = await api.scheduleStatus(); showStatus(box); } catch { /* next time */ }
    setTimeout(run, 3000);
  };
  run();
}
