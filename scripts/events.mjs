// What else was going on in the city that evening, for a quick nod in the bulletin:
// home games at the big NYC-area venues (ESPN's public scoreboard), big parades and races
// (NYC permitted events on Open Data) and rain or snow (Open-Meteo). All free, no keys.
// Every lookup is best-effort: if a source is down the bulletin just goes without it.
//
//   import { eventsFor } from './events.mjs';  await eventsFor('2026-10-26')
//
// Returns { events: [{ kind, caption, spoken, start (minutes after midnight NY), near: [crossing names] }],
//           weather: null | 'rain' | 'snow' }

const MANHATTAN = ['Lincoln Tunnel', 'George Washington Br.', 'Brooklyn-Battery Tunnel', 'Brooklyn Bridge', 'Queens-Midtown Tunnel', 'RFK Bridge'];

// Venue → how to say it, and which ways out its crowds share.
const VENUES = {
  'Madison Square Garden': { at: 'the Garden', short: 'MSG', near: ['Lincoln Tunnel', 'Queens-Midtown Tunnel'] },
  'Barclays Center': { at: 'Barclays', near: ['Brooklyn Bridge', 'Brooklyn-Battery Tunnel', 'Verrazzano'] },
  'UBS Arena': { at: 'UBS Arena', near: ['Long Island', 'Throgs Neck'] },
  'MetLife Stadium': { at: 'MetLife', near: ['Lincoln Tunnel', 'George Washington Br.', 'GWB from the Bronx'] },
  'Prudential Center': { at: 'the Prudential Center', near: ['Lincoln Tunnel'] },
  'Yankee Stadium': { at: 'Yankee Stadium', near: ['Major Deegan north', 'GWB from the Bronx', 'RFK Bridge'] },
  'Citi Field': { at: 'Citi Field', near: ['Long Island', 'Throgs Neck', 'RFK Bridge'] },
};
const SAY = { NYCFC: 'N-Y-C-F-C', 'NY Red Bulls': 'the Red Bulls' };
const LEAGUES = ['basketball/nba', 'hockey/nhl', 'football/nfl', 'baseball/mlb', 'basketball/wnba', 'soccer/usa.1'];
// Games starting in this window put crowds on the roads during the 3–8pm replay.
const GAME_FROM = 13 * 60, GAME_TO = 21 * 60 + 30;

const nyMinutes = (iso) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(iso));
  return +p.find((x) => x.type === 'hour').value * 60 + +p.find((x) => x.type === 'minute').value;
};
const nyDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
const clock = (m) => {
  const h = ((Math.floor(m / 60) + 11) % 12) + 1, mm = m % 60;
  return { written: `${h}${mm ? ':' + String(mm).padStart(2, '0') : ''}${m >= 720 ? 'pm' : 'am'}`, spoken: mm ? `${h}:${String(mm).padStart(2, '0')}` : `${h} o'clock` };
};

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

async function games(date) {
  const out = [];
  for (const league of LEAGUES) {
    const d = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${league}/scoreboard?dates=${date.replaceAll('-', '')}`);
    for (const e of d?.events ?? []) {
      const c = e.competitions?.[0];
      const venue = VENUES[c?.venue?.fullName];
      if (!venue || nyDate(e.date) !== date) continue;
      const start = nyMinutes(e.date);
      if (start < GAME_FROM || start > GAME_TO) continue;
      const home = c.competitors.find((t) => t.homeAway === 'home')?.team;
      const away = c.competitors.find((t) => t.homeAway === 'away')?.team;
      if (!home || !away) continue;
      const t = clock(start), soccer = league.startsWith('soccer');
      out.push({
        kind: 'game', start, near: venue.near,
        caption: `${home.shortDisplayName} vs ${away.shortDisplayName} at ${venue.short || venue.at.replace(/^the /, '')}, ${t.written}`,
        spoken: soccer
          ? `${SAY[home.shortDisplayName] || home.shortDisplayName} hosting ${away.shortDisplayName} at ${venue.at}`
          : `the ${home.shortDisplayName} hosting ${away.location} at ${venue.at}`,
      });
    }
  }
  return out;
}

// Big parades and races only: the permits list is mostly block parties and kids' parades.
async function parades(date) {
  const where = `start_date_time <= '${date}T20:00:00' AND end_date_time >= '${date}T15:00:00'`
    + ` AND event_type in('Parade','Athletic Race / Tour') AND street_closure_type='Full Street Closure'`;
  const rows = await getJSON(`https://data.cityofnewyork.us/resource/tvpp-9vvx.json?$limit=200&$where=${encodeURIComponent(where)}`);
  const out = [];
  for (const r of rows ?? []) {
    const start = nyMinutes(r.start_date_time + '-04:00'), hours = (new Date(r.end_date_time) - new Date(r.start_date_time)) / 36e5;
    const race = r.event_type.startsWith('Athletic');
    const big = race ? hours >= 6 : r.event_borough === 'Manhattan' && hours >= 3;
    if (!big || r.start_date_time.slice(0, 10) !== date && !race) continue;
    const name = r.event_name
      .replace(/\b(19|20)\d\d\b/g, '').replace(/\b\d+(st|nd|rd|th)\b/gi, '').replace(/\bannual\b/gi, '')
      .replace(/^\s*the\s+/i, '').replace(/\bNew Yorks\b/g, '').replace(/\bTCS\b/g, '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    out.push({
      kind: race ? 'race' : 'parade', start: Math.max(start, 15 * 60),
      near: race ? [...MANHATTAN, 'Verrazzano', 'Long Island', 'GWB from the Bronx', 'Major Deegan north'] : MANHATTAN,
      caption: `the ${name}`, spoken: `the ${name}`,
    });
  }
  return out;
}

async function weather(date) {
  const d = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=40.75&longitude=-73.99&hourly=precipitation,snowfall&timezone=America/New_York&start_date=${date}&end_date=${date}`);
  if (!d?.hourly) return null;
  let rain = 0, snow = 0;
  d.hourly.time.forEach((t, i) => {
    const h = +t.slice(11, 13);
    if (h >= 15 && h < 20) { rain += d.hourly.precipitation[i] || 0; snow += d.hourly.snowfall[i] || 0; }
  });
  return snow >= 0.5 ? 'snow' : rain >= 2 ? 'rain' : null;
}

export async function eventsFor(date) {
  const [g, p, w] = await Promise.all([games(date), parades(date), weather(date)]);
  const events = [...p, ...g].sort((a, b) => a.start - b.start);
  return { events, weather: w };
}

// node scripts/events.mjs 2026-10-26
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await eventsFor(process.argv[2]), null, 2));
}
