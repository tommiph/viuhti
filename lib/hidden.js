'use strict';

/**
 * Hidden items store (data/hidden.json).
 * Tracks all shows and movies hidden by the user without a 500-item cap so
 * automated TVmaze/TMDB updates never re-add hidden titles, while retaining
 * metadata so users can unhide them or view them at 25% opacity on the calendar.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HIDDEN_FILE = path.join(DATA_DIR, 'hidden.json');
const LEGACY_TRASH_FILE = path.join(DATA_DIR, 'trash.json');
const LEGACY_DISC_FILE = path.join(DATA_DIR, 'discovery.json');
const LEGACY_MOVIE_DISC_FILE = path.join(DATA_DIR, 'movies-discovery.json');

const idSets = { show: new Set(), movie: new Set() };
let items = []; // newest first
let migratedFromLegacy = false;

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function save() {
  writeJson(HIDDEN_FILE, {
    ids: {
      show: [...idSets.show],
      movie: [...idSets.movie],
    },
    items,
  });
}

function addEntry(entry, persist = true) {
  if (!entry || !Number(entry.id)) return null;
  const kind = entry.kind === 'movie' ? 'movie' : 'show';
  const id = Number(entry.id);
  idSets[kind].add(id);
  const clean = {
    id,
    kind,
    name: String(entry.name || `${kind} #${id}`).slice(0, 140),
    poster: entry.poster || null,
    banner: entry.banner || null,
    background: entry.background || null,
    logo: entry.logo || null,
    channelName: entry.channelName || null,
    channelKind: entry.channelKind || (kind === 'movie' ? 'stream' : 'tv'),
    premiered: entry.premiered || null,
    status: entry.status || null,
    hiddenAt: entry.hiddenAt || entry.trashedAt || Date.now(),
    record: entry.record || { id, addedAt: Date.now() },
  };
  items = [clean, ...items.filter((x) => !(x.id === id && x.kind === kind))];
  if (persist) save();
  return clean;
}

function migrateLegacy({ activeShowIds = new Set(), activeMovieIds = new Set(), cacheDir = null } = {}) {
  let touched = false;
  if (fs.existsSync(LEGACY_TRASH_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(LEGACY_TRASH_FILE, 'utf8'));
      for (const x of raw.items || []) {
        if (x && Number(x.id) && (x.kind === 'show' || x.kind === 'movie')) {
          addEntry(x, false);
          touched = true;
        }
      }
    } catch (err) {
      console.error('Could not migrate trash.json:', err.message);
    }
  }

  const readDisc = (file, kind) => {
    if (!fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const byId = new Map();
      for (const d of raw.dismissed || []) {
        if (d && Number(d.id)) byId.set(Number(d.id), d);
      }
      for (const idRaw of raw.excludedIds || []) {
        const id = Number(idRaw);
        if (!id || idSets[kind].has(id)) continue;
        if ((kind === 'show' ? activeShowIds : activeMovieIds).has(id)) continue;
        const meta = byId.get(id);
        addEntry(
          {
            id,
            kind,
            name: (meta && meta.name) || `${kind === 'movie' ? 'Movie' : 'Show'} #${id}`,
            premiered: meta ? meta.premiered : null,
            hiddenAt: (meta && meta.dismissedAt) || Date.now(),
          },
          false
        );
        touched = true;
      }
    } catch {
      /* ignore corrupt legacy discovery */
    }
  };
  readDisc(LEGACY_DISC_FILE, 'show');
  readDisc(LEGACY_MOVIE_DISC_FILE, 'movie');

  // Recover cached shows previously dropped past the old 500-item FIFO cap
  if (cacheDir && activeShowIds.size > 0 && fs.existsSync(cacheDir)) {
    try {
      for (const f of fs.readdirSync(cacheDir)) {
        const m = f.match(/^(\d+)\.json$/);
        if (!m) continue;
        const id = Number(m[1]);
        if (!id || activeShowIds.has(id) || idSets.show.has(id)) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
          const s = rec && rec.show;
          if (!s) continue;
          const net = s.network;
          const web = s.webChannel;
          const ch = net || web;
          addEntry(
            {
              id,
              kind: 'show',
              name: s.name,
              poster: s.poster || null,
              banner: s.banner || null,
              background: s.background || null,
              logo: s.logo || null,
              channelName: ch ? ch.name : null,
              channelKind: net ? 'tv' : 'stream',
              premiered: s.premiered || null,
              status: s.status || null,
              hiddenAt: Date.now(),
              record: { id, addedAt: Date.now() },
            },
            false
          );
          touched = true;
        } catch {
          /* ignore bad cache entry */
        }
      }
    } catch {
      /* ignore unreadable cache */
    }
  }

  if (touched) {
    migratedFromLegacy = true;
    save();
    console.log(`Migrated ${idSets.show.size} hidden show(s) and ${idSets.movie.size} hidden movie(s) into hidden.json`);
  }
}

function load(migrationOpts = null) {
  idSets.show.clear();
  idSets.movie.clear();
  items = [];
  if (fs.existsSync(HIDDEN_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8'));
      if (raw && raw.ids) {
        for (const id of raw.ids.show || []) if (Number(id)) idSets.show.add(Number(id));
        for (const id of raw.ids.movie || []) if (Number(id)) idSets.movie.add(Number(id));
      }
      if (Array.isArray(raw.items)) {
        items = raw.items.filter((x) => x && Number(x.id) && (x.kind === 'show' || x.kind === 'movie'));
        for (const x of items) idSets[x.kind].add(Number(x.id));
      }
    } catch (err) {
      console.error('Could not read hidden.json:', err.message);
    }
    return;
  }
  if (migrationOpts) migrateLegacy(migrationOpts);
}

function has(kind, id) {
  const k = kind === 'movie' ? 'movie' : 'show';
  return idSets[k].has(Number(id));
}

function add(entry) {
  return addEntry(entry, true);
}

function take(kind, id) {
  id = Number(id);
  const k = kind === 'movie' ? 'movie' : 'show';
  const hadId = idSets[k].delete(id);
  const idx = items.findIndex((x) => x.id === id && x.kind === k);
  let found = null;
  if (idx !== -1) {
    [found] = items.splice(idx, 1);
  }
  if (hadId || found) save();
  return found;
}

function remove(kind, id) {
  id = Number(id);
  const k = kind === 'movie' ? 'movie' : 'show';
  const hadId = idSets[k].has(id);
  const existedItem = items.some((x) => x.id === id && x.kind === k);
  take(k, id);
  return hadId || existedItem;
}

function find(kind, id) {
  id = Number(id);
  const k = kind === 'movie' ? 'movie' : 'show';
  if (!idSets[k].has(id)) return null;
  return items.find((x) => x.id === id && x.kind === k) || { id, kind: k, record: { id, addedAt: Date.now() } };
}

function updateRecord(kind, id, updater) {
  id = Number(id);
  const k = kind === 'movie' ? 'movie' : 'show';
  if (!idSets[k].has(id)) return null;
  let item = items.find((x) => x.id === id && x.kind === k);
  if (!item) {
    item = {
      id,
      kind: k,
      name: `${k === 'movie' ? 'Movie' : 'Show'} #${id}`,
      channelKind: k === 'movie' ? 'stream' : 'tv',
      hiddenAt: Date.now(),
      record: { id, addedAt: Date.now() },
    };
    items.unshift(item);
  }
  const base = { ...(item.record || { id, addedAt: Date.now() }) };
  item.record = updater(base) || base;
  save();
  return item;
}

function listIds(kind) {
  const k = kind === 'movie' ? 'movie' : 'show';
  return [...idSets[k]];
}

function list() {
  return items.map((x) => ({
    id: x.id,
    kind: x.kind,
    name: x.name,
    poster: x.poster,
    banner: x.banner,
    background: x.background,
    logo: x.logo,
    channelName: x.channelName,
    channelKind: x.channelKind,
    premiered: x.premiered,
    status: x.status,
    favorite: Boolean(x.record && x.record.favorite),
    extQuery: (x.record && x.record.extQuery) || null,
    hiddenAt: x.hiddenAt,
  }));
}

function count() {
  return Math.max(items.length, idSets.show.size + idSets.movie.size);
}

function exportData() {
  return {
    ids: {
      show: [...idSets.show],
      movie: [...idSets.movie],
    },
    items,
  };
}

function importData(raw = {}, { replace = false } = {}) {
  if (replace) {
    idSets.show.clear();
    idSets.movie.clear();
    items = [];
  }
  for (const x of raw.items || []) {
    if (x && Number(x.id) && (x.kind === 'show' || x.kind === 'movie')) addEntry(x, false);
  }
  if (raw.ids) {
    for (const kind of ['show', 'movie']) {
      for (const idRaw of raw.ids[kind] || []) {
        const id = Number(idRaw);
        if (id) idSets[kind].add(id);
      }
    }
  }
  save();
  return count();
}

module.exports = {
  load,
  has,
  find,
  updateRecord,
  add,
  take,
  remove,
  list,
  listIds,
  exportData,
  importData,
  count,
  wasMigratedFromLegacy: () => migratedFromLegacy,
};
