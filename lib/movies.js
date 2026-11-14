'use strict';

/**
 * Movie persistence, caching & twice-monthly TMDB sync.
 * Mirrors lib/store.js and inherits twice-monthly schedule + rules from lib/discovery.js
 * to automatically discover new Digital/Streaming, Physical & TV movie releases looking 2 weeks ahead,
 * while strictly skipping hidden movies.
 */

const fs = require('fs');
const path = require('path');
const tmdb = require('./tmdb');
const discovery = require('./discovery');
const hidden = require('./hidden');
const watched = require('./watched');
const digest = require('./digest');
const wordpool = require('./wordpool');
const wiki = require('./wiki');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'movies-cache');
const MOVIES_FILE = path.join(DATA_DIR, 'movies.json');
const MOVIE_DISC_FILE = path.join(DATA_DIR, 'movies-discovery.json');
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_SYNC_MOVIES = 50;

fs.mkdirSync(CACHE_DIR, { recursive: true });

const tracked = new Map(); // id -> { id, source, addedAt, favorite?, extQuery? }
const cache = new Map(); // id -> { movie, fetchedAt }
const inflight = new Map();

const discState = {
  lastPeriod: null,
  lastRunAt: null,
  lastBatch: [],
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
      if (raw.lastPeriod) {
        discState.lastPeriod = raw.lastPeriod;
      } else if (raw.lastRunAt) {
        discState.lastPeriod = discovery.halfMonthKey(new Date(raw.lastRunAt));
      }
      if (raw.lastRunAt) discState.lastRunAt = raw.lastRunAt;
      if (Array.isArray(raw.lastBatch)) discState.lastBatch = raw.lastBatch;
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
  const isAuto = source === 'auto-weekly' || source === 'auto-bimonthly' || source === 'discovery';
  if (isAuto && hidden.has('movie', id)) return null;
  if (!isAuto) hidden.remove('movie', id);

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
  return movieSummary(id);
}

function snapshotForHidden(id, reason = 'hidden') {
  id = Number(id);
  const t = tracked.get(id);
  const c = cache.get(id) || loadCachedFromDisk(id);
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
  const existed = tracked.delete(id);
  if (existed) saveTracked();
  if (purgeCache) {
    cache.delete(id);
    purgeMovieCache(id);
  }
  return existed;
}

function setFavorite(id, favorite) {
  id = Number(id);
  const t = tracked.get(id);
  if (t) {
    const next = favorite === undefined ? !t.favorite : Boolean(favorite);
    if (next) t.favorite = true;
    else delete t.favorite;
    saveTracked();
    return movieSummary(id);
  }
  if (hidden.has('movie', id)) {
    const updated = hidden.updateRecord('movie', id, (rec) => {
      const next = favorite === undefined ? !rec.favorite : Boolean(favorite);
      if (next) rec.favorite = true;
      else delete rec.favorite;
      return rec;
    });
    return movieSummary(id, updated && updated.record, true);
  }
  return null;
}

function setExtQuery(id, extQuery) {
  id = Number(id);
  const q = String(extQuery || '').trim().slice(0, 120);
  const t = tracked.get(id);
  if (t) {
    if (q) t.extQuery = q;
    else delete t.extQuery;
    delete t.tdQuery;
    saveTracked();
    return movieSummary(id);
  }
  if (hidden.has('movie', id)) {
    const updated = hidden.updateRecord('movie', id, (rec) => {
      if (q) rec.extQuery = q;
      else delete rec.extQuery;
      delete rec.tdQuery;
      return rec;
    });
    return movieSummary(id, updated && updated.record, true);
  }
  return null;
}

function isTracked(id) {
  return tracked.has(Number(id));
}

function movieSummary(id, recordOverride = null, isHidden = false) {
  const t = recordOverride || tracked.get(id);
  const c = cache.get(id) || (isHidden ? loadCachedFromDisk(id) : null);
  if (!c) {
    if (isHidden) {
      const h = hidden.find('movie', id);
      if (h) {
        return {
          id,
          kind: 'movie',
          name: h.name,
          poster: h.poster || null,
          banner: h.banner || null,
          logo: h.logo || null,
          channelName: h.channelName || null,
          releaseKind: h.channelKind || 'stream',
          genres: [],
          premiered: h.premiered || null,
          airdate: h.premiered || null,
          status: h.status || null,
          favorite: Boolean(t && t.favorite),
          extQuery: (t && (t.extQuery || t.tdQuery)) || null,
          hidden: true,
        };
      }
    }
    return { id, kind: 'movie', pending: true, source: t && t.source, addedAt: t && t.addedAt, hidden: Boolean(isHidden) };
  }
  const m = { ...c.movie };
  delete m.summary;
  delete m.posterLarge;
  return {
    ...m,
    favorite: Boolean(t && t.favorite),
    extQuery: (t && (t.extQuery || t.tdQuery)) || null,
    source: t ? t.source : null,
    addedAt: t ? t.addedAt : null,
    hidden: Boolean(isHidden),
    watched: watched.has('movie', id),
  };
}

function getMovieDetails(id) {
  const c = cache.get(Number(id)) || loadCachedFromDisk(Number(id));
  if (!c || !c.movie) return null;
  return {
    summary: c.movie.summary || '',
    background: c.movie.background || null,
    posterLarge: c.movie.posterLarge || null,
  };
}

function listMovies({ includeHidden = false } = {}) {
  const out = [...tracked.keys()].map((id) => movieSummary(id, null, false));
  if (includeHidden) {
    for (const id of hidden.listIds('movie')) {
      if (tracked.has(id)) continue;
      const h = hidden.find('movie', id);
      out.push(movieSummary(id, (h && h.record) || { id }, true));
    }
  }
  return out;
}

function schedule(from, to, { withSummaries = false, includeHidden = false } = {}) {
  const out = [];
  const now = Date.now();
  const entries = [...tracked.entries()].map(([id, t]) => ({ id, t, isHidden: false }));
  if (includeHidden) {
    for (const id of hidden.listIds('movie')) {
      if (tracked.has(id)) continue;
      const h = hidden.find('movie', id);
      entries.push({ id, t: (h && h.record) || { id }, isHidden: true });
    }
  }
  for (const { id, t, isHidden } of entries) {
    const c = cache.get(id) || (isHidden ? loadCachedFromDisk(id) : null);
    if (!c || !c.movie || !c.movie.airdate) continue;
    if (c.movie.airdate >= from && c.movie.airdate <= to) {
      const airMs = Date.parse(`${c.movie.airdate}T12:00:00Z`);
      const primMs = c.movie.premiered ? Date.parse(`${c.movie.premiered}T12:00:00Z`) : airMs;
      const isFreshWindow = Math.abs(now - airMs) <= 21 * 86_400_000 && airMs - primMs <= 540 * 86_400_000;
      const isNew = Boolean(
        isFreshWindow || ((t && (t.source === 'auto-weekly' || t.source === 'auto-bimonthly')) && t.addedAt && now - t.addedAt <= 21 * 86_400_000)
      );
      const det = withSummaries ? getMovieDetails(id) : null;
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
        hidden: isHidden,
        watched: watched.has('movie', id),
        ...(withSummaries ? { summary: (det && det.summary) || '' } : {}),
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

function movieHasPrimaryOverride(movie) {
  if (!wordpool.hasActiveEntries() || !movie) return false;
  const wikiDossier = wiki.peekCachedDossier({
    kind: 'movie',
    name: movie.name || movie.title,
    year: String(movie.premiered || movie.release_date || '').slice(0, 4),
    imdbId: movie.imdbId || null,
  });
  return wordpool.matchItem(
    {
      name: movie.name || movie.title,
      summary: movie.summary || movie.overview || '',
      genres: movie.genres || [],
      keywords: movie.keywords || [],
      cast: movie.cast || [],
      creators: movie.creators || movie.crew || [],
      studios: movie.studios || [],
      language: movie.language || '',
    },
    { wikiDossier }
  ).primary;
}

function matchesRules(movie, rules, langs) {
  if (movieHasPrimaryOverride(movie)) return true;
  if (langs.length > 0 && !langs.includes(movie.language || 'Unknown')) return false;
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
 * Inherit the twice-monthly sync cadence & rules from lib/discovery.js to add
 * new Digital/Streaming, Physical & TV movie releases looking two weeks ahead,
 * skipping anything already in Hidden.
 */
function runBiMonthlySync({ force = false } = {}) {
  const currentPeriod = discovery.halfMonthKey();
  const discEnabled = discovery.getStatus().enabled;
  if (job.running) return getStatus();
  if (!tmdb.hasApiKey()) {
    job.error = force ? 'TMDB API key required — add it in Control Center -> Sync & API Keys' : null;
    return getStatus();
  }
  if (!force && (!discEnabled || !discovery.isPeriodDue(discState.lastPeriod))) return getStatus();

  Object.assign(job, {
    running: true,
    total: 0,
    done: 0,
    current: 'Scanning TMDB releases (next 2 weeks)…',
    added: [],
    finishedAt: null,
    error: null,
  });

  (async () => {
    try {
      const dates = discovery.forwardDates(new Date(), 15);
      const from = dates[0];
      const to = dates[dates.length - 1];
      const primaryCutoff = shiftDate(from, -540);
      const rules = discovery.getRules();
      const langs = discovery.activeLanguages();
      const minPop = minPopularityForRule(rules.minWeight || 0);

      const candidateMap = new Map();
      const collect = (res) => {
        for (const m of (res && res.results) || []) {
          if (tracked.has(m.id) || hidden.has('movie', m.id) || candidateMap.has(m.id)) continue;
          if (!m.poster_path && !m.backdrop_path) continue;
          const isPrimary = movieHasPrimaryOverride({ name: m.title, summary: m.overview || '', release_date: m.release_date });
          if (!isPrimary) {
            if ((m.popularity || 0) < minPop) continue;
            const mappedLang = (tmdb.LANG_NAMES && tmdb.LANG_NAMES[m.original_language]) || m.original_language || 'Unknown';
            if (langs.length > 0 && tmdb.LANG_NAMES[m.original_language] && !langs.includes(mappedLang)) continue;
          }
          candidateMap.set(m.id, m);
        }
      };

      for (const page of [1, 2, 3]) {
        const res = await tmdb.discoverMovies(from, to, primaryCutoff, page, '4|6');
        collect(res);
        if (!res || page >= (res.total_pages || 1)) break;
      }
      const physRes = await tmdb.discoverMovies(from, to, primaryCutoff, 1, '5');
      collect(physRes);

      const picks = [...candidateMap.values()]
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
        .slice(0, MAX_SYNC_MOVIES * 2);
      job.total = picks.length;

      const added = [];
      let idx = 0;
      const worker = async () => {
        while (idx < picks.length) {
          const item = picks[idx++];
          job.current = item.title;
          try {
            if (added.length >= MAX_SYNC_MOVIES || hidden.has('movie', item.id)) {
              job.done++;
              continue;
            }
            const full = await tmdb.fetchMovieFull(item.id, from, to);
            if (!full || !full.movie.airdate || full.movie.airdate < from || full.movie.airdate > to) {
              job.done++;
              continue;
            }
            if (!matchesRules(full.movie, rules, langs)) {
              job.done++;
              continue;
            }
            const summary = await addMovie(item.id, 'auto-bimonthly', full);
            if (!summary) {
              job.done++;
              continue;
            }
            const entry = {
              id: summary.id,
              name: summary.name,
              period: currentPeriod,
              airdate: summary.airdate,
              source: summary.channelName,
              addedAt: Date.now(),
            };
            added.push(entry);
            job.added.push(entry);
            digest.record({
              kind: 'movie',
              itemId: summary.id,
              event: 'added',
              title: summary.name,
              detail: summary.channelName ? `${summary.channelName} (${summary.airdate || 'upcoming'})` : 'Added by TMDB sync',
            });
          } catch (err) {
            console.error(`  ! movie sync (${item.title}): ${err.message}`);
          }
          job.done++;
        }
      };
      await Promise.all([worker(), worker(), worker()]);

      discState.lastPeriod = currentPeriod;
      discState.lastRunAt = Date.now();
      if (added.length || !force) {
        const prevSamePeriod = discState.lastBatch.filter((x) => x.period === currentPeriod);
        discState.lastBatch = force ? [...added, ...prevSamePeriod] : added;
      }
      saveDisc();
      console.log(`TMDB bi-monthly movie sync (${currentPeriod}, ${from}..${to}): added ${added.length} movie(s)`);
    } catch (err) {
      job.error = err.message;
      console.error('TMDB movie sync failed:', err.message);
    } finally {
      job.running = false;
      job.current = null;
      job.finishedAt = Date.now();
    }
  })();

  return getStatus();
}

async function refreshStale({ force = false } = {}) {
  const now = Date.now();
  const todo = [...tracked.keys()].filter((id) => {
    const c = cache.get(id);
    return force || !c || now - c.fetchedAt > MAX_AGE;
  });
  for (const id of force ? todo : todo.slice(0, 15)) {
    try {
      await fetchAndCache(id);
    } catch {
      /* retry next cycle */
    }
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
    currentPeriod: discovery.halfMonthKey(),
    lastPeriod: discState.lastPeriod,
    lastRunAt: discState.lastRunAt,
    lastBatch: discState.lastBatch,
    count: tracked.size,
    error: job.error,
  };
}

function exportMovies() {
  return [...tracked.values()];
}

function importMovies(list, { replace = false } = {}) {
  if (!Array.isArray(list)) return tracked.size;
  if (replace) tracked.clear();
  for (const m of list) {
    const id = Number(m && m.id);
    if (!id) continue;
    tracked.set(id, { ...m, id });
    loadCachedFromDisk(id);
  }
  saveTracked();
  return tracked.size;
}

module.exports = {
  CACHE_DIR,
  load,
  hasSavedList: () => fs.existsSync(MOVIES_FILE),
  addMovie,
  restoreMovie,
  removeMovie,
  purgeMovieCache,
  snapshotForHidden,
  getMovieDetails,
  getMovieMeta,
  setFavorite,
  setExtQuery,
  isTracked,
  activeIds: () => new Set(tracked.keys()),
  listMovies,
  schedule,
  runBiMonthlySync,
  runWeeklyMovieDiscovery: runBiMonthlySync,
  refreshStale,
  exportMovies,
  importMovies,
  getStatus,
  activeCount: () => tracked.size,
  count: () => tracked.size,
};
