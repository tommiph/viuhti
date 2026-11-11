'use strict';

/**
 * Polite On-Demand Wikipedia + Wikidata Knowledge Layer (lib/wiki.js).
 *
 * Resource & polling discipline:
 *  - ZERO background timers, startup prefetches, or hover requests.
 *  - Strictly lazy on-demand per user selection/expansion, with in-flight deduplication.
 *  - Strict concurrency + spacing limits honoring Wikimedia API guidelines.
 *  - In-memory LRU (max 80) + bounded persistent disk cache in data/wiki-cache/ (max 400 files).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USER_AGENT = 'Viuhti/1.0 (https://github.com/tommiph/viuhti; personal home-theater graph)';
const CACHE_DIR = path.join(__dirname, '..', 'data', 'wiki-cache');
const POS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MEM = 120;
const MAX_DISK_FILES = 700;
const PRUNE_TARGET_FILES = 600;

const memCache = new Map(); // cacheKey -> record
const inflight = new Map(); // cacheKey -> Promise
let diskWriteCount = 0;
let cooldownUntil = 0;

class PoliteLimiter {
  constructor({ maxConcurrent = 1, minGapMs = 350 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.minGapMs = minGapMs;
    this.active = 0;
    this.lastAt = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const item = this.queue.shift();
      this.active++;
      const now = Date.now();
      const wait = Math.max(0, this.lastAt + this.minGapMs - now);
      this.lastAt = now + wait;

      setTimeout(async () => {
        try {
          resolveSafe(item.resolve, await item.fn());
        } catch (err) {
          item.reject(err);
        } finally {
          this.active--;
          this._pump();
        }
      }, wait);
    }
  }
}

function resolveSafe(fn, val) {
  fn(val);
}

const wpLimiter = new PoliteLimiter({ maxConcurrent: 2, minGapMs: 160 });
const sparqlLimiter = new PoliteLimiter({ maxConcurrent: 1, minGapMs: 450 });

function hashKey(raw) {
  return crypto.createHash('sha1').update(String(raw)).digest('hex').slice(0, 24);
}

function diskPathFor(cacheKey) {
  return path.join(CACHE_DIR, `${hashKey(cacheKey)}.json`);
}

function setMem(cacheKey, data) {
  if (memCache.has(cacheKey)) memCache.delete(cacheKey);
  memCache.set(cacheKey, data);
  if (memCache.size > MAX_MEM) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
}

function isFresh(rec) {
  if (!rec || !rec.fetchedAt) return false;
  const ttl = rec.found ? POS_TTL_MS : NEG_TTL_MS;
  return Date.now() - rec.fetchedAt < ttl;
}

function readCache(cacheKey) {
  const mem = memCache.get(cacheKey);
  if (isFresh(mem)) {
    setMem(cacheKey, mem); // refresh LRU position
    return mem;
  }
  const file = diskPathFor(cacheKey);
  if (!fs.existsSync(file)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isFresh(rec)) {
      setMem(cacheKey, rec);
      return rec;
    }
  } catch {
    /* ignore corrupt cache file */
  }
  return null;
}

function pruneDiskCacheIfNeeded() {
  try {
    const names = fs.readdirSync(CACHE_DIR).filter((n) => n.endsWith('.json'));
    if (names.length <= MAX_DISK_FILES) return;
    const withMtime = names.map((n) => {
      const p = path.join(CACHE_DIR, n);
      try {
        return { p, ms: fs.statSync(p).mtimeMs };
      } catch {
        return { p, ms: 0 };
      }
    });
    withMtime.sort((a, b) => a.ms - b.ms);
    const excess = withMtime.length - PRUNE_TARGET_FILES;
    for (let i = 0; i < excess; i++) {
      try {
        fs.unlinkSync(withMtime[i].p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function writeCache(cacheKey, data) {
  const rec = { ...data, cacheKey, fetchedAt: Date.now() };
  setMem(cacheKey, rec);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = diskPathFor(cacheKey);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
    diskWriteCount++;
    if (diskWriteCount % 20 === 0) pruneDiskCacheIfNeeded();
  } catch {
    /* non-fatal cache write error */
  }
  return rec;
}

async function fetchJsonPolite(url, { accept = 'application/json', timeoutMs = 6000, limiter = wpLimiter } = {}) {
  if (Date.now() < cooldownUntil) return null;
  return limiter.run(async () => {
    if (Date.now() < cooldownUntil) return null;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after'));
        const pauseSec = Number.isFinite(ra) && ra > 0 ? Math.min(60, ra) : 15;
        cooldownUntil = Date.now() + pauseSec * 1000;
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  });
}

async function runSparql(query) {
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;
  const json = await fetchJsonPolite(url, {
    accept: 'application/sparql-results+json',
    timeoutMs: 7000,
    limiter: sparqlLimiter,
  });
  return (json && json.results && json.results.bindings) || [];
}

function qidFromUri(uri) {
  const m = String(uri || '').match(/\/(Q\d+)$/);
  return m ? m[1] : null;
}

function wikiTitleFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('wikipedia.org')) return null;
    const raw = u.pathname.replace(/^\/wiki\//, '');
    return raw ? decodeURIComponent(raw.replace(/_/g, ' ')) : null;
  } catch {
    return null;
  }
}

function splitConcat(binding, field, cap = 25) {
  const val = binding && binding[field] && binding[field].value;
  if (!val) return [];
  const out = [];
  const seen = new Set();
  for (const part of String(val).split('||')) {
    const clean = part.trim();
    if (!clean || /^Q\d+$/.test(clean) || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= cap) break;
  }
  return out;
}

function splitEntityConcat(binding, field, cap = 8) {
  const val = binding && binding[field] && binding[field].value;
  if (!val) return [];
  const out = [];
  const seen = new Set();
  for (const part of String(val).split('||')) {
    const idx = part.indexOf('::');
    if (idx === -1) continue;
    const qid = qidFromUri(part.slice(0, idx).trim());
    const name = part.slice(idx + 2).trim();
    if (!qid || !name || /^Q\d+$/.test(name)) continue;
    const key = qid;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ qid, name });
    if (out.length >= cap) break;
  }
  return out;
}

const PRESTIGE_AWARD_RE = /Academy Award|Oscar|Primetime Emmy|Emmy Award|Golden Globe|BAFTA|Palme d'Or|Cannes|Venice Film Festival|Golden Lion|Berlin|Sundance|Peabody|Hugo Award|Nebula Award|Saturn Award|Critics' Choice|Screen Actors Guild|Directors Guild|Writers Guild|British Academy|César|Goya Award|AACTA/i;

function rankAwards(list, limit = 5) {
  const uniq = [...new Set(list.filter(Boolean))];
  const total = uniq.length;
  const sorted = uniq.sort((a, b) => {
    const pa = PRESTIGE_AWARD_RE.test(a) ? 0 : 1;
    const pb = PRESTIGE_AWARD_RE.test(b) ? 0 : 1;
    return pa - pb || a.length - b.length;
  });
  return { awards: sorted.slice(0, limit), awardsTotal: total };
}

function sanitizeSparqlId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
}

async function fetchWikidataMedia({ imdbId = null, qid = null } = {}) {
  const cleanImdb = imdbId ? sanitizeSparqlId(imdbId) : '';
  const cleanQid = qid && /^Q\d+$/.test(String(qid)) ? String(qid) : '';
  if (!cleanImdb && !cleanQid) return null;

  const matchClause = cleanImdb ? `?item wdt:P345 "${cleanImdb}" .` : `VALUES ?item { wd:${cleanQid} }`;
  const sparql = `
SELECT ?item ?article
  (GROUP_CONCAT(DISTINCT ?basedOnStr; separator="||") AS ?basedOnList)
  (GROUP_CONCAT(DISTINCT ?authorStr; separator="||") AS ?authorList)
  (GROUP_CONCAT(DISTINCT ?composerStr; separator="||") AS ?composerList)
  (GROUP_CONCAT(DISTINCT ?directorStr; separator="||") AS ?directorList)
  (GROUP_CONCAT(DISTINCT ?writerStr; separator="||") AS ?writerList)
  (GROUP_CONCAT(DISTINCT ?awardLabel; separator="||") AS ?awards)
  (GROUP_CONCAT(DISTINCT ?locLabel; separator="||") AS ?locs)
  (GROUP_CONCAT(DISTINCT ?filmLocLabel; separator="||") AS ?filmLocs)
  (GROUP_CONCAT(DISTINCT ?movementLabel; separator="||") AS ?movements)
WHERE {
  ${matchClause}
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL {
    ?item wdt:P144 ?basedOn .
    ?basedOn rdfs:label ?basedOnLabel . FILTER(LANG(?basedOnLabel)="en")
    BIND(CONCAT(STR(?basedOn), "::", ?basedOnLabel) AS ?basedOnStr)
    OPTIONAL {
      ?basedOn wdt:P50 ?author .
      ?author rdfs:label ?authorLabel . FILTER(LANG(?authorLabel)="en")
      BIND(CONCAT(STR(?author), "::", ?authorLabel) AS ?authorStr)
    }
  }
  OPTIONAL {
    ?item wdt:P86 ?composer .
    ?composer rdfs:label ?composerLabel . FILTER(LANG(?composerLabel)="en")
    BIND(CONCAT(STR(?composer), "::", ?composerLabel) AS ?composerStr)
  }
  OPTIONAL {
    ?item wdt:P57 ?director .
    ?director rdfs:label ?directorLabel . FILTER(LANG(?directorLabel)="en")
    BIND(CONCAT(STR(?director), "::", ?directorLabel) AS ?directorStr)
  }
  OPTIONAL {
    ?item wdt:P58 ?writer .
    ?writer rdfs:label ?writerLabel . FILTER(LANG(?writerLabel)="en")
    BIND(CONCAT(STR(?writer), "::", ?writerLabel) AS ?writerStr)
  }
  OPTIONAL { ?item wdt:P166 ?award . ?award rdfs:label ?awardLabel . FILTER(LANG(?awardLabel)="en") }
  OPTIONAL { ?item wdt:P840 ?loc . ?loc rdfs:label ?locLabel . FILTER(LANG(?locLabel)="en") }
  OPTIONAL { ?item wdt:P915 ?filmLoc . ?filmLoc rdfs:label ?filmLocLabel . FILTER(LANG(?filmLocLabel)="en") }
  OPTIONAL { ?item wdt:P135 ?movement . ?movement rdfs:label ?movementLabel . FILTER(LANG(?movementLabel)="en") }
} GROUP BY ?item ?article LIMIT 1`;

  const rows = await runSparql(sparql);
  const b = rows[0];
  if (!b) return null;

  const { awards, awardsTotal } = rankAwards(splitConcat(b, 'awards', 40), 5);
  return {
    qid: qidFromUri(b.item && b.item.value),
    wikiUrl: (b.article && b.article.value) || null,
    wikiTitle: wikiTitleFromUrl(b.article && b.article.value),
    basedOn: splitEntityConcat(b, 'basedOnList', 4),
    authors: splitEntityConcat(b, 'authorList', 4),
    composers: splitEntityConcat(b, 'composerList', 4),
    directors: splitEntityConcat(b, 'directorList', 4),
    writers: splitEntityConcat(b, 'writerList', 4),
    awards,
    awardsTotal,
    locations: splitConcat(b, 'locs', 4),
    filmingLocations: splitConcat(b, 'filmLocs', 4),
    movements: splitConcat(b, 'movements', 3),
  };
}

async function fetchWikidataPerson(qid) {
  const cleanQid = qid && /^Q\d+$/.test(String(qid)) ? String(qid) : '';
  if (!cleanQid) return null;
  const sparql = `
SELECT ?item ?article
  (SAMPLE(YEAR(?dob)) AS ?birthYear)
  (SAMPLE(YEAR(?dod)) AS ?deathYear)
  (SAMPLE(?birthPlaceLabel) AS ?birthPlace)
  (GROUP_CONCAT(DISTINCT ?occLabel; separator="||") AS ?occupations)
  (GROUP_CONCAT(DISTINCT ?awardLabel; separator="||") AS ?awards)
WHERE {
  VALUES ?item { wd:${cleanQid} }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?item wdt:P569 ?dob . }
  OPTIONAL { ?item wdt:P570 ?dod . }
  OPTIONAL { ?item wdt:P19 ?bp . ?bp rdfs:label ?birthPlaceLabel . FILTER(LANG(?birthPlaceLabel)="en") }
  OPTIONAL { ?item wdt:P106 ?occ . ?occ rdfs:label ?occLabel . FILTER(LANG(?occLabel)="en") }
  OPTIONAL { ?item wdt:P166 ?award . ?award rdfs:label ?awardLabel . FILTER(LANG(?awardLabel)="en") }
} GROUP BY ?item ?article LIMIT 1`;

  const rows = await runSparql(sparql);
  const b = rows[0];
  if (!b) return null;
  const { awards, awardsTotal } = rankAwards(splitConcat(b, 'awards', 35), 5);
  return {
    qid: cleanQid,
    wikiUrl: (b.article && b.article.value) || null,
    wikiTitle: wikiTitleFromUrl(b.article && b.article.value),
    birthYear: b.birthYear && b.birthYear.value ? Number(b.birthYear.value) : null,
    deathYear: b.deathYear && b.deathYear.value ? Number(b.deathYear.value) : null,
    birthPlace: (b.birthPlace && b.birthPlace.value) || null,
    occupations: splitConcat(b, 'occupations', 4),
    awards,
    awardsTotal,
  };
}

async function fetchWikidataSource(qid) {
  const cleanQid = qid && /^Q\d+$/.test(String(qid)) ? String(qid) : '';
  if (!cleanQid) return null;
  const sparql = `
SELECT ?item ?article
  (SAMPLE(YEAR(?pub)) AS ?pubYear)
  (GROUP_CONCAT(DISTINCT ?authorStr; separator="||") AS ?authorList)
  (GROUP_CONCAT(DISTINCT ?genreLabel; separator="||") AS ?genres)
  (GROUP_CONCAT(DISTINCT ?awardLabel; separator="||") AS ?awards)
WHERE {
  VALUES ?item { wd:${cleanQid} }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?item wdt:P577 ?pub . }
  OPTIONAL {
    ?item wdt:P50 ?author .
    ?author rdfs:label ?authorLabel . FILTER(LANG(?authorLabel)="en")
    BIND(CONCAT(STR(?author), "::", ?authorLabel) AS ?authorStr)
  }
  OPTIONAL { ?item wdt:P136 ?genre . ?genre rdfs:label ?genreLabel . FILTER(LANG(?genreLabel)="en") }
  OPTIONAL { ?item wdt:P166 ?award . ?award rdfs:label ?awardLabel . FILTER(LANG(?awardLabel)="en") }
} GROUP BY ?item ?article LIMIT 1`;

  const rows = await runSparql(sparql);
  const b = rows[0];
  if (!b) return null;
  const { awards, awardsTotal } = rankAwards(splitConcat(b, 'awards', 30), 4);
  return {
    qid: cleanQid,
    wikiUrl: (b.article && b.article.value) || null,
    wikiTitle: wikiTitleFromUrl(b.article && b.article.value),
    pubYear: b.pubYear && b.pubYear.value ? Number(b.pubYear.value) : null,
    authors: splitEntityConcat(b, 'authorList', 4),
    sourceGenres: splitConcat(b, 'genres', 4),
    awards,
    awardsTotal,
  };
}

async function fetchWikipediaSummary(title) {
  if (!title) return null;
  const slug = encodeURIComponent(String(title).trim().replace(/ /g, '_'));
  const json = await fetchJsonPolite(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`, { timeoutMs: 5500 });
  if (!json || json.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') return null;
  return {
    wikiTitle: json.title || title,
    description: json.description || '',
    extract: json.extract || '',
    qid: json.wikibase_item || null,
    wikiUrl: (json.content_urls && json.content_urls.desktop && json.content_urls.desktop.page) || null,
    thumbnail: (json.thumbnail && json.thumbnail.source) || null,
  };
}

function buildSearchQuery({ kind, name, year }) {
  const cleanName = String(name || '').replace(/\s*\(\d{4}\)$/, '').trim();
  const y = String(year || '').slice(0, 4);
  if (kind === 'show') return `${cleanName} ${y ? y + ' ' : ''}television series`.trim();
  if (kind === 'movie') return `${cleanName} ${y ? y + ' ' : ''}film`.trim();
  if (kind === 'source') return `${cleanName} novel OR book OR comic`.trim();
  return cleanName;
}

function scoreWikiCandidate(page, { kind, name, year }) {
  const title = String(page.title || '').toLowerCase();
  const desc = String(page.description || '').toLowerCase();
  const ext = String(page.extract || '').toLowerCase();
  const target = String(name || '').replace(/\s*\(\d{4}\)$/, '').trim().toLowerCase();
  const y = String(year || '').slice(0, 4);
  let score = 0;

  if (title === target) score += 26;
  else if (title.startsWith(target + ' (')) score += 24;
  else if (title.includes(target)) score += 10;

  if (desc.includes('disambiguation')) return -100;

  if (kind === 'show') {
    if (/\b(episode of|season \d|list of .* episodes|soundtrack|character from)\b/.test(desc)) score -= 40;
    if (/\b(television series|tv series|television show|miniseries|animated series|anime series|sitcom|web television)\b/.test(desc)) score += 32;
    else if (/\btelevision series\b/.test(ext.slice(0, 180))) score += 20;
    if (y && (desc.includes(y) || title.includes(y) || ext.slice(0, 200).includes(y))) score += 12;
  } else if (kind === 'movie') {
    if (/\b(soundtrack|album|video game|novel by|franchise)\b/.test(desc)) score -= 35;
    if (/\b(film|movie)\b/.test(desc) || /\bfilm\b/.test(title)) score += 32;
    else if (/\bfilm\b/.test(ext.slice(0, 160))) score += 18;
    if (y && (desc.includes(y) || title.includes(y) || ext.slice(0, 180).includes(y))) score += 14;
  } else if (kind === 'person') {
    if (/\b(actor|actress|director|producer|screenwriter|filmmaker|writer|author|composer|showrunner|cinematographer|novelist)\b/.test(desc + ' ' + ext.slice(0, 160))) {
      score += 28;
    }
  } else if (kind === 'source') {
    if (/\b(novel|novella|short story|book|comic|manga|graphic novel|play by|story)\b/.test(desc + ' ' + ext.slice(0, 160))) {
      score += 28;
    }
  } else if (kind === 'theme') {
    if (!/\b(episode of|season \d|list of )\b/.test(desc)) score += 16;
  }

  return score - (page.index || 0) * 2;
}

async function searchWikipediaBest({ kind, name, year }) {
  const cleanName = String(name || '').replace(/\s*\(\d{4}\)$/, '').trim();
  if (!cleanName) return null;

  const queries = [buildSearchQuery({ kind, name: cleanName, year })];
  if (queries[0] !== cleanName) queries.push(cleanName);

  for (const q of queries) {
    const u =
      'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2' +
      '&generator=search&gsrsearch=' +
      encodeURIComponent(q) +
      '&gsrlimit=4&prop=pageprops|description|extracts|pageimages|info&inprop=url' +
      '&exintro=1&explaintext=1&exsentences=3&piprop=thumbnail&pithumbsize=300';
    const json = await fetchJsonPolite(u, { timeoutMs: 5500 });
    const pages = ((json && json.query && json.query.pages) || []).filter((p) => !p.missing);
    if (!pages.length) continue;

    const ranked = pages
      .map((p) => ({ page: p, score: scoreWikiCandidate(p, { kind, name: cleanName, year }) }))
      .sort((a, b) => b.score - a.score);
    const top = ranked[0];
    if (top && top.score >= 8) {
      const conf = top.score >= 48 ? 92 : top.score >= 34 ? 85 : top.score >= 22 ? 76 : 64;
      return {
        wikiTitle: top.page.title,
        description: top.page.description || '',
        extract: (top.page.extract || '').trim(),
        qid: (top.page.pageprops && top.page.pageprops.wikibase_item) || null,
        wikiUrl: top.page.canonicalurl || top.page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(String(top.page.title).replace(/ /g, '_'))}`,
        thumbnail: (top.page.thumbnail && top.page.thumbnail.source) || null,
        confidence: conf,
        matchType: 'fuzzy',
      };
    }
  }
  return null;
}

function makeDossierKey({ kind = 'show', name = '', year = '', imdbId = null, qid = null, wikiTitle = null } = {}) {
  if (qid && /^Q\d+$/.test(String(qid))) return `qid:${qid}`;
  if (imdbId && (kind === 'show' || kind === 'movie')) return `imdb:${sanitizeSparqlId(imdbId)}`;
  if (wikiTitle) return `wt:${kind}:${String(wikiTitle).trim().toLowerCase()}`;
  const cleanName = String(name || '').replace(/\s*\(\d{4}\)$/, '').trim().toLowerCase();
  const y = String(year || '').slice(0, 4);
  return `${kind}:${cleanName}${y ? `:${y}` : ''}`;
}

/** Peek strictly local cache without hitting network (instant 0ms lookup). */
function peekCachedDossier(params = {}) {
  const keys = [];
  if (params.qid && /^Q\d+$/.test(String(params.qid))) keys.push(`qid:${params.qid}`);
  if (params.imdbId && (params.kind === 'show' || params.kind === 'movie')) keys.push(`imdb:${sanitizeSparqlId(params.imdbId)}`);
  keys.push(makeDossierKey(params));
  for (const k of [...new Set(keys)]) {
    const c = readCache(k);
    if (c) return { ...c, fromCache: true };
  }
  return null;
}

/** Lazily resolve Wikipedia + Wikidata dossier for one entity, coalescing & caching cleanly. */
async function getWikiDossier(params = {}) {
  const kind = params.kind || 'show';
  const name = String(params.name || '').trim();
  const year = String(params.year || '').slice(0, 4);
  const imdbId = params.imdbId ? sanitizeSparqlId(params.imdbId) : null;
  const qid = params.qid && /^Q\d+$/.test(String(params.qid)) ? String(params.qid) : null;
  const wikiTitle = params.wikiTitle ? String(params.wikiTitle).trim() : null;

  const cached = peekCachedDossier({ kind, name, year, imdbId, qid, wikiTitle });
  if (cached) return cached;

  const primaryKey = makeDossierKey({ kind, name, year, imdbId, qid, wikiTitle });
  if (inflight.has(primaryKey)) return await inflight.get(primaryKey);

  const task = (async () => {
    let wd = null;
    let wp = null;

    // 1. Direct IMDb -> Wikidata path (exact match in 1 call!)
    if ((kind === 'show' || kind === 'movie') && imdbId) {
      wd = await fetchWikidataMedia({ imdbId });
      if (wd && wd.wikiTitle) {
        wp = await fetchWikipediaSummary(wd.wikiTitle);
      }
    } else if (qid) {
      // 2. Direct QID lookup path
      if (kind === 'person') wd = await fetchWikidataPerson(qid);
      else if (kind === 'source') wd = await fetchWikidataSource(qid);
      else if (kind === 'show' || kind === 'movie') wd = await fetchWikidataMedia({ qid });
      const titleToFetch = (wd && wd.wikiTitle) || wikiTitle || name;
      if (titleToFetch) wp = await fetchWikipediaSummary(titleToFetch);
    }

    // 3. Wikipedia title/search fallback when Wikipedia summary is still missing
    if (!wp) {
      if (wikiTitle) wp = await fetchWikipediaSummary(wikiTitle);
      if (!wp && name) wp = await searchWikipediaBest({ kind, name, year });
    }
    // 4. Populate Wikidata structured links when Wikipedia yielded a QID we don't have yet
    if (!wd && wp && wp.qid && kind !== 'theme') {
      if (kind === 'person') wd = await fetchWikidataPerson(wp.qid);
      else if (kind === 'source') wd = await fetchWikidataSource(wp.qid);
      else wd = await fetchWikidataMedia({ qid: wp.qid });
    }

    const found = Boolean((wp && (wp.extract || wp.wikiUrl)) || (wd && wd.qid));
    const matchType =
      (kind === 'show' || kind === 'movie') && imdbId && wd && wd.qid
        ? 'imdb'
        : qid || wikiTitle
        ? 'exact'
        : (wp && wp.matchType) || 'exact';
    const confidence = !found ? 0 : matchType === 'imdb' ? 99 : matchType === 'exact' ? 98 : (wp && wp.confidence) || 75;
    const dossier = {
      found,
      kind,
      matchType,
      confidence,
      qid: (wd && wd.qid) || (wp && wp.qid) || qid || null,
      wikiTitle: (wp && wp.wikiTitle) || (wd && wd.wikiTitle) || null,
      wikiUrl: (wp && wp.wikiUrl) || (wd && wd.wikiUrl) || null,
      description: (wp && wp.description) || '',
      extract: (wp && wp.extract) || '',
      thumbnail: (wp && wp.thumbnail) || null,
      basedOn: (wd && wd.basedOn) || [],
      authors: (wd && wd.authors) || [],
      composers: (wd && wd.composers) || [],
      directors: (wd && wd.directors) || [],
      writers: (wd && wd.writers) || [],
      awards: (wd && wd.awards) || [],
      awardsTotal: (wd && wd.awardsTotal) || 0,
      locations: (wd && wd.locations) || [],
      filmingLocations: (wd && wd.filmingLocations) || [],
      movements: (wd && wd.movements) || [],
      birthYear: (wd && wd.birthYear) || null,
      deathYear: (wd && wd.deathYear) || null,
      birthPlace: (wd && wd.birthPlace) || null,
      occupations: (wd && wd.occupations) || [],
      pubYear: (wd && wd.pubYear) || null,
      sourceGenres: (wd && wd.sourceGenres) || [],
    };

    const stored = writeCache(primaryKey, dossier);
    if (dossier.found) {
      if (dossier.qid && primaryKey !== `qid:${dossier.qid}`) writeCache(`qid:${dossier.qid}`, dossier);
      if (imdbId && primaryKey !== `imdb:${imdbId}`) writeCache(`imdb:${imdbId}`, dossier);
      if (name) {
        const nameKey = makeDossierKey({ kind, name, year });
        if (nameKey !== primaryKey) writeCache(nameKey, dossier);
      }
    }
    return { ...stored, fromCache: false };
  })();

  inflight.set(primaryKey, task);
  try {
    return await task;
  } finally {
    inflight.delete(primaryKey);
  }
}

const NON_SCREEN_WORK_RE = /\b(game|tabletop|role-playing|board game|video game|cancelled|abandoned|unproduced|soundtrack|album|audio drama|stage play|musical)\b/i;
const SCREEN_WORK_RE = /\b(film|movie|television|tv|miniseries|series|anime|animated|serial|special|documentary)\b/i;

function parseScreenWorks(rows, { includeRole = false } = {}) {
  const items = [];
  const seen = new Set();
  for (const r of rows || []) {
    const workQid = qidFromUri(r.work && r.work.value);
    if (!workQid || seen.has(workQid)) continue;

    const wikiUrl = (r.wikiArticle && r.wikiArticle.value) || null;
    const wikiTitle = wikiTitleFromUrl(wikiUrl);
    let name = (r.workLabel && r.workLabel.value) || '';
    if (!name || /^Q\d+$/.test(name)) {
      if (!wikiTitle) continue;
      name = wikiTitle.replace(/\s*\([^)]*(?:film|TV series|television series|miniseries|series)\)$/i, '').trim();
    }
    if (!name || /^Q\d+$/.test(name)) continue;

    const types = String((r.types && r.types.value) || '').toLowerCase();
    const imdbId = (r.imdb && r.imdb.value) || null;
    if (NON_SCREEN_WORK_RE.test(types)) continue;
    if (!imdbId && types && !SCREEN_WORK_RE.test(types)) continue;

    seen.add(workQid);
    const kindHint = /television|tv series|miniseries|anime/.test(types) ? 'show' : 'movie';
    const entry = {
      qid: workQid,
      name,
      imdbId,
      year: r.year && r.year.value ? Number(r.year.value) : null,
      wikiUrl,
      wikiTitle,
      kindHint,
    };
    if (includeRole) entry.creditRole = (r.role && r.role.value) || 'Credit';
    items.push(entry);
  }
  return items;
}

/** On-demand lookup of films/series adapted from a Wikidata source work (novel, manga, comic, etc.). */
async function fetchSourceAdaptations(qid) {
  const cleanQid = qid && /^Q\d+$/.test(String(qid)) ? String(qid) : '';
  if (!cleanQid) return [];
  const cKey = `src_adapt:${cleanQid}`;
  const cached = readCache(cKey);
  if (cached) return cached.items || [];
  if (inflight.has(cKey)) return await inflight.get(cKey);

  const task = (async () => {
    const sparql = `
SELECT DISTINCT ?work ?workLabel ?imdb
  (SAMPLE(COALESCE(YEAR(?pub), YEAR(?start))) AS ?year)
  (SAMPLE(?article) AS ?wikiArticle)
  (GROUP_CONCAT(DISTINCT ?instLabel; separator=", ") AS ?types)
WHERE {
  ?work wdt:P144 wd:${cleanQid} .
  OPTIONAL { ?work wdt:P345 ?imdb . }
  OPTIONAL { ?work wdt:P577 ?pub . }
  OPTIONAL { ?work wdt:P580 ?start . }
  OPTIONAL { ?article schema:about ?work ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?work wdt:P31 ?inst . ?inst rdfs:label ?instLabel . FILTER(LANG(?instLabel)="en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?work ?workLabel ?imdb LIMIT 20`;

    const rows = await runSparql(sparql);
    const items = parseScreenWorks(rows, { includeRole: false });
    writeCache(cKey, { found: items.length > 0, items });
    return items;
  })();

  inflight.set(cKey, task);
  try {
    return await task;
  } finally {
    inflight.delete(cKey);
  }
}

/** On-demand fallback for authors/composers via Wikidata when TVmaze/TMDB has sparse screen credits. */
async function fetchPersonWikiCredits(qid) {
  const cleanQid = qid && /^Q\d+$/.test(String(qid)) ? String(qid) : '';
  if (!cleanQid) return [];
  const cKey = `p_works:${cleanQid}`;
  const cached = readCache(cKey);
  if (cached) return cached.items || [];
  if (inflight.has(cKey)) return await inflight.get(cKey);

  const task = (async () => {
    const sparql = `
SELECT DISTINCT ?work ?workLabel ?imdb ?role
  (SAMPLE(COALESCE(YEAR(?pub), YEAR(?start))) AS ?year)
  (SAMPLE(?article) AS ?wikiArticle)
  (GROUP_CONCAT(DISTINCT ?instLabel; separator=", ") AS ?types)
WHERE {
  { ?work wdt:P86 wd:${cleanQid} . BIND("Score Composer" AS ?role) }
  UNION
  { ?src wdt:P50 wd:${cleanQid} . ?work wdt:P144 ?src . BIND("Adapted Author" AS ?role) }
  OPTIONAL { ?work wdt:P345 ?imdb . }
  OPTIONAL { ?work wdt:P577 ?pub . }
  OPTIONAL { ?work wdt:P580 ?start . }
  OPTIONAL { ?article schema:about ?work ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?work wdt:P31 ?inst . ?inst rdfs:label ?instLabel . FILTER(LANG(?instLabel)="en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?work ?workLabel ?imdb ?role LIMIT 18`;

    const rows = await runSparql(sparql);
    const items = parseScreenWorks(rows, { includeRole: true });
    writeCache(cKey, { found: items.length > 0, items });
    return items;
  })();

  inflight.set(cKey, task);
  try {
    return await task;
  } finally {
    inflight.delete(cKey);
  }
}

/** Fallback Wikidata cast query used ONLY when TVmaze & TMDB yielded 0 cast members. */
async function fetchWikidataCastFallback(qid) {
  const cleanQid = qid && /^Q\d+$/.test(String(qid)) ? String(qid) : '';
  if (!cleanQid) return [];
  const cKey = `p_cast:${cleanQid}`;
  const cached = readCache(cKey);
  if (cached) return cached.items || [];
  if (inflight.has(cKey)) return await inflight.get(cKey);

  const task = (async () => {
    const sparql = `
SELECT DISTINCT ?actor ?actorLabel ?article WHERE {
  wd:${cleanQid} wdt:P161 ?actor .
  OPTIONAL { ?article schema:about ?actor ; schema:isPartOf <https://en.wikipedia.org/> . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 12`;
    const rows = await runSparql(sparql);
    const items = [];
    const seen = new Set();
    for (const r of rows) {
      const aQid = qidFromUri(r.actor && r.actor.value);
      const wikiUrl = (r.article && r.article.value) || null;
      const wikiTitle = wikiTitleFromUrl(wikiUrl);
      let name = (r.actorLabel && r.actorLabel.value) || '';
      if (!name || /^Q\d+$/.test(name)) name = wikiTitle ? wikiTitle.replace(/\s*\([^)]*\)$/, '').trim() : '';
      if (!name || /^Q\d+$/.test(name) || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      items.push({ qid: aQid, name, role: 'Cast', wikiUrl, wikiTitle, image: null });
    }
    writeCache(cKey, { found: items.length > 0, items });
    return items;
  })();

  inflight.set(cKey, task);
  try {
    return await task;
  } finally {
    inflight.delete(cKey);
  }
}

const NON_PERSON_DESC_RE = /\b(disambiguation|municipality|commune|village in|town in|city in|river in|mountain in|studio album|song by|single by|genus of|species of|horologist|clockmaker|carpenter|footballer|cricketer|baseball|basketball|ice hockey|rugby|golfer|politician|senator|congressman|governor|bishop|archbishop)\b/i;

/**
 * Single batched Wikipedia portrait + bio lookup for up to 20 person names.
 * Reads 30-day cached entries first and only queries uncached names in ONE request.
 */
async function fetchPeoplePortraits(names = []) {
  const result = new Map(); // lowercase name -> { image, wikiDesc, wikiUrl }
  const cleanNames = [];
  const seen = new Set();
  for (const raw of names || []) {
    const n = String(raw || '').trim();
    const low = n.toLowerCase();
    if (!n || seen.has(low)) continue;
    seen.add(low);
    const c = readCache(`p_img:${low}`);
    if (c) {
      if (c.found) result.set(low, { image: c.image || null, wikiDesc: c.wikiDesc || '', wikiUrl: c.wikiUrl || null });
    } else {
      cleanNames.push(n);
    }
    if (cleanNames.length >= 20) break;
  }

  if (!cleanNames.length) return result;
  const batchKey = `batch:${cleanNames.map((n) => n.toLowerCase()).join('|')}`;
  if (inflight.has(batchKey)) {
    const shared = await inflight.get(batchKey);
    for (const [k, v] of shared) result.set(k, v);
    return result;
  }

  const task = (async () => {
    const out = new Map();
    const u =
      'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1' +
      '&titles=' +
      encodeURIComponent(cleanNames.join('|')) +
      '&prop=pageimages|description|info&inprop=url&piprop=thumbnail&pithumbsize=220';
    const json = await fetchJsonPolite(u, { timeoutMs: 5500 });
    const q = (json && json.query) || {};
    const normMap = new Map();
    for (const n of q.normalized || []) normMap.set(n.from, n.to);
    const redirMap = new Map();
    for (const r of q.redirects || []) redirMap.set(r.from, r.to);

    const byFinalTitle = new Map();
    for (const p of q.pages || []) {
      if (!p || p.missing) continue;
      const desc = String(p.description || '');
      if (NON_PERSON_DESC_RE.test(desc)) continue;
      byFinalTitle.set(p.title, {
        image: (p.thumbnail && p.thumbnail.source) || null,
        wikiDesc: desc,
        wikiUrl: p.canonicalurl || p.fullurl || null,
      });
    }

    for (const inputName of cleanNames) {
      let cur = inputName;
      if (normMap.has(cur)) cur = normMap.get(cur);
      if (redirMap.has(cur)) cur = redirMap.get(cur);
      const hit = byFinalTitle.get(cur) || null;
      const low = inputName.toLowerCase();
      if (hit) {
        writeCache(`p_img:${low}`, { found: true, ...hit });
        out.set(low, hit);
      } else {
        writeCache(`p_img:${low}`, { found: false });
      }
    }
    return out;
  })();

  inflight.set(batchKey, task);
  try {
    const fresh = await task;
    for (const [k, v] of fresh) result.set(k, v);
    return result;
  } finally {
    inflight.delete(batchKey);
  }
}

module.exports = {
  getWikiDossier,
  peekCachedDossier,
  fetchSourceAdaptations,
  fetchPersonWikiCredits,
  fetchWikidataCastFallback,
  fetchPeoplePortraits,
  makeDossierKey,
};
