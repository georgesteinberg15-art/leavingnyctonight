// Leaving NYC — live traffic on the ways out of New York.
// Data: NYC DOT Real-Time Traffic Speeds (NYC Open Data, dataset i4gi-tjb9).
// The dataset keeps every reading (~every 5 min per road segment), so "today's history"
// comes straight from the source; no backend or API key needed.

const BRAND = 'Leaving NYC';
const HANDLE = '@leavingnyctonight';
const API = 'https://data.cityofnewyork.us/resource/i4gi-tjb9.json';
const TZ = 'America/New_York';
const SLOT_MIN = 10;                 // history resolution
const SLOTS = (24 * 60) / SLOT_MIN;
const EVENING = [15 * 60, 20 * 60];  // window the nightly bulletin talks about
const REFRESH_MS = 3 * 60 * 1000;

// The ways out. Each entry lists the DOT road segments (link_id) on the outbound side.
// mode 'sum' = segments in a row (add their delays), 'avg' = parallel tubes/levels.
const CROSSINGS = [
  { group: 'manhattan', name: 'Lincoln Tunnel', to: 'to New Jersey', mode: 'avg', links: ['4329508', '4329507'] },
  { group: 'manhattan', name: 'George Washington Br.', say: 'the G-W-B from the West Side', to: 'Henry Hudson → NJ', mode: 'sum', links: ['4620343'] },
  { group: 'manhattan', name: 'Brooklyn-Battery Tunnel', to: 'West St → Brooklyn', mode: 'sum', links: ['4456494', '4456502'] },
  { group: 'manhattan', name: 'Brooklyn Bridge', to: 'FDR → Brooklyn', mode: 'sum', links: ['4616341'] },
  { group: 'manhattan', name: 'Queens-Midtown Tunnel', to: 'to Queens', mode: 'sum', links: ['4456511'] },
  { group: 'manhattan', name: 'RFK Bridge', say: 'the R-F-K Bridge', to: 'FDR → Queens / Bronx', mode: 'sum', links: ['4456450'] },
  { group: 'city', name: 'GWB from the Bronx', say: 'the Cross Bronx to the G-W-B', to: 'Cross Bronx → NJ', mode: 'avg', links: ['4620331', '4620332'] },
  { group: 'city', name: 'Major Deegan north', say: 'the Major Deegan', to: 'to the Thruway', mode: 'sum', links: ['4575278'] },
  { group: 'city', name: 'Verrazzano', say: 'the Verrazzano', to: 'Brooklyn → Staten Island', mode: 'sum', links: ['4763657', '4763649'] },
  { group: 'city', name: 'Bayonne Bridge', to: 'Staten Island → NJ', mode: 'sum', links: ['4329499'] },
  { group: 'city', name: 'Long Island', noThe: true, say: 'the drive out to Long Island', to: 'Belt / Cross Island east', mode: 'avg', links: ['4616355', '4616352'] },
  { group: 'city', name: 'Throgs Neck', to: 'Queens → Bronx / New England', mode: 'sum', links: ['4456505'] },
];

// ?date=YYYY-MM-DD shows a finished past day (used by the nightly video job, handy for re-runs).
const DATE_PARAM = /^\d{4}-\d{2}-\d{2}$/.test(new URLSearchParams(location.search).get('date') || '')
  ? new URLSearchParams(location.search).get('date') : null;

// The Instagram buttons are only for the account owner: add ?studio to the address to see them.
// (Just hidden, not secret — anyone could add ?studio, but nothing they make gets posted.)
const STUDIO = new URLSearchParams(location.search).has('studio');

const NYC_BOUNDS = [[-74.26, 40.56], [-73.72, 40.92]];

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

function nyParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}
function shiftDate(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}
function fmtDelay(sec) {
  if (sec == null) return '—';
  if (sec >= 45 * 60) return '45+ min';
  const m = Math.round(sec / 60);
  return m <= 0 ? 'clear' : `+${m} min`;
}
async function soql(params) {
  const url = API + '?' + new URLSearchParams(params);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`NYC Open Data ${r.status}`);
  return r.json();
}
// Google encoded polyline.
function decodePolyline(s) {
  let i = 0, lat = 0, lng = 0;
  const out = [];
  while (i < s.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, res = 0, b;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i <= s.length);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}
// The feed's shapes are messy: the encoded polyline has inconsistent backslash escaping and
// link_points gets cut off on long roads. Try each and keep the longest one that looks sane.
function roadShape(r) {
  const sane = (pts) => pts.length >= 2 && pts.every((p, i) =>
    p[1] > 40.4 && p[1] < 41.1 && p[0] > -74.4 && p[0] < -73.5 &&
    (i === 0 || Math.abs(p[0] - pts[i - 1][0]) + Math.abs(p[1] - pts[i - 1][1]) < 0.06));
  const pts = (r.link_points || '').trim().split(/\s+/).map((pair) => pair.split(',').map(Number))
    .filter((p) => p.length === 2 && p.every((x) => x !== 0 && Number.isFinite(x))).map(([la, lo]) => [lo, la]);
  const candidates = [pts];
  if (r.encoded_poly_line) {
    for (const v of [r.encoded_poly_line, r.encoded_poly_line.replace(/\\\\/g, '\\')]) {
      try { candidates.push(decodePolyline(v)); } catch {}
    }
  }
  const ok = candidates.filter(sane).sort((a, b) => b.length - a.length);
  return ok[0] || null;
}

function colorFor(ratio) {
  if (ratio == null) return getVar('--na');
  if (ratio >= 0.75) return getVar('--g');
  if (ratio >= 0.5) return getVar('--y');
  if (ratio >= 0.25) return getVar('--r');
  return getVar('--rr');
}
const varCache = {};
function getVar(name) {
  return varCache[name] ??= getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- state ----------
const state = {
  today: null,
  nowSlot: 0,
  slot: 0,
  live: true,
  links: new Map(),     // link_id -> { name, borough, coords }
  baseline: new Map(),  // link_id -> { speed, tt } at 1–4am
  history: new Map(),   // link_id -> Array(SLOTS) of { speed, tt } | null
  rows: [], rowsDate: null, lastSeen: null,
};

// ---------- data loading ----------
async function loadGeometry() {
  const since = shiftDate(state.today, -1) + 'T00:00:00';
  const rows = await soql({
    $select: 'link_id,link_name,borough,encoded_poly_line,link_points',
    $where: `data_as_of > '${since}'`,
    $group: 'link_id,link_name,borough,encoded_poly_line,link_points',
    $limit: 5000,
  });
  for (const r of rows) {
    const coords = roadShape(r);
    if (coords && coords.length > (state.links.get(r.link_id)?.coords.length ?? 0)) {
      state.links.set(r.link_id, { name: r.link_name, borough: r.borough, coords });
    }
  }
}

async function loadBaseline() {
  const key = 'lnyc-baseline-' + state.today;
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (cached) { state.baseline = new Map(cached); return; }
  } catch {}
  // "Normal" = average of the last 7 nights between 1 and 4am. Date ranges keep the query fast.
  const nights = [1, 2, 3, 4, 5, 6, 7].map((n) => {
    const d = shiftDate(state.today, -n);
    return `(data_as_of between '${d}T01:00:00' and '${d}T04:00:00')`;
  });
  const rows = await soql({
    $select: 'link_id,avg(speed::number) as ff_speed,avg(travel_time::number) as ff_tt',
    $where: `speed::number > 0 AND (${nights.join(' OR ')})`,
    $group: 'link_id',
    $limit: 5000,
  });
  for (const r of rows) state.baseline.set(r.link_id, { speed: +r.ff_speed, tt: +r.ff_tt });
  try { localStorage.setItem(key, JSON.stringify([...state.baseline])); } catch {}
}

// Readings are kept as raw rows so each refresh only fetches what's new.
async function loadToday() {
  if (state.rowsDate !== state.today) { state.rows = []; state.lastSeen = `${state.today}T00:00:00`; state.rowsDate = state.today; }
  const rows = await soql({
    $select: 'link_id,speed,travel_time,data_as_of',
    $where: `data_as_of > '${state.lastSeen}' AND data_as_of < '${shiftDate(state.today, 1)}T00:00:00'`,
    $limit: 50000,
  });
  for (const r of rows) {
    if (r.data_as_of > state.lastSeen) state.lastSeen = r.data_as_of;
    if (+r.speed > 0) state.rows.push(r);
  }
  const hist = new Map(), stamp = new Map();
  for (const r of state.rows) {
    const t = r.data_as_of.slice(11, 16);
    const slot = Math.floor((+t.slice(0, 2) * 60 + +t.slice(3, 5)) / SLOT_MIN);
    if (!hist.has(r.link_id)) { hist.set(r.link_id, new Array(SLOTS).fill(null)); stamp.set(r.link_id, []); }
    if ((stamp.get(r.link_id)[slot] ?? '') > r.data_as_of) continue; // latest reading in the slot wins
    stamp.get(r.link_id)[slot] = r.data_as_of;
    hist.get(r.link_id)[slot] = { speed: +r.speed, tt: +r.travel_time };
  }
  // Roads with no overnight readings: use their best 10% of today as "normal".
  for (const [id, arr] of hist) {
    const vals = arr.filter(Boolean);
    if (vals.length < 6) continue;
    const speeds = vals.map((v) => v.speed).sort((a, b) => b - a);
    const tts = vals.map((v) => v.tt).sort((a, b) => a - b);
    const k = Math.floor(vals.length * 0.1);
    const b = state.baseline.get(id);
    // also guards against overnight construction making "normal" look slow
    if (!b || speeds[k] > b.speed * 1.25) state.baseline.set(id, { speed: speeds[k], tt: tts[k] });
  }
  // Fill short gaps (feed hiccups) by carrying the last reading forward up to 30 min.
  for (const arr of hist.values()) {
    let last = null, age = 0;
    for (let i = 0; i <= state.nowSlot; i++) {
      if (arr[i]) { last = arr[i]; age = 0; }
      else if (last && ++age <= 3) arr[i] = last;
    }
  }
  state.history = hist;
}

// ---------- derived numbers ----------
// Under 2 mph is almost always a lane/tube closure (common overnight), not traffic.
const CLOSED_MPH = 2;
function linkAt(id, slot) {
  const v = state.history.get(id)?.[slot];
  const b = state.baseline.get(id);
  if (!v || !b) return null;
  if (v.speed < CLOSED_MPH) return { ratio: 0, delay: 0, closed: true, speed: v.speed, normal: b.speed };
  return { ratio: Math.min(1, v.speed / b.speed), delay: Math.max(0, v.tt - b.tt), speed: v.speed, normal: b.speed };
}
function crossingAt(c, slot) {
  const parts = c.links.map((id) => linkAt(id, slot)).filter(Boolean);
  if (!parts.length) return null;
  if (parts.every((p) => p.closed)) return { ratio: 0, delay: 0, closed: true };
  const ratio = Math.min(...parts.filter((p) => !p.closed).map((p) => p.ratio));
  const delays = parts.filter((p) => !p.closed).map((p) => p.delay);
  const delay = c.mode === 'avg' ? delays.reduce((a, b) => a + b, 0) / delays.length : delays.reduce((a, b) => a + b, 0);
  // speed shown to people: the slowest stretch of the route right now vs. its usual speed
  const slowest = parts.filter((p) => !p.closed).reduce((a, b) => (b.ratio < a.ratio ? b : a));
  return { ratio, delay, speed: slowest.speed, normal: slowest.normal };
}
function peakOf(c, fromMin, toMin) {
  let best = null;
  for (let s = Math.floor(fromMin / SLOT_MIN); s <= Math.min(state.nowSlot, Math.floor(toMin / SLOT_MIN)); s++) {
    const v = crossingAt(c, s);
    if (v && !v.closed && (!best || v.delay > best.delay)) best = { ...v, slot: s };
  }
  return best;
}

// ---------- map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  bounds: NYC_BOUNDS,
  fitBoundsOptions: { padding: { top: 20, bottom: 20, left: innerWidth > 700 ? 380 : 20, right: 20 } },
  attributionControl: { compact: true },
  preserveDrawingBuffer: true, // lets us snapshot the map for the Instagram card
});

function roadsGeoJSON() {
  const crossingLinks = new Set(CROSSINGS.flatMap((c) => c.links));
  return {
    type: 'FeatureCollection',
    features: [...state.links].map(([id, l]) => {
      const v = linkAt(id, state.slot);
      return {
        type: 'Feature',
        properties: {
          id, name: l.name, color: colorFor(v?.ratio), crossing: crossingLinks.has(id), closed: !!v?.closed,
          ratio: v ? Math.round(v.ratio * 100) : null, delay: v ? Math.round(v.delay / 60) : null,
          mph: v ? Math.round(v.speed) : null, usual: v ? Math.round(v.normal) : null,
        },
        geometry: { type: 'LineString', coordinates: l.coords },
      };
    }),
  };
}

function addRoadLayers() {
  map.addSource('roads', { type: 'geojson', data: roadsGeoJSON() });
  map.addLayer({ id: 'roads-glow', type: 'line', source: 'roads',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'crossing'], 14, 9], 'line-opacity': 0.18, 'line-blur': 4 } });
  map.addLayer({ id: 'roads', type: 'line', source: 'roads',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['get', 'crossing'], 4, 2.5], 14, ['case', ['get', 'crossing'], 8, 5]] } });

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on('mousemove', 'roads', (e) => {
    const p = e.features[0].properties;
    map.getCanvas().style.cursor = 'pointer';
    const info = p.closed ? 'barely moving — likely closed'
      : p.ratio == null || p.ratio === 'null' ? 'no reading' : `${p.mph} mph · usually ${p.usual} · ${fmtDelay(p.delay * 60)}`;
    popup.setLngLat(e.lngLat).setHTML(`<b>${p.name}</b><br>${info}`).addTo(map);
  });
  map.on('mouseleave', 'roads', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
}

// ---------- UI ----------
function renderCrossings() {
  for (const group of ['manhattan', 'city']) {
    const ul = $(group);
    ul.innerHTML = '';
    for (const c of CROSSINGS.filter((x) => x.group === group)) {
      const v = crossingAt(c, state.slot);
      const peak = peakOf(c, EVENING[0], EVENING[1]);
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="dot" style="background:${colorFor(v?.ratio)}"></div>
        <div><div class="name">${c.name}</div><div class="to">${c.to}</div>${v && !v.closed ? `<div class="mph">${Math.round(v.speed)} mph ${state.live ? 'now' : 'at ' + fmtTime(state.slot * SLOT_MIN)} · usually ${Math.round(v.normal)}</div>` : ''}</div>
        <div class="delay">${!v ? '<small>no feed</small>' : v.closed ? 'closed?' : fmtDelay(v.delay)}<small>${peak && peak.delay > 60 ? 'peak ' + fmtDelay(peak.delay) + ' @ ' + fmtTime(peak.slot * SLOT_MIN) : ''}</small></div>
        <canvas width="600" height="36"></canvas>`;
      li.onclick = () => flyTo(c);
      ul.appendChild(li);
      drawSpark(li.querySelector('canvas'), c);
    }
  }
}

function drawSpark(canvas, c) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const w = W / SLOTS;
  for (let s = 0; s <= state.nowSlot; s++) {
    const v = crossingAt(c, s);
    if (!v) continue;
    const h = Math.max(3, Math.min(1, v.delay / 900) * H); // full height = 15 min delay
    ctx.fillStyle = colorFor(v.ratio);
    ctx.globalAlpha = s === state.slot ? 1 : 0.65;
    ctx.fillRect(s * w, H - h, Math.max(1, w - 0.5), h);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.fillRect(state.slot * w, 0, 2, H);
}

function flyTo(c) {
  const pts = c.links.flatMap((id) => state.links.get(id)?.coords ?? []);
  if (!pts.length) return;
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(b, { padding: { top: 80, bottom: 80, left: innerWidth > 700 ? 440 : 40, right: 80 }, maxZoom: 14 });
}

function renderTime() {
  $('slider').max = state.nowSlot;
  $('slider').value = state.slot;
  $('live').classList.toggle('on', state.live);
  $('timeLabel').textContent = state.live ? `Now · ${fmtTime(nyParts().minutes)}` : fmtTime(state.slot * SLOT_MIN);
}

function render() {
  renderTime();
  renderCrossings();
  map.getSource('roads')?.setData(roadsGeoJSON());
}

// ---------- bulletin ----------
function buildBulletin() {
  const [from, to] = state.nowSlot * SLOT_MIN >= EVENING[0] ? EVENING : [6 * 60, 24 * 60];
  const label = from === EVENING[0] ? 'tonight' : 'so far today';
  const rows = CROSSINGS.map((c) => ({ c, peak: peakOf(c, from, to), now: crossingAt(c, state.nowSlot) }))
    .filter((r) => r.peak);
  rows.sort((a, b) => b.peak.delay - a.peak.delay);
  const dayName = new Date(state.today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

  if (!rows.length) return { html: '<p>No readings yet today.</p>', lines: [], text: '' };
  const worst = rows[0], best = rows[rows.length - 1];
  const jammedNow = rows.filter((r) => r.now && !r.now.closed && r.now.delay >= 300);

  const lines = [];
  lines.push(worst.peak.delay >= 120
    ? `Worst way out ${label}: ${worst.c.noThe ? '' : 'the '}<b>${worst.c.name}</b>, ${fmtDelay(worst.peak.delay)} at ${fmtTime(worst.peak.slot * SLOT_MIN)}.`
    : `Easy going ${label}: nothing worse than ${fmtDelay(worst.peak.delay)} on any way out.`);
  if (rows.length > 1 && worst.peak.delay >= 120) {
    const runners = rows.slice(1, 3).filter((r) => r.peak.delay >= 120);
    if (runners.length) lines.push('Also rough: ' + runners.map((r) => `${r.c.name} (${fmtDelay(r.peak.delay)} at ${fmtTime(r.peak.slot * SLOT_MIN)})`).join(', ') + '.');
    lines.push(`Smoothest: ${best.c.noThe ? '' : 'the '}<b>${best.c.name}</b>, never worse than ${fmtDelay(best.peak.delay)}.`);
  }
  if (!DATE_PARAM) lines.push(jammedNow.length
    ? `Right now (${fmtTime(nyParts().minutes)}): still slow on ${jammedNow.map((r) => `${r.c.name} ${fmtDelay(r.now.delay)}`).join(', ')}.`
    : `Right now (${fmtTime(nyParts().minutes)}): every way out is moving.`);

  const plain = lines.map((l) => l.replace(/<\/?b>/g, ''));
  const caption = `${BRAND} — ${dayName}\n\n${plain.join('\n\n')}\n\nLive map: link in bio.\n#nyc #nyctraffic #lincolntunnel #gwb #commute`;
  return { html: lines.map((l) => `<p>${l}</p>`).join(''), lines: plain, caption, dayName, rows };
}

// Voiceover text for the nightly video (read by ElevenLabs).
function spokenScript() {
  const b = buildBulletin();
  const weekday = new Date(state.today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const say = (r) => r.c.say || `the ${r.c.name}`;
  const mins = (sec) => Math.round(sec / 60);
  const when = (slot) => {
    const m = slot * SLOT_MIN, h = ((Math.floor(m / 60) + 11) % 12) + 1, mm = m % 60;
    return mm === 0 ? `${h} o'clock` : `${h}:${String(mm).padStart(2, '0')}`;
  };
  const rows = b.rows || [];
  const out = [`Leaving New York, ${weekday} night.`];
  if (!rows.length || mins(rows[0].peak.delay) < 3) {
    out.push(`An easy one. Nothing worse than ${Math.max(1, mins(rows[0]?.peak.delay || 0))} extra minutes on any way out.`);
  } else {
    const [w, ...rest] = rows;
    out.push(`The worst way out was ${say(w)}: ${mins(w.peak.delay)} extra minutes at ${when(w.peak.slot)}.`);
    const rough = rest.filter((r) => mins(r.peak.delay) >= 3).slice(0, 2);
    if (rough.length === 2) {
      out.push(`${cap(say(rough[0]))} peaked at ${mins(rough[0].peak.delay)} minutes around ${when(rough[0].peak.slot)}, and ${say(rough[1])} hit ${mins(rough[1].peak.delay)}.`);
    } else if (rough.length === 1) {
      out.push(`${cap(say(rough[0]))} peaked at ${mins(rough[0].peak.delay)} minutes around ${when(rough[0].peak.slot)}.`);
    }
    const best = rows[rows.length - 1];
    if (best !== w) out.push(`Smoothest ride? ${cap(say(best))}.`);
  }
  out.push('Drive safe.');
  return out.join(' ');
}
const cap = (t) => t[0].toUpperCase() + t.slice(1);

// ---------- Instagram card + video (1080 x 1350) ----------
const POST_W = 1080, POST_H = 1350, MAP_H = 760;
const VIDEO_FPS = 30;
const VIDEO_SLOT_MS = 450;  // screen time per 10 minutes of traffic
const VIDEO_END_HOLD_MS = 2500;

// Colour the map for one time slot and grab a copy of it once it has drawn.
async function snapMap(slot) {
  state.slot = slot;
  const drawn = new Promise((res) => { map.once('idle', res); setTimeout(res, 4000); });
  map.getSource('roads').setData(roadsGeoJSON());
  map.triggerRepaint();
  await drawn;
  return createImageBitmap(map.getCanvas());
}

// Frame the whole city for the snapshot; returns a function that puts the camera back.
function frameCity() {
  const cam = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  map.fitBounds(NYC_BOUNDS, { padding: 20, animate: false });
  return () => map.jumpTo(cam);
}

function drawMapLayer(ctx, img, alpha = 1) {
  const scale = Math.max(POST_W / img.width, MAP_H / img.height);
  const sw = POST_W / scale, sh = MAP_H / scale;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, POST_W, MAP_H);
  ctx.globalAlpha = 1;
}

// One full card. `rows` = [{ name, color, delay (sec), note, bar (0–1, optional) }]
function drawCard(ctx, { maps, subtitle, heading, rows, clock, progress }) {
  const W = POST_W, H = POST_H;
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, W, H);
  for (const [img, alpha] of maps) drawMapLayer(ctx, img, alpha);

  const bottom = ctx.createLinearGradient(0, MAP_H - 200, 0, MAP_H);
  bottom.addColorStop(0, 'rgba(11,13,16,0)');
  bottom.addColorStop(1, 'rgba(11,13,16,1)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, MAP_H - 200, W, 200);
  const top = ctx.createLinearGradient(0, 0, 0, 260);
  top.addColorStop(0, 'rgba(11,13,16,0.92)');
  top.addColorStop(1, 'rgba(11,13,16,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, 260);

  // title block over the map
  ctx.fillStyle = '#f2f2ee';
  ctx.font = '800 76px Inter, sans-serif';
  ctx.fillText('LEAVING', 56, 120);
  ctx.fillStyle = getVar('--accent');
  ctx.fillText('NYC', 56 + ctx.measureText('LEAVING ').width, 120);
  ctx.fillStyle = '#c9ccd1';
  ctx.font = '600 32px Inter, sans-serif';
  ctx.fillText(subtitle, 58, 168);

  if (clock) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f2f2ee';
    ctx.font = '800 64px Inter, sans-serif';
    ctx.fillText(clock, W - 56, 120);
    ctx.textAlign = 'left';
  }
  if (progress != null) {
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    roundRect(ctx, 56, MAP_H - 30, W - 112, 6, 3);
    ctx.fillStyle = getVar('--accent');
    roundRect(ctx, 56, MAP_H - 30, Math.max(6, (W - 112) * progress), 6, 3);
  }

  let y = MAP_H + 30;
  ctx.font = '600 22px Inter, sans-serif';
  ctx.fillStyle = '#8b9098';
  ctx.fillText(heading, 56, y);
  y += 22;
  for (const r of rows) {
    y += 58;
    ctx.fillStyle = r.color;
    roundRect(ctx, 56, y - 36, 10, 44, 5);
    if (r.bar != null) {
      ctx.globalAlpha = 0.18;
      roundRect(ctx, 76, y - 38, Math.max(0, (W - 132) * Math.min(1, r.bar)), 48, 6);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#f2f2ee';
    ctx.font = '700 38px Inter, sans-serif';
    ctx.fillText(r.name, 86, y);
    ctx.textAlign = 'right';
    ctx.font = '800 38px Inter, sans-serif';
    ctx.fillText(r.text ?? fmtDelay(r.delay), W - 56, y);
    if (r.note) {
      ctx.fillStyle = '#8b9098';
      ctx.font = '500 26px Inter, sans-serif';
      ctx.fillText(r.note, W - 260, y);
    }
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = '#8b9098';
  ctx.font = '500 24px Inter, sans-serif';
  ctx.fillText(`${HANDLE} · NYC DOT traffic data`, 56, H - 44);
}

function showPost({ imgSrc, videoSrc, filename, caption }) {
  $('postImg').hidden = !imgSrc;
  $('postVideo').hidden = !videoSrc;
  if (imgSrc) $('postImg').src = imgSrc;
  if (videoSrc) { $('postVideo').src = videoSrc; $('postVideo').play().catch(() => {}); }
  $('postDownload').href = imgSrc || videoSrc;
  $('postDownload').download = filename;
  $('postDownload').textContent = videoSrc ? 'Download video' : 'Download image';
  $('copyCaption').onclick = async () => {
    await navigator.clipboard.writeText(caption);
    $('copyCaption').textContent = 'Copied ✓';
  };
  $('copyCaption').textContent = 'Copy caption';
  $('postModal').hidden = false;
}

async function makePost() {
  await document.fonts.ready;
  const b = buildBulletin();
  const wasSlot = state.slot;
  // the still shows the evening peak of the worst crossing
  const slot = b.rows?.[0] ? b.rows[0].peak.slot : state.nowSlot;
  const restore = frameCity();
  const img = await snapMap(slot);
  restore();
  state.slot = wasSlot;
  render();

  const cv = Object.assign(document.createElement('canvas'), { width: POST_W, height: POST_H });
  drawCard(cv.getContext('2d'), {
    maps: [[img, 1]],
    subtitle: `${b.dayName} · map at ${fmtTime(slot * SLOT_MIN)}`,
    heading: 'PEAK DELAY GETTING OUT',
    rows: (b.rows || []).slice(0, 6).map((r) => ({
      name: r.c.name, color: colorFor(r.peak.ratio), delay: r.peak.delay, note: fmtTime(r.peak.slot * SLOT_MIN),
    })),
  });
  showPost({ imgSrc: cv.toDataURL('image/png'), filename: `leaving-nyc-${state.today}.png`, caption: b.caption });
}

// Sets up the evening-rush animation (3–8pm, or as much of it as has happened).
// Returns { canvas, totalMs, drawAt(ms), close() }: drawAt paints the frame for that moment.
// The site records it live (makeVideo); the nightly job steps through it frame by frame.
async function prepareVideo(onProgress = () => {}) {
  await document.fonts.ready;
  let from = Math.floor(EVENING[0] / SLOT_MIN);
  const to = Math.min(state.nowSlot, Math.floor(EVENING[1] / SLOT_MIN));
  if (to - from < 6) from = Math.max(0, to - 30); // before rush hour: show the last 5 hours instead
  const slots = [];
  for (let s = from; s <= to; s++) slots.push(s);

  // Ways out that had any data in the window, ranked by their worst moment.
  const ranked = CROSSINGS.map((c) => ({ c, peak: peakOf(c, from * SLOT_MIN, to * SLOT_MIN) }))
    .filter((r) => r.peak).sort((a, b) => b.peak.delay - a.peak.delay).slice(0, 6);
  const scaleMax = Math.max(600, ...ranked.map((r) => r.peak.delay));

  // 1. Draw the map once per 10-minute slot.
  const wasSlot = state.slot;
  const restore = frameCity();
  const frames = [];
  for (const [i, s] of slots.entries()) {
    onProgress(`Drawing map ${i + 1}/${slots.length}…`);
    frames.push(await snapMap(s));
  }
  restore();
  state.slot = wasSlot;
  render();

  const cv = Object.assign(document.createElement('canvas'), { width: POST_W, height: POST_H });
  const ctx = cv.getContext('2d');
  const dayName = buildBulletin().dayName;
  const valueAt = (c, s) => crossingAt(c, s);
  const drawSlots = (t) => {
    // t = position in slots (fractional), 0 … slots.length - 1
    const i = Math.min(slots.length - 1, Math.floor(t));
    const f = i < slots.length - 1 ? t - i : 0;
    const fade = Math.max(0, (f - 0.5) / 0.5); // hold each map, then cross-fade into the next
    const maps = [[frames[i], 1]];
    if (fade > 0) maps.push([frames[i + 1], fade]);
    const minutes = Math.round((slots[0] + t) * SLOT_MIN);
    drawCard(ctx, {
      maps,
      subtitle: dayName,
      clock: fmtTime(Math.floor(minutes / SLOT_MIN) * SLOT_MIN),
      progress: slots.length > 1 ? t / (slots.length - 1) : 1,
      heading: 'DELAY GETTING OUT',
      rows: ranked.map(({ c }) => {
        const a = valueAt(c, slots[i]);
        const b = f ? valueAt(c, slots[i + 1]) : a;
        const closed = (a ?? b)?.closed;
        const d0 = a && !a.closed ? a.delay : null, d1 = b && !b.closed ? b.delay : null;
        const delay = d0 != null && d1 != null ? d0 + (d1 - d0) * f : d0 ?? d1;
        const now = fade > 0.5 ? b : a;
        return {
          name: c.name, color: colorFor(now?.ratio), delay, bar: delay != null ? delay / scaleMax : 0,
          text: closed ? 'closed?' : delay == null ? '—' : undefined,
        };
      }),
    });
  };
  const totalMs = (slots.length - 1) * VIDEO_SLOT_MS + VIDEO_END_HOLD_MS;
  return {
    canvas: cv,
    totalMs,
    drawAt: (ms) => drawSlots(Math.min(slots.length - 1, ms / VIDEO_SLOT_MS)),
    close: () => frames.forEach((f) => f.close()),
  };
}

// Records the animation live in the browser (the "Make Instagram video" button).
async function makeVideo(onProgress = () => {}) {
  const vid = await prepareVideo(onProgress);
  const mime = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('this browser cannot record video');
  const rec = new MediaRecorder(vid.canvas.captureStream(VIDEO_FPS), { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => { rec.onstop = res; });

  vid.drawAt(0);
  rec.start();
  const t0 = performance.now();
  await new Promise((res) => {
    const tick = () => {
      const el = performance.now() - t0;
      vid.drawAt(el);
      onProgress(`Recording ${Math.min(100, Math.round((el / vid.totalMs) * 100))}%…`);
      if (el >= vid.totalMs) return res();
      setTimeout(tick, 1000 / VIDEO_FPS); // not rAF: keeps going if the tab is in the background
    };
    tick();
  });
  rec.stop();
  await stopped;
  vid.close();

  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  showPost({
    videoSrc: URL.createObjectURL(blob),
    filename: `leaving-nyc-${state.today}.${ext}`,
    caption: buildBulletin().caption,
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

// ---------- wiring ----------
$('slider').oninput = (e) => { state.slot = +e.target.value; state.live = state.slot === state.nowSlot; render(); };
$('live').onclick = () => { state.live = true; state.slot = state.nowSlot; render(); };
let playing = null;
$('play').onclick = () => {
  if (playing) { clearInterval(playing); playing = null; $('play').textContent = '▶'; return; }
  state.live = false;
  state.slot = Math.floor(6 * 60 / SLOT_MIN);
  $('play').textContent = '❚❚';
  playing = setInterval(() => {
    state.slot++;
    if (state.slot >= state.nowSlot) { clearInterval(playing); playing = null; $('play').textContent = '▶'; state.live = true; state.slot = state.nowSlot; }
    render();
  }, 120);
};
if (STUDIO) $('makePost').onclick = () => makePost().catch((e) => alert('Could not make the image: ' + e.message));
if (STUDIO) $('makeVideo').onclick = async () => {
  const btn = $('makeVideo');
  btn.disabled = true;
  try { await makeVideo((msg) => { btn.textContent = msg; }); }
  catch (e) { alert('Could not make the video: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Make Instagram video'; }
};
$('closeModal').onclick = () => { $('postModal').hidden = true; $('postVideo').pause(); };

async function refresh() {
  const p = DATE_PARAM ? { date: DATE_PARAM, minutes: 24 * 60 - 1 } : nyParts();
  state.today = p.date;
  state.nowSlot = Math.floor(p.minutes / SLOT_MIN);
  await loadToday();
  // the newest slot may not have readings yet; step back to the last one that does
  while (state.nowSlot > 0 && ![...state.history.values()].some((a) => a[state.nowSlot])) state.nowSlot--;
  if (state.live) state.slot = state.nowSlot;
  const b = buildBulletin();
  $('bulletin').innerHTML = b.html;
  $('dateline').textContent = `${b.dayName || ''} · ${state.links.size} road segments`;
  render();
}

(async function init() {
  if (!STUDIO) { $('makeVideo').remove(); $('makePost').remove(); }
  try {
    state.today = DATE_PARAM || nyParts().date;
    const mapReady = new Promise((res) => map.on('load', res));
    await Promise.all([loadGeometry(), loadBaseline()]);
    await refresh();
    await mapReady;
    addRoadLayers();
    if (!DATE_PARAM) setInterval(() => refresh().catch(console.error), REFRESH_MS);
    window.leavingReady = true; // signal for the nightly video job
  } catch (e) {
    console.error(e);
    $('dateline').textContent = 'Could not load NYC traffic data: ' + e.message;
  }
})();
