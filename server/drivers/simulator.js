// Simulator driver: a fake room with a simple thermal model.
// Lets you try the app with no hardware at all.
export function createDriver() {
  let roomTemp = 18.5;
  let heating = false;
  let last = Date.now();
  const outside = 8;

  function step() {
    const now = Date.now();
    const dt = (now - last) / 1000; // seconds
    last = now;
    // Heat loss towards outside temperature, plus heater input when on.
    const loss = (roomTemp - outside) * 0.00008 * dt;
    const gain = heating ? 0.0025 * dt : 0;
    roomTemp = roomTemp - loss + gain;
  }

  return {
    name: 'simulator',
    kind: 'relay',
    async read() {
      step();
      return { currentTemp: Math.round(roomTemp * 10) / 10, heating };
    },
    async setHeating(on) {
      step();
      heating = Boolean(on);
    },
  };
}
