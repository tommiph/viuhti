'use strict';

/**
 * Automatic twice-monthly show sync powered by TVmaze.
 * Runs automatically twice per calendar month (1st half: days 1–15, 2nd half: days 16–end),
 * looking two weeks ahead (today through today + 14 days) across TVmaze's full and daily
 * schedules so new or newly updated shows are never missed while hidden shows stay excluded.
 */

const fs = require('fs');
const path = require('path');
const tvmaze = require('./tvmaze');
const store = require('./store');
const hidden = require('./hidden');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DISCOVERY_FILE = path.join(DATA_DIR, 'discovery.json');
const MAX_HISTORY = 100;

const state = {
  enabled: true,
  lastPeriod: null,
  lastRunAt: null,
  lastBatch: [],
  history: [],
  rules: {
    languages: [],
    englishOnly: false,
    scriptedOnly: false,
    minWeight: 0,
    genres: [],
  },
};

let hasExplicitLanguageRule = false;

const job = {
  running: false,
  total: 0,
  done: 0,
  current: null,
  added: [],
  finishedAt: null,
  error: null,
};

function halfMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const half = date.getDate() <= 15 ? '1' : '2';
  return `${y}-${m}-${half}`;
}

function forwardDates(baseDate = new Date(), daysCount = 15) {
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const out = [];
  for (let i = 0; i < daysCount; i++) {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`);
  }
  return out;
}

function isPeriodDue(lastPeriod, now = new Date()) {
  return !lastPeriod || lastPeriod !== halfMonthKey(now);
}

function load() {
  hasExplicitLanguageRule = false;
  if (!fs.existsSync(DISCOVERY_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8'));
    if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled;
    if (raw.lastPeriod) {
      state.lastPeriod = raw.lastPeriod;
    } else if (raw.lastRunAt) {
      state.lastPeriod = halfMonthKey(new Date(raw.lastRunAt));
    }
    if (raw.lastRunAt) state.lastRunAt = raw.lastRunAt;
    if (Array.isArray(raw.lastBatch)) state.lastBatch = raw.lastBatch;
    if (Array.isArray(raw.history)) state.history = raw.history.slice(0, MAX_HISTORY);
    if (raw.rules && typeof raw.rules === 'object') {
      if (Array.isArray(raw.rules.languages)) {
        state.rules.languages = [...new Set(raw.rules.languages.map((l) => String(l || '').trim()).filter(Boolean))];
        state.rules.englishOnly = state.rules.languages.length === 1 && state.rules.languages[0] === 'English';
        hasExplicitLanguageRule = true;
      } else {
        state.rules.englishOnly = Boolean(raw.rules.englishOnly);
        state.rules.languages = state.rules.englishOnly ? ['English'] : [];
        if (raw.rules.englishOnly) hasExplicitLanguageRule = true;
      }
      state.rules.scriptedOnly = Boolean(raw.rules.scriptedOnly);
      state.rules.minWeight = Math.max(0, Math.min(100, Number(raw.rules.minWeight) || 0));
      state.rules.genres = Array.isArray(raw.rules.genres) ? raw.rules.genres.filter((g) => typeof g === 'string' && g.trim()) : [];
    }
  } catch (err) {
    console.error('Could not read discovery.json:', err.message);
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DISCOVERY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DISCOVERY_FILE);
}

function setEnabled(enabled) {
  state.enabled = Boolean(enabled);
  save();
  return getStatus();
}

function setRules(patch = {}) {
  if (Array.isArray(patch.languages)) {
    state.rules.languages = [...new Set(patch.languages.map((l) => String(l || '').trim()).filter(Boolean))];
    state.rules.englishOnly = state.rules.languages.length === 1 && state.rules.languages[0] === 'English';
    hasExplicitLanguageRule = true;
  } else if (patch.englishOnly !== undefined) {
    state.rules.englishOnly = Boolean(patch.englishOnly);
    state.rules.languages = state.rules.englishOnly ? ['English'] : [];
    hasExplicitLanguageRule = true;
  }
  if (patch.scriptedOnly !== undefined) state.rules.scriptedOnly = Boolean(patch.scriptedOnly);
  if (patch.minWeight !== undefined) state.rules.minWeight = Math.max(0, Math.min(100, Number(patch.minWeight) || 0));
  if (Array.isArray(patch.genres)) state.rules.genres = [...new Set(patch.genres.map((g) => String(g).trim()).filter(Boolean))];
  save();
  return getStatus();
}

function activeLanguages() {
  if (Array.isArray(state.rules.languages) && state.rules.languages.length) return state.rules.languages;
  return state.rules.englishOnly ? ['English'] : [];
}

function matchesRules(show) {
  const r = state.rules;
  const langs = activeLanguages();
  if (langs.length > 0 && !langs.includes(show.language || 'Unknown')) return false;
  if (r.scriptedOnly && show.type !== 'Scripted' && show.type !== 'Animation') return false;
  if (r.minWeight > 0 && (show.weight || 0) < r.minWeight) return false;
  if (r.genres.length > 0 && !(show.genres || []).some((g) => r.genres.includes(g))) return false;
  return true;
}

/**
 * Collect all matching TVmaze shows airing inside the next two weeks [fromDate, toDate]
 * by combining `/schedule/full` (global coverage) and per-day web + broadcast schedules,
 * while strictly skipping active or hidden shows.
 */
async function findUpcomingShows(dates) {
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];
  const candidates = new Map();

  const considerItem = (item) => {
    if (!item || !item.airdate || item.airdate < fromDate || item.airdate > toDate) return;
    if (item.type === 'insignificant_special') return;
    const show = (item._embedded && item._embedded.show) || item.show;
    if (!show || !show.id || candidates.has(show.id)) return;
    if (!show.network && !show.webChannel) return;
    if (store.isTracked(show.id) || hidden.has('show', show.id)) return;
    if (!matchesRules(show)) return;
    candidates.set(show.id, show);
  };

  let fullList = [];
  try {
    fullList = (await tvmaze.fetchFullSchedule()) || [];
  } catch (err) {
    console.error('Could not fetch TVmaze full schedule:', err.message);
  }
  for (const item of fullList) considerItem(item);

  for (const date of dates) {
    try {
      const [web, tv] = await Promise.all([tvmaze.fetchSchedule(date, true), tvmaze.fetchSchedule(date, false)]);
      for (const item of [...web, ...tv]) considerItem(item);
    } catch (err) {
      console.error(`Could not fetch TVmaze schedule for ${date}:`, err.message);
    }
  }

  return [...candidates.values()].sort((a, b) => (b.weight || 0) - (a.weight || 0) || b.id - a.id);
}

/**
 * Scan the next two weeks on TVmaze and add all matching airing shows not in Hidden.
 * Runs automatically twice per month (`halfMonthKey`), or immediately when `force` is true.
 */
function runBiMonthlySync({ force = false } = {}) {
  const currentPeriod = halfMonthKey();
  if (job.running) return getStatus();
  if (!force && (!state.enabled || !isPeriodDue(state.lastPeriod))) return getStatus();

  Object.assign(job, {
    running: true,
    total: 0,
    done: 0,
    current: 'Scanning TVmaze (next 2 weeks)…',
    added: [],
    finishedAt: null,
    error: null,
  });

  (async () => {
    try {
      const dates = forwardDates(new Date(), 15);
      const picks = await findUpcomingShows(dates);
      job.total = picks.length;

      const added = [];
      let idx = 0;
      const worker = async () => {
        while (idx < picks.length) {
          const show = picks[idx++];
          job.current = show.name;
          try {
            if (hidden.has('show', show.id)) {
              job.done++;
              continue;
            }
            const summary = await store.addShow(show.id, 'auto-bimonthly');
            if (!summary) {
              job.done++;
              continue;
            }
            const src = summary.network || summary.webChannel;
            const entry = {
              id: summary.id,
              name: summary.name,
              period: currentPeriod,
              premiered: summary.premiered,
              source: src ? src.name : null,
              addedAt: Date.now(),
            };
            added.push(entry);
            job.added.push(entry);
          } catch (err) {
            console.error(`  ! TVmaze sync (${show.name}): ${err.message}`);
          }
          job.done++;
        }
      };
      await Promise.all([worker(), worker(), worker()]);

      state.lastPeriod = currentPeriod;
      state.lastRunAt = Date.now();
      if (added.length || !force) {
        const prevSamePeriod = state.lastBatch.filter((x) => x.period === currentPeriod);
        state.lastBatch = force ? [...added, ...prevSamePeriod] : added;
      }
      state.history = [...added, ...state.history].slice(0, MAX_HISTORY);
      save();
      console.log(`TVmaze bi-monthly sync (${currentPeriod}, ${dates[0]}..${dates[dates.length - 1]}): added ${added.length} show(s)`);
    } catch (err) {
      job.error = err.message;
      console.error('TVmaze bi-monthly sync failed:', err.message);
    } finally {
      job.running = false;
      job.current = null;
      job.finishedAt = Date.now();
    }
  })();

  return getStatus();
}

function getStatus() {
  return {
    enabled: state.enabled,
    running: job.running,
    total: job.total,
    done: job.done,
    current: job.current,
    added: job.added,
    finishedAt: job.finishedAt,
    currentPeriod: halfMonthKey(),
    lastPeriod: state.lastPeriod,
    lastRunAt: state.lastRunAt,
    lastBatch: state.lastBatch,
    rules: state.rules,
    error: job.error,
  };
}

function getRules() {
  return { ...state.rules };
}

module.exports = {
  load,
  hasSavedState: () => fs.existsSync(DISCOVERY_FILE),
  hasExplicitLanguageRule: () => hasExplicitLanguageRule,
  getStatus,
  getRules,
  activeLanguages,
  setEnabled,
  setRules,
  runBiMonthlySync,
  runWeeklyDiscovery: runBiMonthlySync,
  halfMonthKey,
  forwardDates,
  isPeriodDue,
};
