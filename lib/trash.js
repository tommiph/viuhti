'use strict';

/**
 * Trash can persistence (data/trash.json).
 * Preserves removed or dismissed TV shows and movies (including favorite/extQuery/alias)
 * so users can inspect deleted items and restore them cleanly or empty the trash.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRASH_FILE = path.join(DATA_DIR, 'trash.json');
const MAX_ITEMS = 500;

let items = []; // newest first: { id, kind, name, poster, banner, background, logo, channelName, channelKind, premiered, status, reason, trashedAt, record }

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function load() {
  if (!fs.existsSync(TRASH_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(TRASH_FILE, 'utf8'));
    if (Array.isArray(raw.items)) {
      items = raw.items.filter((x) => x && Number(x.id) && (x.kind === 'show' || x.kind === 'movie')).slice(0, MAX_ITEMS);
    }
  } catch (err) {
    console.error('Could not read trash.json:', err.message);
  }
}

function save() {
  writeJson(TRASH_FILE, { items });
}

function add(entry) {
  if (!entry || !Number(entry.id)) return null;
  const kind = entry.kind === 'movie' ? 'movie' : 'show';
  const id = Number(entry.id);
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
    reason: entry.reason || 'removed',
    trashedAt: Date.now(),
    record: entry.record || { id, source: 'search', addedAt: Date.now() },
  };
  items = [clean, ...items.filter((x) => !(x.id === id && x.kind === kind))].slice(0, MAX_ITEMS);
  save();
  return clean;
}

function take(kind, id) {
  id = Number(id);
  kind = kind === 'movie' ? 'movie' : 'show';
  const idx = items.findIndex((x) => x.id === id && x.kind === kind);
  if (idx === -1) return null;
  const [found] = items.splice(idx, 1);
  save();
  return found;
}

function remove(kind, id) {
  return Boolean(take(kind, id));
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
    reason: x.reason,
    wasSource: x.record ? x.record.source : null,
    favorite: Boolean(x.record && x.record.favorite),
    trashedAt: x.trashedAt,
  }));
}

function clear() {
  const removed = items;
  if (!removed.length) return [];
  items = [];
  save();
  return removed;
}

function count() {
  return items.length;
}

module.exports = { load, add, take, remove, list, clear, count };
