// HOMEFLIX — stream the movies on this laptop to an iPad (or any browser) on the same Wi-Fi.
// No dependencies: Node's standard library plus ffmpeg/ffprobe for files Safari can't play directly.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const genres = require('./genres');

const ROOT = __dirname;
let CONFIG = { port: 8080, folders: [], minSizeMB: 5, cacheDir: 'cache', dataDir: '.', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
let CACHE_DIR = path.resolve(ROOT, CONFIG.cacheDir);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.avi', '.webm', '.wmv', '.flv', '.ts', '.m2ts', '.mpg', '.mpeg', '.3gp']);
const DIRECT_CONTAINERS = new Set(['.mp4', '.m4v', '.mov']);
// Audio every browser plays (iPhone, Android, TVs). Dolby AC3/E-AC3, DTS etc. are silent on many
// Android and TV browsers, so those are converted to stereo AAC.
const UNIVERSAL_AUDIO = new Set(['aac', 'mp3']);
const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

// The desktop app calls this with its own settings; `node server.js` uses config.json.
// (config.json may give "pin": "1234" in plain text; it's kept hashed.)
function configure(options) {
  CONFIG = { ...CONFIG, ...options };
  if (typeof CONFIG.pin === 'string' || typeof CONFIG.pin === 'number') CONFIG.pin = /^\d{4,8}$/.test(String(CONFIG.pin)) ? hashPin(CONFIG.pin) : null;
  if (!CONFIG.secret) CONFIG.secret = crypto.randomBytes(16).toString('hex');
  CACHE_DIR = path.resolve(ROOT, CONFIG.cacheDir);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadConfig() {
  const defaults = {
    port: 8080,
    folders: [path.join(os.homedir(), 'Videos'), path.join(os.homedir(), 'Downloads')],
    minSizeMB: 5,
    cacheDir: 'cache',
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
  };
  const file = path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    console.error(`config.json is not valid JSON (${err.message}); using defaults.`);
    return defaults;
  }
}

// ---------- library ----------

let library = new Map(); // id ->{ id, path, name, title, year, size, mtime, folder }

function idFor(file) {
  return crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 16);
}

// Release tags. Strong ones never appear in real titles, so the title always ends there.
const STRONG_JUNK = new RegExp('\\b(?:' + [
  '\\d{3,4}p', '4k', 'uhd', 'hdr10\\+?', '10 ?bit', '8 ?bit',
  'blu ?ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'web ?dl', 'web ?rip', 'hdrip', 'dvdrip', 'dvdscr', 'hdtv', 'pdtv', 'hdcam', 'camrip', 'hdts', 'telesync', 'predvd',
  'amzn', 'dsnp', 'hmax', 'atvp',
  'x ?26[45]', 'h ?26[45]', 'hevc', 'xvid', 'divx',
  'aac\\d(?: \\d)?', 'e?ac3', 'ddp?\\d(?: \\d)?', 'dts ?hd', 'truehd', 'atmos',
  'dual ?audio', 'esubs?', 'msubs?', 'hc ?subs?', 'org auds?',
  'yts(?: \\w{2})?', 'yify', 'rarbg', 'galaxy ?rg', 'tgx', 'qxr', 'ettv', 'eztv',
].join('|') + ')\\b', 'i');
// Weak ones are also ordinary words ("True Lies", "The English Patient"), so they're only dropped from the end.
const WEAK_JUNK = /^(?:web|true|hq|cam|dv|hdr|sdr|nf|avc|av1|vp9|aac|ac3|dd|dts|flac|mp3|opus|[257] 1|\d ?ch|multi|audio|org|tamil|telugu|hindi|malayalam|kannada|bengali|marathi|punjabi|english|eng|subs?|repack|proper|extended|unrated|uncut|remastered|imax|directors? cut|limited|internal|psa|pahe|evo|hd|full movie|movie)$/i;
function dropTrailingJunk(title) {
  let words = title.split(' ');
  while (words.length > 1) {
    const two = words.slice(-2).join(' ');
    if (words.length > 2 && WEAK_JUNK.test(two)) words = words.slice(0, -2);
    else if (WEAK_JUNK.test(words[words.length - 1].replace(/[^\w ]/g, ''))) words = words.slice(0, -1);
    else break;
  }
  return words.join(' ');
}
// Telegram/torrent site and channel prefixes: "@WMR ", "[TamilMV] ", "www 1TamilMV solar - ", "TamilBlasters - "
const PREFIX_RE = /^(?:@\S+|\[[^\]]*\]|\([^)]*\)|www \S+(?: \S+){0,2}? (?:-|–)|www \S+ (?:com|net|org|in|me|to|cc|pw|ws|solar|mx|bz|gg|lol|art|fyi|tel|zip|xyz|site|bond|pro)\b|\S*(?:tamilmv|tamilblasters|tamilrockers|moviesda|isaimini|filmyzilla|movierulz|hdhub4u|vegamovies|katmoviehd|mkvcinemas)\S*(?: \S+){0,2}? (?:-|–))\s*-?\s*/i;
const smartCase = (t) => (/[a-z]/.test(t) && /[A-Z]/.test(t)) || t.length < 4 ? t : t.toLowerCase().replace(/(^|[\s(\-:])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

// "Insidious.Chapter.2.2013.1080p.10bit.BluRay.x265.mkv" -> { title: "Insidious Chapter 2", year: "2013" }
// "Blade.Runner.2049.2017.1080p.mkv"                     -> { title: "Blade Runner 2049", year: "2017" }
// "www.1TamilMV.solar - Leo (2023) Tamil HQ HDRip.mkv"    -> { title: "Leo", year: "2023" }
// "the.office.us.s02e05.720p.mkv"                        -> { title: "The Office Us S02E05", year: null }
function prettyName(file) {
  const original = path.basename(file, path.extname(file)).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  let base = original;
  for (let i = 0; i < 4; i++) {
    const next = base.replace(PREFIX_RE, '').trim();
    if (next === base || !next) break;
    base = next;
  }
  // Episodes: keep "Show S01E02" so the web page can group them; the year (if any) belongs to the show.
  const ep = base.match(/\bS(\d{1,2}) ?E(\d{1,3})\b|\b(\d{1,2})x(\d{2})\b/i);
  if (ep && ep.index > 0) {
    let show = base.slice(0, ep.index).replace(/[\s\-–:([]+$/, '');
    const y = show.match(/[\s(\[]((?:19|20)\d{2})[)\]]?$/);
    if (y) show = show.slice(0, y.index);
    show = smartCase(show.replace(/[[\]()]/g, ' ').replace(/\s+/g, ' ').trim());
    const s = String(+(ep[1] || ep[3])).padStart(2, '0');
    const e = String(+(ep[2] || ep[4])).padStart(2, '0');
    if (show) return { title: `${show} S${s}E${e}`, year: y ? y[1] : null };
  }
  // The title ends at the first release tag; the year is the last one before it, so "Blade Runner 2049 2017"
  // keeps its 2049 and "2012 (2009)" keeps its title.
  const junk = base.search(STRONG_JUNK);
  let head = junk > 0 ? base.slice(0, junk) : base;
  let year = null;
  const years = [...head.matchAll(/(^|[\s(\[])((?:19|20)\d{2})(?=[\s)\]]|$)/g)].filter((m) => m.index + m[1].length > 0);
  const yr = years.pop();
  if (yr) {
    year = yr[2];
    head = head.slice(0, yr.index + yr[1].length);
  }
  const tidy = (t) => t.replace(/\[[^\]]*\]?/g, ' ').replace(/\([^)]*$/, ' ').replace(/\(\s*\)/g, ' ').replace(/[\s\-–:(+]+$/, '').replace(/^[\s\-–:)]+/, '').replace(/\s+/g, ' ').trim();
  let title = tidy(dropTrailingJunk(tidy(head)));
  if (title.length < 1) title = original;
  return { title: smartCase(title), year };
}

async function walk(dir, depth, out) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
    const full = path.join(dir, entry.name);
    if (full.toLowerCase() === CACHE_DIR.toLowerCase()) continue;
    if (entry.isDirectory()) await walk(full, depth + 1, out);
    else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
}

// Requests arriving together share one scan, and the new list replaces the old one only when it's
// complete, so a lookup never sees a half-built library.
let scanning = null;
function scanLibrary() {
  if (!scanning) scanning = buildLibrary().finally(() => (scanning = null));
  return scanning;
}

async function buildLibrary() {
  if (CONFIG.genreLookup !== false) genres.init(CACHE_DIR);
  const files = [];
  for (const folder of CONFIG.folders) await walk(path.resolve(folder), 0, files);
  const next = new Map();
  for (const file of files) {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      continue;
    }
    if (stat.size < CONFIG.minSizeMB * 1024 * 1024) continue;
    const id = idFor(file);
    const folder = CONFIG.folders.find((f) => file.toLowerCase().startsWith(path.resolve(f).toLowerCase())) || '';
    // A file written to in the last 2 minutes is most likely still downloading (e.g. from Telegram).
    const downloading = Date.now() - stat.mtimeMs < 2 * 60 * 1000;
    const pretty = prettyName(file);
    next.set(id, { id, path: file, ...pretty, genres: genres.genresFor(pretty.title, pretty.year), size: stat.size, mtime: stat.mtimeMs, folder: path.basename(folder), downloading });
  }
  library = withCollections(next);
  if (CONFIG.genreLookup !== false) {
    genres.init(CACHE_DIR, () => { library = withCollections(new Map([...library].map(([k, v]) => [k, { ...v, genres: genres.genresFor(v.title, v.year) }]))); });
    genres.request([...next.values()].filter((m) => !m.downloading));
  }
  probeLanguages();
  return [...library.values()].sort((a, b) => b.mtime - a.mtime);
}

// ---------- collections ----------
// Films in the same series: Wikidata's "part of the series" when it knows, else by name, so "Dune" and
// "Dune Part Two", or "Insidious" and "Insidious Chapter 2", end up together. A collection needs 2+ films.
const SEQUEL_RE = /\s*[:\-–]?\s*(?:\b(?:part|chapter|vol(?:ume)?|episode|book)\s+(?:\d+|one|two|three|four|five|six|seven|i{1,3}|iv|vi{0,3}|ix|x)\b.*|\s(?:\d|i{2,3}|iv|vi{0,3})$|\s(?:returns|reloaded|revolutions|resurrections|rises|forever|begins)$)/i;
const nameKey = (t) => t.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
function seriesBase(title) {
  const base = title.replace(SEQUEL_RE, '').trim();
  return base && base.length >= 2 && base !== title ? base : null;
}
function withCollections(map) {
  const films = [...map.values()].filter((m) => !/\bS\d{2}E\d{2}$/.test(m.title));
  const named = new Map(); // key -> { name, ids }
  const add = (key, name, id) => { if (!named.has(key)) named.set(key, { name, ids: new Set() }); named.get(key).ids.add(id); };
  const lookedUp = new Map();
  for (const m of films) {
    const c = CONFIG.genreLookup !== false ? genres.collectionFor(m.title, m.year) : null;
    if (c) { lookedUp.set(m.id, c); add('w:' + nameKey(c), c, m.id); }
  }
  // By name: every film whose title is a base, or base + "Part 2" / "2" / "Chapter Two"...
  const bases = new Map();
  for (const m of films) {
    const b = seriesBase(m.title);
    if (b) bases.set(nameKey(b), b);
  }
  const byName = new Map();
  for (const m of films) {
    if (lookedUp.has(m.id)) continue;
    const b = seriesBase(m.title);
    const key = b ? nameKey(b) : bases.has(nameKey(m.title)) ? nameKey(m.title) : null;
    if (key) { if (!byName.has(key)) byName.set(key, []); byName.get(key).push(m); }
  }
  for (const [key, list] of byName) {
    // A name group joins a Wikidata collection with the same name ("Dune" + "Dune (film series)").
    const target = named.has('w:' + key) ? 'w:' + key : 'n:' + key;
    for (const m of list) add(target, named.has(target) ? named.get(target).name : bases.get(key) || m.title, m.id);
  }
  const of = new Map();
  for (const { name, ids } of named.values()) if (ids.size >= 2) for (const id of ids) of.set(id, name);
  return new Map([...map].map(([k, v]) => [k, { ...v, collection: of.get(k) || null }]));
}

// ---------- audio languages ----------
// Which languages each file can be heard in, for the "Tamil", "English"… and "Multi-Language" rows.
// Read from the audio tracks (ffprobe, in the background after each scan, one file at a time); a
// file with untagged tracks falls back to what its name says ("Leo (2023) Tamil", "Dual Audio").
const langInfo = new Map(); // id:size:mtime -> { languages, multiAudio }
const NAME_LANGS = ['Tamil', 'Telugu', 'Hindi', 'Malayalam', 'Kannada', 'Bengali', 'Marathi', 'Punjabi', 'Gujarati', 'English', 'Korean', 'Japanese', 'Chinese', 'Spanish', 'French', 'German', 'Italian'];
const langKey = (item) => `${item.id}:${item.size}:${Math.floor(item.mtime)}`;
function languagesFromName(file) {
  const name = path.basename(file).replace(/[._\-\[\]()]+/g, ' ');
  const found = NAME_LANGS.filter((l) => new RegExp(`\\b${l}\\b`, 'i').test(name));
  if (/\beng\b/i.test(name) && !found.includes('English')) found.push('English');
  return { found, multi: /\b(dual|multi)\s*audio\b|\bmulti\b/i.test(name) };
}
function audioLanguages(item, info) {
  const fromName = languagesFromName(item.path);
  const tagged = [...new Set(info.audios.map((a) => LANGUAGES[a.lang]).filter(Boolean))];
  const languages = tagged.length ? tagged : fromName.found;
  // Several tracks in different languages (or a name that says so) is multi-language; two
  // untagged tracks could be a commentary, so they don't count on their own.
  const multiAudio = languages.length > 1 || (fromName.multi && info.audios.length > 1);
  return { languages, multiAudio, tracks: info.audios.length };
}
function languageFields(item) {
  const hit = langInfo.get(langKey(item));
  if (hit) {
    // One untagged track (typical of YTS releases): it's almost surely the film's original language.
    const original = !hit.languages.length && hit.tracks <= 1 && CONFIG.genreLookup !== false ? genres.languageFor(item.title, item.year) : null;
    return { languages: original ? [original] : hit.languages, multiAudio: hit.multiAudio };
  }
  // Not probed yet: what the name says, so rows aren't empty while probing runs.
  const n = languagesFromName(item.path);
  return { languages: n.found, multiAudio: n.multi && n.found.length > 1, probing: true };
}
let langRun = null;
function probeLanguages() {
  if (langRun) return langRun;
  langRun = (async () => {
    for (const item of [...library.values()]) {
      if (item.downloading || langInfo.has(langKey(item))) continue;
      try {
        const info = await probe(item);
        langInfo.set(langKey(item), audioLanguages(item, info));
      } catch {
        langInfo.set(langKey(item), { languages: languagesFromName(item.path).found, multiAudio: false, tracks: 0 });
      }
    }
  })().finally(() => (langRun = null));
  return langRun;
}

// ---------- probing ----------

const probes = new Map(); // id -> Promise<info>

// Intel GPUs: a newer VA-API stack installed under /opt/intel-media (LibVA + Intel media driver) is
// used for ffmpeg only, when present; the rest of the system keeps its own. "vaapiDir": "" turns it off.
function vaapiDir() {
  const dir = CONFIG.vaapiDir === undefined ? '/opt/intel-media' : CONFIG.vaapiDir;
  return dir && process.platform === 'linux' && fs.existsSync(path.join(dir, 'lib', 'dri', 'iHD_drv_video.so')) ? dir : null;
}
function ffmpegEnv() {
  const dir = vaapiDir();
  if (!dir) return process.env;
  const lib = path.join(dir, 'lib');
  return { ...process.env, LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'), LIBVA_DRIVERS_PATH: path.join(lib, 'dri'), LIBVA_DRIVER_NAME: 'iHD', LIBVA_MESSAGING_LEVEL: '0' };
}
function renderNode() {
  try {
    const n = fs.readdirSync('/dev/dri').filter((f) => /^renderD\d+$/.test(f)).sort()[0];
    return n ? '/dev/dri/' + n : null;
  } catch {
    return null;
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: ffmpegEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim().split('\n').pop() || `${cmd} exited ${code}`))));
  });
}

// ---------- track names ----------
// Files tag tracks with ISO 639 codes ("tam", "en") and often stuff site names into the title
// ("www.1TamilMV.ing", "t.me/…"). Show "Tamil", "English 5.1", "English SDH" instead.
const LANGUAGES = {
  tam: 'Tamil', ta: 'Tamil', tel: 'Telugu', te: 'Telugu', hin: 'Hindi', hi: 'Hindi', mal: 'Malayalam', ml: 'Malayalam',
  kan: 'Kannada', kn: 'Kannada', ben: 'Bengali', bn: 'Bengali', mar: 'Marathi', mr: 'Marathi', guj: 'Gujarati', gu: 'Gujarati',
  pan: 'Punjabi', pa: 'Punjabi', urd: 'Urdu', ur: 'Urdu', ori: 'Odia', ory: 'Odia', or: 'Odia', asm: 'Assamese', sin: 'Sinhala',
  nep: 'Nepali', eng: 'English', en: 'English', spa: 'Spanish', es: 'Spanish', fre: 'French', fra: 'French', fr: 'French',
  ger: 'German', deu: 'German', de: 'German', ita: 'Italian', it: 'Italian', por: 'Portuguese', pt: 'Portuguese',
  rus: 'Russian', ru: 'Russian', jpn: 'Japanese', ja: 'Japanese', kor: 'Korean', ko: 'Korean', chi: 'Chinese', zho: 'Chinese',
  zh: 'Chinese', ara: 'Arabic', ar: 'Arabic', tur: 'Turkish', tr: 'Turkish', tha: 'Thai', th: 'Thai', ind: 'Indonesian',
  may: 'Malay', msa: 'Malay', vie: 'Vietnamese', vi: 'Vietnamese', fil: 'Filipino', tgl: 'Tagalog', per: 'Persian', fas: 'Persian',
  heb: 'Hebrew', pol: 'Polish', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish',
  gre: 'Greek', ell: 'Greek', cze: 'Czech', ces: 'Czech', hun: 'Hungarian', rum: 'Romanian', ron: 'Romanian', ukr: 'Ukrainian',
};

function trackLabel(s, fallback) {
  const tags = s.tags || {};
  const code = String(tags.language || '').toLowerCase();
  const lang = LANGUAGES[code] || '';
  let title = String(tags.title || '').trim();
  // Site names, Telegram handles and links say nothing about the track.
  if (/www\.|https?:|t\.me|@|\.(com|net|org|in|ing|me|to|cc|tv)\b/i.test(title)) title = '';
  // "ENG SDH" -> "SDH": drop the language itself, which the name already says.
  if (lang) title = title.replace(new RegExp(`\\b(${code}|${lang})\\b`, 'ig'), '').replace(/^[\s\-–|:,]+|[\s\-–|:,]+$/g, '').trim();
  const channels = s.channels === 6 ? ' 5.1' : s.channels === 8 ? ' 7.1' : '';
  const name = [lang, title].filter(Boolean).join(' ') || fallback;
  return s.codec_type === 'audio' ? name + channels : name;
}

function probe(item) {
  const key = `${item.id}-${item.size}-${item.mtime}`; // re-probe once a download grows
  if (!probes.has(key)) {
    const p = run(CONFIG.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', item.path]).then((out) => {
      const data = JSON.parse(out);
      const streams = data.streams || [];
      const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
      // Every audio track, in file order. Track 0 is what plays unless a device asks for another.
      const audios = streams
        .filter((s) => s.codec_type === 'audio')
        .map((s, n) => ({ n, index: s.index, codec: s.codec_name, lang: String((s.tags && s.tags.language) || 'und').toLowerCase(), label: trackLabel(s, `Audio ${n + 1}`) }));
      // Same name twice ("English", "English"): number them so they can be told apart.
      for (const a of audios) if (audios.filter((b) => b.label === a.label).length > 1) a.label += ` (${a.n + 1})`;
      const audio = streams.find((s) => s.codec_type === 'audio');
      const subs = streams
        .filter((s) => s.codec_type === 'subtitle' && TEXT_SUBS.has(s.codec_name))
        .map((s, i) => ({ key: `e${s.index}`, stream: s.index, n: i, lang: (s.tags && s.tags.language) || 'und', label: trackLabel(s, `Subtitles ${i + 1}`) }));
      for (const side of sidecarSubs(item.path)) subs.push(side);
      return {
        duration: Number(data.format && data.format.duration) || 0,
        video,
        audio,
        audios,
        subs,
        mode: playMode(item.path, video, audio),
        videoCodec: video ? video.codec_name : null,
        tenBit: !!video && /1[02]/.test(video.pix_fmt || ''),
        height: video ? video.height : 0,
        width: video ? video.width : 0,
        // HDR10/HDR10+ (PQ) or HLG. Dolby Vision profile 8 files carry an HDR10 picture underneath, so they count too.
        hdr: !!video && (['smpte2084', 'arib-std-b67'].includes(video.color_transfer) || (video.color_primaries === 'bt2020' && /1[02]/.test(video.pix_fmt || '') && (video.side_data_list || []).some((d) => /DOVI|Mastering/i.test(d.side_data_type || '')))),
      };
    });
    p.catch(() => probes.delete(key));
    probes.set(key, p);
  }
  return probes.get(key);
}

// Subtitle files next to the movie: "Movie.srt", "Movie.en.srt", "Movie.English.vtt"
function sidecarSubs(file) {
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file)).toLowerCase();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  return names
    .filter((n) => /\.(srt|vtt)$/i.test(n) && n.toLowerCase().startsWith(stem))
    .map((n, i) => {
      const extra = n.slice(stem.length).replace(/\.(srt|vtt)$/i, '').replace(/^[ ._-]+/, '');
      return { key: `f${i}`, file: path.join(dir, n), lang: extra.slice(0, 3).toLowerCase() || 'und', label: extra || 'Subtitles' };
    });
}

// direct: the file plays as-is. remux: copy the video into an MP4 (seconds).
// transcode: the video itself must be re-encoded, which happens as an HLS stream (see below).
// HEVC plays only on some devices; the player asks for the HLS stream when it can't.
function playMode(file, video, audio) {
  if (!video) return 'transcode';
  const videoOk = videoCopyable(video);
  const audioOk = !audio || UNIVERSAL_AUDIO.has(audio.codec_name);
  const tagOk = video.codec_name !== 'hevc' || video.codec_tag_string === 'hvc1';
  if (DIRECT_CONTAINERS.has(path.extname(file).toLowerCase()) && videoOk && audioOk && tagOk) return 'direct';
  return videoOk ? 'remux' : 'transcode';
}

function videoCopyable(video) {
  if (video.codec_name === 'hevc') return true;
  if (video.codec_name === 'h264') return !/10|12|422|444/.test(video.pix_fmt || '') && !/High 10|4:2:2|4:4:4/.test(video.profile || '');
  return false;
}

// ---------- preparing (remux / transcode into the cache) ----------

const jobs = new Map(); // "id:audio" -> { state, progress, error }

// One copy per audio language, made when a device asks for that language. Browsers on Android and
// TVs can't switch between audio tracks in a file, so each copy carries just one.
function cachedMp4(item, audio = 0) {
  // Include size+mtime so a replaced file gets prepared again; "u" marks the universal-audio format
  // (and is the first audio track, as copies were before languages could be chosen).
  return path.join(CACHE_DIR, `${item.id}-${item.size}-${Math.floor(item.mtime)}-${audio ? `a${audio}` : 'u'}.mp4`);
}

function jobStatus(item, audio = 0) {
  if (fs.existsSync(cachedMp4(item, audio))) return { state: 'ready', progress: 1 };
  const key = `${item.id}:${audio}`;
  const job = jobs.get(key);
  if (job && job.state === 'ready') jobs.delete(key); // its copy was removed to free space
  return jobs.get(key) || { state: 'idle', progress: 0 };
}

// ?audio=N from a request: which audio track (0 = the file's first).
function audioParam(url) {
  const n = Number(url.searchParams.get('audio'));
  return Number.isInteger(n) && n > 0 && n < 64 ? n : 0;
}

// ---------- disk space ----------
// Converted copies are as big as the movie. Keep 2 GB free on the laptop by deleting the copies
// watched longest ago (their mtime is bumped whenever they're streamed).
const RESERVE = 2 * 1024 ** 3;

async function freeBytes() {
  try {
    const s = await fsp.statfs(CACHE_DIR);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

async function makeRoom(need, keep) {
  let free = await freeBytes();
  if (free >= need + RESERVE) return true;
  const busy = new Set([...hls.values()].filter((st) => st.jobs.length).map((st) => st.dir));
  const candidates = [];
  for (const e of await fsp.readdir(CACHE_DIR, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(CACHE_DIR, e.name);
    const isCopy = e.isDirectory() ? e.name.startsWith('hls-') : e.name.endsWith('.mp4');
    if (!isCopy || p === keep || busy.has(p)) continue;
    const st = await fsp.stat(p).catch(() => null);
    if (st) candidates.push({ p, used: st.mtimeMs, dir: e.isDirectory() });
  }
  candidates.sort((a, b) => a.used - b.used);
  const removed = new Set();
  for (const c of candidates) {
    if (free >= need + RESERVE) break;
    const size = c.dir ? await dirSize(c.p) : (await fsp.stat(c.p).catch(() => ({ size: 0 }))).size;
    await fsp.rm(c.p, { recursive: true, force: true }).catch(() => {});
    removed.add(c.p);
    free += size;
    console.log(`Freed ${(size / 1e9).toFixed(1)} GB by removing an old converted copy`);
  }
  for (const [id, st] of hls) if (removed.has(st.dir)) hls.delete(id);
  return free >= need + RESERVE;
}

function touch(file) {
  const now = new Date();
  fs.utimes(file, now, now, () => {});
}

async function prepare(item, audio = 0) {
  const existing = jobStatus(item, audio);
  if (existing.state === 'ready' || existing.state === 'working') return existing;
  if (item.downloading) return { state: 'error', progress: 0, error: 'This file is still downloading. Try again once it finishes.' };
  if (!(await makeRoom(item.size * 1.02))) {
    return { state: 'error', progress: 0, code: 'nospace', error: `Not enough free space on the laptop to prepare this (needs about ${Math.ceil((item.size * 1.02 + RESERVE) / 1e9)} GB free).` };
  }
  const job = { state: 'working', progress: 0, error: null };
  jobs.set(`${item.id}:${audio}`, job);

  try {
    const info = await probe(item);
    if (info.mode === 'transcode') throw new Error('This video needs converting while it plays; the player uses the compatible stream for it.');
    const track = info.audios[audio] || info.audios[0];
    const out = cachedMp4(item, audio);
    const tmp = `${out}.part`;
    // Map the real video stream: some files carry cover art as an extra "video" stream.
    const args = ['-hide_banner', '-v', 'error', '-y', '-i', item.path, '-map', `0:${info.video.index}`, '-map', track ? `0:${track.index}` : '0:a:0?'];
    args.push('-c:v', 'copy');
    if (info.video.codec_name === 'hevc') args.push('-tag:v', 'hvc1');
    // Copying audio every device plays is far faster than re-encoding it; otherwise make stereo AAC.
    if (track && UNIVERSAL_AUDIO.has(track.codec)) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
    args.push('-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', tmp);

    console.log(`Preparing "${item.title}"${track && info.audios.length > 1 ? ` in ${track.label}` : ''} (${info.mode})…`);
    const child = spawn(CONFIG.ffmpeg, args, { windowsHide: true, env: ffmpegEnv() });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m && info.duration) {
        const us = Number(m[m.length - 1].split('=')[1]);
        job.progress = Math.min(0.99, us / 1e6 / info.duration);
      }
    });
    child.on('error', (err) => Object.assign(job, { state: 'error', error: `Could not start ffmpeg: ${err.message}` }));
    child.on('close', async (code) => {
      if (code === 0) {
        await fsp.rename(tmp, out);
        Object.assign(job, { state: 'ready', progress: 1 });
        console.log(`Ready: "${item.title}"`);
      } else {
        fsp.unlink(tmp).catch(() => {});
        Object.assign(job, { state: 'error', error: stderr.trim().split('\n').pop() || `ffmpeg exited ${code}` });
        console.error(`Failed to prepare "${item.title}": ${job.error}`);
      }
    });
  } catch (err) {
    Object.assign(job, { state: 'error', error: err.message });
  }
  return job;
}

// ---------- subtitles & thumbnails (cached) ----------

const pending = new Map(); // cache file -> Promise

function once(file, make) {
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (!pending.has(file)) {
    const p = make().then(() => file).finally(() => pending.delete(file));
    pending.set(file, p);
  }
  return pending.get(file);
}

async function subtitleFile(item, key) {
  const info = await probe(item);
  const sub = info.subs.find((s) => s.key === key);
  if (!sub) return null;
  const out = path.join(CACHE_DIR, `${item.id}-${Math.floor(item.mtime)}-${key}.vtt`);
  const input = sub.file || item.path;
  const map = sub.file ? '0:s:0' : `0:${sub.stream}`;
  return once(out, () => run(CONFIG.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', input, '-map', map, '-f', 'webvtt', out]));
}

// Thumbnails decode real video frames, so only make two at a time.
let thumbSlots = 2;
const thumbQueue = [];
function withThumbSlot(fn) {
  return new Promise((resolve, reject) => {
    const go = () => {
      thumbSlots--;
      fn().then(resolve, reject).finally(() => {
        thumbSlots++;
        if (thumbQueue.length) thumbQueue.shift()();
      });
    };
    thumbSlots > 0 ? go() : thumbQueue.push(go);
  });
}

// hero=true makes a wide backdrop for the landing page banner.
async function thumbnail(item, hero = false) {
  const out = path.join(CACHE_DIR, `${item.id}-${Math.floor(item.mtime)}${hero ? '-hero' : ''}.jpg`);
  return once(out, () =>
    withThumbSlot(async () => {
      const info = await probe(item);
      const at = info.duration ? Math.min(info.duration * 0.2, 600) : 5;
      const scale = hero ? 'scale=1600:-2' : 'scale=480:-2';
      await run(CONFIG.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', at.toFixed(1), '-i', item.path, '-frames:v', '1', '-vf', scale, '-q:v', hero ? '3' : '4', out]);
    })
  );
}

// Short muted clips for the banner and for hovering a card. One at a time: they decode real video.
let previewBusy = Promise.resolve();
const PREVIEW_SECONDS = 30;
async function previewClip(item) {
  const out = path.join(CACHE_DIR, `${item.id}-${Math.floor(item.mtime)}-preview.mp4`);
  return once(out, () => {
    const job = previewBusy.then(async () => {
      const info = await probe(item);
      if (!info.video || !info.duration) throw new Error('No video');
      // A quarter of the way in skips opening credits; short files start near the beginning.
      const at = info.duration > 240 ? Math.min(info.duration * 0.25, 1500) : Math.max(0, info.duration * 0.1);
      const len = Math.min(PREVIEW_SECONDS, Math.max(3, info.duration - at - 1));
      const part = out + '.part';
      await run(CONFIG.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', at.toFixed(1), '-t', len.toFixed(1), '-i', item.path,
        '-map', `0:${info.video.index}`, '-an', '-sn', '-vf', "scale=-2:'min(ih,720)',format=yuv420p",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-maxrate', '2500k', '-bufsize', '5000k', '-profile:v', 'main',
        '-movflags', '+faststart', '-f', 'mp4', part]);
      await fsp.rename(part, out);
    });
    previewBusy = job.catch(() => {});
    return job;
  });
}

// ---------- HLS: H.264 for devices that can't play the original video ----------
// Many Android phones, TV browsers and PCs can't decode HEVC (x265), especially 10-bit. For those,
// the movie is converted to H.264 while it plays, as 4-second HLS segments. The playlist lists every
// segment up front, so the seek bar covers the whole movie; a segment that isn't made yet is waited
// for, and seeking far ahead restarts the converter at that point. Finished segments stay cached.

const SEG = 4; // seconds per segment
const AHEAD = 45; // segments the converter may be behind a request before it's restarted there
const hls = new Map(); // id:audio:quality -> { item, dir, total, done: Set<number>, jobs: [job], profile, error }
// Several people can watch the same converted stream at different points: each gets their own
// converter for their part of the movie (up to this many per stream), instead of taking it over
// from the others, which made everyone wait while it kept restarting.
const MAX_JOBS_PER_STREAM = 3;
// A converter nobody has asked anything of for this long, already well ahead of the last request
// (they left, or paused), stops to free the GPU for others. It picks up again when needed.
const JOB_IDLE_MS = 2 * 60 * 1000;
const JOB_IDLE_AHEAD = 150; // segments (10 minutes)

let encoderList = null;
// Hardware encoders are ~3x faster than the CPU and keep the laptop cool; use the first that works.
function workingEncoders() {
  if (!encoderList) {
    encoderList = (async () => {
      const found = [];
      const node = renderNode();
      if (node) {
        try {
          await run(CONFIG.ffmpeg, ['-hide_banner', '-v', 'error', '-vaapi_device', node, '-f', 'lavfi', '-i', 'color=size=640x360:duration=0.5', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-']);
          found.push('h264_vaapi');
        } catch {}
        // HEVC Main 10 (low-power engine) is what keeps HDR intact.
        try {
          await run(CONFIG.ffmpeg, ['-hide_banner', '-v', 'error', '-vaapi_device', node, '-f', 'lavfi', '-i', 'color=size=640x360:duration=0.5', '-vf', 'format=p010,hwupload', '-c:v', 'hevc_vaapi', '-low_power', '1', '-profile:v', 'main10', '-f', 'null', '-']);
          found.push('hevc10_vaapi');
        } catch {}
      }
      for (const enc of ['h264_qsv', 'h264_nvenc', 'h264_amf']) {
        const pix = enc === 'h264_qsv' ? 'nv12' : 'yuv420p';
        try {
          await run(CONFIG.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=640x360:duration=0.5', '-pix_fmt', pix, '-c:v', enc, '-f', 'null', '-']);
          found.push(enc);
        } catch {}
      }
      console.log(`H.264 encoders: ${[...found, 'libx264'].join(', ')}`);
      return found;
    })();
  }
  return encoderList;
}

// Streaming qualities a viewer can pick: picture height, video bitrate cap, audio bitrate.
// 0 is "Auto": the original behaviour (up to 1080p wide, no bitrate cap).
// Each fits inside a 16:9 box (so "1080p" of a 2.39:1 film is 1920x804, not 2582x1080) and never enlarges.
const QUALITIES = {
  2160: { box: 3840, maxrate: 24000, audio: '192k' },
  1080: { box: 1920, maxrate: 6000, audio: '160k' },
  720: { box: 1280, maxrate: 3000, audio: '128k' },
  480: { box: 854, maxrate: 1400, audio: '128k' },
  360: { box: 640, maxrate: 800, audio: '96k' },
};
// 4K HDR: HEVC Main 10 keeping PQ/HLG, BT.2020 and the HDR metadata, for devices that decode HEVC 10-bit.
const HDR_STREAM = { maxrate: 20000, rate: 15000, audio: '192k' };
function qualityParam(url) {
  const q = Number(url.searchParams.get('q'));
  return QUALITIES[q] ? q : 0;
}
async function hdrStreamAvailable(info) {
  return !!info.hdr && Math.max(info.width, info.height * 16 / 9) >= 3200 && (await workingEncoders()).includes('hevc10_vaapi') && !!renderNode();
}
// HDR to SDR: the picture tone-mapped to normal brightness and colour, and the HDR labels dropped, so a TV
// doesn't switch into HDR mode for an SDR picture.
const DROP_HDR_LABELS = 'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL';
const CPU_TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

// Ways to convert, fastest first. If one fails on a file, the next is tried.
// hdr: the 4K HDR stream (HEVC Main 10, GPU only); otherwise H.264, tone-mapped when the film is HDR.
async function hlsProfiles(info, quality = 0, hdr = false) {
  const encoders = await workingEncoders();
  const hwDecode = ['hevc', 'h264', 'vp9', 'av1', 'mpeg2video'].includes(info.videoCodec);
  if (hdr) {
    const node = renderNode();
    const enc = ['-c:v', 'hevc_vaapi', '-low_power', '1', '-profile:v', 'main10', '-bf', '0', '-rc_mode', 'VBR', '-b:v', `${HDR_STREAM.rate}k`, '-maxrate', `${HDR_STREAM.maxrate}k`, '-bufsize', `${HDR_STREAM.maxrate * 2}k`, '-tag:v', 'hvc1'];
    const vf = "scale_vaapi=w='min(iw,3840)':h='min(ih,2160)':force_original_aspect_ratio=decrease:force_divisible_by=2:format=p010";
    const profiles = [];
    if (hwDecode) profiles.push({ name: 'Intel GPU (VA-API), HDR', pre: ['-hwaccel', 'vaapi', '-hwaccel_device', node, '-hwaccel_output_format', 'vaapi'], vf, enc });
    profiles.push({ name: 'Intel GPU (VA-API), HDR', pre: ['-vaapi_device', node], vf: "scale=w='min(iw,3840)':h='min(ih,2160)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=p010,hwupload", enc });
    return profiles;
  }
  const fit = "'min(iw,1920)'"; // phones and TVs handle 1080p H.264 best
  const box = quality ? QUALITIES[quality].box : 0;
  const boxH = Math.round((box * 9) / 16 / 2) * 2;
  // A chosen quality fits the picture in its box (never enlarging) and caps the bitrate so it streams over weak Wi-Fi.
  const scale = quality ? `scale=w='min(iw,${box})':h='min(ih,${boxH})':force_original_aspect_ratio=decrease:force_divisible_by=2` : `scale=${fit}:-2`;
  const rate = quality ? QUALITIES[quality].maxrate : 0;
  const cap = quality ? ['-maxrate', `${rate}k`, '-bufsize', `${rate * 2}k`] : [];
  // HDR films become SDR here: tone-mapped on the GPU, or with zscale on the CPU.
  const swTone = info.hdr ? `${CPU_TONEMAP},` : '';
  const profiles = [];
  if (encoders.includes('h264_vaapi')) {
    const node = renderNode();
    // Constant quality like the CPU's CRF 22 for Auto; a capped bitrate for a chosen quality.
    const enc = ['-c:v', 'h264_vaapi', '-profile:v', 'high', ...(quality ? ['-rc_mode', 'VBR', '-b:v', `${Math.round(rate * 0.75)}k`, ...cap] : ['-rc_mode', 'CQP', '-qp', '23'])];
    const hwSize = quality ? `w='min(iw,${box})':h='min(ih,${boxH})':force_original_aspect_ratio=decrease:force_divisible_by=2` : `w=${fit}:h=-2`;
    const hwScale = info.hdr
      ? `scale_vaapi=${hwSize}:format=p010,tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,${DROP_HDR_LABELS}`
      : `scale_vaapi=${hwSize}:format=nv12`;
    // All on the GPU: decode, scale (10-bit to 8-bit too) and encode. Then software decoding feeding the GPU encoder.
    if (hwDecode) profiles.push({ name: 'Intel GPU (VA-API)', pre: ['-hwaccel', 'vaapi', '-hwaccel_device', node, '-hwaccel_output_format', 'vaapi'], vf: hwScale, enc });
    profiles.push({ name: 'Intel GPU (VA-API)', pre: ['-vaapi_device', node], vf: `${swTone}${scale},format=nv12,hwupload`, enc });
  }
  if (encoders.includes('h264_qsv')) {
    const enc = ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-forced_idr', '1', ...cap];
    if (!quality && !info.hdr && ['hevc', 'h264'].includes(info.videoCodec)) profiles.push({ name: 'Intel Quick Sync', pre: ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'], vf: `scale_qsv=w=${fit}:h=-1:format=nv12`, enc });
    profiles.push({ name: 'Intel Quick Sync', pre: [], vf: `${swTone}${scale},format=nv12`, enc });
  }
  if (encoders.includes('h264_nvenc')) profiles.push({ name: 'NVIDIA NVENC', pre: [], vf: `${swTone}${scale},format=yuv420p`, enc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-forced-idr', '1', ...cap] });
  if (encoders.includes('h264_amf')) profiles.push({ name: 'AMD AMF', pre: [], vf: `${swTone}${scale},format=yuv420p`, enc: ['-c:v', 'h264_amf', '-quality', 'balanced', ...(quality ? ['-rc', 'vbr_peak', '-b:v', `${Math.round(rate * 0.75)}k`, ...cap] : ['-rc', 'cqp', '-qp_i', '22', '-qp_p', '24']), '-header_insertion_mode', 'idr'] });
  profiles.push({ name: 'CPU', pre: [], vf: `${swTone}${scale},format=yuv420p`, enc: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', quality && quality <= 480 ? '24' : '22', '-forced-idr', '1', ...cap] });
  return profiles;
}

// One converted stream per movie, audio language and quality. The 4K HDR stream is its own, in fMP4
// segments (Apple and browsers only take HEVC that way). "-v2": quality streams sized by the new box
// rule, so they never mix with segments made by the old one; Auto streams are unchanged.
function hlsState(item, info, audio = 0, quality = 0, hdr = false) {
  const variant = hdr ? '-hdr' : quality ? `-q${quality}-v2` : '';
  const dir = path.join(CACHE_DIR, `hls-${item.id}-${item.size}-${Math.floor(item.mtime)}${audio ? `-a${audio}` : ''}${variant}`);
  const key = `${item.id}:${audio}:${hdr ? 'hdr' : quality}`;
  let st = hls.get(key);
  if (!st || st.dir !== dir) {
    if (st) stopHls(st);
    let done = [];
    try {
      done = JSON.parse(fs.readFileSync(path.join(dir, 'segments.json'), 'utf8'));
    } catch {}
    st = { item, audio, quality: hdr ? 0 : quality, hdr, ext: hdr ? 'm4s' : 'ts', dir, total: Math.max(1, Math.ceil(info.duration / SEG)), duration: info.duration, done: new Set(done), jobs: [], profile: 0, error: null, starting: null };
    hls.set(key, st);
  }
  return st;
}

// key / session: the ?k= and ?s= the playlist was asked with, passed on to its segments (AirPlay sends no cookies).
function hlsPlaylist(st, key, session) {
  const params = new URLSearchParams();
  if (st.quality) params.set('q', st.quality);
  if (st.hdr) params.set('h', '1');
  if (key) params.set('k', key);
  if (session) params.set('s', session);
  const q = params.toString() ? '?' + params : '';
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${st.hdr ? 7 : 3}`, `#EXT-X-TARGETDURATION:${SEG + 1}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  if (st.hdr) lines.push('#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="init.mp4${q}"`);
  for (let i = 0; i < st.total; i++) {
    const len = i === st.total - 1 ? st.duration - SEG * i : SEG;
    lines.push(`#EXTINF:${Math.max(0.1, len).toFixed(3)},`, `${i}.${st.ext}${q}`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

const segFile = (st, n) => path.join(st.dir, `seg${String(n).padStart(5, '0')}.${st.ext}`);
const initFile = (st) => path.join(st.dir, 'init.mp4');

function stopJob(st, job) {
  if (!job || job.killed) return;
  job.killed = true;
  clearInterval(job.timer);
  job.child.kill();
  st.jobs = st.jobs.filter((j) => j !== job);
}
function stopHls(st) {
  for (const job of [...st.jobs]) stopJob(st, job);
}

// ffmpeg lists a segment in its own playlist once the segment is complete.
function readProgress(st, job) {
  let text = '';
  try {
    text = fs.readFileSync(job.list, 'utf8');
  } catch {
    return;
  }
  let changed = false;
  // Every HDR converter writes the same init file (checked: byte for byte); the first one's is used.
  if (st.hdr && job.init && /seg\d+\.m4s/.test(text) && !fs.existsSync(initFile(st))) {
    try {
      fs.copyFileSync(job.init, initFile(st) + '.part');
      fs.renameSync(initFile(st) + '.part', initFile(st));
    } catch {}
  }
  for (const m of text.matchAll(/seg(\d+)\.(?:ts|m4s)/g)) {
    const n = Number(m[1]);
    if (!st.done.has(n)) {
      st.done.add(n);
      changed = true;
    }
    job.produced = Math.max(job.produced, n - job.from + 1);
    job.next = Math.max(job.next, n + 1);
  }
  if (changed) fs.writeFile(path.join(st.dir, 'segments.json'), JSON.stringify([...st.done]), () => {});
  if (!st.jobs.includes(job)) return;
  // Ran into segments another converter (or an earlier run) already made: stop, and pick up again where needed.
  if (job.next > job.from && st.done.has(job.next)) return stopJob(st, job);
  // Nobody's needed it for a while and it's far ahead of them: let it go.
  if (Date.now() - job.wanted > JOB_IDLE_MS && job.next - job.lastSeg > JOB_IDLE_AHEAD) {
    console.log(`Stopped converting "${st.item.title}" at ${Math.round((job.next * SEG) / 60)} min: nobody is watching that part.`);
    stopJob(st, job);
  }
}

async function startHls(st, info, from) {
  // All converters for this stream busy: replace the one nobody has needed for the longest.
  if (st.jobs.length >= MAX_JOBS_PER_STREAM) stopJob(st, [...st.jobs].sort((a, b) => a.wanted - b.wanted)[0]);
  // Room for the rest of the movie at roughly 0.35 MB per second of 1080p H.264 (less at a capped quality), else at least 1 GB.
  const need = (st.total - st.done.size) * SEG * (st.hdr ? (HDR_STREAM.maxrate * 1000) / 8 : st.quality ? (QUALITIES[st.quality].maxrate * 1000) / 8 : 0.35e6);
  if (!(await makeRoom(need, st.dir)) && (await freeBytes()) < 1024 ** 3) {
    st.error = 'The laptop is out of disk space. Free some space and try again.';
    return;
  }
  fs.mkdirSync(st.dir, { recursive: true });
  const profiles = await hlsProfiles(info, st.quality, st.hdr);
  const profile = profiles[Math.min(st.profile, profiles.length - 1)];
  const list = path.join(st.dir, `run-${from}.m3u8`); // each converter keeps its own list
  try {
    fs.unlinkSync(list);
  } catch {}
  const at = String(from * SEG);
  const args = ['-hide_banner', '-v', 'error', '-y', ...profile.pre, '-ss', at, '-i', st.item.path, '-map', `0:${info.video.index}`];
  const track = info.audios[st.audio] || info.audios[0];
  if (track) args.push('-map', `0:${track.index}`);
  args.push('-vf', profile.vf, ...profile.enc, '-force_key_frames', `expr:gte(t,n_forced*${SEG})`);
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', st.hdr ? HDR_STREAM.audio : st.quality ? QUALITIES[st.quality].audio : '160k', '-output_ts_offset', at);
  // temp_file: each segment is written aside and renamed into place, so a segment another converter
  // already made is replaced whole, never half-written under someone reading it.
  args.push('-f', 'hls', '-hls_flags', 'temp_file', '-hls_time', String(SEG), '-hls_list_size', '0', '-start_number', String(from));
  let init = null;
  if (st.hdr) {
    // fMP4: frag_discont makes each fragment's time count from the start of the movie (not from where this
    // converter began), so segments from different converters line up; it also keeps the init file the same.
    init = path.join(st.dir, `init-${from}.mp4`);
    args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', path.basename(init), '-hls_segment_options', 'movflags=+frag_custom+dash+delay_moov+frag_discont');
  }
  args.push('-hls_segment_filename', path.join(st.dir, `seg%05d.${st.ext}`), list);

  console.log(`Converting "${st.item.title}" for this device from ${Math.round(from * SEG / 60)} min (${profile.name}${st.hdr ? ', 4K HDR' : st.quality ? `, ${st.quality}p` : ''})…`);
  const job = { child: spawn(CONFIG.ffmpeg, args, { windowsHide: true, env: ffmpegEnv() }), from, next: from, produced: 0, list, init, profile: profile.name, killed: false, wanted: Date.now(), lastSeg: from };
  let stderr = '';
  job.child.stderr.on('data', (d) => (stderr += d));
  job.timer = setInterval(() => readProgress(st, job), 400);
  job.child.on('error', (err) => (stderr += err.message));
  job.child.on('close', (code) => {
    clearInterval(job.timer);
    readProgress(st, job);
    st.jobs = st.jobs.filter((j) => j !== job);
    fs.unlink(list, () => {});
    if (init && fs.existsSync(initFile(st))) fs.unlink(init, () => {});
    if (job.killed || code === 0) return;
    // Failed before making anything: this way of converting doesn't suit the file, try the next one.
    if (job.produced === 0 && st.profile < profiles.length - 1) {
      console.error(`${profile.name} couldn't convert "${st.item.title}", trying another way: ${stderr.trim().split('\n').pop()}`);
      st.profile++;
      startHls(st, info, from);
    } else if (job.produced === 0) {
      st.error = stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`;
      console.error(`Couldn't convert "${st.item.title}": ${st.error}`);
    }
  });
  st.jobs.push(job);
  st.error = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hlsSegment(req, res, item, n, audio, quality, hdr = false) {
  const info = await probe(item);
  const st = hlsState(item, info, audio, quality, hdr);
  if (!(n >= 0 && n < st.total)) return send(res, 404, { error: 'No such segment' });
  const deadline = Date.now() + 45000;
  while (!st.done.has(n)) {
    if (st.error && !st.jobs.length) return send(res, 500, { error: st.error });
    // A converter already heading for this segment: wait for it (and note that someone still needs it).
    const job = st.jobs.find((j) => n >= j.from && n <= j.next + AHEAD);
    if (job) {
      job.wanted = Date.now();
      job.lastSeg = Math.max(job.lastSeg, n);
    } else if (!st.starting) st.starting = startHls(st, info, n).finally(() => (st.starting = null));
    if (st.starting) await st.starting;
    if (Date.now() > deadline || req.destroyed) return send(res, 503, { error: 'Still converting, try again' });
    await sleep(250);
  }
  for (const j of st.jobs) if (n >= j.from - AHEAD && n <= j.next + AHEAD) { j.wanted = Date.now(); j.lastSeg = Math.max(j.lastSeg, n); }
  if (n % 15 === 0) touch(st.dir); // recently watched: keep it when making room
  return streamFile(req, res, segFile(st, n), st.hdr ? 'video/mp4' : 'video/mp2t');
}

// The HDR stream's init file: made with its first segment, so wait for that (and start converting if nobody has).
async function hlsInit(req, res, item, audio) {
  const info = await probe(item);
  const st = hlsState(item, info, audio, 0, true);
  const deadline = Date.now() + 45000;
  while (!fs.existsSync(initFile(st))) {
    if (st.error && !st.jobs.length) return send(res, 500, { error: st.error });
    if (!st.jobs.length && !st.starting) st.starting = startHls(st, info, 0).finally(() => (st.starting = null));
    if (st.starting) await st.starting;
    if (Date.now() > deadline || req.destroyed) return send(res, 503, { error: 'Still converting, try again' });
    await sleep(250);
  }
  return streamFile(req, res, initFile(st), 'video/mp4');
}

async function dirSize(dir) {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

// ---------- accounts, profiles & My List ----------
// People sign in with a username and password. Each account has up to 6 profiles, each with its own
// My List. It's all kept on this laptop (not in the cache, which "Clear cache" empties). Passwords are
// stored as salted scrypt hashes and sessions as SHA-256 hashes of random tokens, so the file holds
// nothing that could be used to sign in. Watch progress stays on each device, kept apart per profile.
const PROFILE_COLORS = ['#e50914', '#2d7ff9', '#1db954', '#f5a623', '#9b59b6', '#16a5a5', '#e84393', '#7f8c8d'];
const MAX_PROFILES = 6;
const MAX_LIST = 500;
const MAX_ACCOUNTS = 50;
const SESSION_DAYS = 180;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;

const dataPath = (name) => path.join(path.resolve(ROOT, CONFIG.dataDir), name);
let accountData = null; // { users: [{ id, username, salt, hash, created, profiles }], sessions: { sha256(token): { user, expires } } }
function loadAccounts() {
  if (accountData) return accountData;
  try {
    const d = JSON.parse(fs.readFileSync(dataPath('accounts.json'), 'utf8'));
    if (Array.isArray(d.users)) accountData = { users: d.users, sessions: d.sessions || {} };
  } catch {}
  if (!accountData) accountData = { users: [], sessions: {} };
  return accountData;
}
// Saves queue up so two can't interleave; each writes a private temp file, then replaces the old one.
let saving = Promise.resolve();
function saveAccounts() {
  saving = saving.then(async () => {
    const file = dataPath('accounts.json');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(accountData, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }).catch((e) => console.error('Could not save accounts:', e.message));
  return saving;
}
// Profiles from before accounts existed (profiles.json) go to the first account made, so "Me" and its
// My List carry on, and so does the watch progress devices saved for it.
function legacyProfiles() {
  try {
    const d = JSON.parse(fs.readFileSync(dataPath('profiles.json'), 'utf8'));
    if (Array.isArray(d.profiles) && d.profiles.length) return d.profiles.slice(0, MAX_PROFILES);
  } catch {}
  return [{ id: 'main', name: 'Me', color: PROFILE_COLORS[0], list: [] }];
}

const scrypt = (password, salt) => new Promise((resolve, reject) => crypto.scrypt(String(password), salt, 64, (e, key) => (e ? reject(e) : resolve(key))));
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const publicUser = (u) => ({ id: u.id, username: u.username });
const SESSION_COOKIE = 'homeflix_session';
const sessionCookie = (token, maxAge) => `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
// The session comes from its cookie, or ?s= on video addresses (AirPlay hands those to an Apple TV, which sends no cookies).
function sessionToken(req, url) {
  const cookie = /(?:^|;\s*)homeflix_session=([0-9a-f]{64})/.exec(req.headers.cookie || '');
  if (cookie) return cookie[1];
  const s = url.searchParams.get('s') || '';
  return /^[0-9a-f]{64}$/.test(s) ? s : '';
}
function sessionFrom(req, url) {
  const token = sessionToken(req, url);
  if (!token) return null;
  const d = loadAccounts();
  const s = d.sessions[tokenHash(token)];
  if (!s || s.expires < Date.now()) return null;
  const user = d.users.find((u) => u.id === s.user);
  return user ? { user, token } : null;
}
async function startSession(res, user) {
  const d = loadAccounts();
  const now = Date.now();
  for (const [k, s] of Object.entries(d.sessions)) if (s.expires < now) delete d.sessions[k];
  const token = crypto.randomBytes(32).toString('hex');
  d.sessions[tokenHash(token)] = { user: user.id, expires: now + SESSION_DAYS * 864e5 };
  await saveAccounts();
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
  res.end(JSON.stringify({ user: publicUser(user), token }));
}

// Wrong passwords: 5 free tries per device, then each try waits longer (30 s, 1 min … up to an hour).
const loginTries = new Map(); // ip -> { fails, until }
function loginWait(ip) {
  const t = loginTries.get(ip);
  return t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0;
}
function loginFailed(ip) {
  const t = loginTries.get(ip) || { fails: 0, until: 0 };
  t.fails++;
  if (t.fails >= 5) t.until = Date.now() + Math.min(3600, 30 * 2 ** (t.fails - 5)) * 1000;
  loginTries.set(ip, t);
}
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

async function accountsApi(req, res, parts) {
  const ip = req.socket.remoteAddress;
  const d = loadAccounts();
  const action = parts[1];
  if (action === 'me') {
    const session = sessionFrom(req, new URL(req.url, 'http://x'));
    return session ? send(res, 200, { user: publicUser(session.user) }) : send(res, 401, { error: 'Sign in first.', login: true });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  if (action === 'logout') {
    const token = sessionToken(req, new URL(req.url, 'http://x'));
    if (token && d.sessions[tokenHash(token)]) {
      delete d.sessions[tokenHash(token)];
      await saveAccounts();
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie('', 0) });
    return res.end(JSON.stringify({ ok: true }));
  }
  const wait = loginWait(ip);
  if (wait) return send(res, 429, { error: `Too many tries. Wait ${wait} seconds.`, wait });
  const body = await readBody(req, 2048);
  const username = String(body.username || '').trim().toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (action === 'signup') {
    if (!USERNAME_RE.test(username)) return send(res, 400, { error: 'Usernames are 3–24 letters or numbers (dots, dashes and underscores are fine too).' });
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return send(res, 400, { error: `Passwords need at least ${PASSWORD_MIN} characters.` });
    if (d.users.some((u) => u.username === username)) return send(res, 400, { error: 'That username is taken.' });
    if (d.users.length >= MAX_ACCOUNTS) return send(res, 400, { error: `This HOMEFLIX already has ${MAX_ACCOUNTS} accounts.` });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt)).toString('hex');
    const first = d.users.length === 0;
    const name = username.charAt(0).toUpperCase() + username.slice(1, 20);
    const user = {
      id: crypto.randomBytes(8).toString('hex'), username, salt, hash, created: Date.now(),
      profiles: first ? legacyProfiles() : [{ id: crypto.randomBytes(6).toString('hex'), name, color: PROFILE_COLORS[0], list: [] }],
    };
    d.users.push(user);
    console.log(`New HOMEFLIX account: ${username}`);
    return startSession(res, user);
  }
  if (action === 'login') {
    const user = d.users.find((u) => u.username === username);
    // Hash even for an unknown name, so the answer takes as long either way.
    const key = await scrypt(password, user ? user.salt : DUMMY_SALT);
    const ok = !!user && password.length > 0 && crypto.timingSafeEqual(key, Buffer.from(user.hash, 'hex'));
    if (!ok) {
      loginFailed(ip);
      const next = loginWait(ip);
      return send(res, 401, { error: next ? `Wrong username or password. Wait ${next} seconds before trying again.` : 'Wrong username or password.', wait: next });
    }
    loginTries.delete(ip);
    return startSession(res, user);
  }
  return send(res, 404, { error: 'Not found' });
}

const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
// My List holds movie ids, "show:<name>" and "col:<name>".
const validListKey = (k) => typeof k === 'string' && k.length <= 120 && (/^[0-9a-f]{16}$/.test(k) || /^(?:show|col):.+/.test(k));

// The signed-in account's profiles.
async function profilesApi(req, res, parts, user) {
  const [, , pid, action] = parts;
  if (!pid && req.method === 'GET') return send(res, 200, { profiles: user.profiles, max: MAX_PROFILES, user: publicUser(user) });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  const body = await readBody(req, 4096);
  if (!pid) {
    if (user.profiles.length >= MAX_PROFILES) return send(res, 400, { error: `Up to ${MAX_PROFILES} profiles per account.` });
    const name = cleanName(body.name);
    if (!name) return send(res, 400, { error: 'Give the profile a name.' });
    if (user.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: 'There is already a profile with that name.' });
    const used = new Set(user.profiles.map((p) => p.color));
    const color = PROFILE_COLORS.includes(body.color) ? body.color : PROFILE_COLORS.find((c) => !used.has(c)) || PROFILE_COLORS[0];
    const profile = { id: crypto.randomBytes(6).toString('hex'), name, color, list: [] };
    user.profiles.push(profile);
    await saveAccounts();
    return send(res, 200, profile);
  }
  const profile = user.profiles.find((p) => p.id === pid);
  if (!profile) return send(res, 404, { error: 'No such profile.' });
  if (action === 'delete') {
    if (user.profiles.length <= 1) return send(res, 400, { error: 'Keep at least one profile.' });
    user.profiles = user.profiles.filter((p) => p !== profile);
    await saveAccounts();
    return send(res, 200, { ok: true });
  }
  if (action === 'list') {
    if (!validListKey(body.key)) return send(res, 400, { error: 'Bad item.' });
    profile.list = profile.list.filter((k) => k !== body.key);
    if (body.on) profile.list.unshift(body.key);
    profile.list = profile.list.slice(0, MAX_LIST);
    await saveAccounts();
    return send(res, 200, { list: profile.list });
  }
  if (!action) {
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (!name) return send(res, 400, { error: 'Give the profile a name.' });
      if (user.profiles.some((p) => p !== profile && p.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: 'There is already a profile with that name.' });
      profile.name = name;
    }
    if (PROFILE_COLORS.includes(body.color)) profile.color = body.color;
    await saveAccounts();
    return send(res, 200, profile);
  }
  return send(res, 404, { error: 'Not found' });
}

// ---------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const VIDEO_MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime' };

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

// Safari requires byte-range support to play (and seek) video.
async function streamFile(req, res, file, type) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return send(res, 404, { error: 'File not found' });
  }
  const size = stat.size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }
  let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
  end = Math.min(end, size - 1);
  if (start < 0 || start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.pipe(res);
  res.on('close', () => stream.destroy());
}

// ---------- who may watch ----------

// Only devices on the home network (and this computer) get in. Someone on the internet reaching the
// port — a router port-forward, a server with a public address — is turned away.
function isLocalAddress(ip) {
  ip = String(ip || '').toLowerCase().replace(/^::ffff:/, '');
  if (ip === '::1') return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip); // IPv6 private and link-local
}

// The page must be opened by address (192.168.1.20:8080, localhost) or a home name (laptop.local), not
// through some website's domain: that stops a web page on a phone from reading the library through it.
function isLocalHost(host) {
  const name = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return !name || name === 'localhost' || /^[\d.]+$/.test(name) || name.includes(':') || !name.includes('.') ||
    /\.(local|lan|home|internal|localhost|home\.arpa)$/.test(name);
}

// Optional PIN. CONFIG.pin is { salt, hash } (scrypt) or null; CONFIG.secret signs the device cookie,
// so changing or removing the PIN signs every device out.
const PIN_COOKIE = 'homeflix_key';
function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}
function deviceKey() {
  return CONFIG.pin ? crypto.createHmac('sha256', String(CONFIG.secret || '')).update(CONFIG.pin.hash).digest('hex').slice(0, 32) : null;
}
function keyFrom(req, url) {
  const cookie = /(?:^|;\s*)homeflix_key=([0-9a-f]+)/.exec(req.headers.cookie || '');
  return url.searchParams.get('k') || (cookie && cookie[1]) || '';
}
function hasKey(req, url) {
  const want = deviceKey();
  if (!want) return true;
  const got = Buffer.from(keyFrom(req, url));
  return got.length === want.length && crypto.timingSafeEqual(got, Buffer.from(want));
}

// Wrong PINs: 5 free tries, then each try waits longer (30 s, 1 min, 2 min … up to an hour).
const pinTries = new Map(); // ip -> { fails, until }
function pinWait(ip) {
  const t = pinTries.get(ip);
  return t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0;
}
function checkPin(ip, pin) {
  const t = pinTries.get(ip) || { fails: 0, until: 0 };
  const ok = /^\d{4,8}$/.test(String(pin)) && crypto.timingSafeEqual(Buffer.from(hashPin(pin, CONFIG.pin.salt).hash, 'hex'), Buffer.from(CONFIG.pin.hash, 'hex'));
  if (ok) pinTries.delete(ip);
  else {
    t.fails++;
    if (t.fails >= 5) t.until = Date.now() + Math.min(3600, 30 * 2 ** (t.fails - 5)) * 1000;
    pinTries.set(ip, t);
  }
  return ok;
}

function readBody(req, limit = 1024) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const keyCookie = (key) => `${PIN_COOKIE}=${key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;

const NOT_HOME = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HOMEFLIX</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#141414;color:#fff;font:17px/1.5 system-ui,sans-serif;text-align:center;padding:24px">
<div><h1 style="color:#e50914;letter-spacing:.04em">HOMEFLIX</h1><p>HOMEFLIX only works on the home network it runs on.<br>Connect to the same Wi-Fi as the computer and open its address again.</p></div>`;

// Returns true when the request may go on; otherwise answers it.
async function gate(req, res, url, parts) {
  const ip = req.socket.remoteAddress;
  if (!isLocalAddress(ip)) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(NOT_HOME);
    return false;
  }
  if (!isLocalHost(req.headers.host)) {
    send(res, 403, 'Open HOMEFLIX by its address, like http://192.168.1.20:8080', 'text/plain; charset=utf-8');
    return false;
  }
  if (parts[0] === 'api' && parts[1] === 'unlock' && req.method === 'POST') {
    if (!CONFIG.pin) return send(res, 200, { ok: true }), false;
    const wait = pinWait(ip);
    if (wait) return send(res, 429, { error: `Too many tries. Wait ${wait} seconds.`, wait }), false;
    const { pin } = await readBody(req);
    if (!checkPin(ip, pin)) {
      const next = pinWait(ip);
      return send(res, 401, { error: next ? `Wrong PIN. Wait ${next} seconds before trying again.` : 'Wrong PIN. Try again.', wait: next }), false;
    }
    const key = deviceKey();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': keyCookie(key) });
    res.end(JSON.stringify({ ok: true, key }));
    return false;
  }
  const ok = hasKey(req, url);
  if (parts[0] === 'api' && parts[1] === 'auth') return send(res, 200, { pin: !!CONFIG.pin, ok, signedIn: !!sessionFrom(req, url) }), false;
  // A valid ?k= (from the desktop app's "Watch on this laptop", or AirPlay) also signs this browser in.
  if (ok && CONFIG.pin && url.searchParams.has('k') && !/homeflix_key=/.test(req.headers.cookie || '')) res.setHeader('Set-Cookie', keyCookie(deviceKey()));
  // The page itself, its icons and scripts load without the PIN so it can ask for it; movies don't.
  const open = !['api', 'video', 'thumb', 'subs', 'hls', 'preview'].includes(parts[0]);
  if (open) return true;
  if (!ok) {
    send(res, 401, { error: 'PIN needed', pin: true });
    return false;
  }
  // Past the PIN, everything but signing in needs a signed-in account.
  if (parts[0] === 'api' && ['signup', 'login', 'logout', 'me'].includes(parts[1])) return true;
  const session = sessionFrom(req, url);
  if (!session) {
    send(res, 401, { error: 'Sign in first.', login: true });
    return false;
  }
  req.session = session;
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  if (!(await gate(req, res, url, parts))) return;
  // /api/<action>/<id>  or  /video|thumb|subs|hls/<id>/...
  const id = parts[0] === 'api' ? parts[2] : parts[1];
  // Unknown movie (just added, or a device resuming right after a restart): look again before giving up.
  const movieRoute = ['api', 'video', 'thumb', 'subs', 'hls', 'preview'].includes(parts[0]) && !['library', 'profiles', 'signup', 'login', 'logout', 'me'].includes(parts[1]);
  if (movieRoute && id && !library.has(id)) await scanLibrary();
  const item = library.get(id) || null;

  if (url.pathname === '/vendor/hls.min.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=86400' });
    return fs.createReadStream(require.resolve('hls.js/dist/hls.min.js')).pipe(res);
  }

  if (parts[0] === 'api') {
    if (parts[1] === 'library') return send(res, 200, (await scanLibrary()).map((m) => { const { path: _p, ...rest } = m; return { ...rest, ...languageFields(m), ...jobStatus(rest) }; }));
    if (['signup', 'login', 'logout', 'me'].includes(parts[1])) return accountsApi(req, res, parts);
    if (parts[1] === 'profiles') return profilesApi(req, res, parts, req.session.user);
    if (!item) return send(res, 404, { error: 'Unknown movie — refresh the library.' });
    const info = await probe(item);
    const audio = Math.min(audioParam(url), Math.max(0, info.audios.length - 1));
    if (parts[1] === 'info') {
      return send(res, 200, {
        ...publicItem(item), duration: info.duration, mode: info.mode, videoCodec: info.videoCodec, tenBit: info.tenBit, height: info.height,
        width: info.width, hdr: info.hdr, fourK: Math.max(info.width, (info.height * 16) / 9) >= 3200, hdrStream: await hdrStreamAvailable(info),
        audios: info.audios.map(({ n, lang, label }) => ({ n, lang, label })),
        subs: info.subs.map(({ key, lang, label }) => ({ key, lang, label })),
        ...jobStatus(item),
      });
    }
    if (parts[1] === 'prepare' && req.method === 'POST') return send(res, 200, await prepare(item, audio));
    if (parts[1] === 'status') return send(res, 200, jobStatus(item, audio));
    if (parts[1] === 'hls') {
      const st = hls.get(`${item.id}:${audio}:${url.searchParams.get('h') === '1' ? 'hdr' : qualityParam(url)}`);
      return send(res, 200, st ? { total: st.total, done: st.done.size, converting: st.jobs.length > 0, converters: st.jobs.length, encoder: st.jobs[0] ? st.jobs[0].profile : null, error: st.error } : { total: 0, done: 0, converting: false, converters: 0 });
    }
    return send(res, 404, { error: 'Not found' });
  }

  if (parts[0] === 'video' && item) {
    const info = await probe(item);
    const audio = Math.min(audioParam(url), Math.max(0, info.audios.length - 1));
    // The original file carries the first language; others come from their own copy.
    if (info.mode === 'direct' && audio === 0) return streamFile(req, res, item.path, VIDEO_MIME[path.extname(item.path).toLowerCase()] || 'video/mp4');
    if (jobStatus(item, audio).state !== 'ready') return send(res, 409, { error: 'This movie is still being prepared.' });
    if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) touch(cachedMp4(item, audio));
    return streamFile(req, res, cachedMp4(item, audio), 'video/mp4');
  }
  // /hls/<id>/index.m3u8 (first language) or /hls/<id>/<audio>/index.m3u8; segments are relative to it.
  if (parts[0] === 'hls' && item && parts[2]) {
    const info = await probe(item);
    const withAudio = /^\d+$/.test(parts[2]) && parts[3];
    const audio = withAudio ? Math.min(Number(parts[2]), Math.max(0, info.audios.length - 1)) : 0;
    const file = withAudio ? parts[3] : parts[2];
    const quality = qualityParam(url);
    // ?h=1: the 4K HDR stream, when this film has HDR and the GPU can make it; otherwise the normal stream.
    const hdr = url.searchParams.get('h') === '1' && (await hdrStreamAvailable(info));
    if (file === 'index.m3u8') return send(res, 200, hlsPlaylist(hlsState(item, info, audio, quality, hdr), CONFIG.pin && url.searchParams.get('k'), url.searchParams.has('s') && req.session.token), 'application/vnd.apple.mpegurl');
    if (file === 'init.mp4' && hdr) return hlsInit(req, res, item, audio);
    const n = /^(\d+)\.(ts|m4s)$/.exec(file);
    if (n && (n[2] === 'm4s') === hdr) return hlsSegment(req, res, item, Number(n[1]), audio, quality, hdr);
  }
  if (parts[0] === 'subs' && item && parts[2]) {
    const file = await subtitleFile(item, parts[2].replace(/\.vtt$/, ''));
    if (!file) return send(res, 404, { error: 'No such subtitle' });
    return send(res, 200, await fsp.readFile(file), 'text/vtt; charset=utf-8');
  }
  if (parts[0] === 'preview' && item) {
    if (item.downloading) return send(res, 404, { error: 'Still downloading' });
    let file;
    try {
      file = await previewClip(item);
    } catch {
      return send(res, 404, { error: 'No preview for this one' });
    }
    if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) touch(file);
    return streamFile(req, res, file, 'video/mp4');
  }
  if (parts[0] === 'thumb' && item) {
    if (item.downloading) return send(res, 404, { error: 'Still downloading' });
    const file = await thumbnail(item, url.searchParams.get('size') === 'hero');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=604800' });
    return fs.createReadStream(file).pipe(res);
  }

  // Static files from ./public
  const rel = url.pathname === '/' || parts[0] === 'watch' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, { error: 'Forbidden' });
  try {
    return send(res, 200, await fsp.readFile(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch {
    return send(res, 404, 'Not found', 'text/plain');
  }
}

function publicItem({ path: _p, ...rest }) {
  return rest;
}

// Home-network IPv4 addresses, real Wi-Fi/Ethernet first. Virtual adapters (Hyper-V, WSL, VirtualBox,
// VPNs) can't be reached from a phone, so they go last.
function lanAddresses() {
  // (utun/awdl/llw/bridge/anpi: macOS VPN, AirDrop, Wi-Fi low-latency, bridges and internal links)
  const virtual = /vEthernet|Virtual|VMware|WSL|Hyper-V|Loopback|Bluetooth|Tailscale|ZeroTier|VPN|TAP|^utun|^awdl|^llw|^bridge|^anpi|^ap\d/i;
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addrs]) => (addrs || []).map((a) => ({ name, ...a })))
    .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .sort((a, b) => virtual.test(a.name) - virtual.test(b.name) || /^192\.168\./.test(b.address) - /^192\.168\./.test(a.address))
    .map((a) => a.address);
}

// Delete prepared copies, converted streams, thumbnails and subtitles. Anything being written is left alone.
async function clearCache() {
  const busy = new Set([...hls.values()].filter((st) => st.jobs.length).map((st) => st.dir));
  let freed = 0;
  for (const entry of await fsp.readdir(CACHE_DIR, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(CACHE_DIR, entry.name);
    if (entry.name.endsWith('.part') || entry.name === 'genres.json' || busy.has(file)) continue;
    try {
      freed += entry.isDirectory() ? await dirSize(file) : (await fsp.stat(file)).size;
      await fsp.rm(file, { recursive: true, force: true });
    } catch {}
  }
  for (const [id, job] of jobs) if (job.state !== 'working') jobs.delete(id);
  for (const [id, st] of hls) if (!st.jobs.length) hls.delete(id);
  return freed;
}

function cacheSize() {
  return dirSize(CACHE_DIR);
}

let server = null;

function start() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error(`${req.method} ${req.url}: ${err.message}`);
        if (!res.headersSent) send(res, 500, { error: err.message });
        else res.destroy();
      });
    });
    server.once('error', reject);
    server.listen(CONFIG.port, '0.0.0.0', () => {
      server.off('error', reject);
      // Look at the library straight away, so languages, genres and collections are ready before anyone opens it.
      scanLibrary().catch(() => {});
      resolve(server.address().port);
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    for (const st of hls.values()) stopHls(st);
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
    server = null;
  });
}

module.exports = { configure, start, stop, scanLibrary, prettyName, lanAddresses, clearCache, cacheSize, hashPin, deviceKey, isLocalAddress, isLocalHost, VIDEO_EXT };

if (require.main === module) {
  configure(loadConfig());
  start()
    .then(async (port) => {
      const movies = await scanLibrary();
      console.log('\n  HOMEFLIX is running.\n');
      console.log(`  Library: ${movies.length} video(s) from ${CONFIG.folders.join(', ')}`);
      console.log('  On your iPad (same Wi-Fi), open Safari and go to:\n');
      for (const ip of lanAddresses()) console.log(`     http://${ip}:${port}`);
      console.log(`\n  On this laptop: http://localhost:${port}`);
      console.log('  Press Ctrl+C to stop.\n');
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') console.error(`Port ${CONFIG.port} is already in use. Is HOMEFLIX already running? Or set "port" in config.json.`);
      else console.error(err);
      process.exit(1);
    });
}
