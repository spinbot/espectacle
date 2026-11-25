// Schedules: play a list of shows on the real lights on chosen days between two times. The server runs
// them (src/scheduler.ts); the website edits them; the app keeps them (ScheduleModels in the app).
import type { UUID } from './project.js';

export interface Schedule {
  id: UUID;
  name: string;
  enabled: boolean;
  days: number[];          // 0 = Sunday ... 6 = Saturday: the days the window starts on
  start: string;           // "HH:MM" local time
  end: string;             // "HH:MM"; at or before start = runs past midnight
  shows: UUID[];           // played in this order, looping
  after: 'off' | 'look';   // when the window ends: all LEDs off, or back to the normal look
}

export interface ScheduleSettings {
  enabled: boolean;        // master switch
  timeZone: string;        // IANA zone the times are in (set from the browser that edits them)
  items: Schedule[];
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const emptySchedules = (timeZone: string): ScheduleSettings => ({ enabled: true, timeZone, items: [] });

export const minutesOf = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  return m ? (Number(m[1]) % 24) * 60 + Math.min(Number(m[2]), 59) : 0;
};

/** Day of the week (0 = Sunday) and minutes since midnight at `when` in `timeZone`. */
export function localTime(when: Date, timeZone: string): { day: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(when);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(when);
  }
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return { day: Math.max(0, DAY_NAMES.indexOf(get('weekday'))), minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

/** True when the schedule's window includes local day/minutes. */
export function windowContains(s: Schedule, day: number, minutes: number): boolean {
  if (!s.days.length) return false;
  const a = minutesOf(s.start), b = minutesOf(s.end);
  if (a < b) return s.days.includes(day) && minutes >= a && minutes < b;
  // Past midnight: the evening part on a chosen day, the early-morning part on the day after.
  return (s.days.includes(day) && minutes >= a) || (s.days.includes((day + 6) % 7) && minutes < b);
}

/** The first enabled schedule (with shows) whose window includes `when`. */
export function activeSchedule(settings: ScheduleSettings | null | undefined, when: Date): Schedule | null {
  if (!settings?.enabled) return null;
  const { day, minutes } = localTime(when, settings.timeZone);
  return settings.items.find(s => s.enabled && s.shows.length > 0 && windowContains(s, day, minutes)) ?? null;
}

/** When the next window starts (up to a week ahead), checked minute by minute. */
export function nextStart(settings: ScheduleSettings | null | undefined, from: Date): { schedule: Schedule; at: Date } | null {
  if (!settings?.enabled) return null;
  const t0 = Math.ceil(from.getTime() / 60000) * 60000;
  let wasActive = activeSchedule(settings, new Date(t0 - 60000));
  for (let k = 0; k < 7 * 24 * 60; k++) {
    const at = new Date(t0 + k * 60000);
    const s = activeSchedule(settings, at);
    if (s && s !== wasActive) return { schedule: s, at };
    wasActive = s;
  }
  return null;
}

/** What the scheduler is doing, for the website. */
export interface ScheduleStatus {
  enabled: boolean;
  active: { id: UUID; name: string } | null;
  show: { id: UUID; name: string; startedAt: number; endsAt: number } | null;
  manual?: boolean;        // the show was started by hand (Home Assistant), not by a schedule
  next: { id: UUID; name: string; at: number } | null;
  pausedUntilEnd: boolean;
  message: string | null;  // e.g. a controller that needs newer firmware
}
