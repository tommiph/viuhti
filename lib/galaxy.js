'use strict';

/**
 * Graxobolt 3D Graph Engine (lib/galaxy.js).
 * Computes semantic 3D nebula layouts & on-demand constellation expansions
 * across TVmaze and TMDB metadata (shows, movies, creators, actors & themes).
 */

const tvmaze = require('./tvmaze');
const tmdb = require('./tmdb');
const recommender = require('./recommender');
const wiki = require('./wiki');

const PERSON_COLOR = '#22d3ee';
const THEME_COLOR = '#a855f7';
const SOURCE_COLOR = '#f472b6';

function hashFloat(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function itemStateFlags({ kind, tvmazeId, tmdbId, name, store, movies, hidden, watched }) {
  const k = kind === 'movie' ? 'movie' : 'show';
  let tracked = false;
  let favorite = false;
  let directorsChoice = false;
  let isWatched = false;
  let isHidden = false;

  if (k === 'show' && tvmazeId) {
    tracked = store.isTracked(tvmazeId);
    isHidden = hidden.has('show', tvmazeId);
    if (tracked) {
      const meta = store.getShowMeta(tvmazeId);
      favorite = Boolean(meta && meta.favorite);
      directorsChoice = Boolean(meta && meta.directorsChoice && meta.directorsChoice.enabled);
      const c = store.getCached(tvmazeId) || store.loadCachedFromDisk(tvmazeId);
      isWatched = Boolean(c && (c.episodes || []).some((e) => watched.has('episode', e.id)));
    }
  } else if (k === 'movie' && tmdbId) {
    tracked = movies.isTracked(tmdbId);
    isHidden = hidden.has('movie', tmdbId);
    if (tracked) {
      const meta = movies.getMovieMeta(tmdbId);
      favorite = Boolean(meta && meta.favorite);
      isWatched = watched.has('movie', tmdbId);
    }
  }

  const fb = recommender.getFeedbackAction(k, k === 'movie' ? tmdbId : tvmazeId || (tmdbId ? `tmdb_${tmdbId}` : name));
  const loved = fb === 'liked';
  const seen = fb === 'seen' || isWatched;
  return { tracked, favorite, directorsChoice, watched: isWatched, seen, loved, hidden: isHidden };
}

async function fetchDeepShowRecord(tvmazeId, fallback = {}) {
  let tv = recommender.readItemCache(`tv_${tvmazeId}`);
  let cachedShow = null;
  if (!tv || !tv.castPeople) {
    try {
      const p = await tvmaze.fetchShowPeople(tvmazeId);
      if (p) {
        cachedShow = p.show;
        tv = {
          tvmazeId,
          imdbId: (p.show.externals && p.show.externals.imdb) || null,
          thetvdb: (p.show.externals && p.show.externals.thetvdb) || null,
          cast: p.cast || [],
          crew: p.crew || [],
          castPeople: p.castPeople || [],
          crewPeople: p.crewPeople || [],
          name: p.show.name,
          poster: p.show.poster,
          rating: p.show.rating,
          premiered: p.show.premiered,
          status: p.show.status,
          genres: p.show.genres || [],
          network: (p.show.network && p.show.network.name) || (p.show.webChannel && p.show.webChannel.name) || null,
          summary: recommender.stripHtml(p.show.summary || ''),
        };
        recommender.writeItemCache(`tv_${tvmazeId}`, tv);
      }
    } catch {
      /* ignore network hiccup */
    }
  }

  let tmdbDeep = null;
  if (tmdb.hasApiKey()) {
    let tid = (tv && tv.tmdbId) || recommender.getCrosswalkTmdbId(tvmazeId) || fallback.tmdbId || null;
    if (!tid) {
      tid = await tmdb.findTvByExternal({
        imdb: (tv && tv.imdbId) || fallback.imdbId || null,
        thetvdb: (tv && tv.thetvdb) || null,
        name: (tv && tv.name) || fallback.name || '',
        year: (tv && tv.premiered) || fallback.premiered || '',
      });
      if (tid && tv) {
        recommender.writeItemCache(`tv_${tvmazeId}`, { ...tv, tmdbId: tid });
      }
    }
    if (tid) {
      tmdbDeep = recommender.readItemCache(`tmdb_tv_${tid}`);
      if (!tmdbDeep || !tmdbDeep.castPeople) {
        tmdbDeep = await tmdb.fetchDeepProfile('show', tid).catch(() => null);
        if (tmdbDeep) recommender.writeItemCache(`tmdb_tv_${tid}`, tmdbDeep);
      }
    }
  }

  const baseName = (tv && tv.name) || (tmdbDeep && tmdbDeep.name) || fallback.name || `Show #${tvmazeId}`;
  const summary = recommender.stripHtml((tv && tv.summary) || (tmdbDeep && tmdbDeep.summary) || fallback.summary || '');
  return {
    kind: 'show',
    tvmazeId,
    tmdbId: (tmdbDeep && tmdbDeep.tmdbId) || (tv && tv.tmdbId) || fallback.tmdbId || null,
    imdbId: (tv && tv.imdbId) || (tmdbDeep && tmdbDeep.imdbId) || fallback.imdbId || null,
    name: baseName,
    poster: (cachedShow && cachedShow.poster) || (tv && tv.poster) || (tmdbDeep && tmdbDeep.poster) || fallback.poster || null,
    rating: (tv && tv.rating) || (tmdbDeep && tmdbDeep.rating) || fallback.rating || null,
    premiered: (tv && tv.premiered) || (tmdbDeep && tmdbDeep.premiered) || fallback.premiered || null,
    status: (tv && tv.status) || (tmdbDeep && tmdbDeep.status) || fallback.status || null,
    genres: (tv && tv.genres && tv.genres.length ? tv.genres : (tmdbDeep && tmdbDeep.genres) || fallback.genres) || [],
    channelName: (tv && tv.network) || (tmdbDeep && tmdbDeep.studios && tmdbDeep.studios[0]) || fallback.channelName || null,
    studios: (tmdbDeep && tmdbDeep.studios) || (tv && tv.network ? [tv.network] : []),
    tagline: (tmdbDeep && tmdbDeep.tagline) || '',
    summary,
    keywords: (tmdbDeep && tmdbDeep.keywords) || [],
    themes: recommender.normalizeTextThemes(`${baseName} ${summary}`),
    castPeople: [...((tv && tv.castPeople) || []), ...((tmdbDeep && tmdbDeep.castPeople) || [])],
    creatorPeople: [...((tv && tv.crewPeople) || []), ...((tmdbDeep && tmdbDeep.creatorPeople) || [])],
    recommendations: (tmdbDeep && tmdbDeep.recommendations) || [],
    similar: (tmdbDeep && tmdbDeep.similar) || [],
  };
}

async function fetchDeepMovieRecord(tmdbId, fallback = {}) {
  let deep = recommender.readItemCache(`tmdb_movie_${tmdbId}`);
  if (!deep || !deep.castPeople) {
    deep = await tmdb.fetchDeepProfile('movie', tmdbId).catch(() => null);
    if (deep) recommender.writeItemCache(`tmdb_movie_${tmdbId}`, deep);
  }
  const d = deep || {};
  const summary = recommender.stripHtml(d.summary || fallback.summary || '');
  const name = d.name || fallback.name || `Movie #${tmdbId}`;
  return {
    kind: 'movie',
    tvmazeId: null,
    tmdbId,
    imdbId: d.imdbId || fallback.imdbId || null,
    name,
    poster: d.poster || fallback.poster || null,
    rating: d.rating || fallback.rating || null,
    premiered: d.premiered || fallback.premiered || null,
    status: d.status || 'Released',
    genres: (d.genres && d.genres.length ? d.genres : fallback.genres) || [],
    channelName: (d.studios && d.studios[0]) || fallback.channelName || null,
    studios: d.studios || [],
    tagline: d.tagline || fallback.tagline || '',
    summary,
    keywords: d.keywords || [],
    themes: recommender.normalizeTextThemes(`${name} ${summary}`),
    castPeople: d.castPeople || [],
    creatorPeople: d.creatorPeople || [],
    recommendations: d.recommendations || [],
    similar: d.similar || [],
  };
}

function makeMediaKey(kind, tvmazeId, tmdbId, name) {
  if (kind === 'movie' && tmdbId) return `movie:tmdb:${tmdbId}`;
  if (kind === 'show' && tvmazeId) return `show:tv:${tvmazeId}`;
  if (kind === 'show' && tmdbId) return `show:tmdb:${tmdbId}`;
  return `${kind}:name:${String(name || '').trim().toLowerCase()}`;
}

/** Smooth 3D deterministic force-directed relaxation keeping clusters crisp inside bounds. */
function computeForceLayout3D(nodes, edges, { lockSeed = false } = {}) {
  const n = nodes.length;
  if (!n) return;

  // Assign deterministic initial spherical positions by cluster/group so related nebulas cluster together cleanly
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    if (nd.fixed) continue;
    const seedAngle = hashFloat(nd.clusterHint || nd.kind || nd.key) * Math.PI * 2;
    const t = (i + 0.5) / Math.max(1, n);
    const phi = Math.acos(1 - 2 * t) * 0.82;
    const r = nd.kind === 'theme' ? 68 : nd.kind === 'source' ? 72 : nd.kind === 'person' ? 84 : nd.tracked ? 76 : 114 + hashFloat(nd.key) * 42;
    if (lockSeed) {
      // Fan seeded constellation forward into a balanced 3D cone ahead of the seed POV (z = -55..-140)
      const seedSpan = (i + 0.5) / Math.max(1, n);
      const goldenTilt = (i * 2.399963) % (Math.PI * 2);
      const depth = 62 + seedSpan * 68 + hashFloat(nd.key) * 18;
      const spreadR = depth * (nd.kind === 'person' ? 0.34 : nd.kind === 'source' ? 0.38 : nd.kind === 'theme' ? 0.42 : 0.48);
      nd.x = Math.cos(goldenTilt) * spreadR;
      nd.y = Math.sin(goldenTilt) * spreadR * 0.62;
      nd.z = -depth;
    } else {
      const theta = goldenAngle * i + seedAngle;
      nd.x = r * Math.sin(phi) * Math.cos(theta);
      nd.y = (r * Math.cos(phi)) * 0.72; // slight galactic disc flattening looks epic cleanly!
      nd.z = r * Math.sin(phi) * Math.sin(theta);
    }
  }

  const byKey = new Map(nodes.map((nd, idx) => [nd.key, idx]));
  const dispX = new Float64Array(n);
  const dispY = new Float64Array(n);
  const dispZ = new Float64Array(n);
  const iters = Math.min(48, Math.max(24, Math.round(9000 / Math.max(20, n))));

  for (let iter = 0; iter < iters; iter++) {
    dispX.fill(0);
    dispY.fill(0);
    dispZ.fill(0);
    const step = 0.28 * (1 - iter / (iters + 4));

    // Pairwise repulsion (capped cleanly for <= 180 nodes -> <16k pairs, ~2ms!)
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 4) {
          dx = (hashFloat(a.key + j) - 0.5) * 4;
          dy = (hashFloat(b.key + i) - 0.5) * 4;
          dz = (hashFloat(a.key + b.key) - 0.5) * 4;
          d2 = dx * dx + dy * dy + dz * dz + 1;
        }
        if (d2 > 22000) continue;
        const inv = 620 / d2;
        dispX[i] += dx * inv;
        dispY[i] += dy * inv;
        dispZ[i] += dz * inv;
        dispX[j] -= dx * inv;
        dispY[j] -= dy * inv;
        dispZ[j] -= dz * inv;
      }
    }

    // Spring attraction along synaptic edges
    for (const e of edges) {
      const ia = byKey.get(e.source);
      const ib = byKey.get(e.target);
      if (ia === undefined || ib === undefined) continue;
      const a = nodes[ia];
      const b = nodes[ib];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const targetLen = e.rel === 'cowatch' ? 32 : e.rel === 'creator' || e.rel === 'composer' ? 37 : e.rel === 'adapted' || e.rel === 'author' ? 39 : 48;
      const pull = ((dist - targetLen) / dist) * (e.weight || 0.7) * 0.22;
      dispX[ia] += dx * pull;
      dispY[ia] += dy * pull;
      dispZ[ia] += dz * pull;
      dispX[ib] -= dx * pull;
      dispY[ib] -= dy * pull;
      dispZ[ib] -= dz * pull;
    }

    // Gentle galactic disc pull + soft boundary
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      if (nd.fixed || (lockSeed && nd.seed)) {
        nd.x = 0;
        nd.y = 0;
        nd.z = 0;
        continue;
      }
      nd.x += Math.max(-18, Math.min(18, dispX[i] * step - nd.x * 0.018));
      nd.y += Math.max(-14, Math.min(14, dispY[i] * step - nd.y * 0.032));
      nd.z += Math.max(-18, Math.min(18, dispZ[i] * step - nd.z * 0.018));
      if (lockSeed) {
        if (nd.z > -52) nd.z = -52 - (Math.abs(nd.z) % 28);
        const depth = Math.abs(nd.z);
        const maxR = depth * 0.68;
        const xyR = Math.hypot(nd.x, nd.y * 1.45);
        if (xyR > maxR && xyR > 1) {
          const s = maxR / xyR;
          nd.x *= s;
          nd.y *= s;
        }
      }
    }
  }

  // Final angular de-crowding pass in POV mode so neighboring stars/labels separate crisply
  if (lockSeed && n > 2) {
    for (let pass = 0; pass < 10; pass++) {
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        if (a.seed || a.fixed) continue;
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          if (b.seed || b.fixed) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dz = a.z - b.z;
          const d = Math.hypot(dx, dy, dz) || 0.1;
          if (d < 24) {
            const push = (24 - d) * 0.35;
            const nx = dx / d;
            const ny = dy / d;
            const nz = dz / d;
            a.x += nx * push;
            a.y += ny * push * 0.85;
            a.z = Math.min(-52, a.z + nz * push * 0.5);
            b.x -= nx * push;
            b.y -= ny * push * 0.85;
            b.z = Math.min(-52, b.z - nz * push * 0.5);
          }
        }
      }
    }
  }
}

function buildNebulaClusters(nodes) {
  const clusters = [];
  const themeHubs = nodes
    .filter((n) => n.kind === 'theme' || (n.kind === 'person' && (n.degree || 0) >= 2) || n.seed)
    .sort((a, b) => (b.degree || 1) - (a.degree || 1))
    .slice(0, 7);

  for (const h of themeHubs) {
    clusters.push({
      id: `cl:${h.key}`,
      label: h.name,
      kind: h.kind,
      x: Math.round(h.x * 10) / 10,
      y: Math.round(h.y * 10) / 10,
      z: Math.round(h.z * 10) / 10,
      radius: h.seed ? 58 : 46 + Math.min(26, (h.degree || 1) * 4),
    });
  }
  return clusters;
}

/** Entry Point A: Build the user's Taste Galaxy from Favorites, Tracked, Top Recommendations & Learned Nebula Hubs. */
async function buildTasteGalaxy({ store, movies, hidden, watched, showDarkMatter = false } = {}) {
  const recData = recommender.getRecommendations({ store, movies, hidden, watched, media: 'all', lens: 'mix', limit: 40 });
  const prof = recommender.buildProfile({ store, movies, hidden, watched });

  const nodeMap = new Map();
  const edgeMap = new Map();
  const addNode = (nd) => {
    if (!nd || !nd.key) return null;
    const prev = nodeMap.get(nd.key);
    if (prev) {
      if (nd.poster && !prev.poster) prev.poster = nd.poster;
      if (nd.summary && !prev.summary) prev.summary = nd.summary;
      if (nd.matchPct && (!prev.matchPct || nd.matchPct > prev.matchPct)) prev.matchPct = nd.matchPct;
      if (nd.tracked) prev.tracked = true;
      if (nd.favorite) prev.favorite = true;
      return prev;
    }
    nodeMap.set(nd.key, { degree: 0, ...nd });
    return nodeMap.get(nd.key);
  };
  const addEdge = (a, b, rel, label, weight = 0.7) => {
    if (!a || !b || a === b) return;
    const [k1, k2] = a < b ? [a, b] : [b, a];
    const ek = `${k1}|${k2}|${rel}`;
    if (!edgeMap.has(ek)) {
      edgeMap.set(ek, { source: a, target: b, rel, label: label || rel, weight });
    }
  };

  // Seed starter items if cold-start empty install so everyone sees a living galaxy on Day 1!
  let seedItems = recData.items || [];
  let seedsEmptyNotice = false;
  if (prof.positiveCount < 2 && seedItems.length < 4) {
    seedsEmptyNotice = true;
    const starters = await recommender.buildStarterSeeds({ store, movies, hidden });
    seedItems = [...seedItems, ...starters.map((s) => ({ ...s, matchPct: 86, reasons: [`Popular ${(s.genres && s.genres[0]) || 'pick'}`] }))];
  }

  // 1. Active Show & Movie Stars (top 14 anchors by weight + favorites)
  const anchors = prof.anchors.slice(0, 14);
  for (const a of anchors) {
    const key = makeMediaKey(a.kind, a.tvmazeId, a.tmdbId, a.name);
    const flags = itemStateFlags({ kind: a.kind, tvmazeId: a.tvmazeId, tmdbId: a.tmdbId, name: a.name, store, movies, hidden, watched });
    const n = addNode({
      key,
      kind: a.kind,
      tvmazeId: a.tvmazeId || null,
      tmdbId: a.tmdbId || null,
      imdbId: a.imdbId || null,
      name: a.name,
      poster: a.poster || null,
      rating: a.rating || null,
      premiered: a.premiered || null,
      genres: a.genres || [],
      channelName: a.channelName || null,
      summary: a.summary || '',
      clusterHint: (a.genres && a.genres[0]) || a.channelName || a.name,
      size: flags.favorite ? 1.55 : 1.25,
      ...flags,
    });
    // Wire top creators/themes cleanly onto local node list
    attachCachedConnections(a, key, addNode, addEdge);
    if (n && !a.summary && a.tvmazeId) {
      const tvC = recommender.readItemCache(`tv_${a.tvmazeId}`);
      if (tvC && tvC.summary) n.summary = tvC.summary;
    }
  }

  // 2. Discover Recommendation Stars (top 36)
  for (const r of seedItems.slice(0, 36)) {
    const key = makeMediaKey(r.kind, r.tvmazeId, r.tmdbId, r.name);
    const flags = itemStateFlags({ kind: r.kind, tvmazeId: r.tvmazeId, tmdbId: r.tmdbId, name: r.name, store, movies, hidden, watched });
    addNode({
      key,
      kind: r.kind,
      tvmazeId: r.tvmazeId || null,
      tmdbId: r.tmdbId || null,
      imdbId: r.imdbId || null,
      name: r.name,
      poster: r.poster || null,
      rating: r.rating || null,
      premiered: r.premiered || null,
      status: r.status || null,
      genres: r.genres || [],
      channelName: r.channelName || (r.studios && r.studios[0]) || null,
      summary: r.summary || '',
      matchPct: r.matchPct || 80,
      reasons: r.reasons || [],
      clusterHint: (r.genres && r.genres[0]) || (r.keywords && r.keywords[0]) || r.name,
      size: 0.95 + ((r.matchPct || 75) - 65) / 80,
      ...flags,
    });
    attachCachedConnections(r, key, addNode, addEdge);
    for (const end of r.endorsedBy || []) {
      const aKey = nodeMap.has(end.key)
        ? end.key
        : [...nodeMap.values()].find((x) => String(x.name).toLowerCase() === String(end.name).toLowerCase())?.key;
      if (aKey) addEdge(aKey, key, 'cowatch', `Co-watched with ${end.name}`, 1.15);
    }
  }

  // Prune ultra-low-degree person/theme hubs (degree < 2 AND not boosted/top love) so galaxy stays dramatic & clean!
  const hubDegrees = new Map();
  for (const e of edgeMap.values()) {
    hubDegrees.set(e.source, (hubDegrees.get(e.source) || 0) + 1);
    hubDegrees.set(e.target, (hubDegrees.get(e.target) || 0) + 1);
  }
  const keptNodes = [];
  const keptSet = new Set();
  const topThemeNames = new Set((prof.loves || []).slice(0, 12).map((l) => String(l.label || '').toLowerCase()));
  for (const nd of nodeMap.values()) {
    nd.degree = hubDegrees.get(nd.key) || 0;
    if ((nd.kind === 'person' || nd.kind === 'theme') && nd.degree < 2 && !topThemeNames.has(nd.name.toLowerCase())) {
      continue;
    }
    keptNodes.push(nd);
    keptSet.add(nd.key);
  }
  // Keep top ~95 nodes cleanly on initial taste galaxy so edges never overwhelm 60fps
  const finalNodes = keptNodes.slice(0, 95);
  const finalSet = new Set(finalNodes.map((n) => n.key));
  const finalEdges = [...edgeMap.values()].filter((e) => finalSet.has(e.source) && finalSet.has(e.target));

  // Optional Dark Matter hidden outer ring
  if (showDarkMatter) {
    const hidSample = hidden.list().slice(0, 14);
    hidSample.forEach((h, idx) => {
      const hk = `hidden:${h.kind}:${h.id}`;
      const ang = (idx / Math.max(1, hidSample.length)) * Math.PI * 2;
      finalNodes.push({
        key: hk,
        kind: h.kind,
        tvmazeId: h.kind === 'show' ? h.id : null,
        tmdbId: h.kind === 'movie' ? h.id : null,
        name: h.name,
        poster: h.poster || null,
        channelName: h.channelName || null,
        premiered: h.premiered || null,
        hidden: true,
        fixed: true,
        size: 0.72,
        x: Math.cos(ang) * 215,
        y: (hashFloat(hk) - 0.5) * 45,
        z: Math.sin(ang) * 215,
      });
    });
  }

  disambiguateMediaNodes(finalNodes);
  computeForceLayout3D(finalNodes, finalEdges);
  return {
    mode: 'taste',
    title: seedsEmptyNotice ? 'Discovery Starter Galaxy' : 'Your Taste Nebula',
    nodes: finalNodes,
    edges: finalEdges,
    clusters: buildNebulaClusters(finalNodes),
  };
}

function attachCachedConnections(item, itemKey, addNode, addEdge) {
  const kws = [
    ...((item.keywords || []).map((k) => (typeof k === 'string' ? k : k && k.name)).filter(Boolean)),
    ...recommender.normalizeTextThemes(`${item.name || ''} ${item.summary || ''}`),
  ];
  for (const kw of [...new Set(kws)].slice(0, 3)) {
    const tk = `theme:${String(kw).toLowerCase()}`;
    addNode({
      key: tk,
      kind: 'theme',
      name: kw.replace(/\b\w/g, (m) => m.toUpperCase()),
      themeGroup: 'kw',
      clusterHint: tk,
      size: 1.05,
    });
    addEdge(itemKey, tk, 'theme', kw, 0.75);
  }
  if (!kws.length && Array.isArray(item.genres) && item.genres[0]) {
    const gk = `theme:${item.genres[0].toLowerCase()}`;
    addNode({ key: gk, kind: 'theme', name: item.genres[0], themeGroup: 'genre', clusterHint: gk, size: 1.0 });
    addEdge(itemKey, gk, 'theme', item.genres[0], 0.65);
  }

  for (const cr of (item.creators || []).slice(0, 2)) {
    const cname = typeof cr === 'string' ? cr : cr && cr.name;
    if (!cname) continue;
    const pk = `person:${cname.toLowerCase()}`;
    addNode({ key: pk, kind: 'person', name: cname, role: 'Creator', clusterHint: pk, size: 0.95 });
    addEdge(itemKey, pk, 'creator', 'Creator', 1.0);
  }
  for (const ca of (item.cast || []).slice(0, 2)) {
    const aname = typeof ca === 'string' ? ca : ca && ca.name;
    if (!aname) continue;
    const pk = `person:${aname.toLowerCase()}`;
    addNode({ key: pk, kind: 'person', name: aname, role: 'Cast', clusterHint: pk, size: 0.8 });
    addEdge(itemKey, pk, 'cast', 'Cast', 0.65);
  }
}

/** Entry Point B: Seed a fresh galaxy centered directly on ANY Show, Movie, Person, Theme, or Source Work! */
async function buildSeedGalaxy({ seedKind = 'show', seedId = null, seedTmdbId = null, seedKeywordId = null, seedQid = null, seedWikiTitle = null, seedName = '', imdbId = null, store, movies, hidden, watched } = {}) {
  const nodeMap = new Map();
  const edgeMap = new Map();
  const addNode = (nd) => {
    if (!nd || !nd.key) return null;
    const prev = nodeMap.get(nd.key);
    if (prev) {
      if (nd.poster && !prev.poster) prev.poster = nd.poster;
      if (nd.image && !prev.image) prev.image = nd.image;
      if (nd.tmdbPersonId && !prev.tmdbPersonId) prev.tmdbPersonId = nd.tmdbPersonId;
      if (nd.tvmazePersonId && !prev.tvmazePersonId) prev.tvmazePersonId = nd.tvmazePersonId;
      if (nd.qid && !prev.qid) prev.qid = nd.qid;
      if (nd.seed) prev.seed = true;
      return prev;
    }
    nodeMap.set(nd.key, { degree: 0, ...nd });
    return nodeMap.get(nd.key);
  };
  const addEdge = (a, b, rel, label, weight = 0.85) => {
    if (!a || !b || a === b) return;
    const [k1, k2] = a < b ? [a, b] : [b, a];
    const ek = `${k1}|${k2}|${rel}`;
    if (!edgeMap.has(ek)) edgeMap.set(ek, { source: a, target: b, rel, label: label || rel, weight });
  };

  let title = seedName || 'Constellation';

  if (seedKind === 'source') {
    const sName = seedName || 'Source Work';
    const sKey = seedQid ? `source:${seedQid}` : `source:${sName.toLowerCase()}`;
    const sNode = addNode({
      key: sKey,
      kind: 'source',
      qid: seedQid || null,
      wikiTitle: seedWikiTitle || null,
      name: sName,
      seed: true,
      fixed: true,
      x: 0,
      y: 0,
      z: 0,
      size: 2.0,
    });
    await expandSourceInto(sNode, addNode, addEdge, { store, movies, hidden, watched, maxItems: 16 });
    title = sNode.name || title;
  } else if (seedKind === 'theme') {
    const tName = seedName || 'Theme Nebula';
    const tKey = `theme:${tName.toLowerCase()}`;
    const tNode = addNode({
      key: tKey,
      kind: 'theme',
      tmdbKeywordId: seedKeywordId ? Number(seedKeywordId) : null,
      name: tName,
      seed: true,
      fixed: true,
      x: 0,
      y: 0,
      z: 0,
      size: 2.0,
    });
    title = tNode.name;
    await expandThemeInto(tNode, addNode, addEdge, { store, movies, hidden, watched, maxItems: 22 });
  } else if (seedKind === 'person') {
    const pKey = `person:${String(seedName || seedId).toLowerCase()}`;
    const pNode = addNode({
      key: pKey,
      kind: 'person',
      tvmazePersonId: seedId ? Number(seedId) : null,
      tmdbPersonId: seedTmdbId ? Number(seedTmdbId) : null,
      qid: seedQid || null,
      name: seedName || `Person #${seedId || seedTmdbId}`,
      role: 'Creator / Cast',
      seed: true,
      fixed: true,
      x: 0,
      y: 0,
      z: 0,
      size: 2.0,
    });
    title = pNode.name;
    await expandPersonInto(pNode, null, addNode, addEdge, { store, movies, hidden, watched, maxItems: 24 });
  } else if (seedKind === 'movie') {
    let mId = Number(seedTmdbId || seedId) || null;
    if (!mId && (imdbId || seedName) && tmdb.hasApiKey()) {
      mId = await tmdb.findMovieByExternal({ imdb: imdbId, name: seedName }).catch(() => null);
    }
    const rec = mId
      ? await fetchDeepMovieRecord(mId, { name: seedName, imdbId })
      : { kind: 'movie', tvmazeId: null, tmdbId: null, imdbId, name: seedName || 'Movie', genres: [], summary: '', keywords: [], themes: [], castPeople: [], creatorPeople: [], recommendations: [], similar: [] };
    title = rec.name;
    const centerKey = makeMediaKey('movie', null, rec.tmdbId, rec.name);
    const flags = itemStateFlags({ kind: 'movie', tmdbId: rec.tmdbId, name: rec.name, store, movies, hidden, watched });
    const rootNode = addNode({
      ...rec,
      key: centerKey,
      seed: true,
      fixed: true,
      x: 0,
      y: 0,
      z: 0,
      size: 2.1,
      ...flags,
    });
    await expandMediaInto(rootNode, rec, addNode, addEdge, { store, movies, hidden, watched, secondaryPerson: true });
    const cachedWiki = wiki.peekCachedDossier({ kind: 'movie', name: rec.name, year: rec.premiered, imdbId: rec.imdbId });
    if (cachedWiki && cachedWiki.found) attachWikiLinksInto(rootNode, cachedWiki, addNode, addEdge);
  } else {
    let tvId = Number(seedId) || null;
    if (!tvId && (imdbId || seedName)) {
      const resolved = await tvmaze.resolveShow({ imdbId, name: seedName }).catch(() => null);
      if (resolved && resolved.id) tvId = resolved.id;
    }
    const rec = tvId ? await fetchDeepShowRecord(tvId, { tmdbId: seedTmdbId ? Number(seedTmdbId) : null, name: seedName, imdbId }) : await fetchDeepShowRecord(0, { tmdbId: Number(seedTmdbId), name: seedName, imdbId });
    title = rec.name;
    const centerKey = makeMediaKey('show', rec.tvmazeId, rec.tmdbId, rec.name);
    const flags = itemStateFlags({ kind: 'show', tvmazeId: rec.tvmazeId, tmdbId: rec.tmdbId, name: rec.name, store, movies, hidden, watched });
    const rootNode = addNode({
      ...rec,
      key: centerKey,
      seed: true,
      fixed: true,
      x: 0,
      y: 0,
      z: 0,
      size: 2.1,
      ...flags,
    });
    await expandMediaInto(rootNode, rec, addNode, addEdge, { store, movies, hidden, watched, secondaryPerson: true });
    const cachedWiki = wiki.peekCachedDossier({ kind: 'show', name: rec.name, year: rec.premiered, imdbId: rec.imdbId });
    if (cachedWiki && cachedWiki.found) attachWikiLinksInto(rootNode, cachedWiki, addNode, addEdge);
  }

  const finalNodes = [...nodeMap.values()];
  const hubDeg = new Map();
  for (const e of edgeMap.values()) {
    hubDeg.set(e.source, (hubDeg.get(e.source) || 0) + 1);
    hubDeg.set(e.target, (hubDeg.get(e.target) || 0) + 1);
  }
  for (const nd of finalNodes) nd.degree = hubDeg.get(nd.key) || 1;
  const finalEdges = [...edgeMap.values()];

  disambiguateMediaNodes(finalNodes);
  computeForceLayout3D(finalNodes, finalEdges, { lockSeed: true });
  return {
    mode: 'seed',
    title,
    seedKey: (finalNodes.find((n) => n.seed) || {}).key || null,
    nodes: finalNodes,
    edges: finalEdges,
    clusters: buildNebulaClusters(finalNodes),
  };
}

async function expandMediaInto(rootNode, deepRec, addNode, addEdge, { store, movies, hidden, watched, secondaryPerson = false }) {
  const key = rootNode.key;
  // 1. Themes / Keywords
  const kwList = [
    ...((deepRec.keywords || []).slice(0, 5).map((k) => ({ name: k.name || k, id: k.id || null }))),
    ...(deepRec.themes || []).slice(0, 3).map((t) => ({ name: t, id: null })),
  ];
  const seenKw = new Set();
  for (const kw of kwList) {
    const nm = String(kw.name || '').trim();
    const low = nm.toLowerCase();
    if (!nm || seenKw.has(low)) continue;
    seenKw.add(low);
    const tk = `theme:${low}`;
    addNode({
      key: tk,
      kind: 'theme',
      name: nm.replace(/\b\w/g, (m) => m.toUpperCase()),
      tmdbKeywordId: kw.id || null,
      clusterHint: tk,
      size: 1.15,
    });
    addEdge(key, tk, 'theme', 'Theme', 0.85);
    if (seenKw.size >= 5) break;
  }

  // 2. Creators / Showrunners (plus optionally 1-hop creator bloom cleanly on seed!)
  const creators = (deepRec.creatorPeople || []).slice(0, 3);
  for (const [idx, cr] of creators.entries()) {
    const pk = `person:${cr.name.toLowerCase()}`;
    const pNode = addNode({
      key: pk,
      kind: 'person',
      tvmazePersonId: cr.id || null,
      tmdbPersonId: cr.tmdbPersonId || null,
      name: cr.name,
      image: cr.image || null,
      role: cr.role || 'Creator',
      clusterHint: pk,
      size: 1.15,
    });
    addEdge(key, pk, 'creator', cr.role || 'Creator', 1.1);
    if (secondaryPerson && idx === 0 && pNode) {
      await expandPersonInto(pNode, cr, addNode, addEdge, { store, movies, hidden, watched, maxItems: 6, skipKey: key });
    }
  }

  // 3. Lead Cast
  for (const ca of (deepRec.castPeople || []).slice(0, 5)) {
    const pk = `person:${ca.name.toLowerCase()}`;
    addNode({
      key: pk,
      kind: 'person',
      tvmazePersonId: ca.id || null,
      tmdbPersonId: ca.tmdbPersonId || null,
      name: ca.name,
      image: ca.image || null,
      role: ca.role || 'Cast',
      clusterHint: pk,
      size: 0.92,
    });
    addEdge(key, pk, 'cast', ca.role || 'Cast', 0.8);
  }

  // 4. Co-Watched Recommendations & Similar
  const combinedRecs = [...(deepRec.recommendations || []), ...(deepRec.similar || [])];
  const addedRecs = new Set([key]);
  for (const r of combinedRecs) {
    const rk = makeMediaKey(r.kind, r.tvmazeId, r.tmdbId, r.name);
    if (addedRecs.has(rk)) continue;
    addedRecs.add(rk);
    const flags = itemStateFlags({ kind: r.kind, tvmazeId: r.tvmazeId, tmdbId: r.tmdbId, name: r.name, store, movies, hidden, watched });
    if (flags.hidden) continue;
    addNode({
      key: rk,
      kind: r.kind,
      tvmazeId: r.tvmazeId || null,
      tmdbId: r.tmdbId || null,
      name: r.name,
      poster: r.poster || null,
      rating: r.rating || null,
      premiered: r.premiered || null,
      genres: r.genres || [],
      summary: recommender.stripHtml(r.summary || ''),
      clusterHint: (r.genres && r.genres[0]) || key,
      size: 1.05,
      reasons: [`Co-watched / similar to ${rootNode.name}`],
      ...flags,
    });
    addEdge(key, rk, 'cowatch', 'Similar / Co-watch', 1.0);
    if (addedRecs.size >= 14) break;
  }
}

async function expandPersonInto(personNode, hintObj, addNode, addEdge, { store, movies, hidden, watched, maxItems = 16, skipKey = null }) {
  const results = [];
  let tvmId = personNode.tvmazePersonId || (hintObj && hintObj.id) || null;
  let tmdbPId = personNode.tmdbPersonId || (hintObj && hintObj.tmdbPersonId) || null;

  if (!tvmId && personNode.name) {
    const hits = await tvmaze.searchPeople(personNode.name).catch(() => []);
    const best = hits.find((h) => h.name.toLowerCase() === personNode.name.toLowerCase()) || hits[0];
    if (best && best.tvmazePersonId) {
      tvmId = best.tvmazePersonId;
      personNode.tvmazePersonId = tvmId;
      if (!personNode.image && best.image) personNode.image = best.image;
    }
  }
  if (tmdb.hasApiKey() && !tmdbPId && personNode.name) {
    const tp = await tmdb.searchPerson(personNode.name).catch(() => null);
    if (tp && tp.tmdbPersonId) {
      tmdbPId = tp.tmdbPersonId;
      personNode.tmdbPersonId = tmdbPId;
      if (!personNode.image && tp.image) personNode.image = tp.image;
    }
  }

  const [tvCreds, tmdbCreds] = await Promise.all([
    tvmId ? tvmaze.fetchPersonCredits(tvmId).catch(() => []) : [],
    tmdbPId && tmdb.hasApiKey() ? tmdb.fetchPersonCredits(tmdbPId).catch(() => []) : [],
  ]);

  const dedupe = new Map();
  for (const s of tvCreds) {
    const k = `show:${String(s.name).trim().toLowerCase()}`;
    dedupe.set(k, {
      kind: 'show',
      tvmazeId: s.id,
      tmdbId: null,
      imdbId: (s.externals && s.externals.imdb) || null,
      name: s.name,
      poster: s.poster || null,
      rating: s.rating || null,
      premiered: s.premiered || null,
      status: s.status || null,
      genres: s.genres || [],
      channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
      summary: recommender.stripHtml(s.summary || ''),
      creditRole: s.creditRole || 'Credit',
    });
  }
  for (const m of tmdbCreds) {
    const norm = `${m.kind}:${String(m.name).trim().toLowerCase()}`;
    const prev = dedupe.get(norm);
    if (prev) {
      prev.tmdbId = m.tmdbId;
      if (!prev.poster && m.poster) prev.poster = m.poster;
      if (!prev.rating && m.rating) prev.rating = m.rating;
    } else {
      dedupe.set(norm, { ...m });
    }
  }

  // Sparse fallback for Authors & Composers (especially in TMDB-keyless mode) via cached/on-demand Wikidata
  if (dedupe.size < 3 && (personNode.qid || /Author|Composer/i.test(personNode.role || ''))) {
    let pQid = personNode.qid || null;
    if (!pQid && personNode.name) {
      const pDos = await wiki.getWikiDossier({ kind: 'person', name: personNode.name });
      if (pDos && pDos.qid) pQid = pDos.qid;
    }
    if (pQid) {
      const wikiCreds = await wiki.fetchPersonWikiCredits(pQid).catch(() => []);
      for (const w of wikiCreds) {
        const local = matchLocalLibrary(w, { store, movies });
        const kind = (local && local.kind) || w.kindHint || 'movie';
        const localMeta = (local && (local.show || local.movie)) || {};
        const norm = `${kind}:${String(localMeta.name || w.name).trim().toLowerCase()}`;
        if (dedupe.has(norm)) continue;
        dedupe.set(norm, {
          kind,
          tvmazeId: (local && local.tvmazeId) || null,
          tmdbId: (local && local.tmdbId) || null,
          imdbId: w.imdbId || null,
          qid: w.qid || null,
          wikiTitle: w.wikiTitle || null,
          name: localMeta.name || w.name,
          poster: localMeta.poster || null,
          rating: localMeta.rating || null,
          premiered: localMeta.premiered || (w.year ? String(w.year) : null),
          genres: localMeta.genres || [],
          channelName: (localMeta.network && localMeta.network.name) || (localMeta.webChannel && localMeta.webChannel.name) || localMeta.channelName || null,
          summary: recommender.stripHtml(localMeta.summary || ''),
          creditRole: w.creditRole || 'Credit',
        });
      }
    }
  }

  for (const item of [...dedupe.values()].slice(0, maxItems)) {
    const mk = makeMediaKey(item.kind, item.tvmazeId, item.tmdbId, item.name);
    if (skipKey && mk === skipKey) continue;
    const flags = itemStateFlags({ kind: item.kind, tvmazeId: item.tvmazeId, tmdbId: item.tmdbId, name: item.name, store, movies, hidden, watched });
    if (flags.hidden) continue;
    const added = addNode({
      ...item,
      key: mk,
      clusterHint: personNode.key,
      size: 1.0,
      reasons: [`${item.creditRole || 'Featured'} — ${personNode.name}`],
      ...flags,
    });
    if (added) {
      const role = item.creditRole || '';
      const rel = /Composer|Music/i.test(role) ? 'composer' : /Creator|Director|Writer|Producer|Author/i.test(role) ? 'creator' : 'cast';
      addEdge(personNode.key, mk, rel, role || 'Credit', 0.9);
      results.push(added);
    }
  }
  return results;
}

/** Match a Wikidata adaptation cleanly against locally tracked TVmaze/TMDB items first (0 API calls). */
function matchLocalLibrary(item, { store, movies }) {
  const imdb = item.imdbId ? String(item.imdbId).toLowerCase() : null;
  const targetName = String(item.name || '').replace(/\s*\(\d{4}\)$/, '').trim().toLowerCase();
  const targetYear = item.year ? String(item.year) : '';

  for (const { id, full } of store.listTrackedCached()) {
    const s = full && full.show;
    if (!s) continue;
    const tvImdb = s.externals && s.externals.imdb ? String(s.externals.imdb).toLowerCase() : null;
    if (imdb && tvImdb === imdb) return { kind: 'show', tvmazeId: id, show: s };
    if (String(s.name || '').trim().toLowerCase() === targetName && (!targetYear || String(s.premiered || '').startsWith(targetYear))) {
      return { kind: 'show', tvmazeId: id, show: s };
    }
  }
  for (const m of movies.listMovies()) {
    const mvC = recommender.readItemCache(`mv_${m.id}`);
    const mvImdb = mvC && mvC.imdbId ? String(mvC.imdbId).toLowerCase() : null;
    if (imdb && mvImdb === imdb) return { kind: 'movie', tmdbId: m.id, movie: m };
    if (String(m.name || '').trim().toLowerCase() === targetName && (!targetYear || String(m.premiered || '').startsWith(targetYear))) {
      return { kind: 'movie', tmdbId: m.id, movie: m };
    }
  }
  return null;
}

/** Fuse Wikipedia/Wikidata Source Works, Original Authors & Score Composers cleanly onto an existing media node. */
function attachWikiLinksInto(rootNode, dossier, addNode, addEdge) {
  if (!dossier || !dossier.found || !rootNode || !rootNode.key) return 0;
  let added = 0;
  const sourceKeys = [];

  for (const b of (dossier.basedOn || []).slice(0, 3)) {
    const sk = b.qid ? `source:${b.qid}` : `source:${b.name.toLowerCase()}`;
    const sn = addNode({
      key: sk,
      kind: 'source',
      qid: b.qid || null,
      name: b.name,
      clusterHint: sk,
      size: 1.15,
      reasons: [`Source material adapted by ${rootNode.name}`],
    });
    if (sn) {
      addEdge(rootNode.key, sk, 'adapted', 'Based on', 1.05);
      sourceKeys.push(sk);
      added++;
    }
  }

  for (const a of (dossier.authors || []).slice(0, 3)) {
    const ak = `person:${a.name.toLowerCase()}`;
    const an = addNode({
      key: ak,
      kind: 'person',
      qid: a.qid || null,
      name: a.name,
      role: 'Author',
      clusterHint: ak,
      size: 1.05,
      reasons: [`Original author behind ${rootNode.name}`],
    });
    if (an) {
      const parentKey = sourceKeys[0] || rootNode.key;
      addEdge(parentKey, ak, 'author', 'Author', 0.95);
      added++;
    }
  }

  for (const c of (dossier.composers || []).slice(0, 3)) {
    const ck = `person:${c.name.toLowerCase()}`;
    const cn = addNode({
      key: ck,
      kind: 'person',
      qid: c.qid || null,
      name: c.name,
      role: 'Score Composer',
      clusterHint: ck,
      size: 1.05,
      reasons: [`Original music composer for ${rootNode.name}`],
    });
    if (cn) {
      addEdge(rootNode.key, ck, 'composer', 'Score Composer', 0.95);
      added++;
    }
  }
  return added;
}

/** Bloom a Source Material (Book / Comic / Manga) hub into its authors + screen adaptations. */
async function expandSourceInto(sourceNode, addNode, addEdge, { store, movies, hidden, watched, maxItems = 14 }) {
  const dossier = await wiki.getWikiDossier({
    kind: 'source',
    qid: sourceNode.qid || null,
    wikiTitle: sourceNode.wikiTitle || null,
    name: sourceNode.name,
  });
  if (dossier && dossier.found) {
    if (dossier.qid && !sourceNode.qid) sourceNode.qid = dossier.qid;
    if (dossier.wikiTitle && !sourceNode.wikiTitle) sourceNode.wikiTitle = dossier.wikiTitle;
    if (dossier.pubYear && !sourceNode.premiered) sourceNode.premiered = String(dossier.pubYear);

    for (const a of (dossier.authors || []).slice(0, 4)) {
      const ak = `person:${a.name.toLowerCase()}`;
      addNode({
        key: ak,
        kind: 'person',
        qid: a.qid || null,
        name: a.name,
        role: 'Author',
        clusterHint: ak,
        size: 1.12,
        reasons: [`Author of ${sourceNode.name}`],
      });
      addEdge(sourceNode.key, ak, 'author', 'Author', 1.0);
    }
  }

  const effectiveQid = sourceNode.qid || (dossier && dossier.qid) || null;
  if (!effectiveQid) return;
  const adaptations = await wiki.fetchSourceAdaptations(effectiveQid);
  for (const ad of adaptations.slice(0, maxItems)) {
    const local = matchLocalLibrary(ad, { store, movies });
    const kind = (local && local.kind) || ad.kindHint || 'movie';
    const tvmazeId = (local && local.tvmazeId) || null;
    const tmdbId = (local && local.tmdbId) || null;
    const mk = makeMediaKey(kind, tvmazeId, tmdbId, `${ad.name}${ad.year ? ` (${ad.year})` : ''}`);
    const flags = itemStateFlags({ kind, tvmazeId, tmdbId, name: ad.name, store, movies, hidden, watched });
    if (flags.hidden) continue;

    const localMeta = (local && (local.show || local.movie)) || {};
    addNode({
      key: mk,
      kind,
      tvmazeId,
      tmdbId,
      imdbId: ad.imdbId || null,
      qid: ad.qid || null,
      wikiTitle: ad.wikiTitle || null,
      name: localMeta.name || ad.name,
      poster: localMeta.poster || null,
      rating: localMeta.rating || null,
      premiered: localMeta.premiered || (ad.year ? String(ad.year) : null),
      genres: localMeta.genres || [],
      channelName: (localMeta.network && localMeta.network.name) || (localMeta.webChannel && localMeta.webChannel.name) || localMeta.channelName || null,
      summary: recommender.stripHtml(localMeta.summary || ''),
      clusterHint: sourceNode.key,
      size: 1.08,
      reasons: [`Adapted from ${sourceNode.name}`],
      ...flags,
    });
    addEdge(sourceNode.key, mk, 'adapted', 'Adaptation', 1.05);
  }
}

/** Expand ANY existing node live (+1 Hop Bloom in 3D space) positioned smoothly outside its parent. */
async function expandNode({ node = {}, existingKeys = [], includeWiki = false, store, movies, hidden, watched } = {}) {
  const existingSet = new Set(Array.isArray(existingKeys) ? existingKeys : []);
  const newNodeMap = new Map();
  const newEdges = [];
  const edgeKeys = new Set();

  const addNode = (nd) => {
    if (!nd || !nd.key) return null;
    if (nd.key === node.key) return nd;
    if (existingSet.has(nd.key)) return { ...nd, _existed: true };
    const prev = newNodeMap.get(nd.key);
    if (prev) return prev;
    newNodeMap.set(nd.key, { degree: 1, ...nd });
    return newNodeMap.get(nd.key);
  };
  const addEdge = (a, b, rel, label, weight = 0.85) => {
    if (!a || !b || a === b) return;
    const [k1, k2] = a < b ? [a, b] : [b, a];
    const ek = `${k1}|${k2}|${rel}`;
    if (!edgeKeys.has(ek)) {
      edgeKeys.add(ek);
      newEdges.push({ source: a, target: b, rel, label: label || rel, weight });
    }
  };

  if (node.kind === 'source') {
    await expandSourceInto({ ...node }, addNode, addEdge, { store, movies, hidden, watched, maxItems: 14 });
  } else if (node.kind === 'person') {
    const pNode = { ...node };
    await expandPersonInto(pNode, pNode, addNode, addEdge, { store, movies, hidden, watched, maxItems: 18 });
  } else if (node.kind === 'theme') {
    await expandThemeInto(node, addNode, addEdge, { store, movies, hidden, watched, maxItems: 16 });
  } else if (node.kind === 'movie') {
    let mId = node.tmdbId ? Number(node.tmdbId) : null;
    if (!mId && (node.imdbId || node.name) && tmdb.hasApiKey()) {
      mId = await tmdb.findMovieByExternal({ imdb: node.imdbId, name: node.name, year: node.premiered }).catch(() => null);
    }
    if (mId) {
      const rec = await fetchDeepMovieRecord(mId, node);
      await expandMediaInto({ ...node, ...rec }, rec, addNode, addEdge, { store, movies, hidden, watched });
    }
  } else {
    let tvId = node.tvmazeId ? Number(node.tvmazeId) : null;
    if (!tvId && (node.imdbId || node.name)) {
      const resolved = await tvmaze.resolveShow({ imdbId: node.imdbId, name: node.name, year: node.premiered }).catch(() => null);
      if (resolved && resolved.id) tvId = resolved.id;
    }
    const rec = tvId
      ? await fetchDeepShowRecord(tvId, node)
      : node.tmdbId && tmdb.hasApiKey()
      ? await tmdb.fetchDeepProfile('show', Number(node.tmdbId)).catch(() => null)
      : null;
    if (rec) {
      await expandMediaInto({ ...node, ...rec }, rec, addNode, addEdge, { store, movies, hidden, watched });
    }
  }

  // Fuse Wikipedia/Wikidata knowledge links on explicit Wiki Bloom OR free cached hit (0 extra polling!)
  if (node.kind === 'show' || node.kind === 'movie') {
    const wikiParams = {
      kind: node.kind,
      name: node.name,
      year: node.premiered,
      imdbId: node.imdbId,
      qid: node.qid,
      wikiTitle: node.wikiTitle,
    };
    const dossier = includeWiki ? await wiki.getWikiDossier(wikiParams) : wiki.peekCachedDossier(wikiParams);
    if (dossier && dossier.found) {
      attachWikiLinksInto(node, dossier, addNode, addEdge);
    }
  }

  // Position newly bloomed nodes radially in a 3D spherical cone outward from parent
  const px = Number(node.x) || 0;
  const py = Number(node.y) || 0;
  const pz = Number(node.z) || 0;
  const pLen = Math.sqrt(px * px + py * py + pz * pz) || 0;
  const outX = pLen > 2 ? px / pLen : 0;
  const outY = pLen > 2 ? py / pLen : 0.25;
  const outZ = pLen > 2 ? pz / pLen : 1;

  const newNodes = [...newNodeMap.values()];
  const m = newNodes.length;
  const ga = Math.PI * (3 - Math.sqrt(5));
  newNodes.forEach((nd, i) => {
    const t = (i + 0.5) / Math.max(1, m);
    const phi = Math.acos(1 - 2 * t);
    const th = ga * i + hashFloat(nd.key) * 2.1;
    const rad = nd.kind === 'person' ? 30 : nd.kind === 'source' ? 34 : nd.kind === 'theme' ? 36 : 42 + hashFloat(nd.key) * 14;
    const rx = Math.sin(phi) * Math.cos(th);
    const ry = Math.cos(phi) * 0.75;
    const rz = Math.sin(phi) * Math.sin(th);
    nd.x = px + (rx + outX * 0.65) * rad;
    nd.y = py + (ry + outY * 0.45) * rad;
    nd.z = pz + (rz + outZ * 0.65) * rad;
  });

  const clusters =
    newNodes.length >= 4
      ? [{ id: `cl:exp:${node.key}`, label: node.name, kind: node.kind, x: px, y: py, z: pz, radius: 44 }]
      : [];

  return { newNodes, newEdges, clusters };
}

async function searchEntities(q) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  const [tvShows, tvPeople, mvHits] = await Promise.all([
    tvmaze.searchShows(q).catch(() => []),
    tvmaze.searchPeople(q).catch(() => []),
    tmdb.hasApiKey() ? tmdb.searchMovies(q).catch(() => []) : [],
  ]);
  const out = [];
  for (const r of (tvShows || []).slice(0, 6)) {
    const s = tvmaze.slimShow(r.show);
    out.push({
      seedKind: 'show',
      seedId: s.id,
      name: s.name,
      sub: `${(s.premiered || '').slice(0, 4) || 'Series'}${s.network ? ` · ${s.network.name}` : ''}`,
      poster: s.poster || null,
    });
  }
  for (const m of (mvHits || []).slice(0, 4)) {
    out.push({
      seedKind: 'movie',
      seedId: m.id,
      name: m.name,
      sub: `${(m.premiered || '').slice(0, 4) || 'Movie'} · Film`,
      poster: m.poster || null,
    });
  }
  for (const p of (tvPeople || []).slice(0, 4)) {
    out.push({
      seedKind: 'person',
      seedId: p.tvmazePersonId,
      name: p.name,
      sub: `Person${p.country ? ` · ${p.country}` : ''}`,
      poster: p.image || null,
    });
  }
  return out.slice(0, 12);
}

async function expandThemeInto(themeNode, addNode, addEdge, { store, movies, hidden, watched, maxItems = 18 }) {
  const addedKeys = new Set();
  const target = String(themeNode.name || '').trim().toLowerCase();
  const kwTokens = target.split(/[\/,& ]+/).filter((w) => w.length > 2);
  const matchesTheme = (hayText, kwList = [], genres = []) => {
    const lowerList = [...(kwList || []), ...(genres || [])].map((x) => String(x || '').toLowerCase());
    if (lowerList.some((x) => x === target || (target.length > 3 && x.includes(target)))) return true;
    const text = String(hayText || '').toLowerCase();
    if (target && text.includes(target)) return true;
    if (recommender.normalizeTextThemes(text).some((lbl) => lbl.toLowerCase() === target)) return true;
    return kwTokens.length >= 2 && kwTokens.every((w) => text.includes(w));
  };

  const tryAttach = (rec, weight, size) => {
    const mk = makeMediaKey(rec.kind, rec.tvmazeId, rec.tmdbId, rec.name);
    if (addedKeys.has(mk)) return false;
    addedKeys.add(mk);
    const flags = itemStateFlags({ kind: rec.kind, tvmazeId: rec.tvmazeId, tmdbId: rec.tmdbId, name: rec.name, store, movies, hidden, watched });
    if (flags.hidden) return false;
    addNode({ ...rec, key: mk, clusterHint: themeNode.key, size, reasons: [`Explores theme "${themeNode.name}"`], ...flags });
    addEdge(themeNode.key, mk, 'theme', themeNode.name, weight);
    return addedKeys.size >= maxItems;
  };

  // 0. Include matching tracked shows & movies from the user's library (ensures seed anchors link back!)
  for (const { id, full } of store.listTrackedCached()) {
    const s = full && full.show;
    if (!s) continue;
    const tvC = recommender.readItemCache(`tv_${id}`);
    const summary = recommender.stripHtml(s.summary || (tvC && tvC.summary) || '');
    const kw = (tvC && tvC.keywords) || [];
    const genres = s.genres || [];
    if (!matchesTheme(`${s.name} ${genres.join(' ')} ${summary}`, kw, genres)) continue;
    if (tryAttach({
      kind: 'show',
      tvmazeId: id,
      tmdbId: (tvC && tvC.tmdbId) || null,
      imdbId: (s.externals && s.externals.imdb) || (tvC && tvC.imdbId) || null,
      name: s.name,
      poster: s.poster || (s.image && (s.image.medium || s.image.original)) || (tvC && tvC.poster) || null,
      rating: s.rating,
      premiered: s.premiered,
      genres,
      channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
      summary,
    }, 0.98, 1.15)) return;
  }

  for (const m of movies.listMovies()) {
    const mvC = recommender.readItemCache(`mv_${m.id}`);
    const summary = (mvC && mvC.summary) || '';
    const kw = (mvC && mvC.keywords) || [];
    const genres = m.genres || (mvC && mvC.genres) || [];
    if (!matchesTheme(`${m.name} ${genres.join(' ')} ${summary}`, kw, genres)) continue;
    if (tryAttach({
      kind: 'movie',
      tmdbId: m.id,
      imdbId: (mvC && mvC.imdbId) || null,
      name: m.name,
      poster: m.poster || null,
      rating: m.rating || (mvC && mvC.rating) || null,
      premiered: m.premiered || null,
      genres,
      channelName: m.channelName || null,
      summary,
    }, 0.96, 1.12)) return;
  }

  // 1. Check cached local pool + recommendations matching this theme next
  const poolRecs = recommender.getRecommendations({ store, movies, hidden, watched, media: 'all', lens: 'mix', limit: 60 }).items || [];
  for (const r of poolRecs) {
    if (!matchesTheme(`${r.name} ${r.summary || ''}`, r.keywords, r.genres)) continue;
    if (tryAttach(r, 0.95, 1.05)) return;
  }

  // 2. TMDB keyword discover if keyword ID is present
  if (themeNode.tmdbKeywordId && tmdb.hasApiKey()) {
    const [tvRows, mvRows] = await Promise.all([
      tmdb.discoverDeep('tv', { with_keywords: String(themeNode.tmdbKeywordId), 'vote_count.gte': 30, sort_by: 'vote_average.desc', page: 1 }).catch(() => []),
      tmdb.discoverDeep('movie', { with_keywords: String(themeNode.tmdbKeywordId), 'vote_count.gte': 40, sort_by: 'vote_average.desc', page: 1 }).catch(() => []),
    ]);
    for (const r of [...tvRows.slice(0, 8), ...mvRows.slice(0, 8)]) {
      if (tryAttach(r, 0.9, 1.02)) return;
    }
  }

  // 3. Free TVmaze catalog matches
  const page0 = await tvmaze.fetchShowsPage(0).catch(() => []);
  for (const s of page0) {
    const summary = recommender.stripHtml(s.summary || '');
    if (!matchesTheme(`${s.name} ${summary}`, [], s.genres || [])) continue;
    if (tryAttach({
      kind: 'show',
      tvmazeId: s.id,
      name: s.name,
      poster: s.poster,
      rating: s.rating,
      premiered: s.premiered,
      genres: s.genres || [],
      channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
      summary,
    }, 0.85, 0.98)) break;
  }
}

function disambiguateMediaNodes(nodes) {
  const byName = new Map();
  for (const n of nodes) {
    if (n.kind !== 'show' && n.kind !== 'movie') continue;
    const k = `${n.kind}:${String(n.name || '').trim().toLowerCase()}`;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(n);
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    for (const n of list) {
      const y = String(n.premiered || '').slice(0, 4);
      if (y) n.name = `${n.name} (${y})`;
    }
  }
}

/** Resolve Cast (Actors), Crew, Profile Images & Wikipedia/Wikidata Lore for the Detail Modal lazily. */
async function getRichItemDetails({
  kind = 'show',
  id = null,
  tvmazeId = null,
  tmdbId = null,
  imdbId = null,
  name = '',
  year = '',
  store,
  movies,
} = {}) {
  const k = kind === 'movie' ? 'movie' : 'show';
  let tvId = k === 'show' ? Number(tvmazeId || id) || null : null;
  let tmId = Number(tmdbId || (k === 'movie' ? id : 0)) || null;
  let knownImdb = imdbId || null;
  let fallbackName = name || '';
  let fallbackYear = year || '';
  let fallbackGenres = [];

  if (k === 'show' && tvId && store) {
    const cached = store.getCached(tvId) || store.loadCachedFromDisk(tvId);
    const sh = cached && cached.show;
    if (sh) {
      if (!fallbackName) fallbackName = sh.name || '';
      if (!fallbackYear) fallbackYear = String(sh.premiered || '').slice(0, 4);
      if (!knownImdb && sh.externals && sh.externals.imdb) knownImdb = sh.externals.imdb;
      fallbackGenres = sh.genres || [];
    }
  } else if (k === 'movie' && tmId && movies) {
    const cachedMv = recommender.readItemCache(`tmdb_movie_${tmId}`) || recommender.readItemCache(`mv_${tmId}`);
    if (cachedMv) {
      if (!fallbackName) fallbackName = cachedMv.name || '';
      if (!fallbackYear) fallbackYear = String(cachedMv.premiered || '').slice(0, 4);
      if (!knownImdb && cachedMv.imdbId) knownImdb = cachedMv.imdbId;
    }
  }

  let rec = null;
  if (k === 'movie') {
    if (!tmId && (knownImdb || fallbackName) && tmdb.hasApiKey()) {
      tmId = await tmdb.findMovieByExternal({ imdb: knownImdb, name: fallbackName, year: fallbackYear }).catch(() => null);
    }
    rec = tmId
      ? await fetchDeepMovieRecord(tmId, { name: fallbackName, imdbId: knownImdb, premiered: fallbackYear, genres: fallbackGenres })
      : {
          kind: 'movie',
          tvmazeId: null,
          tmdbId: null,
          imdbId: knownImdb,
          name: fallbackName,
          premiered: fallbackYear,
          genres: fallbackGenres,
          studios: [],
          tagline: '',
          summary: '',
          castPeople: [],
          creatorPeople: [],
        };
  } else {
    if (!tvId && (knownImdb || fallbackName)) {
      const resolved = await tvmaze.resolveShow({ imdbId: knownImdb, name: fallbackName, year: fallbackYear }).catch(() => null);
      if (resolved && resolved.id) tvId = resolved.id;
    }
    rec = tvId
      ? await fetchDeepShowRecord(tvId, { tmdbId: tmId, name: fallbackName, imdbId: knownImdb, premiered: fallbackYear, genres: fallbackGenres })
      : {
          kind: 'show',
          tvmazeId: null,
          tmdbId: tmId,
          imdbId: knownImdb,
          name: fallbackName,
          premiered: fallbackYear,
          genres: fallbackGenres,
          studios: [],
          tagline: '',
          summary: '',
          castPeople: [],
          creatorPeople: [],
        };
  }

  const dossier = await wiki.getWikiDossier({
    kind: k,
    name: rec.name || fallbackName,
    year: String(rec.premiered || fallbackYear || '').slice(0, 4),
    imdbId: rec.imdbId || knownImdb || null,
  });

  // Merge Crew cleanly (TVmaze + TMDB + Wikidata Directors/Writers/Composers/Authors)
  const crewMap = new Map();
  const addCrew = (p, fallbackRole) => {
    const pName = String((p && p.name) || '').trim();
    if (!pName) return;
    const key = pName.toLowerCase();
    const role = (p && p.role) || fallbackRole || 'Crew';
    const prev = crewMap.get(key);
    if (prev) {
      if (role && !prev.role.toLowerCase().includes(role.toLowerCase())) prev.role = `${prev.role} · ${role}`;
      if (!prev.image && p.image) prev.image = p.image;
      if (!prev.tvmazePersonId && p.id) prev.tvmazePersonId = p.id;
      if (!prev.tmdbPersonId && p.tmdbPersonId) prev.tmdbPersonId = p.tmdbPersonId;
      if (!prev.qid && p.qid) prev.qid = p.qid;
    } else if (crewMap.size < 12) {
      crewMap.set(key, {
        name: pName,
        role,
        image: (p && p.image) || null,
        tvmazePersonId: (p && p.id) || null,
        tmdbPersonId: (p && p.tmdbPersonId) || null,
        qid: (p && p.qid) || null,
      });
    }
  };
  for (const cr of rec.creatorPeople || []) addCrew(cr, 'Creator');
  if (dossier && dossier.found) {
    for (const d of dossier.directors || []) addCrew(d, 'Director');
    for (const w of dossier.writers || []) addCrew(w, 'Writer');
    for (const c of dossier.composers || []) addCrew(c, 'Score Composer');
    for (const a of dossier.authors || []) addCrew(a, 'Original Author');
  }
  const crew = [...crewMap.values()];

  // Merge Cast cleanly (TVmaze + TMDB + Wikidata fallback ONLY if empty)
  const castMap = new Map();
  for (const c of rec.castPeople || []) {
    const cName = String((c && c.name) || '').trim();
    if (!cName) continue;
    const key = cName.toLowerCase();
    const prev = castMap.get(key);
    if (prev) {
      if (!prev.image && c.image) prev.image = c.image;
      if (prev.role === 'Cast' && c.role && c.role !== 'Cast') prev.role = c.role;
      if (!prev.tvmazePersonId && c.id) prev.tvmazePersonId = c.id;
      if (!prev.tmdbPersonId && c.tmdbPersonId) prev.tmdbPersonId = c.tmdbPersonId;
    } else if (castMap.size < 12) {
      castMap.set(key, {
        name: cName,
        role: c.role || 'Cast',
        image: c.image || null,
        tvmazePersonId: c.id || null,
        tmdbPersonId: c.tmdbPersonId || null,
        qid: null,
      });
    }
  }
  if (castMap.size === 0 && dossier && dossier.qid) {
    const fallbackCast = await wiki.fetchWikidataCastFallback(dossier.qid).catch(() => []);
    for (const fc of fallbackCast) {
      if (castMap.size >= 12) break;
      const key = String(fc.name || '').toLowerCase();
      if (key && !castMap.has(key)) {
        castMap.set(key, {
          name: fc.name,
          role: fc.role || 'Cast',
          image: null,
          tvmazePersonId: null,
          tmdbPersonId: null,
          qid: fc.qid || null,
          wikiUrl: fc.wikiUrl || null,
        });
      }
    }
  }
  const cast = [...castMap.values()];

  // Prioritize people missing images first, then include others up to 20 total in 1 polite Wikipedia batch
  const allPeople = [...crew, ...cast];
  const needImgNames = allPeople.filter((p) => !p.image).map((p) => p.name);
  const restNames = allPeople.filter((p) => p.image).map((p) => p.name);
  const portraitLookupNames = [...new Set([...needImgNames, ...restNames])].slice(0, 20);
  const portraits = portraitLookupNames.length ? await wiki.fetchPeoplePortraits(portraitLookupNames).catch(() => new Map()) : new Map();

  for (const p of allPeople) {
    const hit = portraits.get(p.name.toLowerCase());
    if (!hit) continue;
    if (!p.image && hit.image) p.image = hit.image;
    if (hit.wikiUrl) p.wikiUrl = hit.wikiUrl;
    if (hit.wikiDesc) p.wikiDesc = hit.wikiDesc;
  }

  return {
    kind: k,
    tvmazeId: rec.tvmazeId || tvId || null,
    tmdbId: rec.tmdbId || tmId || null,
    imdbId: rec.imdbId || knownImdb || null,
    name: rec.name || fallbackName,
    tagline: rec.tagline || '',
    studios: rec.studios || [],
    summary: rec.summary || '',
    cast,
    crew,
    wiki: dossier,
  };
}

module.exports = {
  PERSON_COLOR,
  THEME_COLOR,
  SOURCE_COLOR,
  computeForceLayout3D,
  buildTasteGalaxy,
  buildSeedGalaxy,
  expandNode,
  searchEntities,
  getRichItemDetails,
};
