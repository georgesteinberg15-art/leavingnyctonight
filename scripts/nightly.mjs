// Makes the nightly Instagram video: records the site's 3–8pm replay in a headless browser,
// gets the voiceover from ElevenLabs, and merges them with ffmpeg.
//
//   node scripts/nightly.mjs --date 2026-10-20 --out _site/tonight [--no-mux]
//
// Env: ELEVENLABS_API_KEY (optional — without it the video is made silent).
// Writes into --out: <name>.mp4, caption.txt, script.txt, meta.json.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';

const VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // Daniel
const VOICE_LEAD = 0.4, VOICE_TAIL = 0.8; // seconds of quiet before / after the voice

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const nyToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const date = arg('date', nyToday);
const outDir = resolve(arg('out', 'tonight'));
const siteDir = resolve(new URL('..', import.meta.url).pathname);
const log = (...a) => console.log(`[nightly ${date}]`, ...a);

// --- serve the site locally so the page runs this checkout's code ---
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(siteDir, p);
    if (!file.startsWith(siteDir)) throw new Error('bad path');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// --- record the replay in the page ---
log('opening site');
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
let result;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && log('page error:', m.text()));
  await page.goto(`http://127.0.0.1:${port}/?date=${date}`);
  await page.waitForFunction(() => window.leavingReady === true, null, { timeout: 120_000 });
  log('recording');
  result = await page.evaluate(async () => {
    await makeVideo();
    const blob = await fetch(document.getElementById('postVideo').src).then((r) => r.blob());
    const b64 = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result.split(',')[1]);
      fr.readAsDataURL(blob);
    });
    const b = buildBulletin();
    return { b64, type: blob.type, script: spokenScript(), caption: b.caption, dayName: b.dayName };
  }, null);
} finally {
  await browser.close();
  server.close();
}

await mkdir(outDir, { recursive: true });
const rawPath = join(outDir, result.type.includes('mp4') ? 'raw.mp4' : 'raw.webm');
await writeFile(rawPath, Buffer.from(result.b64, 'base64'));
await writeFile(join(outDir, 'script.txt'), result.script + '\n');
await writeFile(join(outDir, 'caption.txt'), result.caption + '\n');
log('script:', result.script);

// --- voiceover ---
let voicePath = null;
if (process.env.ELEVENLABS_API_KEY) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: result.script,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
    }),
  });
  if (r.ok) {
    voicePath = join(outDir, 'voice.mp3');
    await writeFile(voicePath, Buffer.from(await r.arrayBuffer()));
    log('voice ok');
  } else {
    log('voice failed, making a silent video:', r.status, (await r.text()).slice(0, 200));
  }
} else {
  log('no ELEVENLABS_API_KEY, making a silent video');
}

// --- merge ---
const name = `leavingnyctonight-${date}.mp4`;
if (!process.argv.includes('--no-mux')) {
  const dur = (f) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
  // MediaRecorder files often have no duration in the header; count frames instead.
  const frames = parseInt(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', rawPath]).toString(), 10);
  const vdur = frames / 30;
  const total = voicePath ? Math.max(vdur, VOICE_LEAD + dur(voicePath) + VOICE_TAIL) : vdur;
  const stretch = (total / vdur).toFixed(4); // slow the replay to the narrator's pace
  const args = ['-y', '-i', rawPath];
  if (voicePath) args.push('-i', voicePath);
  args.push('-filter_complex',
    `[0:v]setpts=${stretch}*PTS,fps=30,format=yuv420p[v]` +
    (voicePath ? `;[1:a]adelay=${VOICE_LEAD * 1000}:all=1,apad[a]` : ''),
    '-map', '[v]');
  if (voicePath) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high',
    '-t', total.toFixed(2), '-movflags', '+faststart', join(outDir, name));
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  log(`video ${name}: ${total.toFixed(1)}s`);
}

await writeFile(join(outDir, 'meta.json'), JSON.stringify({
  date, dayName: result.dayName, video: name, voiced: !!voicePath, made: new Date().toISOString(),
}, null, 2));
log('done');
