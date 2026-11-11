'use strict';

/**
 * Persistence + caching layer.
 *  - data/shows.json         : the list of tracked shows (id, source, addedAt)
 *  - data/cache/<id>.json    : cached TVmaze show record incl. episodes and branding
 * Shows are refreshed when TVmaze reports an update (via /updates/shows) or the cache is stale.
 */

const fs = require('fs');
const path = require('path');
const tvmaze = require('./tvmaze');
const hidden = require('./hidden');
const watched = require('./watched');
const digest = require('./digest');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MAX_AGE = 24 * 60 * 60 * 1000; // hard refresh after 24h even without update notice

fs.mkdirSync(CACHE_DIR, { recursive: true });

const tracked = new Map(); // id -> { id, source, addedAt }
const cache = new Map(); // id -> { show, episodes, fetchedAt }
const inflight = new Map(); // id -> Promise
const VALID_STYLES = new Set([
  'midnight',
  'bistro',
  'airport',
  'cinema',
  'newspaper',
  'blueprint',
  'swiss',
  'cyber',
  'botanical',
  'popart',
]);
const normalizeStyle = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return VALID_STYLES.has(s) ? s : 'midnight';
};
const settings = {
  extSearchUrl: '',
  interests: [],
  tmdbApiKey: '',
  tvmazeApiKey: '',
  installDate: '',
  style: 'midnight',
  showHidden: false,
  hideWatched: false,
  notifyBrowser: false,
  webhookUrl: '',
};

const sync = { running: false, total: 0, done: 0, lastSync: null, error: null };

const maskKey = (k) => (k && k.length > 4 ? `${'•'.repeat(Math.min(8, k.length - 4))}${k.slice(-4)}` : k ? '••••' : '');
const normalizeHttpUrl = (v, label = 'URL') => {
  const s = String(v || '').trim().slice(0, 500);
  if (!s) return '';
  if (!/^https?:\/\/.+/i.test(s)) throw new Error(`${label} must start with http:// or https://`);
  return s;
};
const getTmdbApiKey = () => settings.tmdbApiKey || (process.env.TMDB_API_KEY || '').trim();
const getTvmazeApiKey = () => settings.tvmazeApiKey || (process.env.TVMAZE_API_KEY || '').trim();

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function compactRecord(raw) {
  if (!raw || !raw.show) return null;
  const s = { ...raw.show };
  delete s.summary;
  delete s.background;
  delete s.posterLarge;
  const episodes = (raw.episodes || []).map((e) => ({
    id: e.id,
    season: e.season,
    number: e.number,
    name: e.name,
    type: e.type,
    airdate: e.airdate,
    airtime: e.airtime,
    airstamp: e.airstamp,
    runtime: e.runtime,
    ...(e.summary && /(season|series) finale/i.test(e.summary) ? { finaleHint: 1 } : {}),
  }));
  return { show: s, episodes, fetchedAt: raw.fetchedAt || Date.now() };
}

function load() {
  if (fs.existsSync(SHOWS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
      for (const s of data.shows || []) tracked.set(s.id, s);
    } catch (err) {
      console.error('Could not read shows.json:', err.message);
    }
  }
  for (const id of tracked.keys()) {
    const file = path.join(CACHE_DIR, `${id}.json`);
    if (fs.existsSync(file)) {
      try {
        const c = compactRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (c) cache.set(id, c);
      } catch {
        /* corrupted cache file, will be refetched */
      }
    }
  }
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const rawExtUrl = typeof raw.extSearchUrl === 'string' ? raw.extSearchUrl.trim() : '';
      if (rawExtUrl && /^https?:\/\/.+/i.test(rawExtUrl)) settings.extSearchUrl = rawExtUrl.slice(0, 500);
      if (Array.isArray(raw.interests)) {
        settings.interests = [...new Set(raw.interests.map((g) => String(g || '').trim()).filter(Boolean))].slice(0, 40);
      }
      if (typeof raw.tmdbApiKey === 'string') settings.tmdbApiKey = raw.tmdbApiKey.trim().slice(0, 256);
      if (typeof raw.tvmazeApiKey === 'string') settings.tvmazeApiKey = raw.tvmazeApiKey.trim().slice(0, 256);
      if (typeof raw.installDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.installDate)) settings.installDate = raw.installDate;
      if (typeof raw.style === 'string') settings.style = normalizeStyle(raw.style);
      if (typeof raw.showHidden === 'boolean') settings.showHidden = raw.showHidden;
      if (typeof raw.hideWatched === 'boolean') settings.hideWatched = raw.hideWatched;
      if (typeof raw.notifyBrowser === 'boolean') settings.notifyBrowser = raw.notifyBrowser;
      const rawWebhook = typeof raw.webhookUrl === 'string' ? raw.webhookUrl.trim() : '';
      if (rawWebhook && /^https?:\/\/.+/i.test(rawWebhook)) settings.webhookUrl = rawWebhook.slice(0, 500);
    } catch {
      /* ignore corrupt settings */
    }
  }
}

function getSettings() {
  const tmdbKey = getTmdbApiKey();
  const tvmazeKey = getTvmazeApiKey();
  return {
    extSearchUrl: settings.extSearchUrl,
    interests: [...settings.interests],
    installDate: settings.installDate || null,
    style: settings.style || 'midnight',
    showHidden: Boolean(settings.showHidden),
    hideWatched: Boolean(settings.hideWatched),
    notifyBrowser: Boolean(settings.notifyBrowser),
    webhookUrl: settings.webhookUrl,
    apiKeys: {
      tmdb: Boolean(tmdbKey),
      tmdbHint: maskKey(tmdbKey),
      tmdbFromEnv: Boolean(!settings.tmdbApiKey && process.env.TMDB_API_KEY),
      tvmaze: Boolean(tvmazeKey),
      tvmazeHint: maskKey(tvmazeKey),
      tvmazeFromEnv: Boolean(!settings.tvmazeApiKey && process.env.TVMAZE_API_KEY),
    },
  };
}

function saveSettings(patch = {}) {
  if (patch.extSearchUrl !== undefined) settings.extSearchUrl = normalizeHttpUrl(patch.extSearchUrl, 'External Search URL');
  if (Array.isArray(patch.interests)) {
    settings.interests = [...new Set(patch.interests.map((g) => String(g || '').trim()).filter(Boolean))].slice(0, 40);
  }
  if (patch.tmdbApiKey !== undefined) settings.tmdbApiKey = String(patch.tmdbApiKey || '').trim().slice(0, 256);
  if (patch.tvmazeApiKey !== undefined) settings.tvmazeApiKey = String(patch.tvmazeApiKey || '').trim().slice(0, 256);
  if (typeof patch.installDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.installDate)) {
    settings.installDate = patch.installDate;
  }
  if (patch.style !== undefined) settings.style = normalizeStyle(patch.style);
  if (patch.showHidden !== undefined) settings.showHidden = Boolean(patch.showHidden);
  if (patch.hideWatched !== undefined) settings.hideWatched = Boolean(patch.hideWatched);
  if (patch.notifyBrowser !== undefined) settings.notifyBrowser = Boolean(patch.notifyBrowser);
  if (patch.webhookUrl !== undefined) settings.webhookUrl = normalizeHttpUrl(patch.webhookUrl, 'Webhook URL');
  writeJson(SETTINGS_FILE, settings);
  return getSettings();
}

function hasSavedList() {
  return fs.existsSync(SHOWS_FILE);
}

function saveTracked() {
  writeJson(SHOWS_FILE, { shows: [...tracked.values()] });
}

async function fetchAndCache(id) {
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const full = await tvmaze.fetchShowFull(id);
    if (full) {
      cache.set(id, compactRecord(full));
      writeJson(path.join(CACHE_DIR, `${id}.json`), full);
    }
    return cache.get(id) || full;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

function loadCachedFromDisk(id) {
  if (cache.has(id)) return cache.get(id);
  const file = path.join(CACHE_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = compactRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (parsed) cache.set(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Add a show to the calendar. `prefetched` lets the importer reuse an already-downloaded record. */
async function addShow(id, source = 'search', prefetched = null, alias = null) {
  id = Number(id);
  const isAuto = source === 'auto-weekly' || source === 'auto-bimonthly' || source === 'discovery';
  if (isAuto && hidden.has('show', id)) return null;
  if (!isAuto) hidden.remove('show', id);
  if (prefetched) {
    cache.set(id, compactRecord(prefetched));
    writeJson(path.join(CACHE_DIR, `${id}.json`), prefetched);
  } else if (!loadCachedFromDisk(id)) {
    const full = await fetchAndCache(id);
    if (!full) throw new Error(`Show ${id} not found on TVmaze`);
  }
  const existing = tracked.get(id);
  if (!existing) {
    tracked.set(id, { id, source, addedAt: Date.now(), ...(alias ? { alias } : {}) });
    saveTracked();
  } else if (alias && existing.alias !== alias) {
    existing.alias = alias;
    saveTracked();
  }
  return showSummary(id);
}

/** Bulk-import pre-assembled show records with a single shows.json write. */
function addShowsBulk(records, source = 'onboarding') {
  let added = 0;
  const now = Date.now();
  const isAuto = source === 'auto-weekly' || source === 'auto-bimonthly' || source === 'discovery';
  for (const rec of records || []) {
    if (!rec || !rec.show || !rec.show.id) continue;
    const id = Number(rec.show.id);
    if (isAuto && hidden.has('show', id)) continue;
    if (!isAuto) hidden.remove('show', id);
    const full = { show: rec.show, episodes: rec.episodes || [], fetchedAt: rec.fetchedAt || now };
    cache.set(id, compactRecord(full));
    writeJson(path.join(CACHE_DIR, `${id}.json`), full);
    if (!tracked.has(id)) {
      tracked.set(id, { id, source, addedAt: now });
      added++;
    }
  }
  if (added) saveTracked();
  return added;
}

async function restoreShow(record) {
  const id = Number(record && record.id);
  if (!id) throw new Error('Missing show id');
  if (!loadCachedFromDisk(id)) {
    const full = await fetchAndCache(id);
    if (!full) throw new Error(`Show ${id} not found on TVmaze`);
  }
  const entry = {
    id,
    source: record.source || 'search',
    addedAt: record.addedAt || Date.now(),
    ...(record.favorite ? { favorite: true } : {}),
    ...(record.extQuery || record.tdQuery ? { extQuery: record.extQuery || record.tdQuery } : {}),
    ...(record.alias ? { alias: record.alias } : {}),
  };
  tracked.set(id, entry);
  saveTracked();
  return showSummary(id);
}

function snapshotForHidden(id, reason = 'hidden') {
  id = Number(id);
  const t = tracked.get(id);
  const c = cache.get(id) || loadCachedFromDisk(id);
  if (!t) return null;
  const s = c && c.show;
  const ch = s && (s.network || s.webChannel);
  return {
    id,
    kind: 'show',
    name: (t && t.alias) || (s && s.name) || `Show #${id}`,
    poster: (s && s.poster) || null,
    banner: (s && s.banner) || null,
    background: (s && s.background) || null,
    logo: (s && s.logo) || null,
    channelName: (ch && ch.name) || null,
    channelKind: s && s.webChannel && !s.network ? 'stream' : 'tv',
    premiered: (s && s.premiered) || null,
    status: (s && s.status) || null,
    reason,
    record: { ...t },
  };
}

function getShowMeta(id) {
  id = Number(id);
  const t = tracked.get(id);
  const c = cache.get(id);
  if (!t && !c) return null;
  const s = c && c.show;
  const ch = s && (s.network || s.webChannel);
  return {
    id,
    name: (t && t.alias) || (s && s.name) || `Show ${id}`,
    premiered: (s && s.premiered) || null,
    source: (ch && ch.name) || null,
    wasSource: (t && t.source) || null,
  };
}

function purgeShowCache(id) {
  id = Number(id);
  if (!tracked.has(id)) cache.delete(id);
  fs.rm(path.join(CACHE_DIR, `${id}.json`), { force: true }, () => {});
}

function removeShow(id, { purgeCache = false } = {}) {
  id = Number(id);
  const existed = tracked.delete(id);
  if (existed) saveTracked();
  if (purgeCache) {
    cache.delete(id);
    purgeShowCache(id);
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
    return showSummary(id);
  }
  if (hidden.has('show', id)) {
    const updated = hidden.updateRecord('show', id, (rec) => {
      const next = favorite === undefined ? !rec.favorite : Boolean(favorite);
      if (next) rec.favorite = true;
      else delete rec.favorite;
      return rec;
    });
    return showSummary(id, updated && updated.record, true);
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
    return showSummary(id);
  }
  if (hidden.has('show', id)) {
    const updated = hidden.updateRecord('show', id, (rec) => {
      if (q) rec.extQuery = q;
      else delete rec.extQuery;
      delete rec.tdQuery;
      return rec;
    });
    return showSummary(id, updated && updated.record, true);
  }
  return null;
}

function isTracked(id) {
  return tracked.has(Number(id));
}

function getCached(id) {
  return cache.get(Number(id)) || null;
}

function listTrackedCached() {
  const out = [];
  for (const [id, t] of tracked) {
    const c = cache.get(id);
    if (c) out.push({ id, tracked: t, full: c });
  }
  return out;
}

function nextEpisode(episodes, now = Date.now()) {
  for (const e of episodes) {
    if (e.airstamp && Date.parse(e.airstamp) >= now - 3 * 60 * 60 * 1000) return e;
  }
  return null;
}

function lastEpisode(episodes, now = Date.now()) {
  for (let i = episodes.length - 1; i >= 0; i--) {
    const e = episodes[i];
    if (e.airstamp && Date.parse(e.airstamp) < now) return e;
  }
  return null;
}

function showSummary(id, recordOverride = null, isHidden = false) {
  const t = recordOverride || tracked.get(id);
  const c = cache.get(id) || (isHidden ? loadCachedFromDisk(id) : null);
  if (!c) {
    if (isHidden) {
      const h = hidden.find('show', id);
      if (h) {
        return {
          id,
          name: h.name,
          poster: h.poster || null,
          banner: h.banner || null,
          logo: h.logo || null,
          network: h.channelKind === 'tv' && h.channelName ? { name: h.channelName } : null,
          webChannel: h.channelKind !== 'tv' && h.channelName ? { name: h.channelName } : null,
          genres: [],
          premiered: h.premiered || null,
          status: h.status || null,
          favorite: Boolean(t && t.favorite),
          extQuery: (t && (t.extQuery || t.tdQuery)) || null,
          hidden: true,
        };
      }
    }
    return { id, pending: true, source: t && t.source, addedAt: t && t.addedAt, hidden: Boolean(isHidden) };
  }
  const now = Date.now();
  const next = nextEpisode(c.episodes, now);
  const last = lastEpisode(c.episodes, now);
  const useAlias = t && t.alias && t.alias !== c.show.name;
  return {
    ...c.show,
    ...(useAlias ? { name: t.alias, originalName: c.show.name } : {}),
    favorite: Boolean(t && t.favorite),
    extQuery: (t && (t.extQuery || t.tdQuery)) || null,
    source: t ? t.source : null,
    addedAt: t ? t.addedAt : null,
    hidden: Boolean(isHidden),
    nextEpisode: next ? { season: next.season, number: next.number, name: next.name, airstamp: next.airstamp, airdate: next.airdate } : null,
    lastEpisode: last ? { season: last.season, number: last.number, name: last.name, airstamp: last.airstamp, airdate: last.airdate } : null,
  };
}

function getShowDetails(id, epId = null) {
  id = Number(id);
  const file = path.join(CACHE_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const full = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ep = epId ? (full.episodes || []).find((e) => e.id === Number(epId)) : null;
    return {
      summary: (full.show && full.show.summary) || '',
      background: (full.show && full.show.background) || null,
      posterLarge: (full.show && full.show.posterLarge) || null,
      episodeSummary: (ep && ep.summary) || '',
      episodeUrl: (ep && ep.url) || null,
    };
  } catch {
    return null;
  }
}

function listShows({ includeHidden = false } = {}) {
  const out = [...tracked.keys()].map((id) => showSummary(id, null, false));
  if (includeHidden) {
    for (const id of hidden.listIds('show')) {
      if (tracked.has(id)) continue;
      const h = hidden.find('show', id);
      out.push(showSummary(id, (h && h.record) || { id }, true));
    }
  }
  return out;
}

const ROLLING_TYPES = new Set(['Talk Show', 'News', 'Sports', 'Game Show', 'Panel Show', 'Variety']);

function finaleMapForShow(c, todayYmd) {
  const finales = new Map();
  const byS = new Map();
  for (const e of c.episodes) {
    if (e.season == null || e.number == null || e.type === 'insignificant_special') continue;
    if (!byS.has(e.season)) byS.set(e.season, []);
    byS.get(e.season).push(e);
  }
  const seasons = [...byS.keys()].sort((a, b) => a - b);
  const maxS = seasons[seasons.length - 1] || 0;
  const isRolling = ROLLING_TYPES.has(c.show.type);
  const webStreaming = Boolean(c.show.webChannel && !c.show.network);

  for (const s of seasons) {
    const seps = byS.get(s);
    if (seps.length < 2) continue;
    const maxN = Math.max(...seps.map((e) => e.number));
    const last = seps.find((e) => e.number === maxN);
    if (!last || !last.name || /^TBA$/i.test(last.name.trim())) continue;

    const hasNextS = s < maxS;
    const isEndedMax = c.show.status === 'Ended' && s === maxS;
    const prevS = seasons.filter((x) => x < s).pop();
    const prevCount = prevS ? byS.get(prevS).length : 0;
    const titleHint = /\b(finale|the final)\b/i.test(last.name) || Boolean(last.finaleHint) || /(season|series) finale/i.test(last.summary || '');
    const horizonCut =
      last.airdate &&
      last.airdate > todayYmd &&
      prevCount > 0 &&
      seps.length < Math.max(prevCount - 2, Math.floor(prevCount * 0.75));

    const confirmed =
      isEndedMax ||
      hasNextS ||
      titleHint ||
      (!isRolling &&
        s < 1900 &&
        !horizonCut &&
        ((last.airdate && last.airdate <= todayYmd) || webStreaming || (prevCount > 0 && seps.length >= prevCount - 1) || seps.length >= 6));
    if (confirmed) finales.set(last.id, isEndedMax ? 'series' : 'season');
  }
  return finales;
}

/** Episodes of calendar shows whose (network) airdate falls inside [from, to] (YYYY-MM-DD, inclusive). */
function schedule(from, to, { withSummaries = false, includeHidden = false } = {}) {
  const out = [];
  const todayYmd = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const entries = [...tracked.entries()].map(([id, t]) => ({ id, t, isHidden: false }));
  if (includeHidden) {
    for (const id of hidden.listIds('show')) {
      if (tracked.has(id)) continue;
      const h = hidden.find('show', id);
      entries.push({ id, t: (h && h.record) || { id }, isHidden: true });
    }
  }
  for (const { id, t, isHidden } of entries) {
    const c = cache.get(id) || (isHidden ? loadCachedFromDisk(id) : null);
    if (!c) continue;
    const hasWindowEp = c.episodes.some((e) => e.airdate && e.airdate >= from && e.airdate <= to);
    if (!hasWindowEp) continue;
    let showSummaryText = '';
    let epSummaryById = null;
    if (withSummaries) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${id}.json`), 'utf8'));
        showSummaryText = (raw.show && raw.show.summary) || '';
        epSummaryById = new Map((raw.episodes || []).map((ep) => [ep.id, ep.summary || '']));
      } catch {
        showSummaryText = '';
      }
    }
    const finales =
      c._finalesDate === todayYmd && c._finales
        ? c._finales
        : ((c._finalesDate = todayYmd), (c._finales = finaleMapForShow(c, todayYmd)));
    const primMs = c.show.premiered ? Date.parse(`${c.show.premiered}T12:00:00Z`) : NaN;
    for (const e of c.episodes) {
      if (!e.airdate || e.airdate < from || e.airdate > to) continue;
      const premiere = e.number === 1 && e.season != null ? (e.season === 1 ? 'series' : 'season') : null;
      const finale = finales.get(e.id) || null;
      const special = e.type === 'significant_special' || (e.season != null && e.number == null);
      const diffPrem = Number.isFinite(primMs) ? (Date.parse(`${e.airdate}T12:00:00Z`) - primMs) / 86_400_000 : NaN;
      const isNew = Boolean(
        e.season === 1 &&
          ((Number.isFinite(diffPrem) && diffPrem >= -1 && diffPrem <= 21) ||
            (t && (t.source === 'auto-weekly' || t.source === 'auto-bimonthly') && t.addedAt && now - t.addedAt <= 21 * 86_400_000))
      );
      out.push({
        showId: id,
        id: e.id,
        season: e.season,
        number: e.number,
        name: e.name,
        type: e.type,
        airdate: e.airdate,
        airtime: e.airtime,
        airstamp: e.airstamp,
        runtime: e.runtime,
        premiere,
        finale,
        special,
        isNew,
        hidden: isHidden,
        watched: watched.has('episode', e.id),
        ...(withSummaries
          ? { summary: (epSummaryById && epSummaryById.get(e.id)) || '', showSummary: showSummaryText }
          : {}),
      });
    }
  }
  out.sort((a, b) => String(a.airstamp).localeCompare(String(b.airstamp)));
  return out;
}

async function runPool(items, worker, concurrency = 4) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await worker(item);
      } catch (err) {
        console.error(`  ! ${err.message}`);
      }
    }
  });
  await Promise.all(runners);
}

/** Refresh missing, stale or TVmaze-updated shows. */
async function refresh({ force = false } = {}) {
  if (sync.running) return;
  sync.running = true;
  sync.error = null;
  try {
    let updates = {};
    try {
      updates = await tvmaze.fetchUpdates('day');
    } catch (err) {
      console.error('Could not fetch TVmaze updates:', err.message);
    }
    const now = Date.now();
    const todo = [...tracked.keys()].filter((id) => {
      const c = cache.get(id);
      if (force || !c) return true;
      if (now - c.fetchedAt > MAX_AGE) return true;
      return updates[id] && updates[id] > (c.show.updated || 0);
    });
    if (settings.showHidden) {
      for (const id of hidden.listIds('show')) {
        if (tracked.has(id) || !updates[id]) continue;
        const c = loadCachedFromDisk(id);
        if (c && updates[id] > (c.show.updated || 0)) todo.push(id);
      }
    }
    sync.total = todo.length;
    sync.done = 0;
    if (todo.length) console.log(`Refreshing ${todo.length} show(s) from TVmaze...`);
    await runPool(todo, async (id) => {
      if (!tracked.has(id) && !(settings.showHidden && hidden.has('show', id))) {
        sync.done++;
        return;
      }
      const prev = cache.get(id);
      const next = await fetchAndCache(id);
      if (prev && next && tracked.has(id)) {
        const prevById = new Map((prev.episodes || []).map((e) => [e.id, e]));
        const todayYmd = new Date().toISOString().slice(0, 10);
        let addedEps = 0;
        let shiftedEps = 0;
        for (const ep of next.episodes || []) {
          if (!ep.airdate || ep.airdate < todayYmd) continue;
          const old = prevById.get(ep.id);
          if (!old) addedEps++;
          else if (old.airdate !== ep.airdate) shiftedEps++;
        }
        if (addedEps > 0 || shiftedEps > 0) {
          digest.record({
            kind: 'show',
            itemId: id,
            event: 'updated',
            title: next.show.name,
            detail: addedEps
              ? `${addedEps} new upcoming episode${addedEps === 1 ? '' : 's'} scheduled`
              : 'Upcoming airdate updated on TVmaze',
          });
        }
      }
      sync.done++;
    });
    sync.lastSync = Date.now();
  } catch (err) {
    sync.error = err.message;
  } finally {
    sync.running = false;
  }
}

function exportBackup({ includeKeys = false } = {}) {
  const exportedSettings = { ...settings };
  if (!includeKeys) {
    delete exportedSettings.tmdbApiKey;
    delete exportedSettings.tvmazeApiKey;
    delete exportedSettings.webhookUrl;
  }
  return {
    shows: [...tracked.values()],
    settings: exportedSettings,
  };
}

function importBackup({ shows, settings: importedSettings } = {}, { replace = false } = {}) {
  if (Array.isArray(shows)) {
    if (replace) tracked.clear();
    for (const s of shows) {
      const id = Number(s && s.id);
      if (!id) continue;
      tracked.set(id, { ...s, id });
      loadCachedFromDisk(id);
    }
    saveTracked();
  }
  if (importedSettings && typeof importedSettings === 'object') {
    const patch = {
      ...(importedSettings.extSearchUrl !== undefined ? { extSearchUrl: importedSettings.extSearchUrl } : {}),
      ...(Array.isArray(importedSettings.interests) ? { interests: importedSettings.interests } : {}),
      ...(importedSettings.installDate ? { installDate: importedSettings.installDate } : {}),
      ...(importedSettings.style ? { style: importedSettings.style } : {}),
      ...(typeof importedSettings.showHidden === 'boolean' ? { showHidden: importedSettings.showHidden } : {}),
      ...(typeof importedSettings.hideWatched === 'boolean' ? { hideWatched: importedSettings.hideWatched } : {}),
      ...(typeof importedSettings.notifyBrowser === 'boolean' ? { notifyBrowser: importedSettings.notifyBrowser } : {}),
      ...(typeof importedSettings.tmdbApiKey === 'string' && importedSettings.tmdbApiKey.trim()
        ? { tmdbApiKey: importedSettings.tmdbApiKey }
        : {}),
      ...(typeof importedSettings.tvmazeApiKey === 'string' && importedSettings.tvmazeApiKey.trim()
        ? { tvmazeApiKey: importedSettings.tvmazeApiKey }
        : {}),
      ...(typeof importedSettings.webhookUrl === 'string' && importedSettings.webhookUrl.trim()
        ? { webhookUrl: importedSettings.webhookUrl }
        : {}),
    };
    saveSettings(patch);
  }
  return tracked.size;
}

module.exports = {
  CACHE_DIR,
  load,
  hasSavedList,
  addShow,
  addShowsBulk,
  restoreShow,
  removeShow,
  purgeShowCache,
  snapshotForHidden,
  getShowMeta,
  setFavorite,
  setExtQuery,
  getSettings,
  saveSettings,
  exportBackup,
  importBackup,
  getTmdbApiKey,
  getTvmazeApiKey,
  isTracked,
  activeIds: () => new Set(tracked.keys()),
  loadCachedFromDisk,
  getCached,
  getShowDetails,
  listTrackedCached,
  listShows,
  schedule,
  refresh,
  sync,
  activeCount: () => tracked.size,
  trackedCount: () => tracked.size,
};
