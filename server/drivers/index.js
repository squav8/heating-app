import { createDriver as simulator } from './simulator.js';
import { createDriver as homeassistant } from './homeassistant.js';
import { createDriver as shelly } from './shelly.js';
import { createDriver as evohome } from './evohome.js';

const DRIVERS = { simulator, homeassistant, shelly, evohome, honeywell: evohome };

export function loadDriver(env, opts) {
  const name = (env.HEATING_DRIVER || 'simulator').toLowerCase();
  const factory = DRIVERS[name];
  if (!factory) {
    throw new Error(`Unknown HEATING_DRIVER "${name}". Choose one of: ${Object.keys(DRIVERS).join(', ')}`);
  }
  return factory(env, opts);
}
