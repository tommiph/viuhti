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
const trash = require('./lib/trash');

tmdb.setKeyProvider(() => store.getTmdbApiKey());

const HOST = process.env.HOST || '0.0.0.0';
const START_PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 4280;
const PUBLIC_DIR = path.join(__dirname, 'public');
const REFRESH_INTERVAL = 60 * 60 * 1000; // check TVmaze for updates hourly

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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
      if (data.length > 1e6) req.destroy();
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

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;

  if (pathname === '/api/shows' && method === 'GET') {
    return sendJson(res, 200, store.listShows(), req);
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
    discovery.unmarkExcluded(id);
    trash.remove('show', id);
    const show = await store.addShow(id, 'search');
    return sendJson(res, 201, show);
  }

  const fav = pathname.match(/^\/api\/shows\/(\d+)\/favorite$/);
  if (fav && method === 'POST') {
    const body = await readBody(req);
    const show = store.setFavorite(fav[1], body.favorite);
    if (!show) return sendJson(res, 404, { error: 'Show not tracked' });
    return sendJson(res, 200, { ok: true, id: show.id, favorite: show.favorite, show });
  }

  const extq = pathname.match(/^\/api\/shows\/(\d+)\/(?:ext|td)-query$/);
  if (extq && method === 'POST') {
    const body = await readBody(req);
    const show = store.setExtQuery(extq[1], body.extQuery !== undefined ? body.extQuery : body.tdQuery);
    if (!show) return sendJson(res, 404, { error: 'Show not tracked' });
    return sendJson(res, 200, { ok: true, id: show.id, extQuery: show.extQuery, show });
  }

  const del = pathname.match(/^\/api\/shows\/(\d+)$/);
  if (del && method === 'DELETE') {
    const id = Number(del[1]);
    const meta = store.getShowMeta(id);
    const snap = store.snapshotForTrash(id, 'removed');
    const ok = store.removeShow(id);
    if (ok) {
      if (snap) trash.add(snap);
      discovery.markExcluded(id, meta);
    }
    return sendJson(res, 200, { ok: true, alreadyRemoved: !ok, id, name: (meta && meta.name) || null });
  }

  const sDismiss = pathname.match(/^\/api\/shows\/(\d+)\/dismiss$/);
  if (sDismiss && method === 'POST') {
    const id = Number(sDismiss[1]);
    const body = await readBody(req).catch(() => ({}));
    const meta = store.getShowMeta(id) || (body.name ? { id, name: body.name, wasSource: body.source || 'auto-weekly' } : { id, name: `Show ${id}` });
    const snap = store.snapshotForTrash(id, 'dismissed');
    if (store.removeShow(id) && snap) trash.add(snap);
    discovery.markExcluded(id, meta);
    return sendJson(res, 200, { ok: true, id, kind: 'show', name: meta.name });
  }

  if (pathname === '/api/movies' && method === 'GET') {
    return sendJson(res, 200, movies.listMovies(), req);
  }

  if (pathname === '/api/movies' && method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    if (!id) return sendJson(res, 400, { error: 'Missing movie id' });
    if (!tmdb.hasApiKey()) return sendJson(res, 400, { error: 'TMDB API key is required — add it in Settings -> API Keys' });
    trash.remove('movie', id);
    const movie = await movies.addMovie(id, 'search');
    return sendJson(res, 201, movie);
  }

  const mFav = pathname.match(/^\/api\/movies\/(\d+)\/favorite$/);
  if (mFav && method === 'POST') {
    const body = await readBody(req);
    const movie = movies.setFavorite(mFav[1], body.favorite);
    if (!movie) return sendJson(res, 404, { error: 'Movie not tracked' });
    return sendJson(res, 200, { ok: true, id: movie.id, favorite: movie.favorite, movie });
  }

  const mExtq = pathname.match(/^\/api\/movies\/(\d+)\/(?:ext|td)-query$/);
  if (mExtq && method === 'POST') {
    const body = await readBody(req);
    const movie = movies.setExtQuery(mExtq[1], body.extQuery !== undefined ? body.extQuery : body.tdQuery);
    if (!movie) return sendJson(res, 404, { error: 'Movie not tracked' });
    return sendJson(res, 200, { ok: true, id: movie.id, extQuery: movie.extQuery, movie });
  }

  const mDel = pathname.match(/^\/api\/movies\/(\d+)$/);
  if (mDel && method === 'DELETE') {
    const id = Number(mDel[1]);
    const meta = movies.getMovieMeta(id);
    const snap = movies.snapshotForTrash(id, 'removed');
    const ok = movies.removeMovie(id);
    if (ok && snap) trash.add(snap);
    return sendJson(res, 200, { ok: true, alreadyRemoved: !ok, id, name: (meta && meta.name) || null });
  }

  const mDismiss = pathname.match(/^\/api\/movies\/(\d+)\/dismiss$/);
  if (mDismiss && method === 'POST') {
    const id = Number(mDismiss[1]);
    const body = await readBody(req).catch(() => ({}));
    const meta = movies.getMovieMeta(id) || (body.name ? { id, name: body.name, wasSource: body.source || 'auto-weekly' } : { id, name: `Movie ${id}` });
    const snap = movies.snapshotForTrash(id, 'dismissed');
    if (movies.removeMovie(id)) {
      if (snap) trash.add(snap);
    } else movies.markExcluded(id, meta);
    return sendJson(res, 200, { ok: true, id, kind: 'movie', name: meta.name });
  }

  if (pathname === '/api/trash' && method === 'GET') {
    return sendJson(res, 200, trash.list(), req);
  }

  if (pathname === '/api/trash/restore' && method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    const kind = body.kind === 'movie' ? 'movie' : 'show';
    if (!id) return sendJson(res, 400, { error: 'Missing id' });
    const trashed = trash.take(kind, id);
    let item = null;
    if (kind === 'movie') {
      const prev = movies.unmarkExcluded(id);
      item = trashed && trashed.record
        ? await movies.restoreMovie(trashed.record)
        : await movies.addMovie(id, (prev && prev.wasSource) || 'search');
    } else {
      const prev = discovery.unmarkExcluded(id);
      item = trashed && trashed.record
        ? await store.restoreShow(trashed.record)
        : await store.addShow(id, (prev && prev.wasSource) || 'search');
    }
    return sendJson(res, 200, { ok: true, id, kind, item });
  }

  const trashDel = pathname.match(/^\/api\/trash\/(show|movie)\/(\d+)$/);
  if (trashDel && method === 'DELETE') {
    const kind = trashDel[1];
    const id = Number(trashDel[2]);
    const removed = trash.remove(kind, id);
    if (kind === 'movie') movies.purgeMovieCache(id);
    else store.purgeShowCache(id);
    return sendJson(res, 200, { ok: true, removed, kind, id });
  }

  if (pathname === '/api/trash/empty' && method === 'POST') {
    const cleared = trash.clear();
    for (const x of cleared) {
      if (x.kind === 'movie') movies.purgeMovieCache(x.id);
      else store.purgeShowCache(x.id);
    }
    return sendJson(res, 200, { ok: true, purged: cleared.length });
  }

  if (pathname === '/api/dismissed/restore' && method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    const kind = body.kind === 'movie' ? 'movie' : 'show';
    const readd = body.readd !== false;
    if (!id) return sendJson(res, 400, { error: 'Missing id' });
    const trashed = readd ? trash.take(kind, id) : null;
    let item = null;
    if (kind === 'movie') {
      const prev = movies.unmarkExcluded(id);
      if (readd) {
        item = trashed && trashed.record
          ? await movies.restoreMovie(trashed.record)
          : await movies.addMovie(id, (prev && prev.wasSource) || 'search');
      }
    } else {
      const prev = discovery.unmarkExcluded(id);
      if (readd) {
        item = trashed && trashed.record
          ? await store.restoreShow(trashed.record)
          : await store.addShow(id, (prev && prev.wasSource) || 'search');
      }
    }
    return sendJson(res, 200, { ok: true, id, kind, readd, item });
  }

  if (pathname === '/api/dismissed/clear' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const kind = body.kind || 'all';
    if (kind === 'all' || kind === 'show') discovery.clearExcluded();
    if (kind === 'all' || kind === 'movie') movies.clearExcluded();
    return sendJson(res, 200, { ok: true });
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
      results.map((item) => ({
        ...item,
        tracked: item.kind === 'movie' ? movies.isTracked(item.id) : store.isTracked(item.id),
      }))
    );
  }

  if (pathname === '/api/schedule' && method === 'GET') {
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (!isDate(from) || !isDate(to)) return sendJson(res, 400, { error: 'from/to must be YYYY-MM-DD' });
    return sendJson(res, 200, { episodes: store.schedule(from, to), movies: movies.schedule(from, to), settings: store.getSettings() }, req);
  }

  if (pathname === '/api/status' && method === 'GET') {
    const addr = server.address();
    const urls = addr ? lanUrls(addr.port) : [];
    return sendJson(res, 200, {
      tracked: store.trackedCount(),
      moviesCount: movies.count(),
      trashCount: trash.count(),
      sync: store.sync,
      discovery: discovery.getStatus(),
      movieDiscovery: movies.getStatus(),
      settings: store.getSettings(),
      network: { host: HOST, port: addr ? addr.port : null, urls },
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

  if (pathname === '/api/discovery/toggle' && method === 'POST') {
    const body = await readBody(req);
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : !discovery.getStatus().enabled;
    const status = discovery.setEnabled(enabled);
    if (enabled) {
      discovery.runWeeklyDiscovery();
      if (tmdb.hasApiKey()) movies.runWeeklyMovieDiscovery();
    }
    return sendJson(res, 200, status);
  }

  if (pathname === '/api/discovery/rules' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, discovery.setRules(body));
  }

  if (pathname === '/api/discovery/run' && method === 'POST') {
    const status = discovery.runWeeklyDiscovery({ force: true });
    const movieStatus = movies.runWeeklyMovieDiscovery({ force: true });
    return sendJson(res, 202, { ...status, movies: movieStatus });
  }

  if (pathname === '/api/movies/discovery/run' && method === 'POST') {
    return sendJson(res, 202, movies.runWeeklyMovieDiscovery({ force: true }));
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
          tracked: store.isTracked(rawShow.id),
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
      discovery.unmarkExcluded(r.show.id);
      trash.remove('show', r.show.id);
    }
    store.saveSettings({ installDate: cat.installDate });
    if (body.includeMovies && tmdb.hasApiKey()) movies.runWeeklyMovieDiscovery({ force: true });
    return sendJson(res, 200, { ok: true, added, installDate: cat.installDate });
  }

  if (pathname === '/api/refresh' && method === 'POST') {
    store.refresh({ force: true });
    return sendJson(res, 202, store.sync);
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
discovery.load();
movies.load();
trash.load();
listen(START_PORT);

if (store.hasSavedList() || movies.hasSavedList() || discovery.hasSavedState()) {
  store.refresh().then(() => {
    discovery.runWeeklyDiscovery();
    if (tmdb.hasApiKey()) movies.runWeeklyMovieDiscovery();
  });
}
setInterval(() => {
  if (store.hasSavedList() || movies.hasSavedList() || discovery.hasSavedState()) {
    store.refresh().then(() => {
      discovery.runWeeklyDiscovery();
      if (tmdb.hasApiKey()) movies.runWeeklyMovieDiscovery();
    });
    movies.refreshStale();
  }
}, REFRESH_INTERVAL).unref();
