'use strict';

/**
 * Local End-User Deep-Dive Recommendation Engine.
 * Runs 100% locally on each user's machine against their own calendar, watched state,
 * hidden items, favorites, interests, and Discover feedback.
 *
 * Dual-mode architecture:
 *  - Works out of the box with TVmaze alone (free, no key): cast, creators, genres, networks,
 *    show types, ratings, summary narrative themes & global/upcoming catalog.
 *  - Automatically upgrades when the user provides a TMDB key: TMDB micro-keywords,
 *    studios, multi-hop co-watch recommendations/similar graphs & deep movie/TV discovery.
 */

const fs = require('fs');
const path = require('path');
const tvmaze = require('./tvmaze');
const tmdb = require('./tmdb');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TASTE_FILE = path.join(DATA_DIR, 'taste.json');
const CACHE_DIR = path.join(DATA_DIR, 'taste-cache');
const POOL_FILE = path.join(CACHE_DIR, 'pool.json');
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const POOL_TTL = 24 * 60 * 60 * 1000;

const TEXT_THEMES = [
  ['time loop', /\b(time[- ]loop|time travel|timelines?|temporal|alternate universe|multiverse|parallel world)\b/i],
  ['dystopia', /\b(dystopi\w*|post-?apocalypt\w*|apocalypse|wasteland|totalitarian|rebellion|uprising)\b/i],
  ['detective / whodunit', /\b(detective|investigat\w*|whodunit|cold case|forensic|homicide|murder mystery|serial killer)\b/i],
  ['espionage', /\b(spy|spies|espionage|cia|mi6|mossad|intelligence agency|undercover agent|operative|covert)\b/i],
  ['heist / con', /\b(heist|con artist|grifter|robbery|scam|smuggl\w*|cartel|syndicate)\b/i],
  ['psychological thriller', /\b(psychological|paranoi\w*|mind[- ]bend\w*|gaslight|obsession|twist|unreliable)\b/i],
  ['dark comedy', /\b(dark comedy|dark humor|black comedy|satire|satiric\w*|cynical|absurd|deadpan)\b/i],
  ['space opera', /\b(spaceship|spacecraft|interstellar|galaxy|galactic|planet|astronaut|mars|alien|extraterrestrial)\b/i],
  ['cyberpunk / ai', /\b(artificial intelligence|\bai\b|android|cyborg|hacker|virtual reality|cyber|simulation|biotech)\b/i],
  ['supernatural / occult', /\b(supernatural|vampire|ghost|haunted|witch|occult|demon|cursed|paranormal|folklore)\b/i],
  ['anthology', /\b(anthology|standalone episodes?|each episode|each season tells)\b/i],
  ['period drama', /\b(19th century|18th century|victorian|regency|medieval|world war|1920s|1940s|1960s|historical)\b/i],
  ['nordic / noir', /\b(noir|nordic|scandinavian|neo-noir|gritty|bleak|hardboiled)\b/i],
  ['workplace / satire', /\b(workplace|office|corporate|tech company|billionaire|media empire|newsroom|startup)\b/i],
  ['family dynasty', /\b(dynasty|patriarch|matriarch|inheritance|estranged family|generational|feuding family)\b/i],
  ['survival', /\b(stranded|wilderness|survival|isolated island|shipwreck|pandemic|outbreak|quarantine)\b/i],
  ['conspiracy', /\b(conspiracy|cover-?up|shadowy organization|corrupt|whistleblower|secret society)\b/i],
  ['legal / courtroom', /\b(lawyer|attorney|courtroom|trial|prosecutor|defense counsel|law firm)\b/i],
  ['medical drama', /\b(surgeon|hospital|emergency room|doctor|medical|clinic|diagnostic)\b/i],
  ['british wit', /\b(british|london|oxford|scotland|manchester|mi5|uk)\b/i],
  ['coming of age', /\b(coming-of-age|teenagers?|high school|boarding school|college freshmen)\b/i],
  ['true crime / doc', /\b(true crime|docuseries|investigative journalism|real-life case|interviews)\b/i],
];

const FEATURE_WEIGHT_MULT = {
  kw: 1.35,
  creator: 1.9,
  cast: 0.95,
  genre: 1.0,
  studio: 1.15,
  type: 0.85,
  lang: 0.55,
  era: 0.45,
};

const TMDB_GENRE_ID_BY_NAME = {
  Action: '28',
  Adventure: '12',
  Animation: '16',
  Comedy: '35',
  Crime: '80',
  Documentary: '99',
  Drama: '18',
  Family: '10751',
  Fantasy: '14',
  History: '36',
  Horror: '27',
  Music: '10402',
  Mystery: '9648',
  Romance: '10749',
  'Science-Fiction': '878',
  Thriller: '53',
  War: '10752',
  Western: '37',
};

const TMDB_TV_GENRE_ID_BY_NAME = {
  Action: '10759',
  Adventure: '10759',
  Animation: '16',
  Comedy: '35',
  Crime: '80',
  Documentary: '99',
  Drama: '18',
  Family: '10751',
  Fantasy: '10765',
  Mystery: '9648',
  'Science-Fiction': '10765',
  Thriller: '9648',
  Western: '37',
};

const state = {
  feedback: { show: {}, movie: {} }, // key -> { action: 'liked'|'seen'|'dislike', name, tvmazeId?, tmdbId?, imdbId?, genres?, network?, poster?, premiered?, rating?, type?, summary?, at }
  overrides: { boost: [], mute: [] },
  crosswalk: {}, // 'tv:<tvmazeId>' -> tmdbId, 'imdb:<imdbId>' -> tvmazeId
};

let pool = {
  updatedAt: 0,
  tmdbEnabled: false,
  items: [], // enriched candidate items
};

const job = {
  running: false,
  phase: '',
  done: 0,
  total: 0,
  lastRunAt: null,
  error: null,
};

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function load() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  state.feedback = { show: {}, movie: {} };
  state.overrides = { boost: [], mute: [] };
  state.crosswalk = {};
  if (fs.existsSync(TASTE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(TASTE_FILE, 'utf8'));
      if (raw.feedback && typeof raw.feedback === 'object') {
        state.feedback.show = raw.feedback.show && typeof raw.feedback.show === 'object' ? raw.feedback.show : {};
        state.feedback.movie = raw.feedback.movie && typeof raw.feedback.movie === 'object' ? raw.feedback.movie : {};
      }
      if (raw.overrides && typeof raw.overrides === 'object') {
        state.overrides.boost = Array.isArray(raw.overrides.boost) ? [...new Set(raw.overrides.boost.map(String))] : [];
        state.overrides.mute = Array.isArray(raw.overrides.mute) ? [...new Set(raw.overrides.mute.map(String))] : [];
      }
      if (raw.crosswalk && typeof raw.crosswalk === 'object') state.crosswalk = raw.crosswalk;
    } catch (err) {
      console.error('Could not read taste.json:', err.message);
    }
  }
  if (fs.existsSync(POOL_FILE)) {
    try {
      const rawPool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
      if (Array.isArray(rawPool.items)) {
        pool = {
          updatedAt: Number(rawPool.updatedAt) || 0,
          tmdbEnabled: Boolean(rawPool.tmdbEnabled),
          items: rawPool.items,
        };
      }
    } catch {
      /* rebuild later */
    }
  }
}

function save() {
  writeJson(TASTE_FILE, {
    feedback: state.feedback,
    overrides: state.overrides,
    crosswalk: state.crosswalk,
  });
}

function savePool() {
  writeJson(POOL_FILE, pool);
}

function itemCachePath(cacheKey) {
  return path.join(CACHE_DIR, `${String(cacheKey).replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

function readItemCache(cacheKey) {
  const file = itemCachePath(cacheKey);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || (raw.cachedAt && Date.now() - raw.cachedAt > CACHE_TTL)) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeItemCache(cacheKey, data) {
  try {
    writeJson(itemCachePath(cacheKey), { ...data, cachedAt: Date.now() });
  } catch {
    /* non-fatal cache write error */
  }
}

function normalizeTextThemes(text) {
  const clean = stripHtml(text);
  if (!clean) return [];
  const hits = [];
  for (const [label, re] of TEXT_THEMES) {
    if (re.test(clean)) hits.push(label);
  }
  return hits;
}

function eraBucket(ymd) {
  const y = Number(String(ymd || '').slice(0, 4));
  if (!y || y < 1950) return null;
  if (y < 2000) return 'pre-2000';
  if (y < 2010) return '2000s';
  if (y < 2020) return '2010s';
  return '2020s';
}

function extractFeatures(item) {
  const out = [];
  const seen = new Set();
  const push = (group, rawVal, label, weight = 1) => {
    const norm = String(rawVal || '')
      .trim()
      .toLowerCase();
    if (!norm || norm === 'unknown') return;
    const key = `${group}:${norm}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      key,
      group,
      label: String(label || rawVal).trim(),
      weight: weight * (FEATURE_WEIGHT_MULT[group] || 1),
    });
  };

  for (const g of item.genres || []) push('genre', g, g, 1.0);

  // Explicit TMDB keywords first
  for (const kw of item.keywords || []) {
    const name = typeof kw === 'string' ? kw : kw && kw.name;
    if (name && name.length >= 3 && name.length <= 36) push('kw', name, name, 1.15);
  }
  // Free text narrative themes work everywhere (zero TMDB key needed!)
  for (const theme of normalizeTextThemes(`${item.name || ''} ${item.summary || item.overview || ''}`)) {
    push('kw', theme, theme, 0.95);
  }

  for (const cr of item.creators || []) push('creator', cr, cr, 1.0);
  for (const cr of item.crew || []) {
    const name = typeof cr === 'string' ? cr : cr && cr.name;
    if (name) push('creator', name, name, 0.95);
  }
  for (const actor of (item.cast || []).slice(0, 6)) push('cast', actor, actor, 0.85);

  const studios = [...(item.studios || [])];
  const ch = (item.network && item.network.name) || (item.webChannel && item.webChannel.name) || item.channelName;
  if (ch) studios.unshift(ch);
  for (const st of [...new Set(studios)].slice(0, 4)) push('studio', st, st, 0.9);

  if (item.type) push('type', item.type, item.type, 1.0);
  if (item.language) push('lang', item.language, item.language, 0.7);
  const era = eraBucket(item.premiered);
  if (era) push('era', era, era, 0.65);

  return out;
}

function localShowRecord(store, id) {
  const c = store.getCached(id) || store.loadCachedFromDisk(id);
  const s = (c && c.show) || {};
  const deep = readItemCache(`tv_${id}`) || {};
  const tmdbDeep = deep.tmdbId ? readItemCache(`tmdb_tv_${deep.tmdbId}`) : null;
  let diskSummary = s.summary || '';
  if (!diskSummary && (!tmdbDeep || !tmdbDeep.summary)) {
    try {
      const full = JSON.parse(fs.readFileSync(path.join(store.CACHE_DIR, `${id}.json`), 'utf8'));
      if (full && full.show) diskSummary = full.show.summary || '';
    } catch {
      /* ignore */
    }
  }
  return {
    kind: 'show',
    tvmazeId: id,
    tmdbId: deep.tmdbId || null,
    imdbId: (s.externals && s.externals.imdb) || deep.imdbId || (tmdbDeep && tmdbDeep.imdbId) || null,
    name: s.name || `Show #${id}`,
    genres: s.genres && s.genres.length ? s.genres : (tmdbDeep && tmdbDeep.genres) || [],
    type: s.type || null,
    language: s.language || (tmdbDeep && tmdbDeep.language) || null,
    network: s.network || null,
    webChannel: s.webChannel || null,
    channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
    premiered: s.premiered || (tmdbDeep && tmdbDeep.premiered) || null,
    rating: s.rating || (tmdbDeep && tmdbDeep.rating) || null,
    poster: s.poster || (tmdbDeep && tmdbDeep.poster) || null,
    summary: stripHtml(diskSummary || (tmdbDeep && tmdbDeep.summary) || ''),
    keywords: [...new Set([...((tmdbDeep && tmdbDeep.keywords) || []).map((k) => k.name || k)])],
    creators: [...new Set([...(deep.crew || []).map((c) => c.name), ...((tmdbDeep && tmdbDeep.creators) || [])])],
    cast: [...new Set([...(deep.cast || []), ...((tmdbDeep && tmdbDeep.cast) || [])])],
    studios: (tmdbDeep && tmdbDeep.studios) || [],
    recommendations: (tmdbDeep && tmdbDeep.recommendations) || [],
    similar: (tmdbDeep && tmdbDeep.similar) || [],
  };
}

function localMovieRecord(movies, movieSummaryObj) {
  const m = movieSummaryObj && typeof movieSummaryObj === 'object' ? movieSummaryObj : {};
  const id = Number(m.id || movieSummaryObj);
  const tmdbDeep = readItemCache(`tmdb_movie_${id}`);
  const det = !m.summary && !(tmdbDeep && tmdbDeep.summary) ? movies.getMovieDetails(id) : null;
  return {
    kind: 'movie',
    tmdbId: id,
    imdbId: m.imdbId || (tmdbDeep && tmdbDeep.imdbId) || null,
    name: m.name || (tmdbDeep && tmdbDeep.name) || `Movie #${id}`,
    genres: (m.genres && m.genres.length ? m.genres : (tmdbDeep && tmdbDeep.genres)) || [],
    type: 'Movie',
    language: m.language || (tmdbDeep && tmdbDeep.language) || null,
    channelName: m.channelName || null,
    premiered: m.premiered || (tmdbDeep && tmdbDeep.premiered) || null,
    rating: m.rating || (tmdbDeep && tmdbDeep.rating) || null,
    poster: m.poster || (tmdbDeep && tmdbDeep.poster) || null,
    summary: stripHtml(m.summary || (det && det.summary) || (tmdbDeep && tmdbDeep.summary) || ''),
    keywords: ((tmdbDeep && tmdbDeep.keywords) || []).map((k) => k.name || k),
    creators: (tmdbDeep && tmdbDeep.creators) || [],
    cast: (tmdbDeep && tmdbDeep.cast) || [],
    studios: (tmdbDeep && tmdbDeep.studios) || [],
    recommendations: (tmdbDeep && tmdbDeep.recommendations) || [],
    similar: (tmdbDeep && tmdbDeep.similar) || [],
  };
}

function localHiddenRecord(entry, store, movies) {
  const kind = entry.kind === 'movie' ? 'movie' : 'show';
  const id = Number(entry.id);
  let base = {};
  if (kind === 'show') {
    const c = store.loadCachedFromDisk(id);
    if (c && c.show) base = localShowRecord(store, id);
  } else {
    const tmdbDeep = readItemCache(`tmdb_movie_${id}`);
    if (tmdbDeep) base = tmdbDeep;
  }
  return {
    kind,
    id,
    name: base.name || entry.name || `${kind} #${id}`,
    genres: base.genres || [],
    type: base.type || (kind === 'movie' ? 'Movie' : null),
    language: base.language || null,
    channelName: base.channelName || entry.channelName || null,
    premiered: base.premiered || entry.premiered || null,
    summary: base.summary || '',
    keywords: base.keywords || [],
    creators: base.creators || [],
    cast: base.cast || [],
    studios: base.studios || [],
  };
}

/** Collect user's positive & negative weighted taste signals purely from local data. */
function gatherTasteObservations({ store, movies, hidden, watched }) {
  const positives = [];
  const negatives = [];
  const anchors = [];
  const seenKeys = new Set();

  // Track episode watch intensity per show lightly (capped so 100-ep sitcom doesn't distort DNA)
  const watchedShows = new Set();
  for (const id of store.activeIds()) {
    const c = store.getCached(id) || store.loadCachedFromDisk(id);
    if (c && (c.episodes || []).some((e) => watched.has('episode', e.id))) watchedShows.add(id);
  }

  for (const s of store.listShows({ includeHidden: false })) {
    const rec = localShowRecord(store, s.id);
    const fb = state.feedback.show[String(s.id)];
    if (fb && fb.action === 'dislike') {
      negatives.push({ item: rec, weight: 3.5 });
      continue;
    }
    let w = s.source === 'auto-bimonthly' || s.source === 'auto-weekly' ? 0.7 : 2.1;
    if (s.favorite) w += 3.2;
    if (watchedShows.has(s.id)) w += 2.2;
    if (fb && fb.action === 'liked') w += 3.4;
    positives.push({ item: rec, weight: w });
    anchors.push({ ...rec, key: `show:${s.id}`, anchorWeight: w, favorite: Boolean(s.favorite) });
    seenKeys.add(`show:${s.id}`);
  }

  for (const m of movies.listMovies({ includeHidden: false })) {
    const rec = localMovieRecord(movies, m);
    const fb = state.feedback.movie[String(m.id)];
    if (fb && fb.action === 'dislike') {
      negatives.push({ item: rec, weight: 3.5 });
      continue;
    }
    let w = m.source === 'auto-bimonthly' || m.source === 'auto-weekly' ? 0.75 : 2.1;
    if (m.favorite) w += 3.2;
    if (watched.has('movie', m.id)) w += 2.3;
    if (fb && fb.action === 'liked') w += 3.4;
    positives.push({ item: rec, weight: w });
    anchors.push({ ...rec, key: `movie:${m.id}`, anchorWeight: w, favorite: Boolean(m.favorite) });
    seenKeys.add(`movie:${m.id}`);
  }

  // Explicit Discover feedback items not active on calendar (liked or disliked!)
  for (const [kind, bucket] of [
    ['show', state.feedback.show],
    ['movie', state.feedback.movie],
  ]) {
    for (const [keyStr, fb] of Object.entries(bucket || {})) {
      if (!fb || fb.action === 'seen') continue;
      const itemKey = `${kind}:${keyStr}`;
      if (seenKeys.has(itemKey)) continue;
      const cached =
        (fb.tvmazeId && readItemCache(`tv_${fb.tvmazeId}`)) ||
        (fb.tmdbId && readItemCache(`tmdb_${kind === 'movie' ? 'movie' : 'tv'}_${fb.tmdbId}`));
      const rec = {
        kind,
        tvmazeId: fb.tvmazeId || (Number(keyStr) && kind === 'show' && !String(keyStr).startsWith('tmdb_') ? Number(keyStr) : null),
        tmdbId: fb.tmdbId || (kind === 'movie' && Number(keyStr) ? Number(keyStr) : null),
        imdbId: fb.imdbId || null,
        name: fb.name || 'Item',
        genres: fb.genres || (cached && cached.genres) || [],
        type: fb.type || (cached && cached.type) || (kind === 'movie' ? 'Movie' : 'Scripted'),
        language: fb.language || (cached && cached.language) || null,
        channelName: fb.network || (cached && cached.channelName) || null,
        premiered: fb.premiered || (cached && cached.premiered) || null,
        poster: fb.poster || (cached && cached.poster) || null,
        rating: fb.rating || (cached && cached.rating) || null,
        summary: fb.summary || (cached && cached.summary) || '',
        keywords: (cached && cached.keywords) || [],
        creators: (cached && cached.creators) || [],
        cast: (cached && cached.cast) || [],
        studios: (cached && cached.studios) || [],
        recommendations: (cached && cached.recommendations) || [],
        similar: (cached && cached.similar) || [],
      };
      if (fb.action === 'liked') {
        positives.push({ item: rec, weight: 4.0 });
        anchors.push({ ...rec, key: itemKey, anchorWeight: 4.0, favorite: false, fromFeedback: true });
      } else if (fb.action === 'dislike') {
        negatives.push({ item: rec, weight: 3.2 });
      }
    }
  }

  // Hidden items: sample all local metadata (zero HTTP!) capped smoothly so large lists stay balanced
  const hiddenList = hidden.list().slice(0, 200);
  for (const h of hiddenList) {
    negatives.push({ item: localHiddenRecord(h, store, movies), weight: 1.15 });
  }

  // Explicit settings.interests priors
  const settings = store.getSettings();
  if (Array.isArray(settings.interests) && settings.interests.length) {
    positives.push({
      item: {
        name: 'User Interests',
        genres: settings.interests,
        keywords: [],
        creators: [],
        cast: [],
        studios: [],
      },
      weight: 2.6,
    });
  }

  anchors.sort((a, b) => b.anchorWeight - a.anchorWeight || Number(b.favorite) - Number(a.favorite));
  return { positives, negatives, anchors, hiddenCount: hidden.count(), interestCount: (settings.interests || []).length };
}

/** Build the unified TF-IDF + log-odds Taste DNA vector from local observations. */
function buildProfile({ store, movies, hidden, watched }) {
  const obs = gatherTasteObservations({ store, movies, hidden, watched });
  const posMass = new Map();
  const negMass = new Map();
  const docFreq = new Map();
  const metaByKey = new Map();

  let totalPos = 0;
  let totalNeg = 0;
  for (const { item, weight } of obs.positives) {
    const feats = extractFeatures(item);
    totalPos += weight;
    for (const f of feats) {
      const w = weight * f.weight;
      posMass.set(f.key, (posMass.get(f.key) || 0) + w);
      docFreq.set(f.key, (docFreq.get(f.key) || 0) + 1);
      if (!metaByKey.has(f.key)) metaByKey.set(f.key, { group: f.group, label: f.label });
    }
  }
  for (const { item, weight } of obs.negatives) {
    const feats = extractFeatures(item);
    totalNeg += weight;
    for (const f of feats) {
      const w = weight * f.weight;
      negMass.set(f.key, (negMass.get(f.key) || 0) + w);
      docFreq.set(f.key, (docFreq.get(f.key) || 0) + 1);
      if (!metaByKey.has(f.key)) metaByKey.set(f.key, { group: f.group, label: f.label });
    }
  }

  const totalDocs = Math.max(2, obs.positives.length + obs.negatives.length);
  const boostSet = new Set(state.overrides.boost || []);
  const muteSet = new Set(state.overrides.mute || []);
  const weights = new Map();
  const alpha = 1.6;
  const pDen = totalPos + 2 * alpha;
  const nDen = totalNeg + 2 * alpha;

  const allKeys = new Set([...posMass.keys(), ...negMass.keys(), ...boostSet, ...muteSet]);
  for (const key of allKeys) {
    const pm = posMass.get(key) || 0;
    const nm = negMass.get(key) || 0;
    let score;
    if (totalNeg > 0.5) {
      const pProb = (pm + alpha) / pDen;
      const nProb = (nm + alpha) / nDen;
      score = Math.log(pProb / nProb);
    } else {
      score = Math.log(1 + pm);
    }
    const df = docFreq.get(key) || 1;
    const idf = 0.75 + 0.55 * Math.log(1 + totalDocs / df);
    const support = Math.min(1, (pm + nm * 0.6) / 2.6);
    score = score * idf * (0.45 + 0.55 * support);

    // Language shouldn't drown out narrative DNA positively, only filter negatively or lightly prefer
    const grp = (metaByKey.get(key) && metaByKey.get(key).group) || key.split(':')[0];
    if (grp === 'lang' && score > 0) score = Math.min(score, 0.85);
    if (grp === 'era' && score > 0) score = Math.min(score, 0.75);

    if (boostSet.has(key)) score = Math.max(score + 2.4, 2.8);
    if (muteSet.has(key)) score = -3.8;

    if (Math.abs(score) >= 0.08) weights.set(key, score);
    if (!metaByKey.has(key)) {
      const idx = key.indexOf(':');
      metaByKey.set(key, { group: key.slice(0, idx), label: key.slice(idx + 1) });
    }
  }

  const rankedTraits = [...weights.entries()]
    .map(([key, score]) => {
      const m = metaByKey.get(key) || { group: 'kw', label: key };
      return {
        key,
        group: m.group,
        label: m.label,
        score: Math.round(score * 100) / 100,
        boosted: boostSet.has(key),
        muted: muteSet.has(key),
      };
    })
    .filter((t) => t.group !== 'lang' && t.group !== 'era');

  const rawPosTraits = rankedTraits
    .filter((t) => t.score > 0.35 || t.boosted)
    .sort((a, b) => Number(b.boosted) - Number(a.boosted) || b.score - a.score);
  const groupCaps = { kw: 7, genre: 4, creator: 4, studio: 3, cast: 3 };
  const groupSeen = {};
  const loves = [];
  for (const t of rawPosTraits) {
    const cap = groupCaps[t.group] || 4;
    if (t.boosted || (groupSeen[t.group] || 0) < cap) {
      loves.push(t);
      groupSeen[t.group] = (groupSeen[t.group] || 0) + 1;
      if (loves.length >= 18) break;
    }
  }

  const avoids = rankedTraits
    .filter((t) => t.score < -0.45 || t.muted)
    .sort((a, b) => Number(b.muted) - Number(a.muted) || a.score - b.score)
    .slice(0, 12);

  const signalCount = obs.positives.length + obs.hiddenCount + obs.interestCount;
  const confidence = Math.min(100, Math.round(obs.positives.length * 10 + Math.min(40, obs.hiddenCount * 0.25) + obs.interestCount * 5));
  const coldStart = obs.positives.length < 3;

  return {
    weights,
    metaByKey,
    anchors: obs.anchors.slice(0, 24),
    loves,
    avoids,
    coldStart,
    confidence,
    signalCount,
    positiveCount: obs.positives.length,
    negativeCount: obs.negatives.length,
    tmdbEnabled: tmdb.hasApiKey(),
  };
}

/** Collect a curated live cold-start grid from TVmaze (+ TMDB trending if active) with zero hardcoded fake IDs. */
async function buildStarterSeeds({ store, movies, hidden }) {
  const existing = readItemCache('starter_seeds');
  let seeds = existing && Array.isArray(existing.items) ? existing.items : null;

  if (!seeds || !seeds.length) {
    const picked = [];
    const seenGenres = new Set();
    try {
      const page0 = await tvmaze.fetchShowsPage(0);
      const sorted = page0
        .filter((s) => s.poster && s.rating >= 7.6 && s.language === 'English' && s.type !== 'Talk Show' && s.type !== 'News')
        .sort((a, b) => (b.weight || 0) - (a.weight || 0) || (b.rating || 0) - (a.rating || 0));
      for (const s of sorted) {
        const g0 = (s.genres && s.genres[0]) || 'General';
        if (picked.length < 8 && (!seenGenres.has(g0) || picked.length >= 5)) {
          seenGenres.add(g0);
          picked.push({
            key: `tvmaze:${s.id}`,
            kind: 'show',
            tvmazeId: s.id,
            tmdbId: null,
            name: s.name,
            genres: s.genres || [],
            type: s.type || 'Scripted',
            language: s.language || 'English',
            channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
            poster: s.poster,
            rating: s.rating,
            premiered: s.premiered,
            summary: stripHtml(s.summary).slice(0, 200),
          });
        }
        if (picked.length >= 8) break;
      }
    } catch {
      /* ignore network issues */
    }
    if (tmdb.hasApiKey()) {
      try {
        const trend = await tmdb.fetchTrending('movie');
        for (const m of trend.filter((x) => x.poster && (x.rating || 0) >= 6.8).slice(0, 4)) {
          picked.push({
            key: `tmdb-movie:${m.tmdbId}`,
            kind: 'movie',
            tvmazeId: null,
            tmdbId: m.tmdbId,
            name: m.name,
            genres: m.genres || [],
            type: 'Movie',
            language: m.language || 'English',
            channelName: 'TMDB Movie',
            poster: m.poster,
            rating: m.rating,
            premiered: m.premiered,
            summary: stripHtml(m.summary).slice(0, 200),
          });
        }
      } catch {
        /* ignore */
      }
    }
    seeds = picked;
    if (seeds.length) writeItemCache('starter_seeds', { items: seeds });
  }

  return seeds.filter((s) => {
    if (s.tvmazeId && (store.isTracked(s.tvmazeId) || hidden.has('show', s.tvmazeId) || state.feedback.show[String(s.tvmazeId)])) return false;
    if (s.tmdbId && s.kind === 'movie' && (movies.isTracked(s.tmdbId) || hidden.has('movie', s.tmdbId) || state.feedback.movie[String(s.tmdbId)])) return false;
    return true;
  });
}

async function enrichAnchorForGraph(anchor) {
  if (anchor.kind === 'show' && anchor.tvmazeId) {
    let deepTv = readItemCache(`tv_${anchor.tvmazeId}`);
    if (!deepTv) {
      try {
        const p = await tvmaze.fetchShowPeople(anchor.tvmazeId);
        if (p) {
          deepTv = {
            tvmazeId: anchor.tvmazeId,
            imdbId: (p.show.externals && p.show.externals.imdb) || null,
            thetvdb: (p.show.externals && p.show.externals.thetvdb) || null,
            cast: p.cast || [],
            crew: p.crew || [],
            castPeople: p.castPeople || [],
            crewPeople: p.crewPeople || [],
          };
          writeItemCache(`tv_${anchor.tvmazeId}`, deepTv);
        }
      } catch {
        /* keep lightweight local metadata */
      }
    }
    if (tmdb.hasApiKey()) {
      let tmdbId = (deepTv && deepTv.tmdbId) || state.crosswalk[`tv:${anchor.tvmazeId}`] || null;
      if (!tmdbId) {
        tmdbId = await tmdb.findTvByExternal({
          imdb: (deepTv && deepTv.imdbId) || anchor.imdbId || null,
          thetvdb: (deepTv && deepTv.thetvdb) || null,
          name: anchor.name,
          year: anchor.premiered,
        });
        if (tmdbId) {
          state.crosswalk[`tv:${anchor.tvmazeId}`] = tmdbId;
          if (deepTv) writeItemCache(`tv_${anchor.tvmazeId}`, { ...deepTv, tmdbId });
        }
      }
      if (tmdbId && !readItemCache(`tmdb_tv_${tmdbId}`)) {
        try {
          const td = await tmdb.fetchDeepProfile('show', tmdbId);
          if (td) writeItemCache(`tmdb_tv_${tmdbId}`, td);
        } catch {
          /* ignore */
        }
      }
    }
  } else if (anchor.kind === 'movie' && anchor.tmdbId && tmdb.hasApiKey()) {
    if (!readItemCache(`tmdb_movie_${anchor.tmdbId}`)) {
      try {
        const md = await tmdb.fetchDeepProfile('movie', anchor.tmdbId);
        if (md) writeItemCache(`tmdb_movie_${anchor.tmdbId}`, md);
      } catch {
        /* ignore */
      }
    }
  }
}

function candidateMatchesFilterSet(cand, exclusions) {
  const { trackedShows, trackedMovies, hidden, hiddenTitleKeys, trackedTitleKeys } = exclusions;
  if (cand.tvmazeId) {
    if (trackedShows.has(cand.tvmazeId) || hidden.has('show', cand.tvmazeId)) return false;
    if (state.feedback.show[String(cand.tvmazeId)]) return false;
  }
  if (cand.tmdbId && cand.kind === 'movie') {
    if (trackedMovies.has(cand.tmdbId) || hidden.has('movie', cand.tmdbId)) return false;
    if (state.feedback.movie[String(cand.tmdbId)]) return false;
  }
  if (cand.tmdbId && cand.kind === 'show' && state.feedback.show[`tmdb_${cand.tmdbId}`]) return false;

  const titleKey = `${cand.kind}:${String(cand.name || '').trim().toLowerCase()}`;
  if (trackedTitleKeys.has(titleKey) || hiddenTitleKeys.has(titleKey)) return false;
  return true;
}

function buildExclusions({ store, movies, hidden }) {
  const trackedShows = new Set(store.activeIds());
  const trackedMovies = new Set(movies.activeIds());
  const trackedTitleKeys = new Set();
  const hiddenTitleKeys = new Set();

  for (const s of store.listShows({ includeHidden: false })) {
    trackedTitleKeys.add(`show:${String(s.name || '').trim().toLowerCase()}`);
  }
  for (const m of movies.listMovies({ includeHidden: false })) {
    trackedTitleKeys.add(`movie:${String(m.name || '').trim().toLowerCase()}`);
  }
  for (const h of hidden.list()) {
    hiddenTitleKeys.add(`${h.kind === 'movie' ? 'movie' : 'show'}:${String(h.name || '').trim().toLowerCase()}`);
  }
  return { trackedShows, trackedMovies, hidden, hiddenTitleKeys, trackedTitleKeys };
}

/** Run the full local deep taste scan + candidate mining job cleanly in the background. */
function runDeepScan({ store, movies, hidden, watched, force = false } = {}) {
  if (job.running) return getJobStatus();
  Object.assign(job, {
    running: true,
    phase: 'Profiling your taste DNA…',
    done: 0,
    total: 5,
    error: null,
  });

  (async () => {
    try {
      const exclusions = buildExclusions({ store, movies, hidden });
      const initialProfile = buildProfile({ store, movies, hidden, watched });

      // Step 1: Enrich top positive anchors (skip already cached anchors so rebuilds stay fast!)
      const topAnchors = initialProfile.anchors.slice(0, 8);
      job.phase = tmdb.hasApiKey() ? 'Enriching favorites & watch history (TVmaze + TMDB)…' : 'Enriching favorites & watch history (TVmaze)…';
      job.done = 1;
      for (const a of topAnchors) {
        await enrichAnchorForGraph(a);
      }
      save();

      // Recompute profile now with rich anchor keywords, creators & cast
      const profile = buildProfile({ store, movies, hidden, watched });
      job.done = 2;

      // Step 2: Assemble candidates from TVmaze catalog/schedule + TMDB graph & targeted discover
      const rawMap = new Map(); // canonical id -> candidate
      const upsertCandidate = (cand, sourceTag = '', endorsedByAnchor = null) => {
        if (!cand || !cand.name) return;
        const normName = `${cand.kind}:${String(cand.name).trim().toLowerCase()}`;
        const existingKey = cand.tvmazeId
          ? `tv:${cand.tvmazeId}`
          : cand.tmdbId
          ? `${cand.kind === 'movie' ? 'tmov' : 'ttv'}:${cand.tmdbId}`
          : normName;

        // Also dedupe by title if both TVmaze and TMDB propose the same show!
        let targetKey = existingKey;
        if (!rawMap.has(targetKey)) {
          for (const [k, prev] of rawMap.entries()) {
            if (prev.kind === cand.kind && String(prev.name).trim().toLowerCase() === String(cand.name).trim().toLowerCase()) {
              targetKey = k;
              break;
            }
          }
        }
        const cur = rawMap.get(targetKey) || {
          key: cand.tvmazeId ? `tvmaze:${cand.tvmazeId}` : cand.kind === 'movie' ? `tmdb-movie:${cand.tmdbId}` : `tmdb-tv:${cand.tmdbId}`,
          kind: cand.kind,
          tvmazeId: cand.tvmazeId || null,
          tmdbId: cand.tmdbId || null,
          imdbId: cand.imdbId || null,
          name: cand.name,
          genres: cand.genres || [],
          type: cand.type || (cand.kind === 'movie' ? 'Movie' : 'Scripted'),
          language: cand.language || null,
          channelName: cand.channelName || null,
          network: cand.network || null,
          webChannel: cand.webChannel || null,
          premiered: cand.premiered || null,
          status: cand.status || null,
          runtime: cand.runtime || null,
          rating: cand.rating || null,
          voteCount: cand.voteCount || 0,
          weight: cand.weight || 0,
          popularity: cand.popularity || 0,
          poster: cand.poster || null,
          backdrop: cand.backdrop || null,
          summary: stripHtml(cand.summary || ''),
          keywords: cand.keywords || [],
          creators: cand.creators || [],
          cast: cand.cast || [],
          studios: cand.studios || [],
          url: cand.url || null,
          imdbUrl: cand.imdbUrl || null,
          endorsedBy: [],
          sources: [],
        };
        if (cand.tvmazeId && !cur.tvmazeId) cur.tvmazeId = cand.tvmazeId;
        if (cand.tmdbId && !cur.tmdbId) cur.tmdbId = cand.tmdbId;
        if (cand.imdbId && !cur.imdbId) cur.imdbId = cand.imdbId;
        if (cand.poster && !cur.poster) cur.poster = cand.poster;
        if (cand.backdrop && !cur.backdrop) cur.backdrop = cand.backdrop;
        if (cand.summary && cur.summary.length < cand.summary.length) cur.summary = stripHtml(cand.summary);
        if (cand.rating && (!cur.rating || cur.rating < cand.rating)) cur.rating = cand.rating;
        if (cand.voteCount > cur.voteCount) cur.voteCount = cand.voteCount;
        if (cand.genres && cand.genres.length > cur.genres.length) cur.genres = cand.genres;
        if (sourceTag && !cur.sources.includes(sourceTag)) cur.sources.push(sourceTag);
        if (endorsedByAnchor && !cur.endorsedBy.some((e) => e.name === endorsedByAnchor.name)) {
          cur.endorsedBy.push({ key: endorsedByAnchor.key, name: endorsedByAnchor.name, weight: endorsedByAnchor.anchorWeight });
        }
        rawMap.set(targetKey, cur);
      };

      // 2a: Collaborative graph neighbors from enriched anchors (0 extra network calls!)
      for (const a of profile.anchors.slice(0, 12)) {
        let deep = null;
        if (a.kind === 'show') {
          const tvMap = readItemCache(`tv_${a.tvmazeId}`);
          const tid = (tvMap && tvMap.tmdbId) || state.crosswalk[`tv:${a.tvmazeId}`];
          if (tid) deep = readItemCache(`tmdb_tv_${tid}`);
        } else if (a.tmdbId) {
          deep = readItemCache(`tmdb_movie_${a.tmdbId}`);
        }
        if (!deep) continue;
        for (const r of deep.recommendations || []) {
          if (candidateMatchesFilterSet(r, exclusions)) upsertCandidate(r, 'graph-rec', a);
        }
        for (const s of deep.similar || []) {
          if (candidateMatchesFilterSet(s, exclusions)) upsertCandidate(s, 'graph-sim', a);
        }
      }

      // 2b: TVmaze global curated catalog + upcoming schedule (always runs, even without TMDB key!)
      job.phase = 'Scanning global & upcoming TVmaze catalog…';
      try {
        const [p0, p1, sched] = await Promise.all([
          tvmaze.fetchShowsPage(0).catch(() => []),
          tvmaze.fetchShowsPage(1).catch(() => []),
          tvmaze.fetchFullSchedule().catch(() => []),
        ]);
        for (const s of [...p0, ...p1]) {
          const cand = {
            ...s,
            kind: 'show',
            tvmazeId: s.id,
            channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
          };
          if ((cand.rating || 0) >= 6.4 && candidateMatchesFilterSet(cand, exclusions)) {
            upsertCandidate(cand, 'tvmaze-catalog');
          }
        }
        const today = new Date().toISOString().slice(0, 10);
        for (const item of sched || []) {
          const s = (item._embedded && item._embedded.show) || item.show;
          if (!s || !s.id || !item.airdate || item.airdate < today) continue;
          const slim = tvmaze.slimShow(s);
          const cand = {
            ...slim,
            kind: 'show',
            tvmazeId: slim.id,
            upcomingDate: item.airdate,
            channelName: (slim.network && slim.network.name) || (slim.webChannel && slim.webChannel.name) || null,
          };
          if (candidateMatchesFilterSet(cand, exclusions)) {
            upsertCandidate(cand, 'tvmaze-upcoming');
          }
        }
      } catch (err) {
        console.error('TVmaze discover pool warning:', err.message);
      }
      job.done = 3;

      // 2c: Targeted TMDB /discover queries seeded from top learned genres/preferences
      if (tmdb.hasApiKey()) {
        job.phase = 'Mining TMDB hidden gems & upcoming releases…';
        const topGenres = profile.loves
          .filter((t) => t.group === 'genre')
          .map((t) => t.label)
          .slice(0, 3);
        const tvGenreIds = [...new Set(topGenres.map((g) => TMDB_TV_GENRE_ID_BY_NAME[g]).filter(Boolean))];
        const mvGenreIds = [...new Set(topGenres.map((g) => TMDB_GENRE_ID_BY_NAME[g]).filter(Boolean))];

        const queries = [
          tmdb.discoverDeep('tv', {
            ...(tvGenreIds.length ? { with_genres: tvGenreIds.join('|') } : {}),
            'vote_count.gte': 120,
            'vote_average.gte': 7.4,
            sort_by: 'vote_average.desc',
            page: 1,
          }),
          tmdb.discoverDeep('movie', {
            ...(mvGenreIds.length ? { with_genres: mvGenreIds.join('|') } : {}),
            'vote_count.gte': 250,
            'vote_average.gte': 7.1,
            sort_by: 'vote_average.desc',
            page: 1,
          }),
          tmdb.discoverDeep('movie', {
            ...(mvGenreIds.length ? { with_genres: mvGenreIds.join('|') } : {}),
            'vote_count.gte': 0,
            sort_by: 'popularity.desc',
            'primary_release_date.gte': new Date().toISOString().slice(0, 10),
            page: 1,
          }),
        ];
        const batches = await Promise.all(queries.map((p) => p.catch(() => [])));
        for (const [idx, rows] of batches.entries()) {
          for (const r of rows) {
            if (candidateMatchesFilterSet(r, exclusions)) upsertCandidate(r, idx === 2 ? 'tmdb-recent' : 'tmdb-gem');
          }
        }
      }
      job.done = 4;

      // Pre-score all candidates fast locally so we spend deep enrichment API budget ONLY on the strongest ~20 picks!
      const preScored = [...rawMap.values()]
        .map((c) => ({ cand: c, pre: scoreCandidate(c, profile).rawScore }))
        .sort((a, b) => b.pre - a.pre);

      job.phase = 'Deep-enriching top matches (cast, creators & themes)…';
      const toEnrich = preScored.slice(0, 26).map((x) => x.cand);
      let tvEnrichCount = 0;
      for (const c of toEnrich) {
        if (c.tmdbId && tmdb.hasApiKey()) {
          const cacheK = `tmdb_${c.kind === 'movie' ? 'movie' : 'tv'}_${c.tmdbId}`;
          let deep = readItemCache(cacheK);
          if (!deep) {
            try {
              deep = await tmdb.fetchDeepProfile(c.kind, c.tmdbId);
              if (deep) writeItemCache(cacheK, deep);
            } catch {
              /* continue cleanly */
            }
          }
          if (deep) {
            c.keywords = (deep.keywords || []).map((k) => k.name || k);
            c.creators = deep.creators || [];
            c.cast = deep.cast || [];
            c.studios = deep.studios || [];
            c.imdbId = c.imdbId || deep.imdbId || null;
            c.imdbUrl = c.imdbUrl || deep.imdbUrl || null;
            c.status = c.status || deep.status || null;
            c.runtime = c.runtime || deep.runtime || null;
            c.url = c.url || deep.url || null;
            if (!c.summary && deep.summary) c.summary = stripHtml(deep.summary);
          }
        } else if (c.tvmazeId && tvEnrichCount < 8) {
          let deepTv = readItemCache(`tv_${c.tvmazeId}`);
          if (!deepTv) {
            tvEnrichCount++;
            try {
              const p = await tvmaze.fetchShowPeople(c.tvmazeId);
              if (p) {
                deepTv = {
                  tvmazeId: c.tvmazeId,
                  imdbId: (p.show.externals && p.show.externals.imdb) || null,
                  cast: p.cast || [],
                  crew: p.crew || [],
                };
                writeItemCache(`tv_${c.tvmazeId}`, deepTv);
              }
            } catch {
              /* ignore */
            }
          }
          if (deepTv) {
            c.cast = deepTv.cast || [];
            c.creators = (deepTv.crew || []).map((cr) => cr.name);
            c.imdbId = c.imdbId || deepTv.imdbId || null;
          }
        }
      }

      pool = {
        updatedAt: Date.now(),
        tmdbEnabled: tmdb.hasApiKey(),
        items: preScored.slice(0, 220).map((x) => x.cand),
      };
      savePool();
      job.done = 5;
      job.phase = 'Done';
      job.lastRunAt = Date.now();
    } catch (err) {
      job.error = err.message;
      console.error('Discover deep scan error:', err);
    } finally {
      job.running = false;
    }
  })();

  return getJobStatus();
}

function buildAnchorWeightMap(anchor) {
  const m = new Map();
  if (!anchor) return m;
  for (const f of extractFeatures(anchor)) {
    m.set(f.key, (m.get(f.key) || 0) + 1.65 * f.weight);
  }
  return m;
}

function scoreCandidate(cand, profile, { anchor = null, anchorNeighborSet = null } = {}) {
  const feats = extractFeatures(cand);
  let rawScore = 0;
  const matched = [];
  const anchorWeights = anchor ? buildAnchorWeightMap(anchor) : null;

  for (const f of feats) {
    const baseW = profile.weights.get(f.key) || 0;
    const ancW = anchorWeights ? anchorWeights.get(f.key) || 0 : 0;
    const w = anchorWeights ? baseW * 0.45 + ancW * 0.85 : baseW;
    const contrib = w * Math.min(1.4, f.weight);
    rawScore += contrib;
    if (contrib >= 0.45 && f.group !== 'lang' && f.group !== 'era') {
      matched.push({ key: f.key, group: f.group, label: f.label, contrib });
    }
  }

  // Co-watch collaborative bonus
  const endorsed = cand.endorsedBy || [];
  let coWatchBonus = Math.min(4.8, endorsed.length * 1.45);
  if (anchor && anchorNeighborSet && (anchorNeighborSet.has(`t:${cand.tmdbId}`) || anchorNeighborSet.has(`n:${String(cand.name).toLowerCase()}`))) {
    coWatchBonus += 3.6;
  }
  rawScore += coWatchBonus;

  // Mild quality signal so critically acclaimed shows edge out low-rated noise cleanly
  const r = Number(cand.rating) || 0;
  if (r >= 7.0) rawScore += (r - 6.8) * 0.6;
  else if (r > 0 && r < 6.0) rawScore -= (6.0 - r) * 0.9;

  matched.sort((a, b) => b.contrib - a.contrib);

  // Build crisp human-readable "Why this matches you" lines
  const reasons = [];
  if (anchor && anchorNeighborSet && (anchorNeighborSet.has(`t:${cand.tmdbId}`) || anchorNeighborSet.has(`n:${String(cand.name).toLowerCase()}`))) {
    reasons.push(`Directly similar / co-watched with ${anchor.name}`);
  } else if (endorsed.length) {
    const names = endorsed.slice(0, 2).map((e) => e.name).join(' & ');
    reasons.push(`Watchers of ${names}${endorsed.length > 2 ? ` +${endorsed.length - 2}` : ''} also liked this`);
  }
  const creators = matched.filter((x) => x.group === 'creator').slice(0, 2).map((x) => x.label);
  if (creators.length) reasons.push(`Creator / talent overlap: ${creators.join(', ')}`);
  const cast = matched.filter((x) => x.group === 'cast').slice(0, 2).map((x) => x.label);
  if (cast.length && !creators.length) reasons.push(`Cast connection: ${cast.join(', ')}`);
  const kws = matched.filter((x) => x.group === 'kw').slice(0, 3).map((x) => x.label);
  if (kws.length) reasons.push(`Themes: ${kws.join(' · ')}`);
  const genres = matched.filter((x) => x.group === 'genre').slice(0, 2).map((x) => x.label);
  if (genres.length && reasons.length < 3) reasons.push(`Matches ${genres.join(' & ')}`);
  const studios = matched.filter((x) => x.group === 'studio').slice(0, 1).map((x) => x.label);
  if (studios.length && reasons.length < 3) reasons.push(`From ${studios[0]}`);
  if (!reasons.length && r >= 7.8) reasons.push(`Highly rated (${r}/10)`);

  return {
    rawScore,
    matchedTraits: matched.slice(0, 8),
    reasons: reasons.slice(0, 4),
  };
}

function getRecommendations({ store, movies, hidden, watched, media = 'all', lens = 'mix', anchorKey = '', limit = 36 } = {}) {
  const profile = buildProfile({ store, movies, hidden, watched });
  const exclusions = buildExclusions({ store, movies, hidden });
  const anchor = anchorKey ? profile.anchors.find((a) => a.key === anchorKey) || null : null;

  let anchorNeighborSet = null;
  if (anchor) {
    anchorNeighborSet = new Set();
    let deep = null;
    if (anchor.kind === 'show') {
      const tvMap = readItemCache(`tv_${anchor.tvmazeId}`);
      const tid = (tvMap && tvMap.tmdbId) || state.crosswalk[`tv:${anchor.tvmazeId}`];
      if (tid) deep = readItemCache(`tmdb_tv_${tid}`);
    } else if (anchor.tmdbId) {
      deep = readItemCache(`tmdb_movie_${anchor.tmdbId}`);
    }
    for (const r of (deep && [...(deep.recommendations || []), ...(deep.similar || [])]) || []) {
      if (r.tmdbId) anchorNeighborSet.add(`t:${r.tmdbId}`);
      if (r.name) anchorNeighborSet.add(`n:${String(r.name).trim().toLowerCase()}`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const candidates = pool.items.filter((c) => {
    if (!candidateMatchesFilterSet(c, exclusions)) return false;
    if (media === 'show' && c.kind !== 'show') return false;
    if (media === 'movie' && c.kind !== 'movie') return false;
    if (lens === 'binge' && !(c.kind === 'show' && /ended|canceled/i.test(c.status || ''))) return false;
    if (lens === 'upcoming') {
      const up = (c.upcomingDate && c.upcomingDate >= today) || (c.premiered && c.premiered >= today);
      if (!up) return false;
    }
    if (lens === 'gems') {
      const isMegahit = (c.popularity || 0) > 180 || (c.voteCount || 0) > 7000;
      if (isMegahit || ((c.rating || 0) > 0 && c.rating < 7.2)) return false;
    }
    return true;
  });

  const scored = candidates
    .map((c) => {
      const sc = scoreCandidate(c, profile, { anchor, anchorNeighborSet });
      return {
        ...c,
        rawScore: sc.rawScore,
        reasons: sc.reasons,
        matchedTraits: sc.matchedTraits,
      };
    })
    .sort((a, b) => b.rawScore - a.rawScore || (b.rating || 0) - (a.rating || 0));

  const maxScore = scored[0] ? Math.max(2, scored[0].rawScore) : 8;
  const minScore = scored.length ? Math.min(0, scored[scored.length - 1].rawScore) : 0;
  const span = Math.max(2.5, maxScore - minScore);

  const items = scored.slice(0, limit).map((c) => {
    const rel = Math.max(0, Math.min(1, (c.rawScore - minScore) / span));
    const matchPct = Math.round(62 + rel * 36);
    return {
      ...c,
      matchPct,
    };
  });

  return {
    items,
    poolCount: pool.items.length,
    poolUpdatedAt: pool.updatedAt,
    poolStale: !pool.updatedAt || Date.now() - pool.updatedAt > POOL_TTL || pool.tmdbEnabled !== tmdb.hasApiKey(),
    profile: {
      coldStart: profile.coldStart,
      confidence: profile.confidence,
      signalCount: profile.signalCount,
      positiveCount: profile.positiveCount,
      negativeCount: profile.negativeCount,
      tmdbEnabled: profile.tmdbEnabled,
      loves: profile.loves,
      avoids: profile.avoids,
      anchors: profile.anchors.map((a) => ({ key: a.key, kind: a.kind, name: a.name, favorite: Boolean(a.favorite) })),
    },
  };
}

/** Record user feedback (liked | seen | dislike | clear | track) and optionally hide or add to calendar. */
async function recordFeedback({ kind = 'show', id, tvmazeId = null, tmdbId = null, imdbId = null, action, item = null, store, movies, hidden, digest }) {
  const k = kind === 'movie' ? 'movie' : 'show';
  const fbKey = String(tvmazeId || (k === 'movie' ? tmdbId : id) || (tmdbId ? `tmdb_${tmdbId}` : id));

  if (action === 'clear') {
    delete state.feedback[k][fbKey];
    save();
    return { ok: true };
  }

  if (action === 'track') {
    let addedItem = null;
    if (k === 'movie') {
      const mId = Number(tmdbId || id);
      if (!mId) throw new Error('Missing TMDB movie ID');
      addedItem = await movies.addMovie(mId, 'discover');
    } else {
      let sId = Number(tvmazeId);
      if (!sId) {
        const resolved = await tvmaze.resolveShow({
          imdbId: imdbId || (item && item.imdbId) || null,
          name: (item && item.name) || '',
          year: (item && item.premiered) || '',
        });
        if (!resolved || !resolved.id) throw new Error(`Could not locate "${(item && item.name) || 'show'}" on TVmaze`);
        sId = resolved.id;
      }
      addedItem = await store.addShow(sId, 'discover');
    }
    if (addedItem) {
      state.feedback[k][String(addedItem.id)] = {
        action: 'liked',
        name: addedItem.name,
        tvmazeId: k === 'show' ? addedItem.id : null,
        tmdbId: k === 'movie' ? addedItem.id : tmdbId || null,
        genres: addedItem.genres || (item && item.genres) || [],
        poster: addedItem.poster || (item && item.poster) || null,
        at: Date.now(),
      };
      if (digest) {
        digest.record({
          kind: k,
          itemId: addedItem.id,
          event: 'added',
          title: addedItem.name,
          detail: 'Added from Discover recommendations',
        });
      }
      save();
    }
    return { ok: true, item: addedItem };
  }

  if (!['liked', 'seen', 'dislike'].includes(action)) {
    throw new Error('Invalid feedback action');
  }

  const record = {
    action,
    name: (item && item.name) || `${k} #${fbKey}`,
    tvmazeId: tvmazeId ? Number(tvmazeId) : null,
    tmdbId: tmdbId ? Number(tmdbId) : null,
    imdbId: imdbId || (item && item.imdbId) || null,
    genres: (item && item.genres) || [],
    type: (item && item.type) || null,
    language: (item && item.language) || null,
    network: (item && (item.channelName || (item.network && item.network.name))) || null,
    poster: (item && item.poster) || null,
    rating: (item && item.rating) || null,
    premiered: (item && item.premiered) || null,
    summary: stripHtml((item && item.summary) || '').slice(0, 320),
    at: Date.now(),
  };
  state.feedback[k][fbKey] = record;

  if (action === 'dislike' && hidden) {
    let hideId = k === 'movie' ? Number(tmdbId || id) : Number(tvmazeId);
    if (k === 'show' && !hideId && item && item.name) {
      try {
        const res = await tvmaze.resolveShow({ imdbId: record.imdbId, name: item.name, year: item.premiered });
        if (res && res.id) hideId = res.id;
      } catch {
        /* still keep negative taste signal in taste.json */
      }
    }
    if (hideId) {
      hidden.add({
        id: hideId,
        kind: k,
        name: record.name,
        poster: record.poster,
        channelName: record.network,
        channelKind: k === 'movie' ? 'stream' : 'tv',
        premiered: record.premiered,
        record: { id: hideId, source: 'discover', addedAt: Date.now() },
      });
    }
  }

  save();
  return { ok: true, action };
}

function updateTraitOverrides({ toggleBoost = '', toggleMute = '', boost = null, mute = null } = {}) {
  const b = new Set(Array.isArray(boost) ? boost.map(String) : state.overrides.boost);
  const m = new Set(Array.isArray(mute) ? mute.map(String) : state.overrides.mute);
  if (toggleBoost) {
    const k = String(toggleBoost);
    if (b.has(k)) b.delete(k);
    else {
      b.add(k);
      m.delete(k);
    }
  }
  if (toggleMute) {
    const k = String(toggleMute);
    if (m.has(k)) m.delete(k);
    else {
      m.add(k);
      b.delete(k);
    }
  }
  state.overrides = { boost: [...b], mute: [...m] };
  save();
  return state.overrides;
}

function getJobStatus() {
  return {
    running: job.running,
    phase: job.phase,
    done: job.done,
    total: job.total,
    lastRunAt: job.lastRunAt || pool.updatedAt || null,
    error: job.error,
    poolCount: pool.items.length,
  };
}

function exportData() {
  return {
    feedback: state.feedback,
    overrides: state.overrides,
    crosswalk: state.crosswalk,
  };
}

function importData(raw = {}, { replace = false } = {}) {
  if (replace) {
    state.feedback = { show: {}, movie: {} };
    state.overrides = { boost: [], mute: [] };
    state.crosswalk = {};
  }
  if (raw.feedback && typeof raw.feedback === 'object') {
    if (raw.feedback.show) Object.assign(state.feedback.show, raw.feedback.show);
    if (raw.feedback.movie) Object.assign(state.feedback.movie, raw.feedback.movie);
  }
  if (raw.overrides) {
    state.overrides.boost = [...new Set([...state.overrides.boost, ...(raw.overrides.boost || [])])];
    state.overrides.mute = [...new Set([...state.overrides.mute, ...(raw.overrides.mute || [])])];
  }
  if (raw.crosswalk && typeof raw.crosswalk === 'object') {
    Object.assign(state.crosswalk, raw.crosswalk);
  }
  save();
}

module.exports = {
  load,
  buildProfile,
  buildStarterSeeds,
  runDeepScan,
  getRecommendations,
  recordFeedback,
  updateTraitOverrides,
  getJobStatus,
  exportData,
  importData,
  stripHtml,
  normalizeTextThemes,
  readItemCache,
  writeItemCache,
  getFeedbackAction: (kind, id) => {
    const b = state.feedback[kind === 'movie' ? 'movie' : 'show'] || {};
    const f = b[String(id)];
    return f ? f.action : null;
  },
  getCrosswalkTmdbId: (tvmazeId) => state.crosswalk[`tv:${tvmazeId}`] || null,
};
