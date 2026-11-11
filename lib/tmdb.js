'use strict';

/**
 * Lightweight TMDB API v3 client with rate limiting and payload normalization
 * for movies released on Digital/Streaming (type 4), Physical media (type 5), or TV (type 6).
 */

const BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';
let keyProvider = () => (process.env.TMDB_API_KEY || '').trim();

function setKeyProvider(fn) {
  if (typeof fn === 'function') keyProvider = fn;
}

function getApiKey() {
  return String(keyProvider() || '').trim();
}

function hasApiKey() {
  return Boolean(getApiKey());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.stamps = [];
    this.chain = Promise.resolve();
  }

  acquire() {
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
        if (this.stamps.length < this.max) {
          this.stamps.push(now);
          return;
        }
        await sleep(this.windowMs - (now - this.stamps[0]) + 25);
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

const limiter = new RateLimiter(30, 10_000);

const LANG_NAMES = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
  nl: 'Dutch',
  no: 'Norwegian',
  sv: 'Swedish',
  da: 'Danish',
  pl: 'Polish',
  ru: 'Russian',
  th: 'Thai',
  tl: 'Tagalog',
  id: 'Indonesian',
};

const COUNTRY_PRIORITY = ['US', 'GB', 'CA', 'AU', 'IE', 'NZ', 'DE', 'FR', 'ES', 'BR'];

function cleanProvider(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s+(Standard\s+with\s+Ads|with\s+Ads|Amazon\s+Channel|Apple\s+TV\s+Channel|Premium(\s+Plus)?)$/i, '')
    .replace(/^Amazon\s+Prime\s+Video$/i, 'Prime Video')
    .replace(/^Apple\s+TV\+$/i, 'Apple TV')
    .replace(/^Apple\s+TV\s+Store$/i, 'Apple TV')
    .replace(/^Max$/i, 'HBO Max')
    .trim();
}

async function apiGet(path, params = {}, { allow404 = false, apiKeyOverride = null } = {}) {
  const key = apiKeyOverride !== null ? String(apiKeyOverride || '').trim() : getApiKey();
  if (!key) {
    const err = new Error('TMDB API key is required — add it in Settings -> API Keys');
    err.code = 'TMDB_NO_KEY';
    throw err;
  }
  const url = new URL(BASE + path);
  const headers = { Accept: 'application/json' };
  // Support both TMDB v3 API keys and v4 Read Access Tokens
  if (key.length > 48 || key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    await limiter.acquire();
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (res.status === 404 && allow404) return null;
      if (!res.ok) {
        const err = new Error(`TMDB responded ${res.status} for ${path}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (String(err.message).includes('responded 4')) throw err;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`TMDB request failed: ${path}`);
}

async function validateApiKey(key) {
  return await apiGet('/configuration', {}, { apiKeyOverride: key });
}

function pickLogo(raw) {
  const logos = (raw.images && raw.images.logos) || [];
  if (!logos.length) return null;
  const sorted = [...logos].sort((a, b) => {
    const la = a.iso_639_1 === 'en' ? 2 : a.iso_639_1 ? 0 : 1;
    const lb = b.iso_639_1 === 'en' ? 2 : b.iso_639_1 ? 0 : 1;
    return lb - la || (b.vote_average || 0) - (a.vote_average || 0) || (b.width || 0) - (a.width || 0);
  });
  return sorted[0].file_path ? `${IMG_BASE}/w500${sorted[0].file_path}` : null;
}

function pickWatchProvider(raw) {
  const results = (raw['watch/providers'] && raw['watch/providers'].results) || {};
  for (const cc of ['US', 'GB', 'CA', 'AU', ...Object.keys(results)]) {
    const entry = results[cc];
    if (!entry) continue;
    if (entry.flatrate && entry.flatrate.length) {
      return { kind: 'stream', name: cleanProvider(entry.flatrate[0].provider_name), country: cc };
    }
  }
  return null;
}

function cleanPhysicalLabel(note) {
  const s = String(note || '').trim();
  if (!s) return 'Blu-ray / DVD';
  const has4k = /4k|ultra\s*hd|uhd/i.test(s);
  const hasBd = /blu-?ray/i.test(s);
  const hasDvd = /\bdvd\b/i.test(s);
  if (has4k && hasBd) return '4K UHD / Blu-ray';
  if (has4k) return '4K UHD';
  if (hasBd && hasDvd) return 'Blu-ray / DVD';
  if (hasBd) return 'Blu-ray';
  if (hasDvd) return 'DVD';
  return cleanProvider(s.split(/[|,(]/)[0].trim()) || 'Physical';
}

/**
 * Pick the canonical Digital (4), TV (6), or Physical (5) release for a movie,
 * preferring releases inside [preferFrom, preferTo] if provided and US/GB priority.
 */
function pickRelease(raw, preferFrom = null, preferTo = null) {
  const byCountry = (raw.release_dates && raw.release_dates.results) || [];
  const candidates = [];
  for (const c of byCountry) {
    for (const r of c.release_dates || []) {
      if (r.type !== 4 && r.type !== 5 && r.type !== 6) continue;
      const date = (r.release_date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const kind = r.type === 6 ? 'tv' : r.type === 5 ? 'physical' : 'stream';
      const note =
        kind === 'physical'
          ? cleanPhysicalLabel(r.note)
          : cleanProvider((r.note || '').split(/[,/]/)[0].trim());
      candidates.push({
        country: c.iso_3166_1,
        type: r.type,
        kind,
        date,
        note,
      });
    }
  }

  const inWindow =
    preferFrom && preferTo ? candidates.filter((c) => c.date >= preferFrom && c.date <= preferTo) : [];
  const pool = inWindow.length ? inWindow : candidates;
  const provider = pickWatchProvider(raw);

  if (pool.length) {
    const typeRank = (t) => (t === 4 ? 0 : t === 6 ? 1 : 2);
    pool.sort((a, b) => {
      const pa = COUNTRY_PRIORITY.indexOf(a.country);
      const pb = COUNTRY_PRIORITY.indexOf(b.country);
      const ca = pa === -1 ? 99 : pa;
      const cb = pb === -1 ? 99 : pb;
      return (
        ca - cb ||
        typeRank(a.type) - typeRank(b.type) ||
        Number(Boolean(b.note)) - Number(Boolean(a.note)) ||
        a.date.localeCompare(b.date)
      );
    });
    const best = pool[0];
    const name =
      best.note ||
      (best.kind === 'stream' && provider ? provider.name : best.kind === 'tv' ? 'TV Premiere' : best.kind === 'physical' ? 'Blu-ray / DVD' : 'Digital');
    return { airdate: best.date, kind: best.kind, channel: name, country: best.country };
  }

  // Fallback if search-added movie only has theatrical/primary release_date
  return {
    airdate: raw.release_date || null,
    kind: provider ? 'stream' : 'stream',
    channel: provider ? provider.name : 'Digital',
    country: provider ? provider.country : null,
  };
}

function slimMovie(raw, preferFrom = null, preferTo = null) {
  const rel = pickRelease(raw, preferFrom, preferTo);
  const lang = LANG_NAMES[raw.original_language] || (raw.original_language ? raw.original_language.toUpperCase() : null);
  return {
    id: raw.id,
    kind: 'movie',
    name: raw.title,
    originalName: raw.original_title && raw.original_title !== raw.title ? raw.original_title : null,
    url: `https://www.themoviedb.org/movie/${raw.id}`,
    language: lang,
    genres: (raw.genres || []).map((g) => (g.name === 'Science Fiction' ? 'Science-Fiction' : g.name)),
    status: raw.status || 'Released',
    premiered: raw.release_date || rel.airdate || null,
    airdate: rel.airdate,
    releaseKind: rel.kind,
    channelName: rel.channel,
    channelCountry: rel.country,
    runtime: raw.runtime || null,
    officialSite: raw.homepage || null,
    imdbUrl: raw.imdb_id ? `https://www.imdb.com/title/${raw.imdb_id}/` : null,
    rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null,
    popularity: raw.popularity || 0,
    poster: raw.poster_path ? `${IMG_BASE}/w342${raw.poster_path}` : null,
    posterLarge: raw.poster_path ? `${IMG_BASE}/w780${raw.poster_path}` : null,
    logo: pickLogo(raw),
    background: raw.backdrop_path ? `${IMG_BASE}/w780${raw.backdrop_path}` : null,
    summary: raw.overview || '',
    tagline: raw.tagline || '',
  };
}

async function discoverMovies(from, to, primaryCutoff, page = 1, releaseTypes = '4|5|6') {
  return await apiGet('/discover/movie', {
    with_release_type: releaseTypes,
    'release_date.gte': from,
    'release_date.lte': to,
    'primary_release_date.gte': primaryCutoff,
    sort_by: 'popularity.desc',
    include_adult: false,
    page,
  });
}

async function fetchMovieFull(id, preferFrom = null, preferTo = null) {
  const raw = await apiGet(
    `/movie/${id}`,
    {
      append_to_response: 'release_dates,watch/providers,images',
      include_image_language: 'en,null',
    },
    { allow404: true }
  );
  if (!raw) return null;
  return { movie: slimMovie(raw, preferFrom, preferTo), fetchedAt: Date.now() };
}

async function searchMovies(q) {
  const res = await apiGet('/search/movie', { query: q, include_adult: false });
  return ((res && res.results) || []).slice(0, 10).map((r) => ({
    id: r.id,
    kind: 'movie',
    name: r.title,
    premiered: r.release_date || null,
    language: LANG_NAMES[r.original_language] || r.original_language || null,
    genres: [],
    status: r.release_date ? 'Released' : 'Upcoming',
    poster: r.poster_path ? `${IMG_BASE}/w185${r.poster_path}` : null,
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    summary: r.overview || '',
    channelName: 'TMDB Movie',
    releaseKind: 'stream',
  }));
}

const TMDB_GENRE_NAMES = {
  12: 'Adventure',
  14: 'Fantasy',
  16: 'Animation',
  18: 'Drama',
  27: 'Horror',
  28: 'Action',
  35: 'Comedy',
  36: 'History',
  37: 'Western',
  53: 'Thriller',
  80: 'Crime',
  99: 'Documentary',
  878: 'Science-Fiction',
  9648: 'Mystery',
  10402: 'Music',
  10749: 'Romance',
  10751: 'Family',
  10752: 'War',
  10759: 'Action',
  10762: 'Family',
  10763: 'News',
  10764: 'Reality',
  10765: 'Science-Fiction',
  10766: 'Drama',
  10767: 'Talk',
  10768: 'War',
  10770: 'TV Movie',
};

function normalizeGenreName(name) {
  if (!name) return '';
  if (name === 'Science Fiction' || name === 'Sci-Fi & Fantasy') return 'Science-Fiction';
  if (name === 'Action & Adventure') return 'Action';
  if (name === 'War & Politics') return 'War';
  return name;
}

function slimCandidate(raw, forcedKind = null) {
  const mediaType = forcedKind || (raw.media_type === 'movie' || (!raw.first_air_date && raw.release_date) ? 'movie' : 'show');
  const isMovie = mediaType === 'movie';
  const genres = Array.isArray(raw.genres)
    ? raw.genres.map((g) => normalizeGenreName(g.name)).filter(Boolean)
    : [...new Set((raw.genre_ids || []).map((id) => TMDB_GENRE_NAMES[id]).filter(Boolean))];
  return {
    tmdbId: raw.id,
    kind: isMovie ? 'movie' : 'show',
    name: isMovie ? raw.title || raw.name : raw.name || raw.title,
    premiered: isMovie ? raw.release_date || null : raw.first_air_date || null,
    language: LANG_NAMES[raw.original_language] || (raw.original_language ? raw.original_language.toUpperCase() : null),
    genres: [...new Set(genres)],
    poster: raw.poster_path ? `${IMG_BASE}/w342${raw.poster_path}` : null,
    backdrop: raw.backdrop_path ? `${IMG_BASE}/w780${raw.backdrop_path}` : null,
    rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null,
    voteCount: raw.vote_count || 0,
    popularity: raw.popularity || 0,
    summary: raw.overview || '',
  };
}

async function findTvByExternal({ imdb = null, thetvdb = null, name = '', year = '' } = {}) {
  if (imdb) {
    const res = await apiGet(`/find/${encodeURIComponent(imdb)}`, { external_source: 'imdb_id' }, { allow404: true }).catch(() => null);
    const hit = res && res.tv_results && res.tv_results[0];
    if (hit && hit.id) return hit.id;
  }
  if (thetvdb) {
    const res = await apiGet(`/find/${encodeURIComponent(thetvdb)}`, { external_source: 'tvdb_id' }, { allow404: true }).catch(() => null);
    const hit = res && res.tv_results && res.tv_results[0];
    if (hit && hit.id) return hit.id;
  }
  if (name) {
    const q = await apiGet('/search/tv', {
      query: name,
      ...(year ? { first_air_date_year: String(year).slice(0, 4) } : {}),
    }).catch(() => null);
    const list = (q && q.results) || [];
    const target = name.trim().toLowerCase();
    const exact = list.find((r) => String(r.name || '').trim().toLowerCase() === target) || list[0];
    if (exact && exact.id) return exact.id;
  }
  return null;
}

async function fetchDeepProfile(kind, tmdbId) {
  const isMovie = kind === 'movie';
  const endpoint = isMovie ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
  const raw = await apiGet(
    endpoint,
    { append_to_response: 'keywords,credits,recommendations,similar,external_ids' },
    { allow404: true }
  );
  if (!raw) return null;

  const kwRoot = raw.keywords || {};
  const keywords = (isMovie ? kwRoot.keywords : kwRoot.results) || [];
  const credits = raw.credits || {};
  const cast = (credits.cast || [])
    .slice(0, 8)
    .map((c) => c && c.name)
    .filter(Boolean);
  const creatorsSet = new Set();
  if (!isMovie) {
    for (const c of raw.created_by || []) if (c && c.name) creatorsSet.add(c.name);
  }
  for (const cr of credits.crew || []) {
    if (!cr || !cr.name) continue;
    if (/^(Director|Series Director|Creator|Showrunner|Screenplay|Writer|Executive Producer)$/i.test(cr.job || '')) {
      creatorsSet.add(cr.name);
      if (creatorsSet.size >= 6) break;
    }
  }
  const studios = isMovie
    ? (raw.production_companies || []).slice(0, 3).map((p) => p.name).filter(Boolean)
    : [...(raw.networks || []), ...(raw.production_companies || [])]
        .slice(0, 4)
        .map((p) => p.name)
        .filter(Boolean);

  const base = slimCandidate(raw, isMovie ? 'movie' : 'show');
  return {
    ...base,
    id: raw.id,
    imdbId: (raw.external_ids && raw.external_ids.imdb_id) || raw.imdb_id || null,
    status: raw.status || null,
    runtime: isMovie ? raw.runtime || null : (raw.episode_run_time && raw.episode_run_time[0]) || null,
    studios: [...new Set(studios)],
    keywords: keywords.slice(0, 18).map((k) => ({ id: k.id, name: String(k.name || '').toLowerCase() })).filter((k) => k.name),
    creators: [...creatorsSet],
    cast,
    recommendations: ((raw.recommendations && raw.recommendations.results) || []).slice(0, 14).map((r) => slimCandidate(r, base.kind)),
    similar: ((raw.similar && raw.similar.results) || []).slice(0, 10).map((r) => slimCandidate(r, base.kind)),
    url: `https://www.themoviedb.org/${isMovie ? 'movie' : 'tv'}/${raw.id}`,
    imdbUrl: (raw.external_ids && raw.external_ids.imdb_id) || raw.imdb_id ? `https://www.imdb.com/title/${(raw.external_ids && raw.external_ids.imdb_id) || raw.imdb_id}/` : null,
  };
}

async function discoverDeep(kind, params = {}) {
  const isMovie = kind === 'movie';
  const res = await apiGet(`/discover/${isMovie ? 'movie' : 'tv'}`, {
    include_adult: false,
    sort_by: params.sortBy || 'vote_average.desc',
    ...params,
  });
  return ((res && res.results) || []).map((r) => slimCandidate(r, isMovie ? 'movie' : 'show'));
}

async function fetchTrending(media = 'all') {
  const res = await apiGet(`/trending/${media}/week`, {}).catch(() => null);
  return ((res && res.results) || []).map((r) => slimCandidate(r)).filter((x) => x.name && (x.poster || x.backdrop));
}

module.exports = {
  setKeyProvider,
  hasApiKey,
  validateApiKey,
  discoverMovies,
  fetchMovieFull,
  searchMovies,
  findTvByExternal,
  fetchDeepProfile,
  discoverDeep,
  fetchTrending,
  LANG_NAMES,
};
