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

module.exports = { apiGet, fetchShowFull, fetchSchedule, fetchFullSchedule, fetchAkas, searchShows, fetchUpdates, slimShow, slimEpisode };
