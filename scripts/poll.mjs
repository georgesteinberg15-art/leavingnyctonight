// Backup traffic readings from TomTom, for the roads the NYC DOT feed isn't covering right now:
// some DOT sensors report 0 mph for weeks, and sometimes the whole feed stops. Each run asks DOT
// which of our roads reported in the last hour, reads TomTom only for the rest, and adds the
// readings to today's file (days/YYYY-MM-DD.json on the repo's `data` branch). The site and the
// nightly video fill any gap in the DOT data from these files.
//
//   TOMTOM_KEY=... node scripts/poll.mjs --data <data-branch checkout>
//   TOMTOM_KEY=... node scripts/poll.mjs --check     (read every probe, print what it hits; writes nothing)

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const TZ = 'America/New_York';
const KEEP_DAYS = 14;
const DOT = 'https://data.cityofnewyork.us/resource/i4gi-tjb9.json';
const KEY = process.env.TOMTOM_KEY;
if (!KEY) throw new Error('TOMTOM_KEY is not set');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const CHECK = process.argv.includes('--check');
const dataDir = resolve(arg('data', 'data'));
const siteDir = resolve(new URL('..', import.meta.url).pathname);
const { links } = JSON.parse(await readFile(join(siteDir, 'backup-links.json'), 'utf8'));

const nyNow = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(d).map((x) => [x.type, x.value]));
const p = nyNow();
const date = `${p.year}-${p.month}-${p.day}`;
const time = `${p.hour}:${p.minute}`;

// Which of our roads has DOT heard from (with a real speed) in the last hour? DOT's
// timestamps are New York local time without a zone.
async function dotCovered() {
  const h = nyNow(new Date(Date.now() - 3600e3));
  const since = `${h.year}-${h.month}-${h.day}T${h.hour}:${h.minute}:00`;
  const ids = Object.keys(links).map((id) => `'${id}'`).join(',');
  const where = `link_id in(${ids}) AND speed::number > 0 AND data_as_of > '${since}'`;
  try {
    const r = await fetch(`${DOT}?${new URLSearchParams({ $select: 'link_id', $where: where, $group: 'link_id' })}`,
      { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`DOT ${r.status}`);
    return new Set((await r.json()).map((x) => x.link_id));
  } catch (e) {
    console.log(`couldn't ask DOT (${e.message}); reading every road from TomTom`);
    return new Set();
  }
}

async function flow(lat, lon) {
  const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${lat},${lon}&unit=MPH&key=${KEY}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`TomTom ${r.status} ${(await r.text()).slice(0, 120)}`);
      return (await r.json()).flowSegmentData;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}

const covered = CHECK ? new Set() : await dotCovered();
const todo = Object.entries(links).filter(([id, l]) => l.probe && !covered.has(id));
console.log(`${date} ${time}: DOT has ${covered.size} of our roads; reading ${todo.length} from TomTom`);

const v = {};
for (const [id, l] of todo) {
  try {
    const f = await flow(l.probe.lat, l.probe.lon);
    v[id] = [f.currentSpeed, f.freeFlowSpeed, f.roadClosure ? 1 : 0, +f.confidence.toFixed(2)];
    if (CHECK) {
      const c = f.coordinates.coordinate, a = c[0], b = c[c.length - 1];
      const bearing = (Math.atan2((b.longitude - a.longitude) * Math.cos(a.latitude * Math.PI / 180), b.latitude - a.latitude) * 180 / Math.PI + 360) % 360;
      console.log(`${id} ${l.name.padEnd(56)} ${f.frc} heading ${bearing.toFixed(0).padStart(3)}°  now ${f.currentSpeed} mph, free ${f.freeFlowSpeed}${f.roadClosure ? ' CLOSED' : ''}`);
    }
  } catch (e) {
    console.error(`${id}: ${e.message}`);
  }
}
if (CHECK || !todo.length) process.exit(0);
if (!Object.keys(v).length) process.exit(1);

// --- add to today's file ---
const dayDir = join(dataDir, 'days');
await mkdir(dayDir, { recursive: true });
const file = join(dayDir, `${date}.json`);
let day;
try { day = JSON.parse(await readFile(file, 'utf8')); } catch { day = { date, unit: 'mph', readings: [] }; }
day.readings = day.readings.filter((r) => r.t !== time);
day.readings.push({ t: time, v }); // v: link_id -> [speed now, free-flow speed, closed, confidence]
day.readings.sort((a, b) => a.t.localeCompare(b.t));
await writeFile(file, JSON.stringify(day));

// --- drop old days ---
const cutoff = new Date(Date.parse(date + 'T12:00:00Z') - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
for (const f of await readdir(dayDir)) {
  if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < cutoff) await unlink(join(dayDir, f));
}
