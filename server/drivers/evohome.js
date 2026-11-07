// Honeywell Evohome driver (Total Connect Comfort, Europe).
//
// Talks to the same cloud API the Honeywell Home / TCC app uses. One
// account can hold one location with several temperature zones (rooms),
// each with its own schedule on the controller. This driver exposes:
//   - the house ("system") mode: Auto, AutoWithEco, Away, DayOff, HeatingOff, Custom
//   - every zone: current temperature, target, override mode and 'until'
//   - per-zone overrides (temporary until a time, or permanent) and reset to schedule
//
// The vendor API is rate limited, so status is cached and refreshed on an
// interval; writes refresh it straight away.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const APP_ID = Buffer.from('4a231089-d2b6-41bd-a5eb-16a0a422b999:1a15cdb8-42de-407b-add0-059f92c530cb').toString('base64');
const SCOPE = 'EMEA-V1-Basic EMEA-V1-Anonymous';

// Windows time zone ids (as reported by the API) -> IANA names, for the common European cases.
const WINDOWS_TZ = {
  'W. Europe Standard Time': 'Europe/Amsterdam',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Helsinki',
  'GTB Standard Time': 'Europe/Athens',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'UTC': 'UTC',
};

// The API sends ids with the spaces and dots stripped, e.g. "WEuropeStandardTime".
const norm = s => String(s || '').replace(/[^a-z]/gi, '').toLowerCase();
function windowsToIana(id) {
  const key = norm(id);
  return Object.entries(WINDOWS_TZ).find(([k]) => norm(k) === key)?.[1] || null;
}

export const SYSTEM_MODES = ['Auto', 'AutoWithEco', 'Away', 'DayOff', 'HeatingOff', 'Custom'];

export function createDriver(env, opts = {}) {
  const username = env.EVOHOME_USERNAME;
  const password = env.EVOHOME_PASSWORD;
  if (!username || !password) throw new Error('EVOHOME_USERNAME and EVOHOME_PASSWORD are required for the evohome driver');
  const host = env.EVOHOME_HOST || 'tccna.resideo.com';
  const base = env.EVOHOME_BASE_URL || `https://${host}`; // override only for tests
  const tokenFile = opts.tokenFile || env.EVOHOME_TOKEN_FILE || 'data/evohome-token.json';
  const minPollMs = Number(env.EVOHOME_POLL_SECONDS || 90) * 1000;

  let token = loadToken();
  let location = null;        // { id, name, tz, systemId, allowedModes, zones: Map<id, {id,name}> }
  let cache = null;           // last status snapshot
  let cacheAt = 0;
  const schedules = new Map(); // zoneId -> { fetchedAt, days: {Mon: [...]} }

  // ------------------------------------------------------------ auth

  function loadToken() {
    try { return existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, 'utf8')) : null; } catch { return null; }
  }
  function saveToken(t) {
    try { mkdirSync(dirname(tokenFile), { recursive: true }); writeFileSync(tokenFile, JSON.stringify(t)); } catch {}
  }

  async function requestToken(form) {
    const res = await fetch(`${base}/Auth/OAuth/Token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${APP_ID}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ scope: SCOPE, ...form }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Evohome login failed (HTTP ${res.status}): ${body.error_description || body.error || body.message || 'unknown error'}`);
    return { access: body.access_token, refresh: body.refresh_token, expires: Date.now() + (Number(body.expires_in) - 30) * 1000 };
  }

  async function accessToken() {
    if (token && token.access && token.expires > Date.now()) return token.access;
    if (token && token.refresh) {
      try { token = await requestToken({ grant_type: 'refresh_token', refresh_token: token.refresh }); saveToken(token); return token.access; }
      catch (err) { console.warn('[evohome] refresh failed, logging in again:', err.message); }
    }
    token = await requestToken({ grant_type: 'password', Username: username, Password: password });
    saveToken(token);
    return token.access;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${base}/WebAPI/emea/api/v1/${path}`, {
      method,
      headers: {
        Authorization: `bearer ${await accessToken()}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) { token = null; throw new Error('Evohome rejected the access token'); }
    if (res.status === 429) throw new Error('Evohome API rate limit hit, try again in a few minutes');
    const text = await res.text();
    if (!res.ok) throw new Error(`Evohome ${method} ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  // ------------------------------------------------------- discovery

  async function discover() {
    if (location) return location;
    const account = await api('userAccount');
    const installs = await api(`location/installationInfo?userId=${account.userId}&includeTemperatureControlSystems=True`);
    if (!installs.length) throw new Error('No locations found on this Evohome account');
    const loc = env.EVOHOME_LOCATION ? installs.find(l => String(l.locationInfo.locationId) === env.EVOHOME_LOCATION || l.locationInfo.name === env.EVOHOME_LOCATION) : installs[0];
    if (!loc) throw new Error(`Location "${env.EVOHOME_LOCATION}" not found`);
    const tcs = loc.gateways[0].temperatureControlSystems[0];
    const winTz = loc.locationInfo.timeZone?.timeZoneId;
    location = {
      id: String(loc.locationInfo.locationId),
      name: loc.locationInfo.name,
      timeZoneId: winTz || null,
      tz: env.EVOHOME_TZ || windowsToIana(winTz) || Intl.DateTimeFormat().resolvedOptions().timeZone,
      systemId: String(tcs.systemId),
      allowedModes: (tcs.allowedSystemModes || []).map(m => m.systemMode).filter(m => SYSTEM_MODES.includes(m)),
      zones: new Map(tcs.zones.map(z => [String(z.zoneId), { id: String(z.zoneId), name: z.name, type: z.zoneType }])),
    };
    console.log(`[evohome] location "${location.name}" (${location.tz}), zones: ${[...location.zones.values()].map(z => z.name).join(', ')}`);
    return location;
  }

  // ---------------------------------------------------------- status

  async function fetchStatus() {
    const loc = await discover();
    const status = await api(`location/${loc.id}/status?includeTemperatureControlSystems=True`);
    const tcs = status.gateways[0].temperatureControlSystems[0];
    const zones = tcs.zones.map(z => {
      const meta = loc.zones.get(String(z.zoneId)) || { name: z.name };
      return {
        id: String(z.zoneId),
        name: meta.name || z.name,
        currentTemp: z.temperatureStatus?.isAvailable ? z.temperatureStatus.temperature : null,
        targetTemp: z.setpointStatus?.targetHeatTemperature ?? null,
        setpointMode: z.setpointStatus?.setpointMode || 'FollowSchedule',   // FollowSchedule | TemporaryOverride | PermanentOverride
        until: z.setpointStatus?.until ? Date.parse(z.setpointStatus.until) : null,
        faults: (z.activeFaults || []).map(f => f.faultType),
      };
    });
    cache = {
      systemMode: tcs.systemModeStatus?.mode,
      systemModePermanent: tcs.systemModeStatus?.isPermanent ?? true,
      systemModeUntil: tcs.systemModeStatus?.timeUntil ? Date.parse(tcs.systemModeStatus.timeUntil) : null,
      zones,
    };
    cacheAt = Date.now();
    return cache;
  }

  // -------------------------------------------------------- schedule

  /** Next scheduled switchpoint for a zone, as epoch ms, or null if unknown. */
  async function nextSwitchpoint(zoneId) {
    const loc = await discover();
    let sched = schedules.get(zoneId);
    if (!sched || Date.now() - sched.fetchedAt > 6 * 3600_000) {
      const raw = await api(`temperatureZone/${zoneId}/schedule`);
      const days = {};
      for (const d of raw.dailySchedules || []) {
        days[d.dayOfWeek] = (d.switchpoints || []).map(s => ({ time: s.timeOfDay, temp: s.heatSetpoint ?? s.temperature }));
      }
      sched = { fetchedAt: Date.now(), days };
      schedules.set(zoneId, sched);
    }
    const local = localParts(new Date(), loc.tz);
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (let ahead = 0; ahead < 8; ahead++) {
      const dayName = names[(local.weekday + ahead) % 7];
      const points = (sched.days[dayName] || []).filter(p => ahead > 0 || p.time > local.hhmmss);
      if (points.length) {
        const [h, m] = points[0].time.split(':').map(Number);
        return zonedTime(loc.tz, local.y, local.mo, local.d + ahead, h, m);
      }
    }
    return null;
  }

  // -------------------------------------------------------- commands

  async function setZone(zoneId, { temp, until, permanent }) {
    const body = { setpointMode: permanent ? 'PermanentOverride' : 'TemporaryOverride', heatSetpointValue: temp };
    if (!permanent) {
      let t = until;
      if (!t) t = await nextSwitchpoint(zoneId) || Date.now() + 3600_000;
      body.timeUntil = new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    await api(`temperatureZone/${zoneId}/heatSetpoint`, { method: 'PUT', body });
  }

  async function resetZone(zoneId) {
    await api(`temperatureZone/${zoneId}/heatSetpoint`, { method: 'PUT', body: { setpointMode: 'FollowSchedule' } });
  }

  async function setSystemMode(mode, until) {
    if (!SYSTEM_MODES.includes(mode)) throw new Error(`unknown system mode ${mode}`);
    const loc = await discover();
    const body = { systemMode: mode, permanent: !until };
    if (until) body.timeUntil = new Date(until).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await api(`temperatureControlSystem/${loc.systemId}/mode`, { method: 'PUT', body });
  }

  return {
    name: 'evohome',
    kind: 'zones',
    minPollMs,
    get location() { return location; },
    async read({ force = false } = {}) {
      if (!force && cache && Date.now() - cacheAt < minPollMs) return cache;
      return fetchStatus();
    },
    async info() {
      const loc = await discover();
      return { name: loc.name, tz: loc.tz, timeZoneId: loc.timeZoneId, allowedModes: loc.allowedModes };
    },
    nextSwitchpoint,
    setZone,
    resetZone,
    setSystemMode,
  };
}

// ---------------------------------------------------------- tz helpers

function localParts(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(date).map(p => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const pad = n => String(n).padStart(2, '0');
  return { y: +parts.year, mo: +parts.month, d: +parts.day, weekday, hhmmss: `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` };
}

/** Epoch ms for a wall-clock time in a time zone (handles DST by two-pass offset lookup). */
function zonedTime(tz, y, mo, d, h, m) {
  const guess = Date.UTC(y, mo - 1, d, h, m);
  const offsetAt = t => {
    const p = localParts(new Date(t), tz);
    return Date.UTC(p.y, p.mo - 1, p.d, ...p.hhmmss.split(':').map(Number)) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}
