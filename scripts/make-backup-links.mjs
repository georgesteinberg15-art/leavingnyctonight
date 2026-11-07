// One-off: builds backup-links.json (segKm, the length of the stretch TomTom reads at each probe,
// was added afterwards by hand from `poll.mjs --check`-style lookups; re-add it if you regenerate)
// One-off: builds backup-links.json from NYC DOT history, so the TomTom backup (scripts/poll.mjs)
// still has each road's shape, "normal" speed and a probe point when the DOT feed is down.
//   node scripts/make-backup-links.mjs 2026-10-28      (a normal day with good data)
import { writeFile } from 'node:fs/promises';
const API = 'https://data.cityofnewyork.us/resource/i4gi-tjb9.json';
const day = process.argv[2];
const app = await (await import('node:fs/promises')).readFile(new URL('../app.js', import.meta.url), 'utf8');
const ids = [...app.matchAll(/links: \[([^\]]+)\]/g)].flatMap((m) => m[1].match(/\d+/g));
const soql = async (p) => (await fetch(API + '?' + new URLSearchParams(p))).json();
const list = ids.map((i) => `'${i}'`).join(',');

const shapes = await soql({ $select: 'link_id,link_name,link_points', $where: `link_id in(${list}) AND data_as_of between '${day}T12:00:00' and '${day}T13:00:00'`, $limit: 5000 });
const shift = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const nights = [0, 1, 2, 3, 4, 5, 6].map((n) => `(data_as_of between '${shift(day, -n)}T01:00:00' and '${shift(day, -n)}T04:00:00')`);
const night = await soql({ $select: 'link_id,avg(speed::number) as s,avg(travel_time::number) as tt', $where: `link_id in(${list}) AND speed::number > 0 AND (${nights.join(' OR ')})`, $group: 'link_id' });
// Same rule as the site: overnight average, unless the road's best 10% over three days is faster
// (no overnight readings, or overnight works making "normal" look slow).
const all = await soql({ $select: 'link_id,speed,travel_time', $where: `link_id in(${list}) AND speed::number > 0 AND data_as_of between '${shift(day, -2)}T00:00:00' and '${day}T23:59:59'`, $limit: 50000 });
const base = ids.map((id) => {
  const v = all.filter((r) => r.link_id === id);
  const n = night.find((r) => r.link_id === id);
  if (v.length < 20) return n && { link_id: id, s: n.s, tt: n.tt };
  const k = Math.floor(v.length * 0.1);
  const s = v.map((r) => +r.speed).sort((a, b) => b - a)[k], tt = v.map((r) => +r.travel_time).sort((a, b) => a - b)[k];
  return !n || s > +n.s * 1.25 ? { link_id: id, s, tt } : { link_id: id, s: n.s, tt: n.tt };
}).filter(Boolean);

const km = (a, b) => { const R = 6371, r = Math.PI / 180, dl = (b[1] - a[1]) * r, dn = (b[0] - a[0]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
// Halfway points that TomTom snaps to the wrong carriageway or road, fixed by hand with
// `node scripts/poll.mjs --check` (null = TomTom has no outbound reading there).
const PROBE_FIX = {
  4329507: { lat: 40.763, lon: -74.0055 },    // Lincoln north tube: halfway point reads the eastbound tube
  4456502: { lat: 40.694, lon: -74.013 },     // BBT: halfway point reads the Manhattan-bound tube
  4456450: { lat: 40.773, lon: -73.9442 },    // FDR north: halfway point is up in Inwood
  4616341: { lat: 40.7099, lon: -73.9952 },   // FDR south at the Brooklyn Bridge
  4616355: null,                              // Belt/Laurelton east: only the westbound side is found
};
const out = {};
for (const id of ids) {
  const rows = shapes.filter((r) => r.link_id === id);
  const pts = rows.map((r) => (r.link_points || '').trim().split(/\s+/).map((p) => p.split(',').map(Number))
    .filter((p) => p.length === 2 && p.every((x) => x && Number.isFinite(x)) && p[0] > 40.4 && p[0] < 41.1).map(([la, lo]) => [lo, la]))
    .sort((a, b) => b.length - a.length)[0] || [];
  const b = base.find((r) => r.link_id === id);
  // probe: halfway along the road
  const seg = pts.slice(1).map((p, i) => km(pts[i], p)), total = seg.reduce((a, c) => a + c, 0);
  let acc = 0, probe = pts[0];
  for (let i = 0; i < seg.length; i++) { if (acc + seg[i] >= total / 2) { const f = (total / 2 - acc) / seg[i]; probe = [pts[i][0] + f * (pts[i + 1][0] - pts[i][0]), pts[i][1] + f * (pts[i + 1][1] - pts[i][1])]; break; } acc += seg[i]; }
  out[id] = { name: rows[0]?.link_name, km: +total.toFixed(2), coords: pts, base: b && { speed: +(+b.s).toFixed(1), tt: Math.round(+b.tt) },
    probe: id in PROBE_FIX ? PROBE_FIX[id] : probe && { lat: +probe[1].toFixed(5), lon: +probe[0].toFixed(5) } };
  console.log(id, out[id].name, out[id].km, 'km', pts.length, 'pts', out[id].base, out[id].probe);
}
await writeFile(new URL('../backup-links.json', import.meta.url), JSON.stringify({ _note: 'Made by scripts/make-backup-links.mjs from NYC DOT data; probe = point TomTom is asked about.', links: out }, null, 1));
