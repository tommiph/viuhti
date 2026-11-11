'use strict';

/**
 * Viuhti — Visual Itinerary for Ultimate Home Theater Immersion.
 *   node server.js            -> starts on the first free port from 4280 upward
 *   PORT=5000 node server.js  -> starts on the first free port from 5000 upward
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const store = require('./lib/store');
const tvmaze = require('./lib/tvmaze');
const tmdb = require('./lib/tmdb');
const discovery = require('./lib/discovery');
const movies = require('./lib/movies');
const hidden = require('./lib/hidden');
const watched = require('./lib/watched');
const digest = require('./lib/digest');
const alerts = require('./lib/alerts');
const recommender = require('./lib/recommender');
const galaxy = require('./lib/galaxy');
const wiki = require('./lib/wiki');

tmdb.setKeyProvider(() => store.getTmdbApiKey());

const HOST = process.env.HOST || '0.0.0.0';
const START_PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 4280;
const PUBLIC_DIR = path.join(__dirname, 'public');
const REFRESH_INTERVAL = 60 * 60 * 1000; // check TVmaze for updates hourly

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendResponse(req, res, status, contentType, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-store' };
  const ae = (req && req.headers && req.headers['accept-encoding']) || '';
  if (buf.length > 1024 && /\bgzip\b/.test(ae)) {
    zlib.gzip(buf, (err, gz) => {
      if (err) {
        res.writeHead(status, headers).end(buf);
        return;
      }
      res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }).end(gz);
    });
    return;
  }
  res.writeHead(status, headers).end(buf);
}

function sendJson(res, status, data, req = null) {
  sendResponse(req, res, status, MIME['.json'], JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    sendResponse(req, res, 200, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', buf);
  });
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const fmtYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayYmd = () => fmtYmd(new Date());
const mondayYmd = (base = new Date()) => {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return fmtYmd(d);
};
const addDaysYmd = (ymdStr, n) => {
  const [y, m, d] = ymdStr.split('-').map(Number);
  return fmtYmd(new Date(y, m - 1, d + n));
};
const addMonthsYmd = (ymdStr, months = 2) => {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const idx = m - 1 + months;
  const ty = y + Math.floor(idx / 12);
  const tm = idx % 12;
  const maxD = new Date(ty, tm + 1, 0).getDate();
  return fmtYmd(new Date(ty, tm, Math.min(d, maxD)));
};

const searchCache = new Map(); // q -> { at, data }
let onboardingCatalog = null; // { at, fromDate, toDate, installDate, list, byId, genres }

async function getForwardCatalog() {
  const savedInstall = store.getSettings && store.getSettings().installDate;
  const installDate = savedInstall || todayYmd();
  const fromDate = mondayYmd(new Date(installDate + 'T12:00:00'));
  const toDate = addMonthsYmd(fromDate, 2);
  if (onboardingCatalog && Date.now() - onboardingCatalog.at < 10 * 60 * 1000 && onboardingCatalog.fromDate === fromDate && onboardingCatalog.toDate === toDate) {
    return onboardingCatalog;
  }
  const fullList = (await tvmaze.fetchFullSchedule()) || [];
  let minFullDate = todayYmd();
  for (const e of fullList) {
    if (e && e.airdate && e.airdate < minFullDate) minFullDate = e.airdate;
  }
  const extraItems = [];
  if (fromDate < minFullDate) {
    for (let d = fromDate; d < minFullDate; d = addDaysYmd(d, 1)) {
      const [web, tv] = await Promise.all([tvmaze.fetchSchedule(d, true), tvmaze.fetchSchedule(d, false)]);
      extraItems.push(...web, ...tv);
    }
  }

  const byId = new Map();
  const seenEp = new Set();
  for (const e of [...extraItems, ...fullList]) {
    if (!e || !e.id || seenEp.has(e.id)) continue;
    if (!e.airdate || e.airdate < fromDate || e.airdate > toDate) continue;
    if (e.type === 'insignificant_special') continue;
    const s = (e._embedded && e._embedded.show) || e.show;
    if (!s || !s.id) continue;
    seenEp.add(e.id);
    let bucket = byId.get(s.id);
    if (!bucket) {
      bucket = { rawShow: s, episodes: [] };
      byId.set(s.id, bucket);
    }
    bucket.episodes.push(tvmaze.slimEpisode(e));
  }
  const gc = new Map();
  const lc = new Map();
  const list = [...byId.values()];
  for (const item of list) {
    item.episodes.sort((a, b) => (a.airdate || '').localeCompare(b.airdate || '') || (a.airstamp || '').localeCompare(b.airstamp || ''));
    for (const g of item.rawShow.genres || []) gc.set(g, (gc.get(g) || 0) + 1);
    const lang = item.rawShow.language || 'Unknown';
    lc.set(lang, (lc.get(lang) || 0) + 1);
  }
  list.sort((a, b) => (b.rawShow.weight || 0) - (a.rawShow.weight || 0) || a.rawShow.name.localeCompare(b.rawShow.name));
  const genres = [...gc.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const languages = [...lc.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name === 'Unknown' ? 1 : b.name === 'Unknown' ? -1 : b.count - a.count || a.name.localeCompare(b.name)));
  onboardingCatalog = { at: Date.now(), fromDate, toDate, installDate, list, byId, genres, languages };
  return onboardingCatalog;
}

function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function icsUtcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildIcsFeed({ media = 'both', favoritesOnly = false } = {}) {
  const from = addDaysYmd(todayYmd(), -7);
  const to = addDaysYmd(todayYmd(), 60);
  const dtStamp = icsUtcStamp(Date.now());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Viuhti//TV & Movie Release Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Viuhti Calendar',
  ];

  const pushAllDay = (uid, ymdStr, summary, desc, categories) => {
    const startD = ymdStr.replace(/-/g, '');
    const endD = addDaysYmd(ymdStr, 1).replace(/-/g, '');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtStamp}`);
    lines.push(`DTSTART;VALUE=DATE:${startD}`);
    lines.push(`DTEND;VALUE=DATE:${endD}`);
    lines.push(`SUMMARY:${icsEscape(summary)}`);
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    if (categories) lines.push(`CATEGORIES:${icsEscape(categories)}`);
    lines.push('END:VEVENT');
  };

  if (media !== 'movies') {
    const showById = new Map(store.listShows().map((s) => [s.id, s]));
    for (const e of store.schedule(from, to)) {
      const s = showById.get(e.showId);
      if (!s || (favoritesOnly && !s.favorite)) continue;
      const code = `S${String(e.season).padStart(2, '0')}E${e.number == null ? 'SP' : String(e.number).padStart(2, '0')}`;
      const summary = `${s.name} · ${code}${e.name ? ` — ${e.name}` : ''}`;
      const ch = (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || '';
      const desc = [
        e.virtual ? `Director's Choice (Orig ${e.originYear || ''})` : '',
        ch ? `Channel: ${ch}` : '',
        (s.genres || []).join(', '),
      ]
        .filter(Boolean)
        .join(' · ');
      const cats = [e.premiere === 'series' ? 'Series Premiere' : e.premiere === 'season' ? 'Season Premiere' : '', ...(s.genres || [])]
        .filter(Boolean)
        .join(',');
      if (e.airtime && e.airstamp && Number.isFinite(Date.parse(e.airstamp))) {
        const startMs = Date.parse(e.airstamp);
        const endMs = startMs + Math.max(15, Number(e.runtime) || Number(s.runtime) || 45) * 60_000;
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:viuhti-ep-${e.id}@viuhti.local`);
        lines.push(`DTSTAMP:${dtStamp}`);
        lines.push(`DTSTART:${icsUtcStamp(startMs)}`);
        lines.push(`DTEND:${icsUtcStamp(endMs)}`);
        lines.push(`SUMMARY:${icsEscape(summary)}`);
        if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
        if (cats) lines.push(`CATEGORIES:${icsEscape(cats)}`);
        lines.push('END:VEVENT');
      } else {
        pushAllDay(`viuhti-ep-${e.id}@viuhti.local`, e.airdate, summary, desc, cats);
      }
    }
  }

  if (media !== 'shows') {
    const movieById = new Map(movies.listMovies().map((m) => [m.id, m]));
    for (const me of movies.schedule(from, to)) {
      const m = movieById.get(me.movieId);
      if (!m || (favoritesOnly && !m.favorite)) continue;
      const yr = (m.premiered || m.airdate || '').slice(0, 4);
      const summary = `${m.name}${yr ? ` (${yr})` : ''} — ${me.name}`;
      const desc = [m.channelName ? `Platform: ${m.channelName}` : '', (m.genres || []).join(', ')].filter(Boolean).join(' · ');
      pushAllDay(`viuhti-movie-${m.id}@viuhti.local`, me.airdate, summary, desc, (m.genres || []).join(','));
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function lanUrls(port) {
  if (HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost') return [];
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const ips = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|Loopback|VirtualBox|VMware/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        ips.push({ ip: a.address, name, priv: isPrivate(a.address) });
      }
    }
  }
  ips.sort((a, b) => Number(b.priv) - Number(a.priv));
  return ips.map((x) => `http://${x.ip}:${port}`);
}

const shouldIncludeHidden = (sp) =>
  sp.has('includeHidden') ? sp.get('includeHidden') === '1' : Boolean(store.getSettings().showHidden);

function hideShowById(id, fallbackMeta = null) {
  const meta = store.getShowMeta(id) || fallbackMeta || { id, name: `Show #${id}` };
  const snap = store.snapshotForHidden(id, 'hidden');
  const ok = store.removeShow(id);
  if (snap) hidden.add(snap);
  else if (!hidden.has('show', id)) {
    hidden.add({ id, kind: 'show', name: meta.name, premiered: meta.premiered || null });
  }
  return { ok, id, name: meta.name };
}

function hideMovieById(id, fallbackMeta = null) {
  const meta = movies.getMovieMeta(id) || fallbackMeta || { id, name: `Movie #${id}` };
  const snap = movies.snapshotForHidden(id, 'hidden');
  const ok = movies.removeMovie(id);
  if (snap) hidden.add(snap);
  else if (!hidden.has('movie', id)) {
    hidden.add({ id, kind: 'movie', name: meta.name, premiered: meta.premiered || null });
  }
  return { ok, id, name: meta.name };
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;

  if (pathname === '/api/shows' && method === 'GET') {
    return sendJson(res, 200, store.listShows({ includeHidden: shouldIncludeHidden(searchParams) }), req);
  }

  if (pathname === '/api/item/rich' && method === 'GET') {
    const kind = searchParams.get('kind') === 'movie' ? 'movie' : 'show';
    const id = Number(searchParams.get('id')) || null;
    const tvmazeId = Number(searchParams.get('tvmazeId')) || null;
    const tmdbId = Number(searchParams.get('tmdbId')) || null;
    const imdbId = (searchParams.get('imdbId') || '').trim() || null;
    const name = (searchParams.get('name') || '').trim();
    const year = (searchParams.get('year') || '').slice(0, 4);
    const out = await galaxy.getRichItemDetails({
      kind,
      id,
      tvmazeId,
      tmdbId,
      imdbId,
      name,
      year,
      store,
      movies,
    });
    return sendJson(res, 200, out, req);
  }

  const itemDetail = pathname.match(/^\/api\/item\/(show|movie)\/(\d+)$/);
  if (itemDetail && method === 'GET') {
    const [, kind, id] = itemDetail;
    const epId = searchParams.get('epId');
    const detail = kind === 'movie' ? movies.getMovieDetails(id) : store.getShowDetails(id, epId);
    if (!detail) return sendJson(res, 404, { error: 'Not found' });
    return sendJson(res, 200, detail, req);
  }

  if (pathname === '/api/shows' && method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    if (!id) return sendJson(res, 400, { error: 'Missing show id' });
    hidden.remove('show', id);
    const show = await store.addShow(id, 'search');
    return sendJson(res, 201, show);
  }

  const fav = pathname.match(/^\/api\/shows\/(\d+)\/favorite$/);
  if (fav && method === 'POST') {
    const body = await readBody(req);
    const show = store.setFavorite(fav[1], body.favorite);
    if (!show) return sendJson(res, 404, { error: 'Show not found' });
    return sendJson(res, 200, { ok: true, id: show.id, favorite: show.favorite, show });
  }

  const dcRoute = pathname.match(/^\/api\/shows\/(\d+)\/directors-choice$/);
  if (dcRoute && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    let id = Number(dcRoute[1]) || 0;
    if (!id && (body.imdbId || body.name)) {
      const resolved = await tvmaze.resolveShow({ imdbId: body.imdbId || null, name: body.name || '', year: body.year || '' }).catch(() => null);
      if (resolved && resolved.id) id = resolved.id;
    }
    if (!id) return sendJson(res, 404, { error: 'Could not resolve show on TVmaze' });
    if (!store.isTracked(id)) {
      if (hidden.has('show', id)) {
        const entry = hidden.take('show', id);
        if (entry && entry.record) await store.restoreShow(entry.record);
        else await store.addShow(id, 'directors-choice');
      } else {
        await store.addShow(id, 'directors-choice');
      }
    }
    const show = store.setDirectorsChoice(id, body.enabled, { anchorDate: body.anchorDate || null });
    if (!show) return sendJson(res, 404, { error: 'Show not found' });
    if (show.directorsChoice && show.directorsChoice.enabled && !store.getSettings().showDirectorsChoice) {
      store.saveSettings({ showDirectorsChoice: true });
    }
    return sendJson(res, 200, {
      ok: true,
      id: show.id,
      directorsChoice: show.directorsChoice,
      show,
      settings: store.getSettings(),
    });
  }

  const extq = pathname.match(/^\/api\/shows\/(\d+)\/(?:ext|td)-query$/);
  if (extq && method === 'POST') {
    const body = await readBody(req);
    const show = store.setExtQuery(extq[1], body.extQuery !== undefined ? body.extQuery : body.tdQuery);
    if (!show) return sendJson(res, 404, { error: 'Show not found' });
    return sendJson(res, 200, { ok: true, id: show.id, extQuery: show.extQuery, show });
  }

  const del = pathname.match(/^\/api\/shows\/(\d+)$/);
  if (del && method === 'DELETE') {
    const id = Number(del[1]);
    const info = hideShowById(id);
    return sendJson(res, 200, { ok: true, alreadyRemoved: !info.ok, id, name: info.name });
  }

  const sDismiss = pathname.match(/^\/api\/shows\/(\d+)\/dismiss$/);
  if (sDismiss && method === 'POST') {
    const id = Number(sDismiss[1]);
    const body = await readBody(req).catch(() => ({}));
    const info = hideShowById(id, body.name ? { id, name: body.name } : null);
    return sendJson(res, 200, { ok: true, id, kind: 'show', name: info.name });
  }

  if (pathname === '/api/movies' && method === 'GET') {
    return sendJson(res, 200, movies.listMovies({ includeHidden: shouldIncludeHidden(searchParams) }), req);
  }

  if (pathname === '/api/movies' && method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    if (!id) return sendJson(res, 400, { error: 'Missing movie id' });
    if (!tmdb.hasApiKey()) return sendJson(res, 400, { error: 'TMDB API key is required — add it in Settings -> API Keys' });
    hidden.remove('movie', id);
    const movie = await movies.addMovie(id, 'search');
    return sendJson(res, 201, movie);
  }

  const mFav = pathname.match(/^\/api\/movies\/(\d+)\/favorite$/);
  if (mFav && method === 'POST') {
    const body = await readBody(req);
    const movie = movies.setFavorite(mFav[1], body.favorite);
    if (!movie) return sendJson(res, 404, { error: 'Movie not found' });
    return sendJson(res, 200, { ok: true, id: movie.id, favorite: movie.favorite, movie });
  }

  const mExtq = pathname.match(/^\/api\/movies\/(\d+)\/(?:ext|td)-query$/);
  if (mExtq && method === 'POST') {
    const body = await readBody(req);
    const movie = movies.setExtQuery(mExtq[1], body.extQuery !== undefined ? body.extQuery : body.tdQuery);
    if (!movie) return sendJson(res, 404, { error: 'Movie not found' });
    return sendJson(res, 200, { ok: true, id: movie.id, extQuery: movie.extQuery, movie });
  }

  const mDel = pathname.match(/^\/api\/movies\/(\d+)$/);
  if (mDel && method === 'DELETE') {
    const id = Number(mDel[1]);
    const info = hideMovieById(id);
    return sendJson(res, 200, { ok: true, alreadyRemoved: !info.ok, id, name: info.name });
  }

  const mDismiss = pathname.match(/^\/api\/movies\/(\d+)\/dismiss$/);
  if (mDismiss && method === 'POST') {
    const id = Number(mDismiss[1]);
    const body = await readBody(req).catch(() => ({}));
    const info = hideMovieById(id, body.name ? { id, name: body.name } : null);
    return sendJson(res, 200, { ok: true, id, kind: 'movie', name: info.name });
  }

  if (pathname === '/api/hidden' && method === 'GET') {
    return sendJson(res, 200, hidden.list(), req);
  }

  if (pathname === '/api/hidden/restore' && method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    const kind = body.kind === 'movie' ? 'movie' : 'show';
    if (!id) return sendJson(res, 400, { error: 'Missing id' });
    const entry = hidden.take(kind, id);
    let item = null;
    if (kind === 'movie') {
      item = entry && entry.record ? await movies.restoreMovie(entry.record) : await movies.addMovie(id, 'search');
    } else {
      item = entry && entry.record ? await store.restoreShow(entry.record) : await store.addShow(id, 'search');
    }
    return sendJson(res, 200, { ok: true, id, kind, item });
  }

  if (pathname === '/api/search' && method === 'GET') {
    const q = (searchParams.get('q') || '').trim();
    const kind = searchParams.get('kind') || 'all';
    if (q.length < 2) return sendJson(res, 200, []);
    const key = `${kind}:${q.toLowerCase()}`;
    const hit = searchCache.get(key);
    let results;
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) results = hit.data;
    else {
      const [tvList, movieList] = await Promise.all([
        kind === 'movie' ? [] : tvmaze.searchShows(q).then((r) => r.map((x) => ({ ...tvmaze.slimShow(x.show), kind: 'show' }))),
        kind === 'show' || !tmdb.hasApiKey() ? [] : tmdb.searchMovies(q).catch(() => []),
      ]);
      results = [...tvList.slice(0, 7), ...movieList.slice(0, 5)];
      if (kind === 'show' || tmdb.hasApiKey()) {
        searchCache.set(key, { at: Date.now(), data: results });
        if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value);
      }
    }
    return sendJson(
      res,
      200,
      results.map((item) => {
        const meta = item.kind !== 'movie' && store.isTracked(item.id) ? store.getShowMeta(item.id) : null;
        return {
          ...item,
          onCalendar: item.kind === 'movie' ? movies.isTracked(item.id) : store.isTracked(item.id),
          hidden: item.kind === 'movie' ? hidden.has('movie', item.id) : hidden.has('show', item.id),
          ...(meta && meta.directorsChoice ? { directorsChoice: meta.directorsChoice } : {}),
        };
      })
    );
  }

  if (pathname === '/api/schedule' && method === 'GET') {
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (!isDate(from) || !isDate(to)) return sendJson(res, 400, { error: 'from/to must be YYYY-MM-DD' });
    const withSummaries = searchParams.get('summaries') === '1';
    const includeHidden = shouldIncludeHidden(searchParams);
    const includeDirectorsChoice = searchParams.has('directorsChoice')
      ? searchParams.get('directorsChoice') === '1'
      : undefined;
    return sendJson(
      res,
      200,
      {
        episodes: store.schedule(from, to, { withSummaries, includeHidden, includeDirectorsChoice }),
        movies: movies.schedule(from, to, { withSummaries, includeHidden }),
        settings: store.getSettings(),
      },
      req
    );
  }

  if (pathname === '/api/status' && method === 'GET') {
    const addr = server.address();
    const urls = addr ? lanUrls(addr.port) : [];
    const dig = digest.getStatus();
    return sendJson(res, 200, {
      showCount: store.activeCount(),
      moviesCount: movies.count(),
      hiddenCount: hidden.count(),
      watchedCount: watched.count(),
      sync: store.sync,
      discovery: discovery.getStatus(),
      movieDiscovery: movies.getStatus(),
      discover: recommender.getJobStatus(),
      digest: { unreadCount: dig.unreadCount, unreadItems: dig.unreadItems, items: dig.items },
      settings: store.getSettings(),
      network: { host: HOST, port: addr ? addr.port : null, urls },
    });
  }

  if (pathname === '/api/watched' && method === 'POST') {
    const body = await readBody(req);
    const val = body.watched !== undefined ? Boolean(body.watched) : true;
    if (Array.isArray(body.items)) {
      watched.setMany(body.items, val);
    } else if (Number(body.id)) {
      watched.set(body.kind === 'movie' ? 'movie' : 'episode', Number(body.id), val);
    } else {
      return sendJson(res, 400, { error: 'Missing watched id or items array' });
    }
    return sendJson(res, 200, { ok: true, watched: val, watchedCount: watched.count() });
  }

  if (pathname === '/api/digest' && method === 'GET') {
    return sendJson(res, 200, digest.getStatus(), req);
  }

  if (pathname === '/api/digest/read' && method === 'POST') {
    return sendJson(res, 200, digest.markRead());
  }

  if (pathname === '/api/alerts/test' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const targetUrl = typeof body.webhookUrl === 'string' && body.webhookUrl.trim() ? body.webhookUrl : store.getSettings().webhookUrl;
    if (!targetUrl) return sendJson(res, 400, { error: 'Enter a webhook URL first' });
    const todayHighlights = alerts.collectTodaysAlerts({ store, movies, todayYmd: todayYmd() });
    const msg = todayHighlights.length
      ? todayHighlights.slice(0, 8).map((h) => `• ${h.name} (${h.label})`).join('\n')
      : 'Test notification from Viuhti — premiere alerts are active!';
    await alerts.dispatchWebhook(targetUrl, 'Viuhti · Premiere Alert Test', msg, { event: 'test', items: todayHighlights });
    return sendJson(res, 200, { ok: true, previewCount: todayHighlights.length });
  }

  if (pathname === '/api/calendar.ics' && method === 'GET') {
    const media = searchParams.get('media') || 'both';
    const favoritesOnly = searchParams.get('favorites') === '1';
    const body = buildIcsFeed({ media, favoritesOnly });
    const disp = searchParams.get('download') === '1' ? 'attachment' : 'inline';
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `${disp}; filename="viuhti.ics"`,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  if (pathname === '/api/backup/export' && method === 'GET') {
    const includeKeys = searchParams.get('includeKeys') === '1';
    const base = store.exportBackup({ includeKeys });
    const payload = {
      version: 1,
      origin: 'viuhti',
      exportedAt: new Date().toISOString(),
      ...base,
      movies: movies.exportMovies(),
      hidden: hidden.exportData(),
      watched: watched.exportData(),
      discoveryRules: discovery.getRules(),
      taste: recommender.exportData(),
    };
    const stamp = todayYmd();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="viuhti-backup-${stamp}.json"`,
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  if (pathname === '/api/backup/import' && method === 'POST') {
    const body = await readBody(req);
    if (!body || body.origin !== 'viuhti' || (!Array.isArray(body.shows) && !body.hidden && !body.movies)) {
      return sendJson(res, 400, { error: 'Invalid Viuhti backup file' });
    }
    const replace = body.replace !== false;
    if (body.hidden) hidden.importData(body.hidden, { replace });
    if (body.watched) watched.importData(body.watched, { replace });
    if (body.taste) recommender.importData(body.taste, { replace });
    if (body.discoveryRules) discovery.setRules(body.discoveryRules);
    store.importBackup({ shows: body.shows, settings: body.settings }, { replace });
    if (body.movies) movies.importMovies(body.movies, { replace });
    store.refresh();
    movies.refreshStale();
    return sendJson(res, 200, {
      ok: true,
      showCount: store.activeCount(),
      moviesCount: movies.count(),
      hiddenCount: hidden.count(),
      watchedCount: watched.count(),
    });
  }

  if (pathname === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    if (typeof body.tmdbApiKey === 'string' && body.tmdbApiKey.trim()) {
      try {
        await tmdb.validateApiKey(body.tmdbApiKey.trim());
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          return sendJson(res, 400, { error: 'Invalid TMDB API key — check your key at themoviedb.org/settings/api' });
        }
        throw err;
      }
    }
    if (body.tmdbApiKey !== undefined) searchCache.clear();
    try {
      return sendJson(res, 200, store.saveSettings(body));
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/discover' && method === 'GET') {
    const media = searchParams.get('media') || 'all';
    const lens = searchParams.get('lens') || 'mix';
    const anchorKey = searchParams.get('anchor') || '';
    const needSeeds = searchParams.get('seeds') === '1';
    const rec = recommender.getRecommendations({ store, movies, hidden, watched, media, lens, anchorKey });
    const starterSeeds = needSeeds || rec.profile.coldStart ? await recommender.buildStarterSeeds({ store, movies, hidden }) : [];
    return sendJson(res, 200, { ...rec, job: recommender.getJobStatus(), starterSeeds }, req);
  }

  if (pathname === '/api/discover/run' && method === 'POST') {
    return sendJson(res, 202, recommender.runDeepScan({ store, movies, hidden, watched, force: true }));
  }

  if (pathname === '/api/discover/feedback' && method === 'POST') {
    const body = await readBody(req);
    const out = await recommender.recordFeedback({
      kind: body.kind,
      id: body.id,
      tvmazeId: body.tvmazeId,
      tmdbId: body.tmdbId,
      imdbId: body.imdbId,
      action: body.action,
      item: body.item || null,
      store,
      movies,
      hidden,
      digest,
    });
    const rec = recommender.getRecommendations({
      store,
      movies,
      hidden,
      watched,
      media: body.media || 'all',
      lens: body.lens || 'mix',
      anchorKey: body.anchorKey || '',
    });
    return sendJson(res, 200, { ...out, discover: rec });
  }

  if (pathname === '/api/discover/traits' && method === 'POST') {
    const body = await readBody(req);
    recommender.updateTraitOverrides(body);
    const rec = recommender.getRecommendations({
      store,
      movies,
      hidden,
      watched,
      media: body.media || 'all',
      lens: body.lens || 'mix',
      anchorKey: body.anchorKey || '',
    });
    return sendJson(res, 200, { ok: true, discover: rec });
  }

  if (pathname === '/api/galaxy' && method === 'GET') {
    const seedKind = searchParams.get('seedKind') || '';
    const seedId = searchParams.get('seedId') || '';
    const seedTmdbId = searchParams.get('seedTmdbId') || '';
    const seedKeywordId = searchParams.get('seedKeywordId') || '';
    const seedQid = searchParams.get('seedQid') || '';
    const seedWikiTitle = searchParams.get('seedWikiTitle') || '';
    const seedName = searchParams.get('seedName') || '';
    const imdbId = searchParams.get('imdbId') || '';
    const showDarkMatter = searchParams.get('darkMatter') === '1';

    if (seedKind || seedId || seedTmdbId || seedQid || seedName) {
      const data = await galaxy.buildSeedGalaxy({
        seedKind: seedKind || 'show',
        seedId: seedId || null,
        seedTmdbId: seedTmdbId || null,
        seedKeywordId: seedKeywordId || null,
        seedQid: seedQid || null,
        seedWikiTitle: seedWikiTitle || null,
        seedName,
        imdbId: imdbId || null,
        store,
        movies,
        hidden,
        watched,
      });
      return sendJson(res, 200, data, req);
    }

    const data = await galaxy.buildTasteGalaxy({ store, movies, hidden, watched, showDarkMatter });
    return sendJson(res, 200, data, req);
  }

  if (pathname === '/api/galaxy/expand' && method === 'POST') {
    const body = await readBody(req);
    const out = await galaxy.expandNode({
      node: body.node || {},
      existingKeys: body.existingKeys || [],
      includeWiki: Boolean(body.includeWiki),
      store,
      movies,
      hidden,
      watched,
    });
    return sendJson(res, 200, out, req);
  }

  if (pathname === '/api/galaxy/wiki' && method === 'GET') {
    const kind = searchParams.get('kind') || 'show';
    const name = (searchParams.get('name') || '').trim();
    const year = (searchParams.get('year') || '').slice(0, 4);
    const qid = (searchParams.get('qid') || '').trim() || null;
    const wikiTitle = (searchParams.get('wikiTitle') || '').trim() || null;
    let imdbId = (searchParams.get('imdbId') || '').trim() || null;
    const tvmazeId = Number(searchParams.get('tvmazeId')) || null;
    const tmdbId = Number(searchParams.get('tmdbId')) || null;

    if (!imdbId && kind === 'show' && tvmazeId) {
      const cachedShow = store.getCached(tvmazeId) || store.loadCachedFromDisk(tvmazeId);
      const showImdb = cachedShow && cachedShow.show && cachedShow.show.externals && cachedShow.show.externals.imdb;
      const recTv = recommender.readItemCache(`tv_${tvmazeId}`);
      imdbId = showImdb || (recTv && recTv.imdbId) || null;
    } else if (!imdbId && kind === 'movie' && tmdbId) {
      const recMv = recommender.readItemCache(`tmdb_movie_${tmdbId}`) || recommender.readItemCache(`mv_${tmdbId}`);
      imdbId = (recMv && recMv.imdbId) || null;
    }

    const dossier = await wiki.getWikiDossier({ kind, name, year, imdbId, qid, wikiTitle });
    return sendJson(res, 200, dossier, req);
  }

  if (pathname === '/api/galaxy/search' && method === 'GET') {
    const q = (searchParams.get('q') || '').trim();
    return sendJson(res, 200, await galaxy.searchEntities(q), req);
  }

  if (pathname === '/api/discovery/toggle' && method === 'POST') {
    const body = await readBody(req);
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : !discovery.getStatus().enabled;
    const status = discovery.setEnabled(enabled);
    if (enabled) {
      discovery.runBiMonthlySync();
      if (tmdb.hasApiKey()) movies.runBiMonthlySync();
    }
    return sendJson(res, 200, status);
  }

  if (pathname === '/api/discovery/rules' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, discovery.setRules(body));
  }

  if (pathname === '/api/discovery/run' && method === 'POST') {
    const status = discovery.runBiMonthlySync({ force: true });
    const movieStatus = movies.runBiMonthlySync({ force: true });
    return sendJson(res, 202, { ...status, movies: movieStatus });
  }

  if (pathname === '/api/movies/discovery/run' && method === 'POST') {
    return sendJson(res, 202, movies.runBiMonthlySync({ force: true }));
  }

  if (pathname === '/api/onboarding/shows' && method === 'GET') {
    const cat = await getForwardCatalog();
    return sendJson(
      res,
      200,
      {
        installDate: cat.installDate,
        fromDate: cat.fromDate,
        toDate: cat.toDate,
        total: cat.list.length,
        genres: cat.genres,
        languages: cat.languages,
        shows: cat.list.map(({ rawShow, episodes }) => ({
          id: rawShow.id,
          name: rawShow.name,
          genres: rawShow.genres || [],
          language: rawShow.language || null,
          type: rawShow.type || null,
          weight: rawShow.weight || 0,
          network: (rawShow.network && rawShow.network.name) || (rawShow.webChannel && rawShow.webChannel.name) || null,
          nextAirdate: (episodes[0] && episodes[0].airdate) || cat.fromDate,
          epCount: episodes.length,
          onCalendar: store.isTracked(rawShow.id),
        })),
      },
      req
    );
  }

  if (pathname === '/api/onboarding/import' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const cat = await getForwardCatalog();
    const genreSet = new Set(Array.isArray(body.genres) ? body.genres.map((g) => String(g || '').trim()).filter(Boolean) : []);
    const langSet = new Set(Array.isArray(body.languages) ? body.languages.map((l) => String(l || '').trim()).filter(Boolean) : []);
    const singleLang = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : body.englishOnly ? 'English' : '';
    if (singleLang) langSet.add(singleLang);
    const idSet = Array.isArray(body.ids) ? new Set(body.ids.map(Number).filter(Boolean)) : null;

    const chosen = cat.list.filter(({ rawShow }) => {
      if (store.isTracked(rawShow.id)) return false;
      if (idSet) return idSet.has(rawShow.id);
      if (langSet.size > 0 && !langSet.has(rawShow.language || 'Unknown')) return false;
      if (genreSet.size > 0 && !(rawShow.genres || []).some((g) => genreSet.has(g))) return false;
      return true;
    });

    const records = chosen.map(({ rawShow, episodes }) => ({
      show: tvmaze.slimShow(rawShow),
      episodes,
      fetchedAt: Date.now(),
    }));
    const added = store.addShowsBulk(records, 'onboarding');
    for (const r of records) {
      hidden.remove('show', r.show.id);
    }
    store.saveSettings({ installDate: cat.installDate });
    const rulePatch = {};
    if (langSet.size > 0) rulePatch.languages = [...langSet];
    if (genreSet.size > 0) rulePatch.genres = [...genreSet];
    if (Object.keys(rulePatch).length) discovery.setRules(rulePatch);
    if (body.includeMovies && tmdb.hasApiKey()) movies.runBiMonthlySync({ force: true });
    return sendJson(res, 200, { ok: true, added, installDate: cat.installDate });
  }

  if (pathname === '/api/refresh' && method === 'POST') {
    store.refresh({ force: true });
    discovery.runBiMonthlySync({ force: true });
    movies.refreshStale({ force: true });
    if (tmdb.hasApiKey()) movies.runBiMonthlySync({ force: true });
    return sendJson(res, 202, {
      sync: store.sync,
      discovery: discovery.getStatus(),
      movieDiscovery: movies.getStatus(),
    });
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname);
    else res.writeHead(405).end();
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed:`, err.message);
    const code = err.code === 'TMDB_NO_KEY' ? 400 : err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (!res.headersSent) sendJson(res, code, { error: err.message });
  }
});

function listen(port, attemptsLeft = 50) {
  server.once('error', (err) => {
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && port !== 0 && attemptsLeft > 0) listen(port + 1, attemptsLeft - 1);
    else {
      console.error('Could not start server:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const actualPort = server.address().port;
    const urls = lanUrls(actualPort);
    console.log(`\n  📺  Viuhti running:`);
    console.log(`      Local:   http://localhost:${actualPort}`);
    for (const u of urls) console.log(`      Network: ${u}`);
    console.log('');
  });
}

store.load();
movies.load();
watched.load();
digest.load();
alerts.load();
recommender.load();
hidden.load({
  activeShowIds: store.activeIds(),
  activeMovieIds: movies.activeIds(),
  cacheDir: store.CACHE_DIR,
});
discovery.load();

if (!discovery.hasExplicitLanguageRule() && store.activeCount() > 0 && (hidden.wasMigratedFromLegacy() || discovery.hasSavedState())) {
  const langs = new Set();
  for (const id of store.activeIds()) {
    const c = store.getCached(id) || store.loadCachedFromDisk(id);
    if (c && c.show && c.show.language) langs.add(c.show.language);
  }
  if (langs.size > 0 && langs.size <= 5) {
    discovery.setRules({ languages: [...langs] });
    console.log(`Seeded TVmaze sync language filter from calendar: ${[...langs].join(', ')}`);
  }
}

listen(START_PORT);

async function runPeriodicSync() {
  if (!(store.hasSavedList() || movies.hasSavedList() || discovery.hasSavedState())) return;
  await store.refresh();
  discovery.runBiMonthlySync();
  if (tmdb.hasApiKey()) movies.runBiMonthlySync();
  movies.refreshStale();
  alerts.maybeSendDailyAlerts({ store, movies, todayYmd: todayYmd() }).catch((err) => {
    console.error('Premiere webhook alert failed:', err.message);
  });
}

runPeriodicSync();
setInterval(runPeriodicSync, REFRESH_INTERVAL).unref();
