'use strict';
// Looks up each movie's genres online (Wikidata, no API key needed) and caches the answer on disk,
// so every title is asked about once. Lookups run quietly in the background, one at a time.
// Only the cleaned-up title and year are sent, never file paths. Turn off with "genreLookup": false.
const https = require('https');
const fs = require('fs');
const path = require('path');

const RETRY_MISSES_AFTER = 7 * 864e5; // titles with no answer are tried again after a week
const GAP_MS = 1200; // pause between lookups, to be polite to the service
const LOOKUP_VERSION = 6; // bump when the matching improves, so earlier misses are tried again

let file = null;
let cache = {};
let loaded = false;
const queue = [];
const queued = new Set();
let running = false;
let onChange = () => {};

function init(cacheDir, changed) {
  file = path.join(cacheDir, 'genres.json');
  if (changed) onChange = changed;
  if (loaded) return;
  loaded = true;
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cache = {};
  }
}
function save() {
  if (file) fs.writeFile(file, JSON.stringify(cache), () => {});
}
const keyFor = (title, year) => `${title.toLowerCase().replace(/\s+/g, ' ').trim()}|${year || ''}`;

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'HOMEFLIX/1.4 (home media server)', Accept: 'application/json' }, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const api = (params) => 'https://www.wikidata.org/w/api.php?format=json&origin=*&' + new URLSearchParams(params);

// "horror film" -> "Horror", "science fiction film" -> "Science Fiction"
function tidy(label) {
  const t = label.replace(/\s+(?:films?|movies?)$/i, '').replace(/^(?:feature|live-action)\s+/i, '').trim();
  return t.replace(/\b\w/g, (c) => c.toUpperCase());
}
const SKIP = /^(film|movie|fiction|feature|color|colour|sound|silent|short|b|television|tv)$/i;

const values = (claims, prop) => (claims[prop] || []).map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value).filter(Boolean);
const yearsOf = (claims) => values(claims, 'P577').map((v) => +String(v.time).slice(1, 5)).filter(Boolean);

// Film, animated film, animated feature film, documentary film, 3D film, live-action/animated film.
const FILM_TYPES = ['Q11424', 'Q202866', 'Q29168811', 'Q93204', 'Q229390', 'Q25110269'].map((q) => 'P31=' + q).join('|');

async function lookup(title, year) {
  // Search only items that are films, so "Dune" finds the movies, not the novel or the landform.
  const found = await getJson(api({ action: 'query', list: 'search', srsearch: `${title} haswbstatement:${FILM_TYPES}`, srnamespace: '0', srlimit: '10' }));
  let qids = ((found.query || {}).search || []).map((h) => h.title).filter((t) => /^Q\d+$/.test(t));
  if (!qids.length) {
    // Fallback: plain search, keeping items described as films.
    const plain = await getJson(api({ action: 'wbsearchentities', search: title, language: 'en', type: 'item', limit: '20' }));
    qids = (plain.search || []).filter((h) => /\bfilm\b|\bmovie\b/i.test(h.description || '') && !/\b(series|television|album|soundtrack|novel|game)\b/i.test(h.description || '')).map((h) => h.id);
  }
  if (!qids.length) return { genres: [], collection: null, language: null };
  const ent = await getJson(api({ action: 'wbgetentities', ids: qids.slice(0, 20).join('|'), props: 'claims|labels|aliases', languages: 'en' }));
  const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(title);
  const films = qids
    .map((q) => (ent.entities || {})[q])
    .filter((e) => e && e.claims && values(e.claims, 'P136').length)
    .map((e) => ({ claims: e.claims, exact: [e.labels && e.labels.en, ...((e.aliases && e.aliases.en) || [])].some((l) => l && norm(l.value) === want) }));
  // Exact title matches first (keeps search order otherwise).
  films.sort((a, b) => b.exact - a.exact);
  // With a year, it must match the release year (a year off allows for festival vs. cinema dates);
  // without one, only an exact title match is trusted.
  const y = +year;
  const pick = y
    ? films.find((f) => yearsOf(f.claims).includes(y)) || films.find((f) => yearsOf(f.claims).some((x) => Math.abs(x - y) === 1))
    : films.find((f) => f.exact);
  if (!pick) return { genres: [], collection: null, language: null };
  const ids = [...new Set(values(pick.claims, 'P136').map((v) => v.id).filter(Boolean))];
  // "part of the series" (P179): Dune and Dune: Part Two are both in "Dune (film series)".
  const series = values(pick.claims, 'P179').map((v) => v.id).filter(Boolean)[0] || null;
  // "original language of film" (P364): what an untagged single audio track is most likely in.
  const lang = values(pick.claims, 'P364').map((v) => v.id).filter(Boolean)[0] || null;
  const all = [...ids, series, lang].filter(Boolean);
  if (!all.length) return { genres: [], collection: null, language: null };
  const labels = await getJson(api({ action: 'wbgetentities', ids: all.join('|'), props: 'labels', languages: 'en' }));
  const label = (id) => { const l = ((labels.entities || {})[id] || {}).labels; return l && l.en && l.en.value; };
  const out = [];
  for (const id of ids) {
    const name = label(id) && tidy(label(id));
    if (name && !SKIP.test(name) && !out.includes(name)) out.push(name);
  }
  const language = lang && label(lang) ? label(lang).replace(/\s+language$/i, '').replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  return { genres: out.slice(0, 12), collection: series ? collectionName(label(series)) : null, language };
}
// "Dune (film series)" -> "Dune", "Mission: Impossible film series" -> "Mission: Impossible"
function collectionName(label) {
  if (!label) return null;
  const t = label.replace(/\s*\((?:film )?(?:series|franchise|trilogy|saga)\)\s*$/i, '').replace(/\s+(?:film|movie)\s+(?:series|franchise)$/i, '').trim();
  return t || null;
}

async function work() {
  if (running) return;
  running = true;
  while (queue.length) {
    const { title, year } = queue.shift();
    const key = keyFor(title, year);
    queued.delete(key);
    try {
      // Leftover site tags the name cleaner misses: "www 1TamilMV solar - Dorothy" -> "Dorothy"
      const query = title.replace(/^www\b[^-]*-\s*/i, '').trim() || title;
      // One retry after a pause covers brief network hiccups and rate limits.
      const found = await lookup(query, year).catch(() => new Promise((r) => setTimeout(r, 5000)).then(() => lookup(query, year)));
      cache[key] = { genres: found.genres, collection: found.collection, language: found.language, at: Date.now(), v: LOOKUP_VERSION };
      save();
      onChange();
    } catch {
      // Offline or rate-limited: stop for now; the next library scan queues the rest again.
      queue.length = 0;
      queued.clear();
      break;
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  running = false;
}

// Wikidata's genres are very specific ("Neo-Noir", "Ghost", "Science Fiction Action"); fold them into
// familiar categories so the home screen gets a handful of useful rows instead of dozens of tiny ones.
const BROAD = [
  ['Action', /action|martial arts|superhero|swashbuckler|wuxia|spy|heist/i],
  ['Adventure', /adventure|swashbuckler|epic/i],
  ['Animation', /anim|anime|cartoon/i],
  ['Comedy', /comed|parody|satir|slapstick/i],
  ['Crime', /crime|gangster|heist|noir|mafia|police|detective/i],
  ['Documentary', /documentar/i],
  ['Drama', /drama|melodrama/i],
  ['Family', /family|children|kids/i],
  ['Fantasy', /fantasy|fairy|sword and sorcery/i],
  ['History', /histor|biograph|biopic|period/i],
  ['Horror', /horror|slasher|zombie|ghost|vampire|supernatural|monster/i],
  ['Music', /music|musical|dance/i],
  ['Mystery', /myster|whodunit|detective/i],
  ['Romance', /roman/i],
  ['Science Fiction', /science fiction|sci-fi|cyberpunk|dystopi|space|time travel|alien/i],
  ['Thriller', /thriller|suspense|psychological|noir/i],
  ['War', /war\b|military/i],
  ['Western', /western/i],
  ['Sports', /sport/i],
];
function broad(list) {
  // Rank by how many of the specific genres point at a category, then by how early the first one is listed.
  const scored = [];
  for (const [name, re] of BROAD) {
    const hits = list.map((g, i) => (re.test(g) ? i : -1)).filter((i) => i >= 0);
    if (hits.length) scored.push({ name, n: hits.length, first: hits[0] });
  }
  return scored.sort((a, b) => b.n - a.n || a.first - b.first).slice(0, 3).map((s) => s.name);
}
// Cached genres for an item right now (empty until the lookup finishes).
function genresFor(title, year) {
  const hit = cache[keyFor(title, year)];
  return hit ? broad(hit.genres) : [];
}
// The film series it belongs to, if Wikidata knows one.
function collectionFor(title, year) {
  const hit = cache[keyFor(title, year)];
  return (hit && hit.collection) || null;
}
// The film's original language, if Wikidata knows it ("English", "Tamil").
function languageFor(title, year) {
  const hit = cache[keyFor(title, year)];
  return (hit && hit.language) || null;
}
// Queue any titles we haven't looked up (or didn't find) yet. Episodes are skipped: their file names are show names.
function request(items) {
  let added = false;
  for (const { title, year } of items) {
    if (!title || /\bS\d{1,2}\s*E\d{1,3}\b|\b\d{1,2}x\d{2}\b/i.test(title)) continue;
    const key = keyFor(title, year);
    const hit = cache[key];
    // Answers from an older, weaker lookup are redone once (the old genres show until then); misses are retried weekly.
    if (queued.has(key) || (hit && hit.v === LOOKUP_VERSION && (hit.genres.length || Date.now() - hit.at < RETRY_MISSES_AFTER))) continue;
    queued.add(key);
    queue.push({ title, year });
    added = true;
  }
  if (added) work();
}

module.exports = { init, genresFor, collectionFor, languageFor, request, lookup };
