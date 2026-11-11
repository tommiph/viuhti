'use strict';

/**
 * Small TVmaze API client with a rate limiter (TVmaze allows ~20 calls / 10 s per IP),
 * automatic retry on HTTP 429 and helpers that slim the payloads down to what the UI needs.
 */

const BASE = 'https://api.tvmaze.com';
const USER_AGENT = 'Viuhti/1.0 (personal use)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.stamps = [];
    this.chain = Promise.resolve();
  }

  acquire() {
    // Serialise acquisitions so concurrent callers queue fairly.
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

const limiter = new RateLimiter(18, 10_000);

async function apiGet(path, { allow404 = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    await limiter.acquire();
    try {
      const res = await fetch(BASE + path, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (res.status === 429) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (res.status === 404 && allow404) return null;
      if (!res.ok) throw new Error(`TVmaze responded ${res.status} for ${path}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (String(err.message).includes('responded 4')) throw err; // non-retryable client error
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`TVmaze request failed: ${path}`);
}

function pickImage(images, type, size = 'original') {
  const list = images.filter((i) => i.type === type);
  if (!list.length) return null;
  list.sort((a, b) => Number(b.main) - Number(a.main));
  const res = list[0].resolutions || {};
  return (res[size] && res[size].url) || (res.original && res.original.url) || null;
}

function channelInfo(ch) {
  if (!ch) return null;
  return {
    id: ch.id,
    name: ch.name,
    country: ch.country ? ch.country.code : null,
    timezone: ch.country ? ch.country.timezone : null,
  };
}

function slimShow(raw) {
  const images = (raw._embedded && raw._embedded.images) || [];
  const akas = (raw._embedded && raw._embedded.akas) || [];
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url,
    type: raw.type,
    language: raw.language,
    genres: raw.genres || [],
    status: raw.status,
    premiered: raw.premiered,
    ended: raw.ended,
    runtime: raw.runtime || raw.averageRuntime || null,
    officialSite: raw.officialSite,
    rating: raw.rating ? raw.rating.average : null,
    network: channelInfo(raw.network),
    webChannel: channelInfo(raw.webChannel),
    schedule: raw.schedule || null,
    poster: raw.image ? raw.image.medium : null,
    posterLarge: raw.image ? raw.image.original : null,
    logo: pickImage(images, 'typography'),
    banner: pickImage(images, 'banner', 'medium'),
    background: pickImage(images, 'background'),
    akas: [...new Set(akas.map((a) => a.name).filter((n) => n && n !== raw.name))],
    summary: raw.summary || '',
    weight: raw.weight || 0,
    externals: raw.externals || null,
    updated: raw.updated || 0,
  };
}

function slimEpisode(e) {
  return {
    id: e.id,
    season: e.season,
    number: e.number,
    name: e.name,
    type: e.type,
    airdate: e.airdate,
    airtime: e.airtime,
    airstamp: e.airstamp,
    runtime: e.runtime,
    image: e.image ? e.image.medium : null,
    summary: e.summary || '',
    url: e.url,
  };
}

/** Full show record: metadata + branding images + AKAs + all episodes, in one request. */
async function fetchShowFull(id) {
  const raw = await apiGet(`/shows/${id}?embed[]=episodes&embed[]=images&embed[]=akas`, { allow404: true });
  if (!raw) return null;
  const episodes = ((raw._embedded && raw._embedded.episodes) || [])
    .filter((e) => e.type !== 'insignificant_special')
    .map(slimEpisode);
  return { show: slimShow(raw), episodes, fetchedAt: Date.now() };
}

async function fetchSchedule(date, web = false) {
  return (await apiGet(`/schedule${web ? '/web' : ''}?date=${encodeURIComponent(date)}`)) || [];
}

async function fetchFullSchedule() {
  return (await apiGet('/schedule/full')) || [];
}

async function fetchAkas(id) {
  return (await apiGet(`/shows/${id}/akas`, { allow404: true })) || [];
}

async function searchShows(q) {
  const results = await apiGet(`/search/shows?q=${encodeURIComponent(q)}`);
  return (results || []).map((r) => ({ score: r.score, show: r.show }));
}

/** Map of showId -> last updated unix timestamp for shows changed in the given period. */
async function fetchUpdates(since = 'day') {
  return (await apiGet(`/updates/shows?since=${since}`)) || {};
}

/** Fetch show metadata + main cast & creators/showrunners in one API call. */
async function fetchShowPeople(id) {
  const raw = await apiGet(`/shows/${id}?embed[]=cast&embed[]=crew`, { allow404: true });
  if (!raw) return null;
  const cast = [];
  const castPeople = [];
  const seenCast = new Set();
  for (const c of (raw._embedded && raw._embedded.cast) || []) {
    const p = c && c.person;
    const name = p && p.name;
    if (name && !seenCast.has(name)) {
      seenCast.add(name);
      cast.push(name);
      castPeople.push({
        id: p.id || null,
        name,
        image: (p.image && p.image.medium) || (c.character && c.character.image && c.character.image.medium) || null,
        role: (c.character && c.character.name) || 'Cast',
      });
      if (cast.length >= 8) break;
    }
  }
  const crew = [];
  const crewPeople = [];
  const seenCrew = new Set();
  for (const cr of (raw._embedded && raw._embedded.crew) || []) {
    const p = cr && cr.person;
    const name = p && p.name;
    const type = String((cr && cr.type) || '');
    if (name && /creator|showrunner|executive producer|writer|director/i.test(type) && !seenCrew.has(name)) {
      seenCrew.add(name);
      crew.push({ name, role: type });
      crewPeople.push({
        id: p.id || null,
        name,
        image: (p.image && p.image.medium) || null,
        role: type,
      });
      if (crew.length >= 6) break;
    }
  }
  return { show: slimShow(raw), cast, crew, castPeople, crewPeople };
}

/** Fetch all shows an actor or creator is credited on in TVmaze cleanly. */
async function fetchPersonCredits(personId) {
  personId = Number(personId);
  if (!personId) return [];
  const [castRows, crewRows] = await Promise.all([
    apiGet(`/people/${personId}/castcredits?embed=show`, { allow404: true }).catch(() => []),
    apiGet(`/people/${personId}/crewcredits?embed=show`, { allow404: true }).catch(() => []),
  ]);
  const map = new Map();
  for (const row of [...(crewRows || []), ...(castRows || [])]) {
    const rawShow = row && row._embedded && row._embedded.show;
    if (!rawShow || !rawShow.id) continue;
    const prev = map.get(rawShow.id);
    const role = row.type || 'Cast';
    if (!prev) map.set(rawShow.id, { ...slimShow(rawShow), creditRole: role });
    else if (row.type && !prev.creditRole.includes(row.type)) prev.creditRole = `${prev.creditRole} · ${row.type}`;
  }
  return [...map.values()].sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.weight || 0) - (a.weight || 0));
}

async function searchPeople(q) {
  const rows = (await apiGet(`/search/people?q=${encodeURIComponent(q)}`, { allow404: true })) || [];
  return (Array.isArray(rows) ? rows : [])
    .slice(0, 8)
    .map((r) => r && r.person)
    .filter(Boolean)
    .map((p) => ({
      kind: 'person',
      tvmazePersonId: p.id,
      name: p.name,
      country: p.country ? p.country.name : null,
      image: (p.image && p.image.medium) || null,
    }));
}

/** Browse TVmaze global curated catalog page (250 shows per page). */
async function fetchShowsPage(page = 0) {
  const rows = (await apiGet(`/shows?page=${Math.max(0, Number(page) || 0)}`, { allow404: true })) || [];
  return Array.isArray(rows) ? rows.map(slimShow) : [];
}

/** Resolve a show by IMDb ID or fuzzy title/year on TVmaze so TMDB picks can be added cleanly. */
async function resolveShow({ imdbId = null, name = '', year = '' } = {}) {
  if (imdbId) {
    try {
      const raw = await apiGet(`/lookup/shows?imdb=${encodeURIComponent(imdbId)}`, { allow404: true });
      if (raw && raw.id) return slimShow(raw);
    } catch {
      /* fall through to name search */
    }
  }
  if (!name) return null;
  const hits = await searchShows(name);
  const target = name.trim().toLowerCase();
  const yStr = String(year || '').slice(0, 4);
  const ranked = hits
    .map((h) => {
      const s = h.show;
      const sn = String(s.name || '').trim().toLowerCase();
      let score = h.score || 0;
      if (sn === target) score += 20;
      if (yStr && String(s.premiered || '').startsWith(yStr)) score += 10;
      return { show: slimShow(s), score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0] ? ranked[0].show : null;
}

module.exports = {
  apiGet,
  fetchShowFull,
  fetchSchedule,
  fetchFullSchedule,
  fetchAkas,
  searchShows,
  fetchUpdates,
  fetchShowPeople,
  fetchPersonCredits,
  searchPeople,
  fetchShowsPage,
  resolveShow,
  slimShow,
  slimEpisode,
};
