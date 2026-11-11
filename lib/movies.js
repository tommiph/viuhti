'use strict';

/**
 * Movie persistence, caching & weekly TMDB discovery.
 * Mirrors lib/store.js and inherits weekly schedule + rules from lib/discovery.js
 * to automatically discover new movies released on Digital/Streaming or TV once per week.
 */

const fs = require('fs');
const path = require('path');
const tmdb = require('./tmdb');
const discovery = require('./discovery');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'movies-cache');
const MOVIES_FILE = path.join(DATA_DIR, 'movies.json');
const MOVIE_DISC_FILE = path.join(DATA_DIR, 'movies-discovery.json');
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_WEEKLY_MOVIES = 25;

fs.mkdirSync(CACHE_DIR, { recursive: true });

const tracked = new Map(); // id -> { id, source, addedAt, favorite?, extQuery? }
const cache = new Map(); // id -> { movie, fetchedAt }
const inflight = new Map();

const discState = {
  lastWeek: null,
  lastRunAt: null,
  lastBatch: [],
  excludedIds: [],
  dismissed: [],
};

const job = {
  running: false,
  total: 0,
  done: 0,
  current: null,
  added: [],
  finishedAt: null,
  error: null,
};

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function load() {
  if (fs.existsSync(MOVIES_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(MOVIES_FILE, 'utf8'));
      for (const m of data.movies || []) tracked.set(m.id, m);
    } catch (err) {
      console.error('Could not read movies.json:', err.message);
    }
  }
  for (const id of tracked.keys()) {
    const file = path.join(CACHE_DIR, `${id}.json`);
    if (fs.existsSync(file)) {
      try {
        cache.set(id, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        /* corrupted cache file */
      }
    }
  }
  if (fs.existsSync(MOVIE_DISC_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(MOVIE_DISC_FILE, 'utf8'));
      if (raw.lastWeek) discState.lastWeek = raw.lastWeek;
      if (raw.lastRunAt) discState.lastRunAt = raw.lastRunAt;
      if (Array.isArray(raw.lastBatch)) discState.lastBatch = raw.lastBatch;
      if (Array.isArray(raw.excludedIds)) discState.excludedIds = raw.excludedIds.map(Number).filter(Boolean);
      if (Array.isArray(raw.dismissed)) discState.dismissed = raw.dismissed.filter((x) => x && Number(x.id)).slice(0, 500);
    } catch (err) {
      console.error('Could not read movies-discovery.json:', err.message);
    }
  }
}

function saveTracked() {
  writeJson(MOVIES_FILE, { movies: [...tracked.values()] });
}

function saveDisc() {
  writeJson(MOVIE_DISC_FILE, discState);
}

async function fetchAndCache(id, preferFrom = null, preferTo = null) {
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const full = await tmdb.fetchMovieFull(id, preferFrom, preferTo);
    if (full) {
      cache.set(id, full);
      writeJson(path.join(CACHE_DIR, `${id}.json`), full);
    }
    return full;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

function loadCachedFromDisk(id) {
  if (cache.has(id)) return cache.get(id);
  const file = path.join(CACHE_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.set(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function addMovie(id, source = 'search', prefetched = null) {
  id = Number(id);
  if (prefetched) {
    cache.set(id, prefetched);
    writeJson(path.join(CACHE_DIR, `${id}.json`), prefetched);
  } else if (!loadCachedFromDisk(id)) {
    const full = await fetchAndCache(id);
    if (!full) throw new Error(`Movie ${id} not found on TMDB`);
  }
  if (!tracked.has(id)) {
    tracked.set(id, { id, source, addedAt: Date.now() });
    saveTracked();
  }
  unmarkExcluded(id);
  return movieSummary(id);
}

async function restoreMovie(record) {
  const id = Number(record && record.id);
  if (!id) throw new Error('Missing movie id');
  if (!loadCachedFromDisk(id)) {
    const full = await fetchAndCache(id);
    if (!full) throw new Error(`Movie ${id} not found on TMDB`);
  }
  const entry = {
    id,
    source: record.source || 'search',
    addedAt: record.addedAt || Date.now(),
    ...(record.favorite ? { favorite: true } : {}),
    ...(record.extQuery || record.tdQuery ? { extQuery: record.extQuery || record.tdQuery } : {}),
  };
  tracked.set(id, entry);
  saveTracked();
  unmarkExcluded(id);
  return movieSummary(id);
}

function snapshotForTrash(id, reason = 'removed') {
  id = Number(id);
  const t = tracked.get(id);
  const c = cache.get(id);
  if (!t) return null;
  const m = c && c.movie;
  return {
    id,
    kind: 'movie',
    name: (m && m.name) || `Movie #${id}`,
    poster: (m && m.poster) || null,
    banner: (m && m.banner) || null,
    background: (m && m.background) || null,
    logo: (m && m.logo) || null,
    channelName: (m && m.channelName) || null,
    channelKind: (m && m.releaseKind) || 'stream',
    premiered: (m && (m.airdate || m.premiered)) || null,
    status: (m && m.status) || null,
    reason,
    record: { ...t },
  };
}

function getMovieMeta(id) {
  id = Number(id);
  const t = tracked.get(id);
  const c = cache.get(id);
  if (!t && !c) return null;
  const m = c && c.movie;
  return {
    id,
    name: (m && m.name) || `Movie ${id}`,
    premiered: (m && (m.airdate || m.premiered)) || null,
    source: (m && m.channelName) || null,
    wasSource: (t && t.source) || null,
  };
}

function purgeMovieCache(id) {
  id = Number(id);
  if (!tracked.has(id)) cache.delete(id);
  fs.rm(path.join(CACHE_DIR, `${id}.json`), { force: true }, () => {});
}

function removeMovie(id, { purgeCache = false } = {}) {
  id = Number(id);
  const meta = getMovieMeta(id);
  const existed = tracked.delete(id);
  if (existed) {
    saveTracked();
    markExcluded(id, meta);
  }
  cache.delete(id);
  if (purgeCache) purgeMovieCache(id);
  return existed;
}

function setFavorite(id, favorite) {
  id = Number(id);
  const t = tracked.get(id);
  if (!t) return null;
  const next = favorite === undefined ? !t.favorite : Boolean(favorite);
  if (next) t.favorite = true;
  else delete t.favorite;
  saveTracked();
  return movieSummary(id);
}

function setExtQuery(id, extQuery) {
  id = Number(id);
  const t = tracked.get(id);
  if (!t) return null;
  const q = String(extQuery || '').trim().slice(0, 120);
  if (q) t.extQuery = q;
  else delete t.extQuery;
  delete t.tdQuery;
  saveTracked();
  return movieSummary(id);
}

function markExcluded(id, meta = null) {
  id = Number(id);
  let changed = false;
  if (!discState.excludedIds.includes(id)) {
    discState.excludedIds.push(id);
    if (discState.excludedIds.length > 500) discState.excludedIds.shift();
    changed = true;
  }
  if (meta && meta.name) {
    const entry = {
      id,
      name: String(meta.name).slice(0, 120),
      premiered: meta.premiered || null,
      source: meta.source || null,
      wasSource: meta.wasSource || null,
      dismissedAt: Date.now(),
    };
    discState.dismissed = [entry, ...discState.dismissed.filter((x) => x.id !== id)].slice(0, 500);
    changed = true;
  }
  if (changed) saveDisc();
}

function unmarkExcluded(id) {
  id = Number(id);
  const prev = discState.dismissed.find((x) => x.id === id) || null;
  const nextIds = discState.excludedIds.filter((x) => x !== id);
  const nextMeta = discState.dismissed.filter((x) => x.id !== id);
  if (nextIds.length !== discState.excludedIds.length || nextMeta.length !== discState.dismissed.length) {
    discState.excludedIds = nextIds;
    discState.dismissed = nextMeta;
    saveDisc();
  }
  return prev;
}

function clearExcluded() {
  if (!discState.excludedIds.length && !discState.dismissed.length) return;
  discState.excludedIds = [];
  discState.dismissed = [];
  saveDisc();
}

function isTracked(id) {
  return tracked.has(Number(id));
}

function movieSummary(id) {
  const t = tracked.get(id);
  const c = cache.get(id);
  if (!c) return { id, kind: 'movie', pending: true, source: t && t.source, addedAt: t && t.addedAt };
  const m = { ...c.movie };
  delete m.summary;
  delete m.posterLarge;
  return {
    ...m,
    favorite: Boolean(t && t.favorite),
    extQuery: (t && (t.extQuery || t.tdQuery)) || null,
    source: t ? t.source : null,
    addedAt: t ? t.addedAt : null,
  };
}

function getMovieDetails(id) {
  const c = cache.get(Number(id));
  if (!c || !c.movie) return null;
  return {
    summary: c.movie.summary || '',
    background: c.movie.background || null,
    posterLarge: c.movie.posterLarge || null,
  };
}

function listMovies() {
  return [...tracked.keys()].map(movieSummary);
}

function schedule(from, to) {
  const out = [];
  const now = Date.now();
  for (const [id, t] of tracked) {
    const c = cache.get(id);
    if (!c || !c.movie.airdate) continue;
    if (c.movie.airdate >= from && c.movie.airdate <= to) {
      const airMs = Date.parse(`${c.movie.airdate}T12:00:00Z`);
      const primMs = c.movie.premiered ? Date.parse(`${c.movie.premiered}T12:00:00Z`) : airMs;
      const isFreshWindow = Math.abs(now - airMs) <= 21 * 86_400_000 && airMs - primMs <= 540 * 86_400_000;
      const isNew = Boolean((t && t.source === 'auto-weekly') || isFreshWindow);
      out.push({
        id: `m-${id}`,
        movieId: id,
        kind: 'movie',
        airdate: c.movie.airdate,
        airtime: '',
        airstamp: `${c.movie.airdate}T12:00:00Z`,
        name:
          c.movie.tagline ||
          (c.movie.releaseKind === 'tv'
            ? 'TV Premiere'
            : c.movie.releaseKind === 'physical'
            ? 'Physical Media Release'
            : 'Streaming Release'),
        isNew,
      });
    }
  }
  out.sort((a, b) => a.airdate.localeCompare(b.airdate));
  return out;
}

function minPopularityForRule(minWeight) {
  if (minWeight >= 90) return 50;
  if (minWeight >= 75) return 25;
  if (minWeight >= 50) return 10;
  return 4;
}

function matchesRules(movie, rules) {
  if (rules.englishOnly && movie.language !== 'English') return false;
  if (rules.scriptedOnly && (movie.genres || []).includes('Documentary') && !(rules.genres || []).includes('Documentary')) {
    return false;
  }
  if ((movie.popularity || 0) < minPopularityForRule(rules.minWeight || 0)) return false;
  if (rules.genres && rules.genres.length > 0 && !(movie.genres || []).some((g) => rules.genres.includes(g))) return false;
  return true;
}

function shiftDate(ymd, days) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Inherit the weekly discovery cadence & rules from lib/discovery.js to add
 * new Digital/Streaming & TV movie premieres once per ISO week.
 */
function runWeeklyMovieDiscovery({ force = false } = {}) {
  const currentWeek = discovery.isoWeekKey();
  const discEnabled = discovery.getStatus().enabled;
  if (job.running) return getStatus();
  if (!tmdb.hasApiKey()) {
    job.error = force ? 'TMDB API key required — add it in Settings -> API Keys' : null;
    return getStatus();
  }
  if (!force && (!discEnabled || discState.lastWeek === currentWeek)) return getStatus();

  Object.assign(job, {
    running: true,
    total: 0,
    done: 0,
    current: 'Scanning TMDB releases…',
    added: [],
    finishedAt: null,
    error: null,
  });

  (async () => {
    try {
      const dates = discovery.weekDates(new Date(), 0, 7);
      const from = dates[0];
      const to = dates[dates.length - 1];
      const primaryCutoff = shiftDate(from, -540); // genuinely new movies (<= 18 months since primary debut)
      const rules = discovery.getRules();
      const minPop = minPopularityForRule(rules.minWeight || 0);
      const excluded = new Set(discState.excludedIds);

      const candidateMap = new Map();
      const collect = (res) => {
        for (const m of (res && res.results) || []) {
          if (tracked.has(m.id) || excluded.has(m.id) || candidateMap.has(m.id)) continue;
          if (!m.poster_path && !m.backdrop_path) continue;
          if ((m.popularity || 0) < minPop) continue;
          if (rules.englishOnly && m.original_language !== 'en') continue;
          candidateMap.set(m.id, m);
        }
      };

      for (const page of [1, 2]) {
        const res = await tmdb.discoverMovies(from, to, primaryCutoff, page, '4|6');
        collect(res);
        if (!res || page >= (res.total_pages || 1)) break;
      }
      const physRes = await tmdb.discoverMovies(from, to, primaryCutoff, 1, '5');
      collect(physRes);

      const picks = [...candidateMap.values()]
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
        .slice(0, MAX_WEEKLY_MOVIES * 2);
      job.total = picks.length;

      const added = [];
      let idx = 0;
      const worker = async () => {
        while (idx < picks.length) {
          const item = picks[idx++];
          job.current = item.title;
          try {
            if (added.length >= MAX_WEEKLY_MOVIES) {
              job.done++;
              continue;
            }
            const full = await tmdb.fetchMovieFull(item.id, from, to);
            if (!full || !full.movie.airdate || full.movie.airdate < from || full.movie.airdate > to) {
              job.done++;
              continue;
            }
            if (!matchesRules(full.movie, rules)) {
              job.done++;
              continue;
            }
            const summary = await addMovie(item.id, 'auto-weekly', full);
            const entry = {
              id: summary.id,
              name: summary.name,
              week: currentWeek,
              airdate: summary.airdate,
              source: summary.channelName,
              addedAt: Date.now(),
            };
            added.push(entry);
            job.added.push(entry);
          } catch (err) {
            console.error(`  ! movie discovery (${item.title}): ${err.message}`);
          }
          job.done++;
        }
      };
      await Promise.all([worker(), worker(), worker()]);

      discState.lastWeek = currentWeek;
      discState.lastRunAt = Date.now();
      if (added.length || !force) {
        const prevSameWeek = discState.lastBatch.filter((x) => x.week === currentWeek);
        discState.lastBatch = force ? [...added, ...prevSameWeek] : added;
      }
      saveDisc();
      console.log(`Weekly movie discovery (${currentWeek}): added ${added.length} new movie(s)`);
    } catch (err) {
      job.error = err.message;
      console.error('Weekly movie discovery failed:', err.message);
    } finally {
      job.running = false;
      job.current = null;
      job.finishedAt = Date.now();
    }
  })();

  return getStatus();
}

async function refreshStale() {
  const now = Date.now();
  const todo = [...tracked.keys()].filter((id) => {
    const c = cache.get(id);
    return !c || now - c.fetchedAt > MAX_AGE;
  });
  for (const id of todo.slice(0, 10)) {
    try {
      await fetchAndCache(id);
    } catch { /* retry next cycle */ }
  }
}

function getStatus() {
  return {
    running: job.running,
    total: job.total,
    done: job.done,
    current: job.current,
    added: job.added,
    finishedAt: job.finishedAt,
    currentWeek: discovery.isoWeekKey(),
    lastWeek: discState.lastWeek,
    lastRunAt: discState.lastRunAt,
    lastBatch: discState.lastBatch,
    dismissed: discState.dismissed,
    count: tracked.size,
    error: job.error,
  };
}

module.exports = {
  load,
  hasSavedList: () => fs.existsSync(MOVIES_FILE),
  addMovie,
  restoreMovie,
  removeMovie,
  purgeMovieCache,
  snapshotForTrash,
  getMovieDetails,
  getMovieMeta,
  unmarkExcluded,
  clearExcluded,
  setFavorite,
  setExtQuery,
  isTracked,
  listMovies,
  schedule,
  runWeeklyMovieDiscovery,
  refreshStale,
  getStatus,
  count: () => tracked.size,
};
