// Front-end logic for the heating app. Plain JS, no build step.
const $ = s => document.querySelector(s);
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
let state = null;
let pendingTarget = null;   // optimistic target while the user taps +/-
let targetTimer = null;
let scheduleTimer = null;
let pin = localStorage.getItem('heating-pin') || '';

// ------------------------------------------------------------------ API

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Pin': pin },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { askPin(); throw new Error('PIN required'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refresh() {
  try {
    state = await api('/api/state');
    const heatingZones = (state.zones || []).filter(z => z.currentTemp != null && z.targetTemp != null && z.currentTemp < z.targetTemp).length;
    setStatus(state.sensorError ? 'err' : 'ok', state.sensorError ? 'Connection error'
      : state.kind === 'zones' ? (heatingZones ? `${heatingZones} room${heatingZones > 1 ? 's' : ''} heating` : 'Idle')
      : state.heating ? 'Heating on' : 'Idle');
    render();
  } catch (err) {
    if (err.message !== 'PIN required') setStatus('err', 'Offline');
  }
}

function send(path, body) {
  return api(path, path.endsWith('/schedule') ? 'PUT' : 'POST', body)
    .then(s => { state = s; render(); })
    .catch(err => toast(err.message));
}

// --------------------------------------------------------------- render

function render() {
  if (!state) return;
  $('#single-view').hidden = state.kind === 'zones';
  $('#zones-view').hidden = state.kind !== 'zones';
  if (state.kind === 'zones') return renderZones();
  const { limits } = state;
  const target = pendingTarget ?? state.effectiveTarget;
  const cur = state.currentTemp;

  $('#current').textContent = cur == null ? '--' : cur.toFixed(1);
  $('#target').textContent = target == null ? '—' : target.toFixed(1);
  $('#flame').hidden = !state.heating;

  // Ring: fill proportionally between min and max over a 270° arc (405 of 540 dash units).
  const span = limits.max - limits.min;
  const frac = cur == null ? 0 : Math.min(1, Math.max(0, (cur - limits.min) / span));
  $('#ring-fill').setAttribute('stroke-dasharray', `${frac * 405} 540`);
  $('#ring-fill').classList.toggle('cool', target != null && cur != null && cur >= target);
  const marker = $('#ring-marker');
  if (target == null) marker.style.display = 'none';
  else {
    marker.style.display = '';
    const angle = (135 + 270 * (target - limits.min) / span) * Math.PI / 180;
    marker.setAttribute('cx', 100 + 86 * Math.cos(angle));
    marker.setAttribute('cy', 100 + 86 * Math.sin(angle));
  }

  const off = state.mode === 'off';
  $('#minus').disabled = off || target == null || target <= limits.min;
  $('#plus').disabled = off || target == null || target >= limits.max;

  $('#hint').textContent = {
    off: 'Heating is off. Adjusting the temperature turns it on.',
    auto: 'Following your schedule. Adjust to hold a temperature manually.',
    heat: 'Holding this temperature until you change mode.',
    boost: state.boost ? `Boost until ${fmtTime(state.boost.until)}, then back to ${state.boost.previousMode === 'auto' ? 'schedule' : state.boost.previousMode}.` : '',
  }[state.mode];

  document.querySelectorAll('.modes button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === state.mode || (state.mode === 'boost' && b.dataset.mode === state.boost?.previousMode));
  });

  const boosting = state.mode === 'boost' && state.boost;
  $('#boost-cancel').hidden = !boosting;
  $('#boost-text').textContent = boosting
    ? `Boosting to ${state.boost.temp}° until ${fmtTime(state.boost.until)}.`
    : 'Warm the house up quickly for a while, then go back to normal.';
  document.querySelectorAll('[data-boost]').forEach(b => b.classList.toggle('active', false));

  if (!scheduleTimer) renderSchedule();
  $('#footer').textContent = `Backend: ${state.driver}`;
}

function renderSchedule() {
  const ul = $('#schedule');
  ul.innerHTML = '';
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);
  const todaysActive = state.schedule
    .filter(e => e.days.includes(now.getDay()) && e.time <= hhmm)
    .sort((a, b) => b.time.localeCompare(a.time))[0];

  state.schedule.forEach((entry, i) => {
    const li = document.createElement('li');
    li.className = 'entry' + (entry === todaysActive && state.mode === 'auto' ? ' now' : '');

    const time = document.createElement('input');
    time.type = 'time'; time.value = entry.time;
    time.onchange = () => { entry.time = time.value; saveSchedule(); };

    const days = document.createElement('div'); days.className = 'days';
    DAY_LABELS.forEach((label, d) => {
      const b = document.createElement('button');
      b.textContent = label; b.className = entry.days.includes(d) ? 'on' : '';
      b.setAttribute('aria-label', ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d]);
      b.onclick = () => {
        entry.days = entry.days.includes(d) ? entry.days.filter(x => x !== d) : [...entry.days, d];
        b.classList.toggle('on'); saveSchedule();
      };
      days.appendChild(b);
    });

    const temp = document.createElement('div'); temp.className = 'temp-edit';
    const minus = document.createElement('button'); minus.textContent = '−';
    const val = document.createElement('span'); val.textContent = `${entry.temp.toFixed(1)}°`;
    const plus = document.createElement('button'); plus.textContent = '+';
    const bump = delta => {
      entry.temp = Math.min(state.limits.max, Math.max(state.limits.min, entry.temp + delta));
      val.textContent = `${entry.temp.toFixed(1)}°`; saveSchedule();
    };
    minus.onclick = () => bump(-state.limits.step);
    plus.onclick = () => bump(state.limits.step);
    temp.append(minus, val, plus);

    const remove = document.createElement('button'); remove.className = 'remove'; remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove');
    remove.onclick = () => { state.schedule.splice(i, 1); renderSchedule(); saveSchedule(); };

    li.append(time, days, temp, remove);
    ul.appendChild(li);
  });
}

function saveSchedule() {
  clearTimeout(scheduleTimer);
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    send('/api/schedule', { schedule: state.schedule }).then(() => { renderSchedule(); toast('Schedule saved'); });
  }, 800);
}

// --------------------------------------------------------------- actions

function adjust(delta) {
  if (!state) return;
  const base = pendingTarget ?? state.effectiveTarget ?? state.targetTemp;
  pendingTarget = Math.min(state.limits.max, Math.max(state.limits.min, Math.round((base + delta) / state.limits.step) * state.limits.step));
  render();
  clearTimeout(targetTimer);
  targetTimer = setTimeout(() => {
    const t = pendingTarget; pendingTarget = null;
    send('/api/target', { targetTemp: t });
  }, 700);
}

$('#minus').onclick = () => adjust(-state.limits.step);
$('#plus').onclick = () => adjust(state.limits.step);
document.querySelectorAll('.modes button').forEach(b => b.onclick = () => send('/api/mode', { mode: b.dataset.mode }));
document.querySelectorAll('[data-boost]').forEach(b => b.onclick = () => send('/api/boost', { minutes: Number(b.dataset.boost) }));
$('#boost-cancel').onclick = () => send('/api/mode', { mode: state.boost?.previousMode || 'auto' });
$('#add-entry').onclick = () => {
  state.schedule.push({ days: [0, 1, 2, 3, 4, 5, 6], time: '12:00', temp: 20 });
  renderSchedule(); saveSchedule();
};

// ------------------------------------------------------------------ PIN

function askPin() {
  const dlg = $('#pin-dialog');
  if (dlg.open) return;
  $('#pin-input').value = '';
  dlg.showModal();
  dlg.onclose = () => {
    pin = $('#pin-input').value.trim();
    if (pin) { localStorage.setItem('heating-pin', pin); refresh(); }
  };
}

// --------------------------------------------------------------- helpers

function setStatus(kind, text) {
  $('#status').className = `status ${kind}`;
  $('#status-text').textContent = text;
}
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
let toastEl;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastEl.t); toastEl.t = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------- start

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
refresh();
setInterval(refresh, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });


// ============================================================ zones view (Evohome)

const HOUSE_MODE_LABELS = { Auto: 'Schedule', AutoWithEco: 'Eco', Away: 'Away', DayOff: 'Day off', HeatingOff: 'Off', Custom: 'Custom' };
const HOUSE_MODE_HINTS = {
  Auto: 'Every room follows its own schedule on the controller.',
  AutoWithEco: 'Schedules run 3° cooler.',
  Away: 'Whole house held at a low temperature while you are away.',
  DayOff: 'Rooms follow their weekend schedule today.',
  HeatingOff: 'Heating is off in every room. Frost protection stays on.',
  Custom: 'Rooms follow their custom schedule.',
};
const HOLD_OPTIONS = [['next', 'Next'], ['60', '1 h'], ['180', '3 h'], ['permanent', '∞']];
const zonePending = new Map();   // zoneId -> { temp, timer }
let zonesSignature = '';

function holdFor(zoneId) { return localStorage.getItem(`hold-${zoneId}`) || 'next'; }

function renderZones() {
  $('#house-name').textContent = state.house.name || 'Home';
  const modes = state.house.allowedModes.length ? state.house.allowedModes : Object.keys(HOUSE_MODE_LABELS);
  const modesEl = $('#house-modes');
  if (modesEl.dataset.sig !== modes.join()) {
    modesEl.dataset.sig = modes.join();
    modesEl.innerHTML = '';
    modes.forEach(m => {
      const b = document.createElement('button'); b.dataset.mode = m; b.role = 'tab'; b.textContent = HOUSE_MODE_LABELS[m] || m;
      b.onclick = () => send('/api/house', { mode: m }).then(() => toast(`House set to ${HOUSE_MODE_LABELS[m] || m}`));
      modesEl.appendChild(b);
    });
  }
  modesEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === state.house.mode));
  let hint = HOUSE_MODE_HINTS[state.house.mode] || '';
  if (state.house.until && !state.house.permanent) hint += ` Until ${fmtWhen(state.house.until)}.`;
  $('#house-hint').textContent = hint;

  const ul = $('#zones');
  const sig = state.zones.map(z => z.id).join();
  if (zonesSignature !== sig) { ul.innerHTML = ''; zonesSignature = sig; }

  state.zones.forEach(z => {
    let li = ul.querySelector(`[data-zone="${z.id}"]`);
    if (!li) {
      li = document.createElement('li'); li.className = 'zone'; li.dataset.zone = z.id;
      li.innerHTML = `
        <div class="zone-head"><span class="zone-name"></span><span class="zone-sub"></span></div>
        <div class="zone-body">
          <div class="zone-temp"></div>
          <div class="zone-target">
            <button class="round minus" aria-label="Lower">−</button>
            <span class="val"></span>
            <button class="round plus" aria-label="Raise">+</button>
          </div>
        </div>
        <div class="zone-foot">
          <div class="hold"></div>
          <button class="pill reset" hidden>Follow schedule</button>
        </div>`;
      const hold = li.querySelector('.hold');
      HOLD_OPTIONS.forEach(([val, label]) => {
        const b = document.createElement('button'); b.textContent = label; b.dataset.hold = val;
        b.title = { next: 'Until the next scheduled change', permanent: 'Until you change it' }[val] || `For ${label}`;
        b.onclick = () => { localStorage.setItem(`hold-${z.id}`, val); hold.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
        hold.appendChild(b);
      });
      li.querySelector('.minus').onclick = () => adjustZone(z.id, -state.limits.step);
      li.querySelector('.plus').onclick = () => adjustZone(z.id, state.limits.step);
      li.querySelector('.reset').onclick = () => send(`/api/zones/${z.id}/schedule`).then(() => toast(`${z.name}: following schedule`));
      ul.appendChild(li);
    }
    const pending = zonePending.get(z.id);
    const target = pending ? pending.temp : z.targetTemp;
    li.querySelector('.zone-name').textContent = z.name;
    const tempEl = li.querySelector('.zone-temp');
    if (z.currentTemp == null) { tempEl.textContent = 'No signal'; tempEl.className = 'zone-temp na'; }
    else { tempEl.innerHTML = `${z.currentTemp.toFixed(1)}<small>°</small>`; tempEl.className = 'zone-temp'; }
    li.querySelector('.val').textContent = target == null ? '—' : `${target.toFixed(1)}°`;
    li.querySelector('.minus').disabled = target == null || target <= state.limits.min;
    li.querySelector('.plus').disabled = target == null || target >= state.limits.max;
    li.classList.toggle('heating', z.currentTemp != null && target != null && z.currentTemp < target);

    const sub = li.querySelector('.zone-sub');
    const overridden = z.setpointMode !== 'FollowSchedule';
    sub.className = 'zone-sub' + (overridden ? ' override' : '');
    sub.textContent = pending ? 'Saving…'
      : z.setpointMode === 'TemporaryOverride' ? `Held until ${fmtWhen(z.until)}`
      : z.setpointMode === 'PermanentOverride' ? 'Held permanently'
      : 'Following schedule' + faultNote(z.faults);
    li.querySelector('.reset').hidden = !overridden;
    const cur = holdFor(z.id);
    li.querySelectorAll('.hold button').forEach(b => b.classList.toggle('on', b.dataset.hold === cur));
  });
}

function adjustZone(zoneId, delta) {
  const z = state.zones.find(x => x.id === zoneId);
  if (!z) return;
  const prev = zonePending.get(zoneId);
  const base = prev ? prev.temp : (z.targetTemp ?? 20);
  const temp = Math.min(state.limits.max, Math.max(state.limits.min, Math.round((base + delta) / state.limits.step) * state.limits.step));
  clearTimeout(prev?.timer);
  const timer = setTimeout(() => {
    zonePending.delete(zoneId);
    send(`/api/zones/${zoneId}/target`, { temp, hold: holdFor(zoneId) })
      .then(() => toast(`${z.name} set to ${temp.toFixed(1)}°`));
  }, 900);
  zonePending.set(zoneId, { temp, timer });
  renderZones();
}

function faultNote(faults = []) {
  const notes = [];
  if (faults.some(f => /CommunicationLost/.test(f))) notes.push('no signal');
  if (faults.some(f => /LowBattery/.test(f))) notes.push('low battery');
  return notes.length ? ` · ${notes.join(', ')}` : '';
}

function fmtWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
