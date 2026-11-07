// Persistent app state: target temperature, mode, schedule, boost.
// Stored as a small JSON file so it survives restarts.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULTS = {
  mode: 'auto',          // off | heat | auto | boost
  targetTemp: 20,        // used in 'heat' mode (manual hold)
  boost: null,           // { temp, until (epoch ms), previousMode }
  schedule: [
    { days: [1, 2, 3, 4, 5], time: '06:30', temp: 21 },
    { days: [1, 2, 3, 4, 5], time: '08:30', temp: 17 },
    { days: [1, 2, 3, 4, 5], time: '17:00', temp: 21 },
    { days: [0, 1, 2, 3, 4, 5, 6], time: '22:30', temp: 16 },
    { days: [0, 6], time: '08:00', temp: 21 },
  ],
  limits: { min: 5, max: 30, step: 0.5 },
};

export class Store {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      if (existsSync(this.file)) {
        const saved = JSON.parse(readFileSync(this.file, 'utf8'));
        this.data = { ...structuredClone(DEFAULTS), ...saved };
      }
    } catch (err) {
      console.warn('[state] could not read state file, using defaults:', err.message);
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn('[state] could not write state file:', err.message);
    }
  }

  get() { return this.data; }

  update(patch) {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.data;
  }
}

/** Clamp and round a temperature to the configured step. */
export function normaliseTemp(value, limits) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('temperature must be a number');
  const rounded = Math.round(n / limits.step) * limits.step;
  return Math.min(limits.max, Math.max(limits.min, rounded));
}

/** Validate a schedule entry list. Returns a cleaned copy or throws. */
export function validateSchedule(entries, limits) {
  if (!Array.isArray(entries)) throw new Error('schedule must be an array');
  return entries.map((e, i) => {
    if (!Array.isArray(e.days) || e.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error(`entry ${i}: days must be integers 0 (Sun) to 6 (Sat)`);
    }
    if (typeof e.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.time)) {
      throw new Error(`entry ${i}: time must be HH:MM`);
    }
    return { days: [...new Set(e.days)].sort(), time: e.time, temp: normaliseTemp(e.temp, limits) };
  }).sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Work out the scheduled target for a given moment: the most recent entry
 * today at or before `now`, otherwise the last entry from the latest previous
 * day that has one.
 */
export function scheduledTarget(schedule, now = new Date()) {
  if (!schedule.length) return null;
  const hhmm = now.toTimeString().slice(0, 5);
  for (let back = 0; back < 8; back++) {
    const day = (now.getDay() - back + 7) % 7;
    const todays = schedule
      .filter(e => e.days.includes(day))
      .filter(e => back > 0 || e.time <= hhmm)
      .sort((a, b) => b.time.localeCompare(a.time));
    if (todays.length) return todays[0].temp;
  }
  return null;
}
