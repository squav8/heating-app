// Home Assistant driver: controls a `climate.*` entity through the HA REST API.
// Home Assistant already integrates Tado, Nest, Hive, Honeywell, Netatmo,
// Bosch, Viessmann, Drayton Wiser and many more, so this is the quickest route
// if you own a smart thermostat.
export function createDriver(env) {
  const base = (env.HA_URL || 'http://homeassistant.local:8123').replace(/\/$/, '');
  const token = env.HA_TOKEN;
  const entity = env.HA_ENTITY || 'climate.living_room';
  if (!token) throw new Error('HA_TOKEN is required for the homeassistant driver');

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function call(path, body) {
    const res = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Home Assistant ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  return {
    name: `homeassistant (${entity})`,
    kind: 'thermostat',
    async read() {
      const s = await call(`/api/states/${entity}`);
      const a = s.attributes || {};
      return {
        currentTemp: a.current_temperature ?? null,
        targetTemp: a.temperature ?? null,
        heating: a.hvac_action === 'heating',
        hvacMode: s.state, // off | heat | auto ...
      };
    },
    // mode here is 'off' or 'heat'; the app does scheduling itself.
    async apply({ targetTemp, mode }) {
      if (mode === 'off') {
        await call('/api/services/climate/set_hvac_mode', { entity_id: entity, hvac_mode: 'off' });
        return;
      }
      await call('/api/services/climate/set_hvac_mode', { entity_id: entity, hvac_mode: 'heat' });
      await call('/api/services/climate/set_temperature', { entity_id: entity, temperature: targetTemp });
    },
  };
}
