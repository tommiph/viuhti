'use strict';

/**
 * Sync activity digest (data/digest.json).
 * Records newly synced shows/movies and schedule/entry updates from TVmaze & TMDB
 * so users can review what arrived or changed since their last visit.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DIGEST_FILE = path.join(DATA_DIR, 'digest.json');
const MAX_ITEMS = 80;
const DEDUPE_MS = 12 * 60 * 60 * 1000;

let dismissedBefore = 0;
let items = []; // newest first

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DIGEST_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ dismissedBefore, items }));
  fs.renameSync(tmp, DIGEST_FILE);
}

function load() {
  dismissedBefore = 0;
  items = [];
  if (!fs.existsSync(DIGEST_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DIGEST_FILE, 'utf8'));
    if (Number(raw.dismissedBefore)) dismissedBefore = Number(raw.dismissedBefore);
    if (Array.isArray(raw.items)) {
      items = raw.items.filter((x) => x && x.title && Number(x.at)).slice(0, MAX_ITEMS);
    }
  } catch (err) {
    console.error('Could not read digest.json:', err.message);
  }
}

function record({ kind = 'show', itemId, event = 'added', title, detail = '' }) {
  if (!title || !Number(itemId)) return null;
  const now = Date.now();
  const id = Number(itemId);
  const k = kind === 'movie' ? 'movie' : 'show';
  const existing = items.find(
    (x) => x.kind === k && x.itemId === id && x.event === event && now - x.at < DEDUPE_MS
  );
  if (existing) {
    if (detail && detail !== existing.detail) {
      existing.detail = String(detail).slice(0, 160);
      existing.at = now;
      save();
    }
    return existing;
  }
  const entry = {
    id: `${now}-${k}-${id}-${Math.random().toString(16).slice(2, 6)}`,
    kind: k,
    itemId: id,
    event: String(event),
    title: String(title).slice(0, 140),
    detail: String(detail || '').slice(0, 160),
    at: now,
  };
  items = [entry, ...items].slice(0, MAX_ITEMS);
  save();
  return entry;
}

function markRead(untilTs = Date.now()) {
  dismissedBefore = Math.max(dismissedBefore, Number(untilTs) || Date.now());
  save();
  return getStatus();
}

function getStatus() {
  const unread = items.filter((x) => x.at > dismissedBefore);
  return {
    dismissedBefore,
    unreadCount: unread.length,
    unreadItems: unread.slice(0, 20),
    items: items.slice(0, 40),
  };
}

module.exports = {
  load,
  record,
  markRead,
  getStatus,
};
