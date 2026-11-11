'use strict';

/**
 * Webhook / ntfy premiere alerts dispatcher for Favorites and My Interests.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ALERTS_STATE_FILE = path.join(DATA_DIR, 'alerts.json');

let lastAlertDate = '';

function load() {
  lastAlertDate = '';
  if (!fs.existsSync(ALERTS_STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(ALERTS_STATE_FILE, 'utf8'));
    if (typeof raw.lastAlertDate === 'string') lastAlertDate = raw.lastAlertDate;
  } catch {
    /* ignore */
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ALERTS_STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ lastAlertDate }));
  fs.renameSync(tmp, ALERTS_STATE_FILE);
}

function normalizeWebhookUrl(v) {
  const s = String(v || '').trim().slice(0, 500);
  if (!s) return '';
  if (!/^https?:\/\/.+/i.test(s)) throw new Error('Webhook URL must start with http:// or https://');
  return s;
}

async function dispatchWebhook(webhookUrl, title, message, payload = {}) {
  const target = normalizeWebhookUrl(webhookUrl);
  const url = new URL(target);
  const host = url.hostname.toLowerCase();
  const isNtfy = host === 'ntfy.sh' || host.endsWith('.ntfy.sh') || host.startsWith('ntfy.');
  const isDiscord = host.includes('discord.com') || host.includes('discordapp.com');
  const isSlack = host.includes('hooks.slack.com');

  let reqInit;
  if (isNtfy) {
    reqInit = {
      method: 'POST',
      headers: { Title: title, Priority: 'default', Tags: 'tv,clapper' },
      body: message,
      signal: AbortSignal.timeout(8000),
    };
  } else if (isDiscord) {
    reqInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${title}**\n${message}` }),
      signal: AbortSignal.timeout(8000),
    };
  } else if (isSlack) {
    reqInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${title}*\n${message}` }),
      signal: AbortSignal.timeout(8000),
    };
  } else {
    reqInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'viuhti', title, message, text: message, ...payload }),
      signal: AbortSignal.timeout(8000),
    };
  }

  const res = await fetch(target, reqInit);
  if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
  return { ok: true, status: res.status };
}

function collectTodaysAlerts({ store, movies, todayYmd }) {
  const settings = store.getSettings();
  const interests = new Set(settings.interests || []);
  const showById = new Map(store.listShows().map((s) => [s.id, s]));
  const movieById = new Map(movies.listMovies().map((m) => [m.id, m]));

  const highlights = [];
  for (const ep of store.schedule(todayYmd, todayYmd)) {
    if (ep.watched) continue;
    const s = showById.get(ep.showId);
    if (!s) continue;
    const isFav = Boolean(s.favorite);
    const hitInterest = (s.genres || []).some((g) => interests.has(g));
    const isPrem = ep.premiere === 'series' || ep.premiere === 'season';
    if (!isFav && !(hitInterest && (isPrem || ep.isNew))) continue;
    highlights.push({
      kind: 'show',
      name: s.name,
      label: ep.premiere === 'series' ? 'Series Premiere' : ep.premiere === 'season' ? 'Season Premiere' : `S${String(ep.season).padStart(2, '0')}E${String(ep.number).padStart(2, '0')}`,
      favorite: isFav,
      airtime: ep.airtime || '',
    });
  }
  for (const me of movies.schedule(todayYmd, todayYmd)) {
    if (me.watched) continue;
    const m = movieById.get(me.movieId);
    if (!m) continue;
    const isFav = Boolean(m.favorite);
    const hitInterest = (m.genres || []).some((g) => interests.has(g));
    if (!isFav && !hitInterest) continue;
    highlights.push({
      kind: 'movie',
      name: m.name,
      label: m.releaseKind === 'physical' ? 'Disc Release' : m.releaseKind === 'tv' ? 'TV Premiere' : 'Streaming Release',
      favorite: isFav,
      airtime: '',
    });
  }
  return highlights;
}

async function maybeSendDailyAlerts({ store, movies, todayYmd }) {
  const settings = store.getSettings();
  if (!settings.webhookUrl || lastAlertDate === todayYmd) return { sent: false };
  const highlights = collectTodaysAlerts({ store, movies, todayYmd });
  if (!highlights.length) return { sent: false };

  const title = `Viuhti · ${highlights.length} highlight${highlights.length === 1 ? '' : 's'} today (${todayYmd})`;
  const message = highlights
    .slice(0, 12)
    .map((h) => `• ${h.name} (${h.label})${h.favorite ? ' ★' : ''}${h.airtime ? ` at ${h.airtime}` : ''}`)
    .join('\n');

  await dispatchWebhook(settings.webhookUrl, title, message, { event: 'daily-alerts', date: todayYmd, items: highlights });
  lastAlertDate = todayYmd;
  save();
  return { sent: true, count: highlights.length };
}

module.exports = {
  load,
  normalizeWebhookUrl,
  dispatchWebhook,
  collectTodaysAlerts,
  maybeSendDailyAlerts,
};
