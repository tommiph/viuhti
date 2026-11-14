'use strict';

/**
 * Custom Word Pool Engine (lib/wordpool.js -> data/wordpool.json).
 *
 * Resource discipline:
 *  - Zero external API calls or background polling timers.
 *  - Operates strictly over local library records, already-cached pool items,
 *    and cached Wikipedia dossiers (via wiki.peekCachedDossier).
 *
 * Modes:
 *  - primary : Strict whole-word/phrase boundary match that overrides Sync,
 *              Discover filters/penalties, and Calendar filters (*respecting
 *              explicit user Hidden blocklists).
 *  - fuzzy   : Typo-tolerant + casual mention matcher (e.g. "sceubs" -> "Scrubs",
 *              "gordon ramsey" mentioned in summaries/Wikipedia/cast) uniformly
 *              badged as "Fuzzy Match", with optional "NO ..." exclusions.
 *  - exclude : Global NO / negation filter for non-Primary suggestions.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WORDPOOL_FILE = path.join(DATA_DIR, 'wordpool.json');
const MAX_ENTRIES = 120;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'where', 'which', 'while', 'about',
  'after', 'before', 'their', 'there', 'these', 'those', 'have', 'has', 'had', 'were', 'been', 'being',
  'will', 'would', 'could', 'should', 'must', 'over', 'under', 'between', 'through', 'during', 'against',
  'other', 'some', 'more', 'most', 'such', 'only', 'than', 'then', 'very', 'just', 'also', 'even', 'back',
  'they', 'them', 'what', 'your', 'life', 'world', 'story', 'series', 'show', 'season', 'episode', 'episodes',
  'movie', 'film', 'finds', 'find', 'must', 'live', 'lives', 'year', 'years', 'time', 'young', 'woman', 'man',
  'family', 'home', 'make', 'makes', 'takes', 'take', 'goes', 'comes', 'two', 'three', 'one', 'new', 'old',
  'high', 'good', 'great', 'best', 'real', 'true', 'help', 'turns', 'sets', 'first', 'last', 'aftermath',
  'becomes', 'discover', 'discovers', 'forced', 'secret', 'secrets', 'begins', 'following', 'amid', 'together',
  'television', 'american', 'british', 'drama', 'comedy', 'action', 'adventure',
]);

let state = {
  entries: [],
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

function normText(str) {
  return stripHtml(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTokens(str) {
  const n = normText(str);
  return n ? n.split(' ') : [];
}

function damerauLevenshtein(a, b, maxDist = 2) {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > maxDist) return maxDist + 1;
  if (a === b) return 0;

  const dp = Array.from({ length: al + 1 }, () => new Int16Array(bl + 1));
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;

  for (let i = 1; i <= al; i++) {
    let rowMin = maxDist + 1;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2][j - 2] + 1);
      }
      dp[i][j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
  }
  return dp[al][bl];
}

function bigramDice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const mapA = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    mapA.set(bg, (mapA.get(bg) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const n = mapA.get(bg) || 0;
    if (n > 0) {
      overlap++;
      mapA.set(bg, n - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

function singleTokenSimilarity(queryTok, candTok) {
  if (!queryTok || !candTok) return 0;
  if (queryTok === candTok) return 1;
  const qLen = queryTok.length;
  const cLen = candTok.length;

  // Stem/prefix handling (e.g. "investigates" ~ "investigate", "scrub" ~ "scrubs")
  if (qLen >= 5 && cLen >= 5) {
    const minLen = Math.min(qLen, cLen);
    const maxLen = Math.max(qLen, cLen);
    if ((candTok.startsWith(queryTok) || queryTok.startsWith(candTok)) && maxLen - minLen <= 4) {
      return 0.88;
    }
  }

  if (qLen < 4 || cLen < 4) return 0;
  const maxEdits = qLen >= 7 && cLen >= 7 ? 2 : 1;
  if (Math.abs(qLen - cLen) <= maxEdits) {
    const dist = damerauLevenshtein(queryTok, candTok, maxEdits);
    if (dist <= maxEdits) {
      return Math.max(0.74, 1 - dist / Math.max(qLen, cLen));
    }
  }

  if (qLen >= 5 && cLen >= 5 && Math.abs(qLen - cLen) <= 3) {
    const dice = bigramDice(queryTok, candTok);
    if (dice >= 0.78) return dice * 0.92;
  }
  return 0;
}

function makeSnippet(rawText, matchText) {
  const clean = stripHtml(rawText);
  if (!clean) return '';
  if (!matchText) return clean.slice(0, 120);
  const lowClean = clean.toLowerCase();
  const idx = lowClean.indexOf(String(matchText).toLowerCase());
  if (idx < 0) return clean.slice(0, 120);
  const start = Math.max(0, idx - 36);
  const end = Math.min(clean.length, idx + String(matchText).length + 52);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}

/** Parse optional inline `term NO excluded1, excluded2` syntax cleanly. */
function parseRuleInput(rawTerm, { excludeTerms = [], aliases = [] } = {}) {
  let termStr = String(rawTerm || '').trim();
  const inlineExcludes = [];
  const noSplit = termStr.match(/^(.+?)\s+\bNO\b(?::|\s)+(.+)$/);
  if (noSplit) {
    termStr = noSplit[1].trim();
    for (const part of noSplit[2].split(/[,;|]+/)) {
      const cleaned = part.trim();
      if (cleaned) inlineExcludes.push(cleaned);
    }
  }
  const cleanAliases = [...new Set((Array.isArray(aliases) ? aliases : String(aliases || '').split(/[,;|]+/)).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 12);
  const cleanExcludes = [...new Set([
    ...(Array.isArray(excludeTerms) ? excludeTerms : String(excludeTerms || '').split(/[,;|]+/)),
    ...inlineExcludes,
  ].map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 16);

  return { term: termStr, aliases: cleanAliases, excludeTerms: cleanExcludes };
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = raw.mode === 'primary' || raw.mode === 'exclude' ? raw.mode : 'fuzzy';
  const parsed = parseRuleInput(raw.term, { excludeTerms: raw.excludeTerms, aliases: raw.aliases });
  if (!parsed.term || parsed.term.length < 2) return null;
  return {
    id: String(raw.id || `wp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`),
    term: parsed.term.slice(0, 80),
    mode,
    aliases: parsed.aliases,
    excludeTerms: parsed.excludeTerms,
    enabled: raw.enabled !== false,
    weight: Math.max(1, Math.min(5, Number(raw.weight) || (mode === 'primary' ? 5 : 2))),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = WORDPOOL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ entries: state.entries }, null, 2));
  fs.renameSync(tmp, WORDPOOL_FILE);
}

function load() {
  state = { entries: [] };
  if (!fs.existsSync(WORDPOOL_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(WORDPOOL_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.entries) ? raw.entries : [];
    state.entries = list.map(sanitizeEntry).filter(Boolean).slice(0, MAX_ENTRIES);
  } catch (err) {
    console.error('Could not read wordpool.json:', err.message);
  }
}

function listEntries() {
  return state.entries.map((e) => ({ ...e, aliases: [...e.aliases], excludeTerms: [...e.excludeTerms] }));
}

function getStats() {
  let primary = 0;
  let fuzzy = 0;
  let exclude = 0;
  for (const e of state.entries) {
    if (!e.enabled) continue;
    if (e.mode === 'primary') primary++;
    else if (e.mode === 'exclude') exclude++;
    else fuzzy++;
  }
  return { total: state.entries.length, active: primary + fuzzy + exclude, primary, fuzzy, exclude };
}

function hasActiveEntries() {
  return state.entries.some((e) => e.enabled);
}

function addEntry(input = {}) {
  const clean = sanitizeEntry({ ...input, createdAt: Date.now(), updatedAt: Date.now() });
  if (!clean) throw new Error('Enter a word or phrase (at least 2 characters)');
  const lowTerm = normText(clean.term);
  const existingIdx = state.entries.findIndex((e) => e.mode === clean.mode && normText(e.term) === lowTerm);
  if (existingIdx >= 0) {
    const prev = state.entries[existingIdx];
    const merged = sanitizeEntry({
      ...prev,
      aliases: [...new Set([...prev.aliases, ...clean.aliases])],
      excludeTerms: [...new Set([...prev.excludeTerms, ...clean.excludeTerms])],
      enabled: true,
      weight: clean.weight,
      updatedAt: Date.now(),
    });
    state.entries[existingIdx] = merged;
    save();
    return merged;
  }
  state.entries.unshift(clean);
  state.entries = state.entries.slice(0, MAX_ENTRIES);
  save();
  return clean;
}

function updateEntry(id, patch = {}) {
  const idx = state.entries.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  const cur = state.entries[idx];
  const next = sanitizeEntry({
    ...cur,
    ...(patch.term !== undefined ? { term: patch.term } : {}),
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.aliases !== undefined ? { aliases: patch.aliases } : {}),
    ...(patch.excludeTerms !== undefined ? { excludeTerms: patch.excludeTerms } : {}),
    ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
    ...(patch.weight !== undefined ? { weight: patch.weight } : {}),
    id: cur.id,
    createdAt: cur.createdAt,
    updatedAt: Date.now(),
  });
  if (!next) return null;
  state.entries[idx] = next;
  save();
  return next;
}

function removeEntry(id) {
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => e.id !== id);
  if (state.entries.length !== before) {
    save();
    return true;
  }
  return false;
}

function exportData() {
  return { entries: listEntries() };
}

function importData(raw = {}, { replace = false } = {}) {
  const incoming = (Array.isArray(raw) ? raw : Array.isArray(raw && raw.entries) ? raw.entries : [])
    .map(sanitizeEntry)
    .filter(Boolean);
  if (replace) {
    state.entries = incoming.slice(0, MAX_ENTRIES);
  } else {
    const map = new Map(state.entries.map((e) => [`${e.mode}:${normText(e.term)}`, e]));
    for (const e of incoming) map.set(`${e.mode}:${normText(e.term)}`, e);
    state.entries = [...map.values()].slice(0, MAX_ENTRIES);
  }
  save();
  return state.entries.length;
}

/**
 * Build searchable local field buckets from a media/candidate object plus optional cached Wiki dossier.
 * Strictly zero network requests.
 */
function buildSearchDoc(item = {}, { wikiDossier = null, episodeSummaries = [] } = {}) {
  const rawTitle = String(item.name || item.title || '').trim();
  const rawSummary = stripHtml(item.summary || item.overview || '');
  const epText = Array.isArray(episodeSummaries) ? episodeSummaries.map(stripHtml).filter(Boolean).join(' · ') : '';

  const peopleList = [];
  for (const p of item.creators || []) peopleList.push(typeof p === 'string' ? p : p && p.name);
  for (const p of item.crew || []) peopleList.push(typeof p === 'string' ? p : p && p.name);
  for (const p of item.cast || []) peopleList.push(typeof p === 'string' ? p : p && p.name);

  const tagList = [
    ...(item.genres || []),
    ...((item.keywords || []).map((k) => (typeof k === 'string' ? k : k && k.name))),
    ...(item.studios || []),
    item.channelName || (item.network && item.network.name) || (item.webChannel && item.webChannel.name) || '',
    item.language || '',
    item.type || '',
  ];

  const wikiParts = [];
  if (wikiDossier && wikiDossier.found) {
    if (wikiDossier.extract) wikiParts.push(wikiDossier.extract);
    if (wikiDossier.description) wikiParts.push(wikiDossier.description);
    for (const a of wikiDossier.awards || []) wikiParts.push(a);
    for (const b of wikiDossier.basedOn || []) wikiParts.push(b && b.name);
    for (const a of wikiDossier.authors || []) wikiParts.push(a && a.name);
    for (const l of wikiDossier.locations || []) wikiParts.push(l);
    for (const l of wikiDossier.filmingLocations || []) wikiParts.push(l);
  }

  const rawByField = {
    title: rawTitle,
    people: peopleList.filter(Boolean).join(', '),
    tags: tagList.filter(Boolean).join(', '),
    episode: epText,
    summary: rawSummary,
    wiki: wikiParts.filter(Boolean).join(' · '),
  };

  const fields = [];
  for (const field of ['title', 'people', 'tags', 'episode', 'summary', 'wiki']) {
    const raw = rawByField[field];
    if (!raw) continue;
    const norm = normText(raw);
    if (!norm) continue;
    fields.push({
      field,
      raw,
      norm,
      padded: ` ${norm} `,
      tokens: norm.split(' '),
    });
  }
  return { rawTitle, fields };
}

function strictMatchPhrase(phrase, fields) {
  const nPhrase = normText(phrase);
  if (!nPhrase || nPhrase.length < 2) return null;
  const needle = ` ${nPhrase} `;
  for (const f of fields) {
    const pos = f.padded.indexOf(needle);
    if (pos >= 0) {
      return {
        field: f.field,
        matchedText: phrase,
        confidence: 100,
        snippet: makeSnippet(f.raw, phrase),
      };
    }
  }
  return null;
}

function fuzzyMatchPhrase(phrase, fields) {
  const qToks = splitTokens(phrase);
  if (!qToks.length) return null;
  const nPhrase = qToks.join(' ');
  const needle = ` ${nPhrase} `;

  // 1. Exact whole-phrase / token-sequence match first (still labeled Fuzzy Match when entry mode is fuzzy)
  for (const f of fields) {
    if (f.padded.includes(needle)) {
      return {
        field: f.field,
        matchedText: phrase,
        confidence: f.field === 'title' ? 98 : 94,
        snippet: makeSnippet(f.raw, phrase),
      };
    }
  }

  // 2. Direct substring match inside contiguous words (for compound nouns like time-loop / cybernetics)
  if (nPhrase.length >= 4) {
    for (const f of fields) {
      const idx = f.norm.indexOf(nPhrase);
      if (idx >= 0) {
        return {
          field: f.field,
          matchedText: phrase,
          confidence: 90,
          snippet: makeSnippet(f.raw, phrase),
        };
      }
    }
  }

  // 3. Single-word or short multi-word typo/stem tolerant sliding window ("sceubs" -> "scrubs", "gordon ramsey" -> "Gordon Ramsay")
  let best = null;
  const qLen = qToks.length;
  for (const f of fields) {
    const toks = f.tokens;
    if (!toks.length) continue;

    if (qLen === 1) {
      const qt = qToks[0];
      if (qt.length < 3) continue;
      for (const ct of toks) {
        const sim = singleTokenSimilarity(qt, ct);
        if (sim >= 0.74) {
          const conf = Math.round(sim * 100);
          if (!best || conf > best.confidence) {
            best = {
              field: f.field,
              matchedText: ct,
              confidence: Math.min(95, conf),
              snippet: makeSnippet(f.raw, ct),
            };
            if (conf >= 92) return best;
          }
        }
      }
    } else if (qLen <= 4) {
      for (let i = 0; i <= toks.length - qLen; i++) {
        // Every query token must match in order within window length qLen + 1
        let minSim = 1;
        let sumSim = 0;
        let ti = i;
        let matchedAll = true;
        const matchedSpan = [];
        for (let qi = 0; qi < qLen; qi++) {
          const qt = qToks[qi];
          let tokSim = ti < toks.length ? singleTokenSimilarity(qt, toks[ti]) : 0;
          if (tokSim < 0.72 && ti + 1 < toks.length && ti - i <= qLen) {
            const nextSim = singleTokenSimilarity(qt, toks[ti + 1]);
            if (nextSim >= 0.72) {
              ti += 1;
              tokSim = nextSim;
            }
          }
          if (tokSim < 0.72) {
            matchedAll = false;
            break;
          }
          matchedSpan.push(toks[ti]);
          minSim = Math.min(minSim, tokSim);
          sumSim += tokSim;
          ti++;
        }
        if (matchedAll) {
          const avgSim = sumSim / qLen;
          const conf = Math.min(95, Math.round((avgSim * 0.7 + minSim * 0.3) * 100));
          if (!best || conf > best.confidence) {
            const phraseSpan = matchedSpan.join(' ');
            best = {
              field: f.field,
              matchedText: phraseSpan,
              confidence: conf,
              snippet: makeSnippet(f.raw, matchedSpan[0]),
            };
          }
        }
      }
    }
  }
  return best;
}

function docMatchesExclusion(terms, fields) {
  for (const ex of terms || []) {
    if (!ex) continue;
    const hit = strictMatchPhrase(ex, fields) || (splitTokens(ex).length <= 3 && fuzzyMatchPhrase(ex, fields));
    if (hit && hit.confidence >= 84) return ex;
  }
  return null;
}

/**
 * Evaluate all active Word Pool entries against an item/candidate + optional cached Wiki/episodes.
 * Returns { primary, fuzzy, excluded, primaryMatches, fuzzyMatches, excludeMatches, badgeLabel }.
 */
function matchItem(item = {}, opts = {}) {
  if (!hasActiveEntries()) {
    return { primary: false, fuzzy: false, excluded: false, primaryMatches: [], fuzzyMatches: [], excludeMatches: [] };
  }
  const doc = opts._doc || buildSearchDoc(item, opts);
  const fields = doc.fields;
  if (!fields.length) {
    return { primary: false, fuzzy: false, excluded: false, primaryMatches: [], fuzzyMatches: [], excludeMatches: [] };
  }

  const primaryMatches = [];
  const fuzzyMatches = [];
  const excludeMatches = [];

  for (const entry of state.entries) {
    if (!entry.enabled) continue;
    const phrases = [entry.term, ...(entry.aliases || [])].filter(Boolean);

    if (entry.mode === 'exclude') {
      for (const ph of phrases) {
        const m = strictMatchPhrase(ph, fields);
        if (m) {
          excludeMatches.push({ entryId: entry.id, term: entry.term, ...m });
          break;
        }
      }
      continue;
    }

    // Per-rule `NO ...` exclusions suppress that rule cleanly if hit
    if (entry.excludeTerms && entry.excludeTerms.length && docMatchesExclusion(entry.excludeTerms, fields)) {
      continue;
    }

    if (entry.mode === 'primary') {
      let bestStrict = null;
      for (const ph of phrases) {
        const hit = strictMatchPhrase(ph, fields);
        if (hit) {
          bestStrict = {
            entryId: entry.id,
            mode: 'primary',
            label: 'Primary Override',
            term: entry.term,
            weight: entry.weight,
            ...hit,
          };
          break;
        }
      }
      if (bestStrict) primaryMatches.push(bestStrict);
    } else {
      let bestFuzzy = null;
      for (const ph of phrases) {
        const hit = fuzzyMatchPhrase(ph, fields);
        if (hit && (!bestFuzzy || hit.confidence > bestFuzzy.confidence)) {
          bestFuzzy = {
            entryId: entry.id,
            mode: 'fuzzy',
            label: 'Fuzzy Match',
            term: entry.term,
            weight: entry.weight,
            ...hit,
          };
        }
      }
      if (bestFuzzy) fuzzyMatches.push(bestFuzzy);
    }
  }

  // Respect global `NO` excludes unless a strict Primary Override claims the item (*Primary overrides all* except user Hidden)
  const primary = primaryMatches.length > 0;
  const fuzzy = !primary && excludeMatches.length === 0 ? fuzzyMatches.length > 0 : primary && fuzzyMatches.length > 0;
  const excluded = !primary && excludeMatches.length > 0;

  return {
    primary,
    fuzzy,
    excluded,
    primaryMatches,
    fuzzyMatches: excludeMatches.length > 0 && !primary ? [] : fuzzyMatches,
    excludeMatches,
  };
}

/** Match an arbitrary search query string (e.g. from top bar or Graxobolt search) against local items. */
function searchLocalFuzzy(query, items = [], { wiki = null, limit = 8 } = {}) {
  const q = String(query || '').trim();
  const qToks = splitTokens(q);
  if (!qToks.length || q.length < 2) return [];

  const exactNorm = qToks.join(' ');
  const out = [];
  for (const item of items) {
    if (!item || !item.name) continue;
    const wikiDossier =
      wiki && typeof wiki.peekCachedDossier === 'function'
        ? wiki.peekCachedDossier({
            kind: item.kind || 'show',
            name: item.name,
            year: item.premiered ? String(item.premiered).slice(0, 4) : '',
            imdbId: item.imdbId || null,
          })
        : null;
    const doc = buildSearchDoc(item, { wikiDossier });
    const titleNorm = normText(item.name);
    if (titleNorm === exactNorm) continue; // Exact matches already come from main API search cleanly

    const hit = fuzzyMatchPhrase(q, doc.fields);
    if (!hit) continue;
    // Require stronger threshold for casual queries so irrelevant noise doesn't flood dropdown
    const minConf = hit.field === 'title' ? 76 : 86;
    if (hit.confidence < minConf) continue;

    out.push({
      item,
      confidence: hit.confidence,
      field: hit.field,
      snippet: hit.snippet,
      label: 'Fuzzy Match',
    });
  }

  out.sort((a, b) => b.confidence - a.confidence || (b.item.popularity || 0) - (a.item.popularity || 0));
  return out.slice(0, limit);
}

/** Suggest distinct 1–2 word phrases purely from local library & cached Wikipedia lore (0 network calls). */
function suggestFromLocal({ store, movies, recommender, wiki, limit = 16 } = {}) {
  const existingNorm = new Set(state.entries.map((e) => normText(e.term)));
  const phraseScores = new Map();
  const addPhrase = (raw, weight = 1) => {
    const clean = stripHtml(raw).trim();
    const norm = normText(clean);
    if (!norm || norm.length < 4 || norm.length > 36 || existingNorm.has(norm)) return;
    if (STOPWORDS.has(norm)) return;
    const cur = phraseScores.get(norm) || { term: clean, score: 0 };
    cur.score += weight;
    phraseScores.set(norm, cur);
  };

  const trackedShows = store && typeof store.listShows === 'function' ? store.listShows() : [];
  for (const s of trackedShows.slice(0, 60)) {
    const w = s.favorite ? 2.4 : 1.0;
    const deep = recommender ? recommender.readItemCache(`tv_${s.id}`) : null;
    for (const kw of (deep && deep.keywords) || []) {
      const kName = typeof kw === 'string' ? kw : kw && kw.name;
      if (kName) addPhrase(kName, w * 1.4);
    }
    for (const cr of ((deep && (deep.creators || deep.crew)) || []).slice(0, 2)) {
      const name = typeof cr === 'string' ? cr : cr && cr.name;
      if (name) addPhrase(name, w * 1.2);
    }
    const wd =
      wiki && typeof wiki.peekCachedDossier === 'function'
        ? wiki.peekCachedDossier({
            kind: 'show',
            name: s.name,
            year: (s.premiered || '').slice(0, 4),
            imdbId: (s.externals && s.externals.imdb) || (deep && deep.imdbId) || null,
          })
        : null;
    if (wd && wd.found) {
      for (const b of wd.basedOn || []) if (b && b.name) addPhrase(b.name, w * 1.6);
      for (const a of wd.authors || []) if (a && a.name) addPhrase(a.name, w * 1.5);
    }
    const toks = splitTokens(s.summary || '');
    for (let i = 0; i < toks.length; i++) {
      const a = toks[i];
      if (a.length >= 5 && !STOPWORDS.has(a)) addPhrase(a, w * 0.45);
      if (i + 1 < toks.length) {
        const b = toks[i + 1];
        if (a.length >= 4 && b.length >= 4 && !STOPWORDS.has(a) && !STOPWORDS.has(b)) {
          addPhrase(`${a} ${b}`, w * 0.7);
        }
      }
    }
  }

  const trackedMovies = movies && typeof movies.listMovies === 'function' ? movies.listMovies() : [];
  for (const m of trackedMovies.slice(0, 40)) {
    const w = m.favorite ? 2.2 : 1.0;
    const deep = recommender ? recommender.readItemCache(`tmdb_movie_${m.id}`) : null;
    for (const kw of (deep && deep.keywords) || []) {
      const kName = typeof kw === 'string' ? kw : kw && kw.name;
      if (kName) addPhrase(kName, w * 1.4);
    }
  }

  return [...phraseScores.values()]
    .filter((x) => x.score >= 1.8)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ term: x.term, score: Math.round(x.score * 10) / 10 }));
}

module.exports = {
  load,
  listEntries,
  getStats,
  hasActiveEntries,
  addEntry,
  updateEntry,
  removeEntry,
  exportData,
  importData,
  buildSearchDoc,
  matchItem,
  searchLocalFuzzy,
  suggestFromLocal,
  normText,
};
