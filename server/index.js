// Heating control server: serves the iPhone web app and a small JSON API.
// Two kinds of backend:
//   - single-zone drivers (simulator, shelly, homeassistant): this server runs
//     the schedule, boost and thermostat logic itself
//   - multi-zone drivers (evohome / Honeywell): the controller owns the
//     schedules; this server relays house mode and per-room overrides
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, normaliseTemp, validateSchedule, scheduledTarget } from './state.js';
import { loadDriver } from './drivers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
loadDotEnv(join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const PIN = (process.env.HEATING_PIN || '').trim();
const HYSTERESIS = 0.3; // °C either side of the target before switching

const store = new Store(join(ROOT, 'data', 'state.json'));
const driver = loadDriver(process.env, { tokenFile: join(ROOT, 'data', 'evohome-token.json') });
const ZONES = driver.kind === 'zones';
const LOOP_MS = ZONES ? (driver.minPollMs || 90_000) : 15_000;
console.log(`[heating] driver: ${driver.name}`);

let sensor = { currentTemp: null, heating: false, error: null, updatedAt: null };
let house = null; // zones: { name, tz, allowedModes }

// ---------------------------------------------------------------- control loop

function effectiveTarget(s = store.get(), now = new Date()) {
  if (s.mode === 'boost' && s.boost && s.boost.until > now.getTime()) return s.boost.temp;
  if (s.mode === 'heat') return s.targetTemp;
  if (s.mode === 'auto') return scheduledTarget(s.schedule, now) ?? s.targetTemp;
  return null; // off
}

async function tick({ force = false } = {}) {
  try {
    if (ZONES) {
      if (!house) house = await driver.info();
      const reading = await driver.read({ force });
      sensor = { ...reading, error: null, updatedAt: Date.now() };
      return;
    }
    const s = store.get();
    if (s.mode === 'boost' && (!s.boost || s.boost.until <= Date.now())) {
      store.update({ mode: s.boost?.previousMode || 'auto', boost: null });
    }
    const target = effectiveTarget();
    if (driver.kind === 'thermostat') {
      await driver.apply({ targetTemp: target ?? store.get().limits.min, mode: target == null ? 'off' : 'heat' });
    } else {
      const reading = await driver.read();
      let on = reading.heating;
      if (target == null || reading.currentTemp == null) on = false;
      else if (reading.currentTemp <= target - HYSTERESIS) on = true;
      else if (reading.currentTemp >= target + HYSTERESIS) on = false;
      if (on !== reading.heating) await driver.setHeating(on);
    }
    const reading = await driver.read();
    sensor = { ...reading, error: null, updatedAt: Date.now() };
  } catch (err) {
    sensor = { ...sensor, error: err.message, updatedAt: Date.now() };
    console.warn('[heating] driver error:', err.message);
  }
}

// ------------------------------------------------------------------------ API

function snapshot() {
  const s = store.get();
  if (ZONES) {
    return {
      driver: driver.name,
      kind: 'zones',
      house: {
        name: house?.name || 'Home',
        tz: house?.tz,
        timeZoneId: house?.timeZoneId,
        mode: sensor.systemMode || null,
        permanent: sensor.systemModePermanent,
        until: sensor.systemModeUntil || null,
        allowedModes: house?.allowedModes || [],
      },
      zones: sensor.zones || [],
      limits: { min: 5, max: 35, step: 0.5 },
      sensorError: sensor.error,
      updatedAt: sensor.updatedAt,
      serverTime: Date.now(),
    };
  }
  return {
    driver: driver.name,
    kind: 'single',
    mode: s.mode,
    targetTemp: s.targetTemp,
    effectiveTarget: effectiveTarget(s),
    currentTemp: sensor.currentTemp,
    heating: sensor.heating,
    boost: s.boost && s.mode === 'boost' ? s.boost : null,
    schedule: s.schedule,
    limits: s.limits,
    sensorError: sensor.error,
    updatedAt: sensor.updatedAt,
    serverTime: Date.now(),
  };
}

async function handleZonesApi(req, res, url, body) {
  const limits = { min: 5, max: 35, step: 0.5 };
  const zoneMatch = url.pathname.match(/^\/api\/zones\/([^/]+)\/(target|schedule|next)$/);

  if (req.method === 'GET' && zoneMatch && zoneMatch[2] === 'next') {
    const at = await driver.nextSwitchpoint(zoneMatch[1]);
    return send(res, 200, { zoneId: zoneMatch[1], nextSwitchpoint: at, tz: house?.tz });
  }

  if (req.method === 'POST' && zoneMatch) {
    const [, zoneId, action] = zoneMatch;
    if (!(sensor.zones || []).some(z => z.id === zoneId)) return send(res, 404, { error: 'unknown zone' });
    if (action === 'schedule') {
      await driver.resetZone(zoneId);
    } else {
      const temp = normaliseTemp(body.temp, limits);
      // hold: 'next' (until next scheduled change, default) | 'permanent' | number of minutes
      const hold = body.hold ?? 'next';
      if (hold === 'permanent') await driver.setZone(zoneId, { temp, permanent: true });
      else if (hold === 'next') await driver.setZone(zoneId, { temp });
      else await driver.setZone(zoneId, { temp, until: Date.now() + Math.min(24 * 60, Math.max(5, Number(hold))) * 60_000 });
    }
  } else if (req.method === 'POST' && url.pathname === '/api/house') {
    const minutes = body.minutes ? Math.min(14 * 24 * 60, Math.max(5, Number(body.minutes))) : null;
    await driver.setSystemMode(body.mode, minutes ? Date.now() + minutes * 60_000 : null);
  } else if (req.method === 'POST' && url.pathname === '/api/refresh') {
    // fall through to the forced refresh below
  } else {
    return send(res, 404, { error: 'not found' });
  }
  await tick({ force: true });
  send(res, sensor.error ? 502 : 200, { ...snapshot(), error: sensor.error || undefined });
}

async function handleApi(req, res, url) {
  if (PIN && req.headers['x-pin'] !== PIN) return send(res, 401, { error: 'PIN required' });
  const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot());
  if (ZONES) return handleZonesApi(req, res, url, body);

  const s = store.get();
  if (req.method === 'POST' && url.pathname === '/api/target') {
    const targetTemp = normaliseTemp(body.targetTemp, s.limits);
    if (s.mode === 'boost' && s.boost) store.update({ boost: { ...s.boost, temp: targetTemp } });
    else store.update({ targetTemp, mode: 'heat' });
  } else if (req.method === 'POST' && url.pathname === '/api/mode') {
    if (!['off', 'heat', 'auto'].includes(body.mode)) return send(res, 400, { error: 'mode must be off, heat or auto' });
    const patch = { mode: body.mode, boost: null };
    if (body.mode === 'heat' && s.mode !== 'heat') patch.targetTemp = effectiveTarget(s) ?? s.targetTemp;
    store.update(patch);
  } else if (req.method === 'POST' && url.pathname === '/api/boost') {
    const minutes = Math.min(240, Math.max(5, Number(body.minutes) || 60));
    const temp = normaliseTemp(body.temp ?? (effectiveTarget(s) ?? s.targetTemp) + 2, s.limits);
    const previousMode = s.mode === 'boost' ? (s.boost?.previousMode || 'auto') : s.mode;
    store.update({ mode: 'boost', boost: { temp, until: Date.now() + minutes * 60_000, previousMode } });
  } else if (req.method === 'PUT' && url.pathname === '/api/schedule') {
    store.update({ schedule: validateSchedule(body.schedule, s.limits) });
  } else {
    return send(res, 404, { error: 'not found' });
  }
  await tick();
  send(res, 200, snapshot());
}

// ----------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, 'public', rel);
  if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) return send(res, 404, { error: 'not found' });
  const type = MIME[extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
  res.end(readFileSync(file));
}

// -------------------------------------------------------------------- helpers

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 64_000) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
  });
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// --------------------------------------------------------------------- server

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(res, url.pathname);
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

await tick();
setInterval(tick, LOOP_MS);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[heating] listening on http://0.0.0.0:${PORT}  (open this address on your iPhone)`);
  if (PIN) console.log('[heating] PIN protection enabled');
});
