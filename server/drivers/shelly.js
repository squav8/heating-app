// Shelly driver: switches a boiler / pump / valve through a Shelly relay
// (Shelly 1, Plus 1, 1PM, Pro 1 ...) and reads the room temperature from
// either a Shelly add-on sensor or any HTTP endpoint that returns JSON.
// The app itself acts as the thermostat (hysteresis control in server/index.js).
export function createDriver(env) {
  const base = (env.SHELLY_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('SHELLY_URL is required for the shelly driver');
  const tempSource = env.SHELLY_TEMP_SOURCE || 'shelly';
  const tempUrl = env.SHELLY_TEMP_URL;
  const tempPath = (env.SHELLY_TEMP_PATH || 'temperature').split('.');

  async function getJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }

  async function readRelay() {
    // Gen2 RPC first, fall back to Gen1.
    try {
      const r = await getJson(`${base}/rpc/Switch.GetStatus?id=0`);
      return Boolean(r.output);
    } catch {
      const r = await getJson(`${base}/relay/0`);
      return Boolean(r.ison);
    }
  }

  async function readTemperature() {
    if (tempSource === 'url' && tempUrl) {
      const j = await getJson(tempUrl);
      return Number(tempPath.reduce((o, k) => (o == null ? o : o[k]), j));
    }
    // Shelly Plus add-on temperature sensor
    const r = await getJson(`${base}/rpc/Temperature.GetStatus?id=100`);
    return Number(r.tC);
  }

  return {
    name: `shelly (${base})`,
    kind: 'relay',
    async read() {
      const [heating, currentTemp] = await Promise.all([readRelay(), readTemperature()]);
      return { heating, currentTemp: Number.isFinite(currentTemp) ? currentTemp : null };
    },
    async setHeating(on) {
      try {
        await getJson(`${base}/rpc/Switch.Set?id=0&on=${on ? 'true' : 'false'}`);
      } catch {
        await getJson(`${base}/relay/0?turn=${on ? 'on' : 'off'}`);
      }
    },
  };
}
