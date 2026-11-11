'use strict';

/**
 * Automatic weekly new-show discovery powered by TVmaze.
 * Once per ISO week (when enabled), scans TVmaze's daily TV and streaming schedules
 * for all brand-new Series Premieres (S01E01) debuting that week that are not
 * already tracked (or previously dismissed by the user), and adds them with
 * source = 'auto-weekly'.
 */

const fs = require('fs');
const path = require('path');
const tvmaze = require('./tvmaze');
const store = require('./store');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DISCOVERY_FILE = path.join(DATA_DIR, 'discovery.json');
const MAX_HISTORY = 100;

const state = {
  enabled: true,
  lastWeek: null,
  lastRunAt: null,
  lastBatch: [],
  history: [],
  excludedIds: [],
  dismissed: [],
  rules: {
    englishOnly: false,
    scriptedOnly: false,
    minWeight: 0,
    genres: [],
  },
};

const job = {
  running: false,
  total: 0,
  done: 0,
  current: null,
  added: [],
  finishedAt: null,
  error: null,
};

function isoWeekKey(date = new Date()) {
  const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weekDates(baseDate = new Date(), offsetDays = 0, count = 7) {
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow + offsetDays);
  const out = [];
  for (let i = 0; i < count; i++) {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`);
  }
  return out;
}

const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

function load() {
  if (!fs.existsSync(DISCOVERY_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8'));
    if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled;
    if (raw.lastWeek) state.lastWeek = raw.lastWeek;
    if (raw.lastRunAt) state.lastRunAt = raw.lastRunAt;
    if (Array.isArray(raw.lastBatch)) state.lastBatch = raw.lastBatch;
    if (Array.isArray(raw.history)) state.history = raw.history.slice(0, MAX_HISTORY);
    if (Array.isArray(raw.excludedIds)) state.excludedIds = raw.excludedIds.map(Number).filter(Boolean);
    if (Array.isArray(raw.dismissed)) state.dismissed = raw.dismissed.filter((x) => x && Number(x.id)).slice(0, 500);
    if (raw.rules && typeof raw.rules === 'object') {
      state.rules.englishOnly = Boolean(raw.rules.englishOnly);
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
  if (patch.englishOnly !== undefined) state.rules.englishOnly = Boolean(patch.englishOnly);
  if (patch.scriptedOnly !== undefined) state.rules.scriptedOnly = Boolean(patch.scriptedOnly);
  if (patch.minWeight !== undefined) state.rules.minWeight = Math.max(0, Math.min(100, Number(patch.minWeight) || 0));
  if (Array.isArray(patch.genres)) state.rules.genres = [...new Set(patch.genres.map((g) => String(g).trim()).filter(Boolean))];
  save();
  return getStatus();
}

function matchesRules(show) {
  const r = state.rules;
  if (r.englishOnly && show.language !== 'English') return false;
  if (r.scriptedOnly && show.type !== 'Scripted' && show.type !== 'Animation') return false;
  if (r.minWeight > 0 && (show.weight || 0) < r.minWeight) return false;
  if (r.genres.length > 0 && !(show.genres || []).some((g) => r.genres.includes(g))) return false;
  return true;
}

function markExcluded(id, meta = null) {
  id = Number(id);
  let changed = false;
  if (!state.excludedIds.includes(id)) {
    state.excludedIds.push(id);
    if (state.excludedIds.length > 500) state.excludedIds.shift();
    changed = true;
  }
  if (meta && meta.name) {
    const entry = {
      id,
      name: String(meta.name).slice(0, 120),
      premiered: meta.premiered || null,
      source: meta.source || null,
      wasSource: meta.wasSource || null,
      dismissedAt: Date.now(),
    };
    state.dismissed = [entry, ...state.dismissed.filter((x) => x.id !== id)].slice(0, 500);
    changed = true;
  }
  if (changed) save();
}

function unmarkExcluded(id) {
  id = Number(id);
  const prev = state.dismissed.find((x) => x.id === id) || null;
  const nextIds = state.excludedIds.filter((x) => x !== id);
  const nextMeta = state.dismissed.filter((x) => x.id !== id);
  if (nextIds.length !== state.excludedIds.length || nextMeta.length !== state.dismissed.length) {
    state.excludedIds = nextIds;
    state.dismissed = nextMeta;
    save();
  }
  return prev;
}

function clearExcluded() {
  if (!state.excludedIds.length && !state.dismissed.length) return;
  state.excludedIds = [];
  state.dismissed = [];
  save();
}

async function findNewPremieres(dates, excludedSet) {
  const candidates = new Map();
  const midDate = dates[Math.floor(dates.length / 2)];
  for (const date of dates) {
    const [web, tv] = await Promise.all([tvmaze.fetchSchedule(date, true), tvmaze.fetchSchedule(date, false)]);
    for (const item of [...web, ...tv]) {
      const show = (item._embedded && item._embedded.show) || item.show;
      if (!show || candidates.has(show.id)) continue;
      if (item.season !== 1 || item.number !== 1) continue;
      if (!show.network && !show.webChannel) continue;
      if (store.isTracked(show.id) || excludedSet.has(show.id)) continue;
      if (!show.premiered || dayDiff(show.premiered, midDate) > 10) continue;
      if (!matchesRules(show)) continue;
      candidates.set(show.id, show);
    }
  }
  return [...candidates.values()].sort((a, b) => (b.weight || 0) - (a.weight || 0) || b.id - a.id);
}

/**
 * Scan the current week on TVmaze and add all brand-new S01E01 shows.
 * Runs at most once per ISO week automatically, or immediately when `force` is true.
 */
function runWeeklyDiscovery({ force = false } = {}) {
  const currentWeek = isoWeekKey();
  if (job.running) return getStatus();
  if (!force && (!state.enabled || state.lastWeek === currentWeek)) return getStatus();

  Object.assign(job, {
    running: true,
    total: 0,
    done: 0,
    current: 'Scanning TVmaze schedule…',
    added: [],
    finishedAt: null,
    error: null,
  });

  (async () => {
    try {
      const excluded = new Set(state.excludedIds);
      const thisWeek = weekDates(new Date(), 0, 7);
      const picks = await findNewPremieres(thisWeek, excluded);
      job.total = picks.length;

      const added = [];
      let idx = 0;
      const worker = async () => {
        while (idx < picks.length) {
          const show = picks[idx++];
          job.current = show.name;
          try {
            const summary = await store.addShow(show.id, 'auto-weekly');
            const src = summary.network || summary.webChannel;
            const entry = {
              id: summary.id,
              name: summary.name,
              week: currentWeek,
              premiered: summary.premiered,
              source: src ? src.name : null,
              addedAt: Date.now(),
            };
            added.push(entry);
            job.added.push(entry);
          } catch (err) {
            console.error(`  ! weekly discovery (${show.name}): ${err.message}`);
          }
          job.done++;
        }
      };
      await Promise.all([worker(), worker(), worker()]);

      state.lastWeek = currentWeek;
      state.lastRunAt = Date.now();
      if (added.length || !force) {
        const prevSameWeek = state.lastBatch.filter((x) => x.week === currentWeek);
        state.lastBatch = force ? [...added, ...prevSameWeek] : added;
      }
      state.history = [...added, ...state.history].slice(0, MAX_HISTORY);
      save();
      console.log(`Weekly discovery (${currentWeek}): added ${added.length} new show(s)`);
    } catch (err) {
      job.error = err.message;
      console.error('Weekly discovery failed:', err.message);
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
    currentWeek: isoWeekKey(),
    lastWeek: state.lastWeek,
    lastRunAt: state.lastRunAt,
    lastBatch: state.lastBatch,
    dismissed: state.dismissed,
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
  getStatus,
  getRules,
  setEnabled,
  setRules,
  runWeeklyDiscovery,
  markExcluded,
  unmarkExcluded,
  clearExcluded,
  isoWeekKey,
  weekDates,
};
