'use strict';

/**
 * Watched / collected item state (data/watched.json).
 * Tracks individual episode IDs and movie IDs marked done by the user
 * without affecting hidden/sync blocklists.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WATCHED_FILE = path.join(DATA_DIR, 'watched.json');

const sets = {
  episode: new Set(),
  movie: new Set(),
};

function normalizeKind(kind) {
  return kind === 'movie' ? 'movie' : 'episode';
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = WATCHED_FILE + '.tmp';
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      episodes: [...sets.episode],
      movies: [...sets.movie],
    })
  );
  fs.renameSync(tmp, WATCHED_FILE);
}

function load() {
  sets.episode.clear();
  sets.movie.clear();
  if (!fs.existsSync(WATCHED_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(WATCHED_FILE, 'utf8'));
    for (const id of raw.episodes || []) if (Number(id)) sets.episode.add(Number(id));
    for (const id of raw.movies || []) if (Number(id)) sets.movie.add(Number(id));
  } catch (err) {
    console.error('Could not read watched.json:', err.message);
  }
}

function has(kind, id) {
  return sets[normalizeKind(kind)].has(Number(id));
}

function set(kind, id, watched = true) {
  const k = normalizeKind(kind);
  const numId = Number(id);
  if (!numId) return false;
  const changed = watched ? !sets[k].has(numId) : sets[k].has(numId);
  if (watched) sets[k].add(numId);
  else sets[k].delete(numId);
  if (changed) save();
  return changed;
}

function setMany(entries, watched = true) {
  let changed = 0;
  for (const item of entries || []) {
    if (!item || !Number(item.id)) continue;
    const k = normalizeKind(item.kind);
    const numId = Number(item.id);
    if (watched) {
      if (!sets[k].has(numId)) {
        sets[k].add(numId);
        changed++;
      }
    } else if (sets[k].delete(numId)) {
      changed++;
    }
  }
  if (changed) save();
  return changed;
}

function exportData() {
  return {
    episodes: [...sets.episode],
    movies: [...sets.movie],
  };
}

function importData(raw = {}, { replace = false } = {}) {
  if (replace) {
    sets.episode.clear();
    sets.movie.clear();
  }
  let added = 0;
  for (const id of raw.episodes || []) {
    const n = Number(id);
    if (n && !sets.episode.has(n)) {
      sets.episode.add(n);
      added++;
    }
  }
  for (const id of raw.movies || []) {
    const n = Number(id);
    if (n && !sets.movie.has(n)) {
      sets.movie.add(n);
      added++;
    }
  }
  save();
  return added;
}

module.exports = {
  load,
  has,
  set,
  setMany,
  listIds: (kind) => [...sets[normalizeKind(kind)]],
  exportData,
  importData,
  count: () => sets.episode.size + sets.movie.size,
};
