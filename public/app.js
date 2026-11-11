/* Viuhti – Visual Itinerary for Ultimate Home Theater Immersion */
(() => {
  'use strict';

  // ---------- Helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stripHtml = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return (d.textContent || '').trim();
  };
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const startOfWeek = (d) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (x.getDay() + 6) % 7; // Monday = 0
    return addDays(x, -dow);
  };
  const isoWeek = (d) => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  };
  const epCode = (e) => (e.season != null && e.number != null ? `S${pad(e.season)}E${pad(e.number)}` : e.season != null ? `S${pad(e.season)} Special` : 'Special');
  const store = {
    get: (k, def) => localStorage.getItem('viuhti.' + k) ?? def,
    set: (k, v) => localStorage.setItem('viuhti.' + k, v),
  };
  const fmtTime = (date, tz) =>
    new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }).format(date);
  const fmtDay = (date, opts) => new Intl.DateTimeFormat(undefined, opts).format(date);

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- Icons ----------
  const useIcon = (id) => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const ICON = {
    tv: useIcon('tv'),
    stream: useIcon('stream'),
    physical: useIcon('physical'),
    search: useIcon('search'),
    ext: useIcon('ext'),
    trash: useIcon('trash'),
    clock: useIcon('clock'),
    cal: useIcon('cal'),
    star: useIcon('star'),
    starOutline: useIcon('starOutline'),
    globe: useIcon('globe'),
    close: useIcon('close'),
    restore: useIcon('restore'),
    check: useIcon('check'),
    alert: useIcon('alert'),
    tvBig: useIcon('tvBig'),
  };

  // ---------- Branding: channel / streaming colors ----------
  const BRANDS = [
    [/4k|uhd/, '#b45309'],
    [/blu-?ray/, '#0284c7'],
    [/^dvd$|physical/, '#4f46e5'],
    [/netflix/, '#E50914'],
    [/hbo|^max$/, '#5b2bd6'],
    [/disney/, '#113CCF'],
    [/apple tv/, '#1d1d1f'],
    [/prime video|amazon/, '#00A8E1'],
    [/hulu/, '#1CE783'],
    [/paramount/, '#0064FF'],
    [/peacock/, '#2b2b2b'],
    [/showtime/, '#B10000'],
    [/starz/, '#111111'],
    [/crunchyroll/, '#F47521'],
    [/youtube/, '#FF0000'],
    [/^bbc/, '#b0151d'],
    [/^itv/, '#16a394'],
    [/channel 4|^e4$|^more4/, '#3a3fa8'],
    [/channel 5|^5$/, '#d6006f'],
    [/^sky/, '#0b6bd3'],
    [/^cbs/, '#0a3d91'],
    [/^nbc/, '#e8660d'],
    [/^abc/, '#2f2f2f'],
    [/^fox/, '#00315f'],
    [/^the cw|^cw$/, '#22884a'],
    [/^amc/, '#2b2b2b'],
    [/^fx/, '#1a1a1a'],
    [/^tnt/, '#d81e26'],
    [/^tbs/, '#2f5fb3'],
    [/comedy central/, '#f5c800'],
    [/bravo/, '#6b2b8a'],
    [/^e!$/, '#e4004b'],
    [/syfy/, '#6e1a8a'],
    [/discovery/, '#0a62c4'],
    [/history/, '#b5121b'],
    [/mgm/, '#a8781f'],
    [/^cbc/, '#d40000'],
    [/^ctv/, '#0055a5'],
    [/citytv/, '#c8102e'],
    [/global/, '#1c3f94'],
    [/tvn/, '#e4002b'],
    [/^jtbc/, '#7a3cd1'],
    [/^kbs/, '#004ea2'],
    [/^sbs/, '#1b57b6'],
    [/^mbc/, '#2d8ae6'],
    [/^ten$|network 10/, '#0f0f0f'],
    [/^nine/, '#0096d6'],
    [/^seven/, '#e30613'],
    [/^tf1/, '#0058a8'],
    [/canal\+/, '#111111'],
    [/^france/, '#2b46b8'],
    [/viaplay/, '#0c1d3a'],
    [/^yle/, '#1d9ccf'],
    [/^svt/, '#0d6e3d'],
    [/^nrk/, '#d1191f'],
    [/^dr/, '#c9061c'],
  ];
  function brandColor(name) {
    const n = String(name || '').toLowerCase().trim();
    for (const [re, c] of BRANDS) if (re.test(n)) return c;
    let h = 0;
    for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 50% 38%)`;
  }
  function textOn(color) {
    if (!color.startsWith('#')) return '#fff';
    const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? '#111' : '#fff';
  }
  /** Primary source of a show or movie: TV channel or streaming service. */
  function sourceOf(item) {
    if (!item) return { kind: 'tv', name: 'Unknown' };
    if (item.kind === 'movie') {
      return { kind: item.releaseKind || 'stream', name: item.channelName || 'Digital', country: item.channelCountry || null, tz: null };
    }
    if (item.network) return { kind: 'tv', name: item.network.name, country: item.network.country, tz: item.network.timezone };
    if (item.webChannel) return { kind: 'stream', name: item.webChannel.name, country: item.webChannel.country, tz: item.webChannel.timezone };
    return { kind: 'tv', name: 'Unknown' };
  }
  function srcBadge(name, kind, extraClass = '') {
    const bg = brandColor(name);
    const tip = kind === 'stream' ? 'Streaming / Digital on' : kind === 'physical' ? 'Physical media:' : 'Airs on';
    return `<span class="src ${extraClass}" style="--src-bg:${bg};--src-fg:${textOn(bg)}" title="${tip} ${esc(name)}">${ICON[kind] || ICON.stream}<span>${esc(name)}</span></span>`;
  }

  // ---------- External Search link ----------
  const extSearchQuery = (itemOrName, ep = null) => {
    const isObj = itemOrName && typeof itemOrName === 'object';
    const rawName = isObj ? itemOrName.extQuery || itemOrName.name : itemOrName;
    const isCustom = isObj && Boolean(itemOrName.extQuery);
    const base = isCustom
      ? String(rawName).trim()
      : String(rawName).replace(/['’`]/g, '').replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = [base];
    if (isObj && itemOrName.kind === 'movie') {
      const yr = (itemOrName.premiered || itemOrName.airdate || '').slice(0, 4);
      if (yr && !isCustom) parts.push(yr);
    } else if (ep && ep.season != null && ep.number != null) {
      parts.push(`S${pad(ep.season)}E${pad(ep.number)}`);
    } else if (ep && ep.season != null) {
      parts.push(`S${pad(ep.season)}`);
    }
    return parts.join(' ').trim();
  };
  const extSearchUrl = (itemOrName, ep = null) => {
    const tpl = (state.settings && state.settings.extSearchUrl) || '';
    if (!tpl) return null;
    const q = encodeURIComponent(extSearchQuery(itemOrName, ep));
    return /\{query\}|\{q\}/i.test(tpl) ? tpl.replace(/\{query\}|\{q\}/gi, q) : `${tpl}${q}`;
  };
  const extSearchBtnHtml = (item, ep = null, mini = false) => {
    const url = extSearchUrl(item, ep);
    if (!url) return '';
    const title = `External Search: "${extSearchQuery(item, ep)}"`;
    if (mini) return `<a class="mini-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${ICON.search}</a>`;
    return `<a class="ext-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}" data-stop>${ICON.search}<span>Ext</span></a>`;
  };

  // ---------- State ----------
  const state = {
    weekStart: startOfWeek(new Date()),
    shows: new Map(),
    movies: new Map(),
    trash: [],
    episodes: [],
    movieEvents: [],
    groups: new Map(), // key -> group (for modal lookup)
    media: store.get('media', 'shows'), // 'shows' | 'both' | 'movies'
    drawerMedia: 'settings', // 'settings' | 'trash'
    filter: store.get('filter', 'all'),
    genre: store.get('genre', ''),
    favoritesOnly: store.get('favOnly', '0') === '1',
    timeMode: store.get('timeMode', 'local'),
    density: store.get('density', 'cards'),
    settings: { extSearchUrl: '', interests: [], apiKeys: { tmdb: false, tmdbHint: '', tvmaze: false, tvmazeHint: '' } },
    status: null,
    showsLoaded: false,
    loaded: false,
  };

  // ---------- Data loading ----------
  function updateTrashUi() {
    const n = state.trash.length;
    for (const sel of ['#topTrashCount', '#drawerTrashCount']) {
      const el = $(sel);
      if (!el) continue;
      el.textContent = n;
      el.hidden = n === 0;
    }
    const bar = $('#trashBar');
    if (bar) bar.hidden = state.drawerMedia !== 'trash';
    const sum = $('#trashSummary');
    if (sum) sum.textContent = n ? `${n} item${n === 1 ? '' : 's'} in Trash · Click Restore to recover` : 'Trash is empty';
    const emptyBtn = $('#emptyTrashBtn');
    if (emptyBtn) emptyBtn.disabled = n === 0;
  }

  async function refreshTrash() {
    state.trash = await api('/api/trash');
    updateTrashUi();
    if (state.drawerMedia === 'trash') renderTrashDrawer();
  }

  async function loadShows() {
    const [showList, movieList, trashList] = await Promise.all([api('/api/shows'), api('/api/movies'), api('/api/trash')]);
    state.shows = new Map(showList.map((s) => [s.id, { ...s, kind: 'show' }]));
    state.movies = new Map(movieList.map((m) => [m.id, { ...m, kind: 'movie' }]));
    state.trash = trashList || [];
    state.showsLoaded = true;
    $('#showCount').textContent = showList.length;
    $('#movieCount').textContent = movieList.length;
    updateFavUi();
    updateTrashUi();
    populateGenres();
    if ($('#drawer').classList.contains('open')) renderInterestsSettings();
    renderTrashDrawer();
    if (state.loaded) renderCalendar(true);
  }

  function activeCollections() {
    if (state.media === 'movies') return [state.movies];
    if (state.media === 'both') return [state.shows, state.movies];
    return [state.shows];
  }

  function updateFavUi() {
    let favCount = 0;
    for (const col of activeCollections()) {
      for (const s of col.values()) if (s.favorite) favCount++;
    }
    $('#favCount').textContent = favCount;
    const btn = $('#favFilterBtn');
    btn.classList.toggle('on', state.favoritesOnly);
    btn.setAttribute('aria-pressed', String(state.favoritesOnly));
  }

  function populateGenres() {
    const counts = new Map();
    for (const col of activeCollections()) {
      for (const s of col.values()) {
        for (const g of s.genres || []) counts.set(g, (counts.get(g) || 0) + 1);
      }
    }
    const genres = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    if (state.genre && !counts.has(state.genre)) {
      state.genre = '';
      store.set('genre', '');
    }
    const sel = $('#genreFilter');
    sel.innerHTML =
      '<option value="">All genres</option>' +
      genres.map((g) => `<option value="${esc(g)}">${esc(g)} (${counts.get(g)})</option>`).join('');
    sel.value = state.genre;
    $('#genreWrap').classList.toggle('active', Boolean(state.genre));
  }

  let weekReq = 0;
  async function loadWeek(scrollToday = true) {
    const req = ++weekReq;
    const from = ymd(addDays(state.weekStart, -1));
    const to = ymd(addDays(state.weekStart, 7));
    const data = await api(`/api/schedule?from=${from}&to=${to}`);
    if (req !== weekReq) return;
    state.episodes = data.episodes || [];
    state.movieEvents = data.movies || [];
    if (data.settings) state.settings = { extSearchUrl: '', interests: [], apiKeys: {}, ...data.settings };
    state.loaded = true;
    if (state.showsLoaded) renderCalendar(scrollToday);
  }

  const reloadAll = () => Promise.all([loadShows(), loadWeek()]).catch((e) => toast(e.message, 'err'));

  // ---------- Calendar rendering ----------
  function dayKeyOf(ep) {
    if (state.timeMode === 'network' || !ep.airtime || !ep.airstamp) return ep.airdate;
    return ymd(new Date(ep.airstamp));
  }

  function timeLabel(ep, show) {
    if (!ep.airtime || !ep.airstamp) return show && show.webChannel && !show.network ? 'Streaming' : 'TBA';
    const d = new Date(ep.airstamp);
    if (state.timeMode === 'network') {
      const tz = sourceOf(show).tz;
      try {
        return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short', ...(tz ? { timeZone: tz } : {}) }).format(d);
      } catch {
        return ep.airtime;
      }
    }
    return fmtTime(d);
  }

  function matchesCalendarFilters(item) {
    if (!item || item.pending) return false;
    const src = sourceOf(item);
    if (state.filter === 'tv' && src.kind !== 'tv') return false;
    if (state.filter === 'stream' && src.kind !== 'stream') return false;
    if (state.filter === 'physical' && src.kind !== 'physical') return false;
    if (state.genre && !(item.genres || []).includes(state.genre)) return false;
    if (state.favoritesOnly && !item.favorite) return false;
    return true;
  }

  function buildGroups() {
    const days = new Map();
    for (let i = 0; i < 7; i++) days.set(ymd(addDays(state.weekStart, i)), new Map());
    if (state.media !== 'movies') {
      for (const ep of state.episodes) {
        const show = state.shows.get(ep.showId);
        if (!matchesCalendarFilters(show)) continue;
        const key = dayKeyOf(ep);
        const day = days.get(key);
        if (!day) continue;
        const gk = `s:${key}:${ep.showId}`;
        if (!day.has(gk)) day.set(gk, { key: gk, kind: 'show', day: key, show, eps: [] });
        day.get(gk).eps.push(ep);
      }
    }
    if (state.media !== 'shows') {
      for (const ev of state.movieEvents) {
        const movie = state.movies.get(ev.movieId);
        if (!matchesCalendarFilters(movie)) continue;
        const day = days.get(ev.airdate);
        if (!day) continue;
        const gk = `m:${ev.airdate}:${ev.movieId}`;
        day.set(gk, { key: gk, kind: 'movie', day: ev.airdate, show: movie, eps: [ev] });
      }
    }
    state.groups.clear();
    const out = [];
    for (const [key, map] of days) {
      const groups = [...map.values()];
      for (const g of groups) {
        if (g.kind === 'show') g.eps.sort((a, b) => (a.season - b.season) || (a.number - b.number));
        state.groups.set(g.key, g);
      }
      groups.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'show' ? -1 : 1;
        if (a.kind === 'movie') return (b.show.popularity || 0) - (a.show.popularity || 0) || a.show.name.localeCompare(b.show.name);
        return sortStamp(a.eps[0]) - sortStamp(b.eps[0]) || a.show.name.localeCompare(b.show.name);
      });
      out.push({ key, groups });
    }
    return out;
  }
  const sortStamp = (ep) => (ep.airtime && ep.airstamp ? Date.parse(ep.airstamp) : Date.parse(ep.airdate + 'T00:00:00') - 1);

  function artHtml(show, priority = false) {
    const pri = priority ? 'high' : 'low';
    if (state.density === 'compact') {
      return show.poster ? `<img class="cposter" src="${esc(show.poster)}" alt="" fetchpriority="${pri}" decoding="async" onerror="this.style.display='none'">` : '';
    }
    return cardArtHtml(show, pri);
  }

  function wideArtHtml(img, alt = '', pri = 'low') {
    return `<img class="banner" src="${esc(img)}" alt="${esc(alt)}" fetchpriority="${pri}" decoding="async" onerror="this.style.display='none'">`;
  }

  function cardArtHtml(item, pri = 'low') {
    if (item.kind === 'movie') {
      if (item.background && item.logo) {
        return `<img class="movie-bg" src="${esc(item.background)}" alt="" fetchpriority="${pri}" decoding="async" onerror="this.style.display='none'"><img class="movie-logo" src="${esc(item.logo)}" alt="${esc(item.name)} logo" fetchpriority="${pri}" decoding="async" onerror="this.style.display='none'">`;
      }
      if (item.background) return `<img src="${esc(item.background)}" alt="" fetchpriority="${pri}" decoding="async" onerror="this.style.display='none'">`;
      if (item.logo) return wideArtHtml(item.logo, `${item.name} logo`, pri);
      if (item.poster) return `<img class="poster" src="${esc(item.poster)}" alt="" fetchpriority="${pri}" decoding="async" onerror="this.style.display='none'">`;
      return '';
    }
    if (item.banner) return wideArtHtml(item.banner, '', pri);
    if (item.poster) return `<img class="poster" src="${esc(item.poster)}" alt="" fetchpriority="${pri}" decoding="async" onerror="this.style.display='none'">`;
    if (item.logo) return wideArtHtml(item.logo, `${item.name} logo`, pri);
    return '';
  }

  function epEventBadge(ep) {
    if (!ep) return null;
    if (ep.premiere === 'series' || (ep.premiere == null && ep.season === 1 && ep.number === 1)) {
      return { text: 'Series premiere', short: 'S1 Prem', cls: 'series-prem', title: 'Series premiere' };
    }
    if (ep.premiere === 'season' || (ep.premiere == null && ep.season > 1 && ep.number === 1)) {
      return { text: 'Season premiere', short: 'Premiere', cls: 'season-prem', title: 'Season premiere' };
    }
    if (ep.finale === 'series') return { text: 'Series finale', short: 'Series fin', cls: 'series-fin', title: 'Series finale' };
    if (ep.finale === 'season') return { text: 'Season finale', short: 'Finale', cls: 'season-fin', title: 'Season finale' };
    if (ep.special || (ep.season != null && ep.number == null)) {
      return { text: 'Special', short: 'Special', cls: 'special', title: 'Special episode' };
    }
    return null;
  }

  function groupBadges(g) {
    const { kind, eps } = g;
    if (kind === 'movie') {
      return {
        primary: { text: 'Movie', short: 'Movie', cls: 'movie', title: 'Movie release' },
        isNew: Boolean(eps[0] && eps[0].isNew),
      };
    }
    const premSeries = eps.some((e) => e.premiere === 'series' || (e.premiere == null && e.season === 1 && e.number === 1));
    const premSeason = eps.some((e) => e.premiere === 'season' || (e.premiere == null && e.season > 1 && e.number === 1));
    const finSeries = eps.some((e) => e.finale === 'series');
    const finSeason = eps.some((e) => e.finale === 'season');
    const isSpecial = eps.some((e) => e.special || (e.season != null && e.number == null));
    const hasFin = finSeries || finSeason;
    const isNew = eps.some((e) => e.isNew);
    let primary = null;
    if (premSeries) {
      primary = {
        text: 'Series premiere',
        short: 'S1 Prem',
        cls: 'series-prem',
        title: hasFin && eps.length > 1 ? 'Series premiere (full season drop)' : 'Brand-new series premiere',
      };
    } else if (premSeason) {
      primary = {
        text: 'Season premiere',
        short: 'Premiere',
        cls: 'season-prem',
        title: hasFin && eps.length > 1 ? 'Season premiere (full season drop)' : 'Season premiere',
      };
    } else if (finSeries) {
      primary = { text: 'Series finale', short: 'Series fin', cls: 'series-fin', title: 'Series finale' };
    } else if (finSeason) {
      primary = { text: 'Season finale', short: 'Finale', cls: 'season-fin', title: 'Season finale' };
    } else if (isSpecial) {
      primary = { text: 'Special', short: 'Special', cls: 'special', title: 'Special episode' };
    } else if (isNew) {
      primary = { text: 'New', short: 'New', cls: 'new', title: 'New series in its debut run' };
    }
    return { primary, isNew: !premSeries && primary?.cls !== 'new' && isNew };
  }

  function interestSet() {
    return new Set((state.settings && state.settings.interests) || []);
  }

  function matchedInterests(item) {
    if (!item || !item.genres || !item.genres.length) return [];
    const set = interestSet();
    if (!set.size) return [];
    return item.genres.filter((g) => set.has(g));
  }

  function interestPillsHtml(genres, isPremiere = false, inline = false) {
    if (!genres || !genres.length) return '';
    const pills = genres
      .map(
        (g, i) =>
          `<span class="interest-pill${isPremiere ? ' bounce' : ''}"${isPremiere ? ` style="animation-delay:${i * 110}ms"` : ''} title="${isPremiere ? `Premiere matching your interest: ${esc(g)}` : `Matches your interest: ${esc(g)}`}">${esc(g)}</span>`
      )
      .join('');
    return inline ? pills : `<div class="interest-row">${pills}</div>`;
  }

  function evPillHtml(b, useShort = false) {
    if (!b) return '';
    return `<span class="ev-pill ${b.cls}" title="${esc(b.title || b.text)}">${esc(useShort ? b.short : b.text)}</span>`;
  }

  function cardHtml(g, idx, priority = false) {
    const { show, eps, kind } = g;
    const isMovie = kind === 'movie';
    const isAuto = show.source === 'auto-weekly';
    const first = eps[0];
    const last = eps[eps.length - 1];
    const src = sourceOf(show);
    const brand = brandColor(src.name);
    const multi = !isMovie && eps.length > 1;
    const code = isMovie
      ? (show.premiered || show.airdate || '').slice(0, 4) || 'Movie'
      : multi
      ? `${epCode(first)}–${last.season === first.season ? 'E' + pad(last.number) : epCode(last)}`
      : epCode(first);
    const title = isMovie
      ? [show.runtime ? `${show.runtime}m` : '', (show.genres || []).slice(0, 2).join(' · ')].filter(Boolean).join(' · ') || first.name
      : multi
      ? `${eps.length} episodes`
      : first.name || 'TBA';
    const { primary, isNew } = groupBadges(g);
    const interests = matchedInterests(show);
    const isPrem = Boolean(primary && (primary.cls === 'series-prem' || primary.cls === 'season-prem'));
    const aired = !isMovie && first.airstamp && Date.parse(first.airstamp) < Date.now();
    const time = isMovie ? (src.kind === 'tv' ? 'TV Premiere' : src.kind === 'physical' ? 'Physical' : 'Streaming') : timeLabel(first, show);
    const isCompact = state.density === 'compact';
    const tlBadges = !isCompact
      ? [
          primary ? `<span class="ep-tag ${primary.cls}" title="${esc(primary.title)}">${esc(primary.text)}</span>` : '',
          isNew ? '<span class="ep-tag new" title="Brand-new release">New</span>' : '',
        ]
          .filter(Boolean)
          .join('')
      : '';
    const inlineBadges = isCompact
      ? [
          primary && primary.cls !== 'movie' ? evPillHtml(primary, true) : '',
          isNew ? '<span class="ev-pill new">New</span>' : '',
          isAuto ? '<span class="auto-pill">Auto</span>' : '',
        ]
          .filter(Boolean)
          .join('')
      : '';
    const dismissBtn = isAuto
      ? `<button class="dismiss-btn" type="button" data-dismiss="${show.id}" data-kind="${kind}" data-stop title="Dismiss (not interested — hides now &amp; won't auto-add again)" aria-label="Dismiss ${esc(show.name)}">${ICON.close}</button>`
      : `<button class="dismiss-btn subtle" type="button" data-remove-card="${show.id}" data-kind="${kind}" data-stop title="Remove ${esc(show.name)}" aria-label="Remove ${esc(show.name)}">${ICON.close}</button>`;
    const art = artHtml(show, priority);
    return `
      <article class="ep${aired ? ' aired' : ''}${show.favorite ? ' fav' : ''}${interests.length ? ' interest' : ''}${interests.length && isPrem ? ' interest-prem' : ''}" tabindex="0" data-key="${esc(g.key)}" style="--brand:${brand}">
        <div class="ep-art">
          ${art || `<div class="art-fallback">${esc(show.name)}</div>`}
          ${!isCompact && tlBadges ? `<div class="ep-badges-tl">${tlBadges}</div>` : ''}
          ${!isCompact && isAuto ? '<span class="ep-auto" title="Automatically discovered this week">Auto</span>' : ''}
          ${isCompact ? '' : `<span class="ep-time">${esc(time)}</span><span class="ep-code-badge">${esc(code)}</span>`}
        </div>
        <div class="ep-body">
          <div class="ep-show-row">
            <div class="ep-show">${esc(show.name)}</div>
            <div class="ep-card-btns">
              <button class="fav-btn${show.favorite ? ' on' : ''}" type="button" data-fav="${show.id}" data-kind="${kind}" data-stop aria-pressed="${Boolean(show.favorite)}" title="${show.favorite ? 'Remove from Favorites' : 'Mark as Favorite'}">${show.favorite ? ICON.star : ICON.starOutline}</button>
              ${dismissBtn}
            </div>
          </div>
          ${inlineBadges ? `<div class="ep-compact-pills">${inlineBadges}</div>` : ''}
          ${interests.length ? interestPillsHtml(interests, isPrem) : ''}
          <div class="ep-title">${isCompact ? `<span class="ep-ctime">${esc(time)}</span>` : ''}${isMovie ? '' : `<span class="code">${esc(code)}</span>`}${esc(title)}</div>
          <div class="ep-foot">
            ${srcBadge(src.name, src.kind)}
            ${extSearchBtnHtml(show, isMovie ? null : first)}
          </div>
        </div>
      </article>`;
  }

  function agendaRowHtml(g) {
    const { show, eps, kind } = g;
    const isMovie = kind === 'movie';
    const isAuto = show.source === 'auto-weekly';
    const first = eps[0];
    const last = eps[eps.length - 1];
    const src = sourceOf(show);
    const brand = brandColor(src.name);
    const multi = !isMovie && eps.length > 1;
    const code = isMovie
      ? (show.premiered || show.airdate || '').slice(0, 4) || 'Movie'
      : multi
      ? `${epCode(first)}–${last.season === first.season ? 'E' + pad(last.number) : epCode(last)}`
      : epCode(first);
    const title = isMovie
      ? [show.runtime ? `${show.runtime}m` : '', (show.genres || []).slice(0, 2).join(' · ')].filter(Boolean).join(' · ') || first.name
      : multi
      ? `${eps.length} episodes`
      : first.name || 'TBA';
    const time = isMovie ? (src.kind === 'tv' ? 'TV' : src.kind === 'physical' ? 'Disc' : 'Digital') : timeLabel(first, show);
    const { primary, isNew } = groupBadges(g);
    const interests = matchedInterests(show);
    const isPrem = Boolean(primary && (primary.cls === 'series-prem' || primary.cls === 'season-prem'));
    const thumb = show.background && isMovie
      ? `<img src="${esc(show.background)}" alt="" fetchpriority="low" decoding="async" onerror="this.style.display='none'">`
      : show.banner
      ? wideArtHtml(show.banner)
      : show.poster
      ? `<img src="${esc(show.poster)}" alt="" fetchpriority="low" decoding="async" onerror="this.style.display='none'">`
      : show.logo
      ? wideArtHtml(show.logo)
      : '';
    return `
      <article class="agenda-row${show.favorite ? ' fav' : ''}${interests.length ? ' interest' : ''}${interests.length && isPrem ? ' interest-prem' : ''}" tabindex="0" data-key="${esc(g.key)}" style="--brand:${brand}">
        <div class="agenda-time">${esc(time)}</div>
        <div class="agenda-thumb">${thumb}</div>
        <div class="agenda-main">
          <div class="agenda-title">
            <span class="name">${esc(show.name)}</span>
            ${primary ? evPillHtml(primary, primary.cls !== 'movie') : ''}
            ${isNew ? '<span class="ev-pill new">New</span>' : ''}
            ${isAuto ? '<span class="auto-pill">Auto</span>' : ''}
            ${interests.length ? interestPillsHtml(interests, isPrem, true) : ''}
            <button class="fav-btn${show.favorite ? ' on' : ''}" type="button" data-fav="${show.id}" data-kind="${kind}" data-stop aria-pressed="${Boolean(show.favorite)}" title="${show.favorite ? 'Remove from Favorites' : 'Mark as Favorite'}">${show.favorite ? ICON.star : ICON.starOutline}</button>
            ${
              isAuto
                ? `<button class="dismiss-btn" type="button" data-dismiss="${show.id}" data-kind="${kind}" data-stop title="Dismiss (not interested — hides now &amp; won't auto-add again)" aria-label="Dismiss ${esc(show.name)}">${ICON.close}</button>`
                : `<button class="dismiss-btn subtle" type="button" data-remove-card="${show.id}" data-kind="${kind}" data-stop title="Remove ${esc(show.name)}" aria-label="Remove ${esc(show.name)}">${ICON.close}</button>`
            }
          </div>
          <div class="agenda-sub"><span class="code">${esc(code)}</span>${esc(title)}</div>
        </div>
        <div class="agenda-actions">
          ${srcBadge(src.name, src.kind)}
          ${extSearchBtnHtml(show, isMovie ? null : first)}
        </div>
      </article>`;
  }

  let predecodeGen = 0;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 60));
  function scheduleImagePredecode() {
    const gen = ++predecodeGen;
    const imgs = [...document.querySelectorAll('#calendar img')];
    let i = 0;
    const runBatch = () => {
      if (gen !== predecodeGen) return;
      let started = 0;
      while (i < imgs.length && started < 4) {
        const img = imgs[i++];
        if (!img.isConnected) continue;
        if (img.complete && img.naturalWidth > 0 && typeof img.decode === 'function') {
          img.decode().catch(() => {});
          started++;
        } else if (!img.complete) {
          img.addEventListener(
            'load',
            () => {
              if (gen === predecodeGen && typeof img.decode === 'function') {
                idle(() => {
                  if (gen === predecodeGen) img.decode().catch(() => {});
                });
              }
            },
            { once: true }
          );
        }
      }
      if (i < imgs.length) idle(runBatch);
    };
    setTimeout(() => {
      if (gen === predecodeGen) idle(runBatch);
    }, 350);
  }

  function renderCalendar(scrollToday = false) {
    predecodeGen++;
    const cal = $('#calendar');
    cal.className = `calendar ${state.density}`;
    const end = addDays(state.weekStart, 6);
    const sameMonth = state.weekStart.getMonth() === end.getMonth();
    $('#weekTitle').textContent = `${fmtDay(state.weekStart, { month: 'short', day: 'numeric' })} – ${fmtDay(end, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}, ${end.getFullYear()}`;

    if (!state.showsLoaded || !state.loaded) return;

    const totalShows = state.media === 'movies' ? state.movies.size : state.media === 'both' ? state.shows.size + state.movies.size : state.shows.size;
    if (totalShows === 0) {
      $('#weekMeta').textContent = `Week ${isoWeek(state.weekStart)}`;
      cal.innerHTML = emptyStateHtml();
      bindEmptyState();
      return;
    }

    const days = buildGroups();
    const total = days.reduce((n, d) => n + d.groups.reduce((m, g) => m + g.eps.length, 0), 0);
    const noun = state.media === 'movies' ? 'movie' : state.media === 'both' ? 'release' : 'episode';
    const metaParts = [`Week ${isoWeek(state.weekStart)}`, `${total} ${noun}${total === 1 ? '' : 's'}`];
    if (state.favoritesOnly) metaParts.push('Favorites only');
    if (state.genre) metaParts.push(state.genre);
    if (state.media !== 'movies') metaParts.push(state.timeMode === 'local' ? 'your local time' : 'network time');
    const clearBtn =
      total === 0 && (state.filter !== 'all' || state.genre || state.favoritesOnly)
        ? ' <button id="clearFiltersBtn" class="clear-filters" type="button">Clear filters</button>'
        : '';
    $('#weekMeta').innerHTML = esc(metaParts.join(' · ')) + clearBtn;
    const cf = $('#clearFiltersBtn');
    if (cf) {
      cf.addEventListener('click', () => {
        state.filter = 'all';
        state.genre = '';
        state.favoritesOnly = false;
        store.set('filter', 'all');
        store.set('genre', '');
        store.set('favOnly', '0');
        $$('#filterSeg button').forEach((b) => b.classList.toggle('on', b.dataset.value === 'all'));
        $('#genreFilter').value = '';
        $('#genreWrap').classList.remove('active');
        updateFavUi();
        renderCalendar();
      });
    }

    const today = ymd(new Date());
    const isCurrentWeek = ymd(state.weekStart) === ymd(startOfWeek(new Date()));
    if (state.density === 'agenda') {
      const upcoming = days.filter((d) => (!isCurrentWeek || d.key >= today) && d.groups.length > 0);
      cal.innerHTML = upcoming.length
        ? upcoming
            .map(({ key, groups }) => {
              const d = new Date(key + 'T12:00:00');
              const label = key === today ? 'Today' : key === ymd(addDays(new Date(), 1)) ? 'Tomorrow' : fmtDay(d, { weekday: 'long' });
              const count = groups.reduce((m, g) => m + g.eps.length, 0);
              return `
              <section class="day${key === today ? ' today' : ''}" data-day="${key}">
                <header class="day-head">
                  <div class="day-name">${esc(label)}</div>
                  <div class="day-date"><span class="day-num">${d.getDate()}</span>${esc(fmtDay(d, { month: 'short' }))} · <span class="day-count">${count}</span></div>
                </header>
                <div class="day-body">${groups.map(agendaRowHtml).join('')}</div>
              </section>`;
            })
            .join('')
        : '<div class="empty-state" style="padding:32px"><h2>Nothing upcoming this week</h2><p class="muted" style="margin:0">Try switching to Cards view, clearing filters, or jumping to next week.</p></div>';
      return;
    }

    let idx = 0;
    cal.innerHTML = days
      .map(({ key, groups }) => {
        const d = new Date(key + 'T12:00:00');
        const cls = ['day', key === today ? 'today' : key < today ? 'past' : '', groups.length ? '' : 'empty-day'].join(' ');
        const count = groups.reduce((m, g) => m + g.eps.length, 0);
        return `
        <section class="${cls}" data-day="${key}">
          <header class="day-head">
            <div class="day-name">${esc(fmtDay(d, { weekday: 'long' }))}</div>
            <div class="day-date"><span class="day-num">${d.getDate()}</span>${esc(fmtDay(d, { month: 'short' }))}${count ? ` · <span class="day-count">${count}</span>` : ''}</div>
          </header>
          <div class="day-body">
            ${groups.length ? groups.map((g) => cardHtml(g, idx++, key === today)).join('') : `<div class="day-empty">${state.media === 'movies' ? 'No movies' : 'No episodes'}</div>`}
          </div>
        </section>`;
      })
      .join('');

    // Scroll today's column/section into view on narrow/mobile screens.
    const todayEl = $('.day.today', cal);
    if (todayEl) {
      if (cal.scrollWidth > cal.clientWidth) cal.scrollTo({ left: todayEl.offsetLeft - cal.offsetLeft - 16, behavior: 'auto' });
      else if (scrollToday && window.innerWidth <= 720) todayEl.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
    scheduleImagePredecode();
  }

  function hasTmdbKey() {
    return Boolean(state.settings && state.settings.apiKeys && state.settings.apiKeys.tmdb);
  }

  function openApiKeysDrawer() {
    openDrawer('settings');
    requestAnimationFrame(() => $('#tmdbKeyInput')?.focus());
  }

  const wizard = {
    step: 1, // 1 = optional API keys, 2 = genre-filtered show import
    dismissed: false,
    loading: false,
    importing: false,
    error: null,
    catalog: null, // { installDate, total, genres, shows }
    selectedGenres: new Set(),
    selectedLanguages: new Set(),
    langOpen: false,
    langQuery: '',
    query: '',
    includeMovies: true,
  };

  async function loadOnboardingCatalog() {
    if (wizard.catalog || wizard.loading) return;
    wizard.loading = true;
    wizard.error = null;
    renderCalendar();
    try {
      wizard.catalog = await api('/api/onboarding/shows');
    } catch (err) {
      wizard.error = err.message;
    } finally {
      wizard.loading = false;
      renderCalendar();
    }
  }

  function filteredWizardShows(ignoreGenres = false, ignoreLanguages = false) {
    const shows = (wizard.catalog && wizard.catalog.shows) || [];
    const q = wizard.query.trim().toLowerCase();
    return shows.filter((s) => {
      const lang = s.language || 'Unknown';
      if (!ignoreLanguages && wizard.selectedLanguages.size > 0 && !wizard.selectedLanguages.has(lang)) return false;
      if (!ignoreGenres && wizard.selectedGenres.size > 0 && !(s.genres || []).some((g) => wizard.selectedGenres.has(g))) return false;
      if (q && !s.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function wizardFacetCounts(shows, readKeys, selectedSet, unknownLast = false) {
    const counts = new Map();
    for (const s of shows) {
      for (const k of readKeys(s)) counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const k of selectedSet) if (!counts.has(k)) counts.set(k, 0);
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        if (unknownLast) {
          if (a.name === 'Unknown' && b.name !== 'Unknown') return 1;
          if (b.name === 'Unknown' && a.name !== 'Unknown') return -1;
        }
        return b.count - a.count || a.name.localeCompare(b.name);
      });
  }

  function wizardGenresForCurrentFilters() {
    return wizardFacetCounts(filteredWizardShows(true, false), (s) => s.genres || [], wizard.selectedGenres);
  }

  function wizardLanguagesForCurrentFilters() {
    return wizardFacetCounts(filteredWizardShows(false, true), (s) => [s.language || 'Unknown'], wizard.selectedLanguages, true);
  }

  function setWizLangOpen(open) {
    wizard.langOpen = open;
    if (!open) wizard.langQuery = '';
  }

  function wizardLangButtonLabel(allCount) {
    const langs = [...wizard.selectedLanguages];
    if (!langs.length) return `All languages (${allCount})`;
    if (langs.length <= 2) return langs.join(', ');
    return `${langs.length} languages`;
  }

  function renderWizardLangList(languages) {
    const q = wizard.langQuery.trim().toLowerCase();
    const visible = q ? languages.filter((l) => l.name.toLowerCase().includes(q)) : languages;
    if (!visible.length) return '<div class="muted" style="font-size:12px;padding:6px 7px">No matching languages.</div>';
    return visible
      .map((l) => {
        const on = wizard.selectedLanguages.has(l.name);
        return `<label class="wiz-lang-opt${on ? ' on' : ''}"><input type="checkbox" data-wlang="${esc(l.name)}"${on ? ' checked' : ''} /><span class="wiz-lang-name">${esc(l.name)}</span><span class="wiz-lang-count">${l.count}</span></label>`;
      })
      .join('');
  }

  function rerenderWizKeepingLangScroll() {
    const prevScroll = $('#wizLangList')?.scrollTop || 0;
    renderCalendar();
    const list = $('#wizLangList');
    if (list) list.scrollTop = prevScroll;
  }

  function emptyStateHtml() {
    const disc = state.status && state.status.discovery;
    const mdisc = state.status && state.status.movieDiscovery;
    const scanning = Boolean((disc && disc.running) || (mdisc && mdisc.running));
    const total = ((disc && disc.total) || 0) + ((mdisc && mdisc.total) || 0);
    const done = ((disc && disc.done) || 0) + ((mdisc && mdisc.done) || 0);
    const pct = scanning && total ? Math.round((done / total) * 100) : 0;
    const tmdbReady = hasTmdbKey();
    const isMovies = state.media === 'movies';
    const curName = (disc && disc.running && disc.current) || (mdisc && mdisc.running && mdisc.current) || '';

    if (scanning) {
      return `
        <div class="empty-state">
          <div class="big-icon">${ICON.tvBig}</div>
          <h2>Scanning premieres…</h2>
          <p>Discovering new releases on TVmaze and TMDB${total ? ` — ${done} of ${total} checked` : ''}${curName ? ` (${esc(curName)})` : ''}.</p>
          <div class="progress"><i style="width:${pct}%"></i></div>
        </div>`;
    }

    if (isMovies || wizard.dismissed || state.shows.size > 0 || state.movies.size > 0) {
      const heading = isMovies ? 'No movies tracked yet' : 'Your library is empty';
      const body = isMovies
        ? tmdbReady
          ? 'Search TMDB above to add specific movies, or scan this week’s Digital/Streaming, Physical, and TV movie premieres.'
          : 'Add your optional TMDB API key in Settings → API Keys to enable movie search and weekly movie releases.'
        : 'Search TVmaze & TMDB above to add titles one at a time, or re-open the setup wizard to bulk-import upcoming shows.';
      return `
        <div class="empty-state">
          <div class="big-icon">${ICON.tvBig}</div>
          <h2>${heading}</h2>
          <p>${body}</p>
          <div class="empty-services">
            <span class="api-status-pill ok">TVmaze · Ready</span>
            <span class="api-status-pill ${tmdbReady ? 'ok' : 'muted'}">TMDB · ${tmdbReady ? 'Configured' : 'Optional'}</span>
          </div>
          <div class="empty-actions">
            ${isMovies && !tmdbReady ? '<button class="btn" id="emptyApiKeyBtn" type="button">Add TMDB API key</button>' : ''}
            ${!isMovies ? '<button class="btn" id="emptyWizardBtn" type="button">Launch setup wizard</button>' : ''}
            <button class="btn btn-ghost" id="emptySearchBtn" type="button">${ICON.search} Search shows &amp; movies</button>
            ${!isMovies || tmdbReady ? '<button class="btn btn-ghost" id="emptyScanBtn" type="button">' + ICON.check + ' Scan weekly premieres</button>' : ''}
          </div>
        </div>`;
    }

    const step1 = wizard.step === 1;
    const ak = (state.settings && state.settings.apiKeys) || {};
    const stepBar = `
      <div class="wiz-steps">
        <span class="wiz-step ${step1 ? 'active' : 'done'}">1. Optional APIs</span>
        <span class="wiz-step ${!step1 ? 'active' : ''}">2. Import Upcoming Shows</span>
      </div>`;

    if (step1) {
      return `
        <div class="empty-state wizard">
          <div class="big-icon">${ICON.tvBig}</div>
          <h2>Welcome to Viuhti</h2>
          <p>Visual Itinerary for Ultimate Home Theater Immersion. Optionally add API keys below, or skip right ahead to choose your genres and import upcoming shows.</p>
          ${stepBar}
          <div class="wiz-panel">
            <div class="wiz-field">
              <label for="wizTmdbInput">
                <span>TMDB API Key <span class="muted">(optional — unlocks Movies &amp; movie search)</span></span>
                <span class="api-key-badge ${tmdbReady ? 'ok' : 'muted'}">${tmdbReady ? `Saved (${esc(ak.tmdbHint || 'configured')})` : 'Optional'}</span>
              </label>
              <input id="wizTmdbInput" type="password" autocomplete="off" spellcheck="false" placeholder="${tmdbReady ? 'Leave blank to keep existing TMDB key, or enter a new one…' : 'Paste TMDB v3 key or v4 Read Access Token (optional)…'}" />
              <div class="wiz-hint">Free key at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">themoviedb.org/settings/api</a></div>
            </div>
            <div class="wiz-field">
              <label for="wizTvmazeInput">
                <span>TVmaze API Key <span class="muted">(optional — public show search works without a key)</span></span>
                <span class="api-key-badge ${ak.tvmaze ? 'ok' : 'muted'}">${ak.tvmaze ? `Saved (${esc(ak.tvmazeHint || 'configured')})` : 'Optional'}</span>
              </label>
              <input id="wizTvmazeInput" type="password" autocomplete="off" spellcheck="false" placeholder="${ak.tvmaze ? 'Leave blank to keep existing TVmaze key…' : 'Optional TVmaze user API key…'}" />
            </div>
          </div>
          <div class="empty-actions">
            <button class="btn" id="wizNextBtn" type="button">Next: Choose shows →</button>
            <button class="btn btn-ghost" id="wizSkipStep1Btn" type="button">Skip APIs →</button>
          </div>
        </div>`;
    }

    const cat = wizard.catalog;
    const matches = cat ? filteredWizardShows() : [];
    const genres = cat ? wizardGenresForCurrentFilters() : [];
    const languages = cat ? wizardLanguagesForCurrentFilters() : [];
    const allLangCount = cat ? filteredWizardShows(false, true).length : 0;
    const langList = [...wizard.selectedLanguages];
    const langSummary = langList.length
      ? ` · ${langList.slice(0, 3).join(', ')}${langList.length > 3 ? ` +${langList.length - 3}` : ''}`
      : '';
    const fromLabel = (cat && cat.fromDate) || ymd(startOfWeek(new Date()));
    const toDateObj = new Date(fromLabel + 'T12:00:00');
    toDateObj.setMonth(toDateObj.getMonth() + 2);
    const toLabel = (cat && cat.toDate) || ymd(toDateObj);
    return `
      <div class="empty-state wizard">
        <div class="big-icon">${ICON.tvBig}</div>
        <h2>Import upcoming shows</h2>
        <p>Import shows airing from Monday <b>${esc(fromLabel)}</b> through <b>${esc(toLabel)}</b> (up to 2 months ahead). Filter by genre below — or leave all genres unselected to import all matching shows.</p>
        ${stepBar}
        <div class="wiz-panel">
          ${
            wizard.loading || (!cat && !wizard.error)
              ? '<div class="imp-loading" style="justify-content:center;padding:18px 0"><span class="spinner"></span><span>Loading upcoming TVmaze schedule…</span></div>'
              : wizard.error
              ? `<p class="muted" style="margin:0">${esc(wizard.error)}</p><div><button class="btn btn-small" id="wizRetryCatBtn" type="button">Retry</button></div>`
              : `
                <div class="wiz-toolbar">
                  <input id="wizFilterInput" type="search" value="${esc(wizard.query)}" placeholder="Filter matching shows…" autocomplete="off" />
                  <div class="wiz-lang-drop">
                    <button type="button" id="wizLangBtn" class="wiz-lang-btn${wizard.selectedLanguages.size ? ' active' : ''}" aria-haspopup="listbox" aria-expanded="${wizard.langOpen}" title="${esc(langList.join(', ') || 'All languages')}">
                      <span class="wiz-lang-btn-text">${esc(wizardLangButtonLabel(allLangCount))}</span>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                    <div id="wizLangMenu" class="wiz-lang-menu"${wizard.langOpen ? '' : ' hidden'}>
                      <div class="wiz-lang-head">
                        <input id="wizLangSearch" type="search" value="${esc(wizard.langQuery)}" placeholder="Filter languages…" autocomplete="off" />
                        ${wizard.selectedLanguages.size ? '<button class="mini-text-btn muted-btn" id="wizLangClearBtn" type="button">Clear</button>' : ''}
                        <button class="mini-text-btn" id="wizLangDoneBtn" type="button">Done</button>
                      </div>
                      <div id="wizLangList" class="wiz-lang-list">
                        ${renderWizardLangList(languages)}
                      </div>
                    </div>
                  </div>
                  ${wizard.selectedGenres.size ? '<button class="mini-text-btn muted-btn" id="wizClearGenresBtn" type="button">All genres</button>' : ''}
                </div>
                <div class="wiz-genres">
                  ${genres
                    .map(
                      (g) =>
                        `<button type="button" class="wiz-gchip${wizard.selectedGenres.has(g.name) ? ' on' : ''}" data-wgenre="${esc(g.name)}">${esc(g.name)} (${g.count})</button>`
                    )
                    .join('')}
                </div>
                <div class="wiz-toolbar" style="font-size:12px;color:var(--muted)">
                  <span><b>${matches.length}</b> show${matches.length === 1 ? '' : 's'} airing ${esc(fromLabel)} – ${esc(toLabel)}${esc(langSummary)}${wizard.selectedGenres.size ? ` · ${esc([...wizard.selectedGenres].join(', '))}` : ''}</span>
                  ${tmdbReady ? `<label class="imp-check-toggle"><input id="wizMoviesCheck" type="checkbox"${wizard.includeMovies ? ' checked' : ''} /> Also scan TMDB movies</label>` : ''}
                </div>
                ${
                  matches.length
                    ? `<ul class="wiz-preview-list">${matches
                        .slice(0, 60)
                        .map(
                          (s) =>
                            `<li class="wiz-show"><span class="wiz-show-name" title="${esc(s.name)}">${esc(s.name)}</span><span class="wiz-show-meta">${esc([s.network, s.nextAirdate, (s.genres || []).slice(0, 2).join(', ')].filter(Boolean).join(' · '))}</span></li>`
                        )
                        .join('')}${matches.length > 60 ? `<li class="wiz-show"><span class="wiz-show-name">+ ${matches.length - 60} more shows</span><span class="wiz-show-meta">All ${matches.length} will be imported</span></li>` : ''}</ul>`
                    : '<div class="muted" style="font-size:12px">No upcoming shows match those filters.</div>'
                }`
          }
        </div>
        <div class="empty-actions">
          <button class="btn btn-ghost" id="wizBackBtn" type="button"${wizard.importing ? ' disabled' : ''}>← Back</button>
          <button class="btn" id="wizImportBtn" type="button"${!cat || !matches.length || wizard.importing ? ' disabled' : ''}>${wizard.importing ? 'Importing…' : `Import ${matches.length} show${matches.length === 1 ? '' : 's'}`}</button>
          <button class="btn btn-ghost" id="wizDismissBtn" type="button"${wizard.importing ? ' disabled' : ''}>Skip (start empty)</button>
        </div>
      </div>`;
  }
  function bindEmptyState() {
    $('#emptyApiKeyBtn')?.addEventListener('click', openApiKeysDrawer);
    $('#emptyWizardBtn')?.addEventListener('click', () => {
      wizard.dismissed = false;
      wizard.step = 1;
      renderCalendar();
    });
    $('#emptySearchBtn')?.addEventListener('click', () => {
      searchInput.focus();
      searchInput.select();
    });
    $('#emptyScanBtn')?.addEventListener('click', async () => {
      try {
        await api('/api/discovery/run', { method: 'POST' });
        toast(hasTmdbKey() ? 'Scanning TVmaze & TMDB for premieres…' : 'Scanning TVmaze for new premieres…', 'ok');
        pollStatus(true);
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    // Wizard Step 1 handlers
    $('#wizNextBtn')?.addEventListener('click', async () => {
      const tmdbVal = ($('#wizTmdbInput')?.value || '').trim();
      const tvmazeVal = ($('#wizTvmazeInput')?.value || '').trim();
      const btn = $('#wizNextBtn');
      if (tmdbVal || tvmazeVal) {
        if (btn) {
          btn.disabled = true;
          btn.textContent = tmdbVal ? 'Validating TMDB key…' : 'Saving…';
        }
        try {
          const patch = {};
          if (tmdbVal) patch.tmdbApiKey = tmdbVal;
          if (tvmazeVal) patch.tvmazeApiKey = tvmazeVal;
          state.settings = await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
          toast('API key settings saved', 'ok');
        } catch (err) {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Next: Choose shows →';
          }
          toast(err.message, 'err');
          return;
        }
      }
      wizard.step = 2;
      renderCalendar();
      loadOnboardingCatalog();
    });
    $('#wizSkipStep1Btn')?.addEventListener('click', () => {
      wizard.step = 2;
      renderCalendar();
      loadOnboardingCatalog();
    });

    // Wizard Step 2 handlers
    $('#wizBackBtn')?.addEventListener('click', () => {
      setWizLangOpen(false);
      wizard.step = 1;
      renderCalendar();
    });
    $('#wizDismissBtn')?.addEventListener('click', () => {
      setWizLangOpen(false);
      wizard.dismissed = true;
      renderCalendar();
    });
    $('#wizRetryCatBtn')?.addEventListener('click', () => {
      wizard.catalog = null;
      loadOnboardingCatalog();
    });
    $('#wizFilterInput')?.addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      wizard.query = e.target.value;
      renderCalendar();
      const inp = $('#wizFilterInput');
      if (inp) {
        inp.focus();
        if (pos !== null) inp.setSelectionRange(pos, pos);
      }
    });
    $('.wiz-lang-drop')?.addEventListener('click', (e) => e.stopPropagation());
    $('#wizLangBtn')?.addEventListener('click', () => {
      setWizLangOpen(!wizard.langOpen);
      renderCalendar();
      if (wizard.langOpen) $('#wizLangSearch')?.focus();
      else $('#wizLangBtn')?.focus();
    });
    $('#wizLangDoneBtn')?.addEventListener('click', () => {
      setWizLangOpen(false);
      renderCalendar();
      $('#wizLangBtn')?.focus();
    });
    $('#wizLangClearBtn')?.addEventListener('click', () => {
      wizard.selectedLanguages.clear();
      rerenderWizKeepingLangScroll();
      $('#wizLangSearch')?.focus();
    });
    $('#wizLangSearch')?.addEventListener('input', (e) => {
      wizard.langQuery = e.target.value;
      const list = $('#wizLangList');
      if (list && wizard.catalog) list.innerHTML = renderWizardLangList(wizardLanguagesForCurrentFilters());
    });
    $('#wizLangList')?.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-wlang]');
      if (!cb) return;
      const lang = cb.dataset.wlang;
      if (cb.checked) wizard.selectedLanguages.add(lang);
      else wizard.selectedLanguages.delete(lang);
      rerenderWizKeepingLangScroll();
    });
    $('#wizMoviesCheck')?.addEventListener('change', (e) => {
      wizard.includeMovies = e.target.checked;
    });
    $('#wizClearGenresBtn')?.addEventListener('click', () => {
      wizard.selectedGenres.clear();
      renderCalendar();
    });
    $$('[data-wgenre]').forEach((b) =>
      b.addEventListener('click', () => {
        const g = b.dataset.wgenre;
        if (wizard.selectedGenres.has(g)) wizard.selectedGenres.delete(g);
        else wizard.selectedGenres.add(g);
        renderCalendar();
      })
    );
    $('#wizImportBtn')?.addEventListener('click', async () => {
      const matches = filteredWizardShows();
      if (!matches.length || wizard.importing) return;
      setWizLangOpen(false);
      wizard.importing = true;
      renderCalendar();
      try {
        const res = await api('/api/onboarding/import', {
          method: 'POST',
          body: JSON.stringify({
            ids: matches.map((s) => s.id),
            includeMovies: hasTmdbKey() && wizard.includeMovies,
          }),
        });
        toast(`Imported ${res.added} upcoming show${res.added === 1 ? '' : 's'}!`, 'ok');
        await reloadAll();
        if (hasTmdbKey() && wizard.includeMovies) pollStatus(true);
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        wizard.importing = false;
        if (state.shows.size === 0) renderCalendar();
      }
    });
  }

  // ---------- Episode modal ----------
  const detailCache = new Map();
  let modalSeq = 0;

  function openModal(key) {
    const g = state.groups.get(key);
    if (!g) return;
    const seq = ++modalSeq;
    $('.modal-card')?.classList.remove('wide');
    const { show, eps, kind } = g;
    const isMovie = kind === 'movie';
    const first = eps[0];
    const src = sourceOf(show);
    const cacheKey = `${kind}:${show.id}:${!isMovie && eps.length === 1 ? first.id : ''}`;
    const det = detailCache.get(cacheKey);
    const heroImg = (det && (det.background || det.posterLarge)) || show.background || show.banner || show.posterLarge || show.poster || '';
    const d = !isMovie && first.airstamp && first.airtime ? new Date(first.airstamp) : new Date(first.airdate + 'T12:00:00');
    const localWhen = !isMovie && first.airtime
      ? `${fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' })} · ${fmtTime(d)} your time`
      : `${fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' })}`;
    let networkWhen = '';
    if (!isMovie && first.airtime && src.tz) {
      try {
        networkWhen = `${new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone: src.tz }).format(d)} (${src.country || 'network'})`;
      } catch { /* ignore invalid tz */ }
    }
    const rawSummary = det
      ? !isMovie && eps.length === 1 && det.episodeSummary
        ? det.episodeSummary
        : det.summary
      : !isMovie && eps.length === 1 && first.summary
      ? first.summary
      : show.summary;
    const summary = stripHtml(rawSummary);
    const multi = !isMovie && eps.length > 1;
    const statusCls = /running|released/i.test(show.status) ? 'running' : /ended/i.test(show.status) ? 'ended' : 'tbd';
    const epArg = isMovie ? null : first;
    const { primary, isNew } = groupBadges(g);
    const isAuto = show.source === 'auto-weekly';
    const extUrl = (det && !multi && det.episodeUrl) || (multi || isMovie ? show.url : first.url || show.url);

    $('#modalBody').innerHTML = `
      <div class="m-hero">
        <div class="m-hero-bg" id="modalHeroBg" style="background-image:url('${esc(heroImg)}')"></div>
        <div class="m-hero-inner">
          ${show.poster ? `<img class="m-poster" src="${esc(show.poster)}" alt="">` : ''}
          <div>
            ${show.logo ? `<img class="m-logo" src="${esc(show.logo)}" alt="${esc(show.name)} logo">` : ''}
            <h2 class="m-show" id="modalTitle">${esc(show.name)}</h2>
            ${show.originalName ? `<div class="m-orig">Original title: ${esc(show.originalName)}</div>` : ''}
            <div class="m-ep">${
              isMovie
                ? `<span class="code">${esc((show.premiered || first.airdate || '').slice(0, 4) || 'Movie')}</span>${esc(show.tagline || (src.kind === 'tv' ? 'TV Movie Release' : src.kind === 'physical' ? 'Physical Media Release (Blu-ray / DVD)' : 'Digital / Streaming Release'))}`
                : multi
                ? `<span class="code">${esc(epCode(first))} – ${esc(epCode(eps[eps.length - 1]))}</span>${eps.length} episodes`
                : `<span class="code">${esc(epCode(first))}</span>${esc(first.name || 'TBA')}`
            }</div>
          </div>
        </div>
      </div>
      <div class="m-content">
        <div class="m-facts">
          ${primary ? evPillHtml(primary, false) : ''}
          ${isNew ? '<span class="ev-pill new">New</span>' : ''}
          ${srcBadge(src.name, src.kind)}
          ${!isMovie && show.network && show.webChannel ? srcBadge(show.webChannel.name, 'stream') : ''}
          <span class="fact">${ICON.cal}${esc(localWhen)}</span>
          ${networkWhen ? `<span class="fact">${ICON.globe}${esc(networkWhen)}</span>` : ''}
          ${first.runtime || show.runtime ? `<span class="fact">${ICON.clock}${first.runtime || show.runtime} min</span>` : ''}
          ${show.rating ? `<span class="fact">${ICON.star}${show.rating}</span>` : ''}
          <span class="fact"><span class="status-dot ${statusCls}"></span>${esc(show.status || '')}</span>
          ${isAuto ? '<span class="auto-pill">Weekly auto-pick</span>' : ''}
          ${(show.genres || []).slice(0, 3).map((gr, idx) => {
            const hit = interestSet().has(gr);
            const bounce = hit && primary && (primary.cls === 'series-prem' || primary.cls === 'season-prem');
            return `<button class="fact fact-btn${hit ? ' interest-hit' : ''}${bounce ? ' bounce' : ''}"${bounce ? ` style="animation-delay:${idx * 110}ms"` : ''} type="button" data-genre="${esc(gr)}" title="${hit ? `My interest · click to filter by ${esc(gr)}` : `Filter calendar by ${esc(gr)}`}">${esc(gr)}</button>`;
          }).join('')}
        </div>
        ${
          multi
            ? `<ul class="m-eplist">${eps
                .map((e) => {
                  const eb = epEventBadge(e);
                  return `<li><span class="code">${esc(epCode(e))}</span><span class="m-eptitle">${esc(e.name || 'TBA')}</span>${eb ? evPillHtml(eb, true) : ''}${extSearchBtnHtml(show, e)}</li>`;
                })
                .join('')}</ul>`
            : ''
        }
        <p class="m-summary" id="modalSummary"${summary ? '' : ' hidden'}>${esc(summary)}</p>
        <div class="m-actions">
          ${
            extSearchUrl(show, epArg)
              ? `<a class="btn btn-ext" id="modalExtSearchLink" href="${esc(extSearchUrl(show, epArg))}" target="_blank" rel="noopener noreferrer">${ICON.search} External Search</a>`
              : `<button class="btn btn-ghost" id="modalExtSetupBtn" type="button">${ICON.search} Configure External Search</button>`
          }
          <button class="btn btn-fav${show.favorite ? ' on' : ''}" id="modalFav" type="button" aria-pressed="${Boolean(show.favorite)}">${show.favorite ? ICON.star : ICON.starOutline} <span>${show.favorite ? 'Favorited' : 'Favorite'}</span></button>
          <a class="btn btn-ghost" id="modalExtLink" href="${esc(extUrl)}" target="_blank" rel="noopener noreferrer">${ICON.ext} ${isMovie ? 'TMDB' : 'TVmaze'}</a>
          ${show.imdbUrl ? `<a class="btn btn-ghost" href="${esc(show.imdbUrl)}" target="_blank" rel="noopener noreferrer">${ICON.ext} IMDb</a>` : ''}
          ${show.officialSite ? `<a class="btn btn-ghost" href="${esc(show.officialSite)}" target="_blank" rel="noopener noreferrer">${ICON.globe} Official site</a>` : ''}
          <button class="btn btn-danger" id="modalRemove" type="button">${isAuto ? `${ICON.close} Dismiss (not interested)` : `${ICON.trash} ${isMovie ? 'Remove movie' : 'Remove show'}`}</button>
        </div>
        <div class="m-ext-custom">
          <span>External search query: <b id="modalExtPreview">${esc(extSearchQuery(show, epArg))}</b></span>
          <input id="modalExtInput" type="text" value="${esc(show.extQuery || '')}" placeholder="Override search title" />
          <button class="btn btn-small btn-ghost" id="modalExtSave" type="button">Save</button>
          ${show.extQuery ? '<button class="btn btn-small btn-ghost" id="modalExtReset" type="button">Reset</button>' : ''}
        </div>
      </div>`;
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';

    $('#modalExtSetupBtn')?.addEventListener('click', () => {
      closeModal();
      openDrawer('settings');
      requestAnimationFrame(() => $('#extUrlInput')?.focus());
    });

    if (!det) {
      const q = !isMovie && eps.length === 1 ? `?epId=${first.id}` : '';
      api(`/api/item/${kind}/${show.id}${q}`)
        .then((d) => {
          detailCache.set(cacheKey, d);
          if (detailCache.size > 40) detailCache.delete(detailCache.keys().next().value);
          if (seq !== modalSeq || $('#modal').hidden) return;
          const bg = d.background || d.posterLarge;
          if (bg && !show.background && !show.banner) {
            const bgEl = $('#modalHeroBg');
            if (bgEl) bgEl.style.backgroundImage = `url('${bg.replace(/'/g, '%27')}')`;
          }
          const txt = stripHtml(!isMovie && eps.length === 1 && d.episodeSummary ? d.episodeSummary : d.summary);
          const sumEl = $('#modalSummary');
          if (sumEl && txt) {
            sumEl.textContent = txt;
            sumEl.hidden = false;
          }
          const extEl = $('#modalExtLink');
          if (extEl && !multi && d.episodeUrl) extEl.href = d.episodeUrl;
        })
        .catch(() => {});
    }
    const saveExtOverride = async (val) => {
      try {
        const endpoint = isMovie ? `/api/movies/${show.id}/ext-query` : `/api/shows/${show.id}/ext-query`;
        const res = await api(endpoint, { method: 'POST', body: JSON.stringify({ extQuery: val }) });
        show.extQuery = res.extQuery;
        const item = (isMovie ? state.movies : state.shows).get(show.id);
        if (item) item.extQuery = res.extQuery;
        $('#modalExtPreview').textContent = extSearchQuery(show, epArg);
        const linkEl = $('#modalExtSearchLink');
        if (linkEl) linkEl.href = extSearchUrl(show, epArg) || '#';
        renderCalendar();
        toast(res.extQuery ? 'Saved custom External Search query' : 'Reset External Search query', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    $('#modalExtSave').addEventListener('click', () => saveExtOverride($('#modalExtInput').value));
    const resetBtn = $('#modalExtReset');
    if (resetBtn) resetBtn.addEventListener('click', () => { $('#modalExtInput').value = ''; saveExtOverride(''); });
    $('#modalFav').addEventListener('click', async () => {
      const fav = await toggleFavorite(show.id, kind);
      if (fav === null) return;
      const b = $('#modalFav');
      b.classList.toggle('on', fav);
      b.setAttribute('aria-pressed', String(fav));
      b.innerHTML = `${fav ? ICON.star : ICON.starOutline} <span>${fav ? 'Favorited' : 'Favorite'}</span>`;
    });
    $('#modalRemove').addEventListener('click', async () => {
      closeModal();
      if (isAuto) await dismissItem(show.id, show.name, kind);
      else await removeItem(show.id, show.name, kind);
    });
    $$('.fact-btn[data-genre]', $('#modalBody')).forEach((b) =>
      b.addEventListener('click', () => {
        setGenre(b.dataset.genre);
        closeModal();
      })
    );
    $('.modal-close').focus();
  }
  function closeModal() {
    $('#modal').hidden = true;
    $('.modal-card')?.classList.remove('wide');
    document.body.style.overflow = '';
  }

  // ---------- Show & movie management ----------
  const pendingRemovals = new Set();

  async function addItem(id, name, kind = 'show') {
    try {
      await api(kind === 'movie' ? '/api/movies' : '/api/shows', { method: 'POST', body: JSON.stringify({ id }) });
      toast(`Added ${name}`, 'ok');
      await reloadAll();
      return true;
    } catch (e) {
      toast(e.message, 'err');
      return false;
    }
  }
  function applyLocalRemoval(id, kind) {
    id = Number(id);
    if (kind === 'movie') {
      state.movies.delete(id);
      state.movieEvents = state.movieEvents.filter((m) => m.movieId !== id);
    } else {
      state.shows.delete(id);
      state.episodes = state.episodes.filter((e) => e.showId !== id);
    }
    $('#showCount').textContent = state.shows.size;
    $('#movieCount').textContent = state.movies.size;
    updateFavUi();
    populateGenres();
    renderCalendar();
    renderTrashDrawer();
  }

  async function removeItem(id, name, kind = 'show') {
    id = Number(id);
    const key = `${kind}:${id}`;
    if (pendingRemovals.has(key)) return;
    pendingRemovals.add(key);
    try {
      await api(kind === 'movie' ? `/api/movies/${id}` : `/api/shows/${id}`, { method: 'DELETE' });
      applyLocalRemoval(id, kind);
      await refreshTrash().catch(() => {});
      pollStatus();
      toast(`Moved ${name} to Trash`, 'ok', { label: 'Undo', onClick: () => restoreFromTrash(id, name, kind) });
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      pendingRemovals.delete(key);
    }
  }

  async function dismissItem(id, name, kind = 'show') {
    id = Number(id);
    const key = `${kind}:${id}`;
    if (pendingRemovals.has(key)) return;
    pendingRemovals.add(key);
    try {
      const endpoint = kind === 'movie' ? `/api/movies/${id}/dismiss` : `/api/shows/${id}/dismiss`;
      await api(endpoint, { method: 'POST', body: JSON.stringify({ name }) });
      applyLocalRemoval(id, kind);
      await refreshTrash().catch(() => {});
      pollStatus();
      toast(`Dismissed ${name} to Trash`, 'ok', { label: 'Undo', onClick: () => restoreFromTrash(id, name, kind) });
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      pendingRemovals.delete(key);
    }
  }

  async function restoreFromTrash(id, name, kind = 'show') {
    try {
      await api('/api/trash/restore', { method: 'POST', body: JSON.stringify({ id: Number(id), kind }) });
      toast(`Restored ${name}`, 'ok');
      await reloadAll();
      pollStatus();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function purgeTrashItem(id, name, kind = 'show') {
    try {
      await api(`/api/trash/${kind === 'movie' ? 'movie' : 'show'}/${Number(id)}`, { method: 'DELETE' });
      state.trash = state.trash.filter((x) => !(x.id === Number(id) && x.kind === kind));
      updateTrashUi();
      renderTrashDrawer();
      toast(`Deleted ${name} permanently`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function emptyTrash() {
    try {
      const res = await api('/api/trash/empty', { method: 'POST' });
      state.trash = [];
      updateTrashUi();
      renderTrashDrawer();
      toast(res.purged ? `Emptied Trash (${res.purged} deleted)` : 'Trash is already empty', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function toggleFavorite(id, kind = 'show') {
    const col = kind === 'movie' ? state.movies : state.shows;
    const s = col.get(id);
    if (!s) return null;
    try {
      const url = kind === 'movie' ? `/api/movies/${id}/favorite` : `/api/shows/${id}/favorite`;
      const res = await api(url, { method: 'POST', body: JSON.stringify({ favorite: !s.favorite }) });
      s.favorite = res.favorite;
      updateFavUi();
      if (state.favoritesOnly) {
        renderCalendar();
      } else {
        $$(`#calendar .fav-btn[data-fav="${id}"][data-kind="${kind}"]`).forEach((b) => {
          b.classList.toggle('on', res.favorite);
          b.setAttribute('aria-pressed', String(res.favorite));
          b.title = res.favorite ? 'Remove from Favorites' : 'Mark as Favorite';
          b.innerHTML = res.favorite ? ICON.star : ICON.starOutline;
          const card = b.closest('.ep, .agenda-row');
          if (card) card.classList.toggle('fav', res.favorite);
        });
      }
      toast(res.favorite ? `Added ${s.name} to Favorites` : `Removed ${s.name} from Favorites`, 'ok');
      return res.favorite;
    } catch (e) {
      toast(e.message, 'err');
      return null;
    }
  }

  // ---------- Search ----------
  const searchInput = $('#searchInput');
  const searchResults = $('#searchResults');
  let searchTimer = null;
  let searchSeq = 0;
  let searchItems = [];
  let activeIdx = -1;

  function renderSearch(items, q) {
    searchItems = items;
    activeIdx = items.length ? 0 : -1;
    const tmdbReady = hasTmdbKey();
    const noteHtml = !tmdbReady
      ? `<div class="sr-note"><span>Movie search disabled until a TMDB API key is set.</span><button class="mini-text-btn" type="button" id="srAddTmdbBtn">Add key</button></div>`
      : '';
    if (!items.length) {
      searchResults.innerHTML = `<div class="sr-empty">${tmdbReady ? `No shows or movies found for “${esc(q)}”` : `No TVmaze shows found for “${esc(q)}”`}</div>${noteHtml}`;
    } else {
      searchResults.innerHTML =
        items
          .map((s, i) => {
            const isMovie = s.kind === 'movie';
            const src = sourceOf(s);
            const year = s.premiered ? s.premiered.slice(0, 4) : '';
            return `
          <div class="sr-item${i === 0 ? ' active' : ''}" data-idx="${i}" role="option">
            ${s.poster ? `<img src="${esc(s.poster)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
            <div style="min-width:0">
              <div class="sr-name">${esc(s.name)} ${year ? `<span class="year">(${year})</span>` : ''}</div>
              <div class="sr-meta">
                ${isMovie ? '<span class="movie-pill">Movie</span>' : src.name !== 'Unknown' ? srcBadge(src.name, src.kind) : ''}
                ${src.country ? `<span>${esc(src.country)}</span>` : ''}
                <span><span class="status-dot ${/running|released/i.test(s.status) ? 'running' : /ended/i.test(s.status) ? 'ended' : 'tbd'}"></span> ${esc(s.status || '')}</span>
                ${s.genres && s.genres.length ? `<span>· ${esc(s.genres.slice(0, 2).join(', '))}</span>` : ''}
              </div>
              ${s.summary ? `<div class="sr-summary">${esc(stripHtml(s.summary))}</div>` : ''}
            </div>
            <button class="add-btn${s.tracked ? ' tracked' : ''}" data-id="${s.id}" data-kind="${isMovie ? 'movie' : 'show'}" type="button">${s.tracked ? '✓ Tracking' : '+ Add'}</button>
          </div>`;
          })
          .join('') + noteHtml;
    }
    $('#srAddTmdbBtn', searchResults)?.addEventListener('click', () => {
      searchResults.hidden = true;
      openApiKeysDrawer();
    });
    searchResults.hidden = false;
  }

  async function doSearch(q) {
    const seq = ++searchSeq;
    searchResults.hidden = false;
    searchResults.innerHTML = '<div class="sr-empty"><span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:8px"></span>Searching TVmaze &amp; TMDB…</div>';
    try {
      const items = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (seq === searchSeq) renderSearch(items, q);
    } catch (e) {
      if (seq === searchSeq) searchResults.innerHTML = `<div class="sr-empty">${esc(e.message)}</div>`;
    }
  }

  async function toggleSearchItem(idx, btn) {
    const s = searchItems[idx];
    if (!s) return;
    const kind = s.kind === 'movie' ? 'movie' : 'show';
    btn = btn || $(`.add-btn[data-id="${s.id}"][data-kind="${kind}"]`, searchResults);
    btn.disabled = true;
    if (s.tracked) {
      await removeItem(s.id, s.name, kind);
      s.tracked = false;
    } else {
      btn.textContent = 'Adding…';
      if (await addItem(s.id, s.name, kind)) s.tracked = true;
    }
    btn.disabled = false;
    btn.classList.toggle('tracked', s.tracked);
    btn.textContent = s.tracked ? '✓ Tracking' : '+ Add';
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) {
      searchResults.hidden = true;
      return;
    }
    searchTimer = setTimeout(() => doSearch(q), 280);
  });
  function syncSearchTracked() {
    for (const s of searchItems) {
      const kind = s.kind === 'movie' ? 'movie' : 'show';
      s.tracked = (kind === 'movie' ? state.movies : state.shows).has(s.id);
      const btn = $(`.add-btn[data-id="${s.id}"][data-kind="${kind}"]`, searchResults);
      if (btn) {
        btn.classList.toggle('tracked', s.tracked);
        btn.textContent = s.tracked ? '✓ Tracking' : '+ Add';
      }
    }
  }

  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 2 && searchResults.innerHTML) {
      syncSearchTracked();
      searchResults.hidden = false;
    }
  });
  searchInput.addEventListener('keydown', (e) => {
    const items = $$('.sr-item', searchResults);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      items[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      toggleSearchItem(activeIdx);
    } else if (e.key === 'Escape') {
      searchResults.hidden = true;
      searchInput.blur();
    }
  });
  searchResults.addEventListener('click', (e) => {
    const btn = e.target.closest('.add-btn');
    if (btn) toggleSearchItem(Number(btn.closest('.sr-item').dataset.idx), btn);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#searchBox')) searchResults.hidden = true;
  });

  // ---------- Settings & Trash drawer ----------
  function setDrawerTab(tab) {
    const next = tab === 'trash' ? 'trash' : 'settings';
    state.drawerMedia = next;
    $$('#drawerMediaSeg button').forEach((x) => x.classList.toggle('on', x.dataset.value === next));
    $('#drawer').classList.toggle('drawer-in-trash', next === 'trash');
    updateTrashUi();
    renderTrashDrawer();
  }

  function openDrawer(tab = null) {
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#drawerScrim').hidden = false;
    renderApiKeysSettings(state.settings);
    renderInterestsSettings();
    renderExtSettings(state.settings);
    if (state.status) {
      renderDiscovery(state.status.discovery, state.status.movieDiscovery);
    } else {
      pollStatus();
    }
    setDrawerTab(tab || 'settings');
  }
  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#drawerScrim').hidden = true;
    $('#showList').innerHTML = '';
  }

  function relAgo(ts) {
    if (!ts) return '';
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.round(hr / 24);
    return `${days}d ago`;
  }

  function renderTrashList(list, q) {
    let items = [...state.trash];
    if (q) {
      items = items.filter(
        (x) =>
          (x.name || '').toLowerCase().includes(q) ||
          (x.channelName || '').toLowerCase().includes(q) ||
          (x.kind || '').toLowerCase().includes(q)
      );
    }
    $('#drawerSub').textContent = `${state.trash.length} deleted item${state.trash.length === 1 ? '' : 's'} · Restore any time`;
    if (!items.length) {
      list.innerHTML = `<li class="sr-empty">${state.trash.length ? 'No matching items in Trash' : 'Trash can is empty. Removed or dismissed shows appear here so you can restore them anytime.'}</li>`;
      return;
    }
    list.innerHTML = items
      .map((x) => {
        const isMovie = x.kind === 'movie';
        const thumb = isMovie && x.background
          ? `<img src="${esc(x.background)}" alt="" loading="lazy">`
          : x.logo
          ? wideArtHtml(x.logo)
          : x.banner
          ? wideArtHtml(x.banner)
          : x.poster
          ? `<img class="poster" src="${esc(x.poster)}" alt="" loading="lazy">`
          : '';
        const srcName = x.channelName || (isMovie ? 'Movie' : 'TV');
        const when = relAgo(x.trashedAt);
        const why = x.reason === 'dismissed' ? 'Dismissed' : 'Removed';
        return `
        <li class="show-item trash-item">
          <div class="show-thumb" style="background:${brandColor(srcName)}33">${thumb}</div>
          <div style="min-width:0">
            <div class="show-name" title="${esc(x.name)}">${esc(x.name)}</div>
            <div class="show-meta">
              <span class="imp-pill ${isMovie ? 'movie-tag' : 'tracked'}">${isMovie ? 'Movie' : 'Show'}</span>
              ${x.channelName ? srcBadge(x.channelName, x.channelKind || 'tv') : ''}
              ${x.favorite ? `<span class="fav-ind" title="Was favorited">${ICON.star}</span>` : ''}
            </div>
            <div class="show-next">${why}${when ? ` · ${esc(when)}` : ''}</div>
          </div>
          <div class="show-actions trash-actions">
            <button class="restore-btn" type="button" data-trash-restore="${x.id}" data-kind="${x.kind}" data-name="${esc(x.name)}" title="Restore ${esc(x.name)} back to your list">${ICON.restore}<span>Restore</span></button>
            <button class="mini-btn danger" type="button" data-trash-purge="${x.id}" data-kind="${x.kind}" data-name="${esc(x.name)}" title="Delete forever">${ICON.close}</button>
          </div>
        </li>`;
      })
      .join('');
  }

  function renderTrashDrawer() {
    if (!$('#drawer').classList.contains('open')) return;
    $('#drawer').classList.toggle('drawer-in-trash', state.drawerMedia === 'trash');
    updateTrashUi();
    const list = $('#showList');
    if (state.drawerMedia !== 'trash') {
      list.innerHTML = '';
      $('#drawerSub').textContent = `${state.shows.size} show${state.shows.size === 1 ? '' : 's'} · ${state.movies.size} movie${state.movies.size === 1 ? '' : 's'}`;
      return;
    }
    const q = $('#showFilter').value.trim().toLowerCase();
    renderTrashList(list, q);
  }

  $('#showList').addEventListener('click', async (e) => {
    const trRestore = e.target.closest('[data-trash-restore]');
    if (trRestore) {
      if (trRestore.disabled) return;
      trRestore.disabled = true;
      await restoreFromTrash(Number(trRestore.dataset.trashRestore), trRestore.dataset.name || 'item', trRestore.dataset.kind || 'show');
      return;
    }
    const trPurge = e.target.closest('[data-trash-purge]');
    if (trPurge) {
      if (trPurge.disabled) return;
      trPurge.disabled = true;
      await purgeTrashItem(Number(trPurge.dataset.trashPurge), trPurge.dataset.name || 'item', trPurge.dataset.kind || 'show');
    }
  });
  $$('#drawerMediaSeg button').forEach((b) =>
    b.addEventListener('click', () => setDrawerTab(b.dataset.value))
  );
  $('#showFilter').addEventListener('input', renderTrashDrawer);
  $('#myShowsBtn').addEventListener('click', () => openDrawer('settings'));
  $('#trashTopBtn').addEventListener('click', () => openDrawer('trash'));
  $('#emptyTrashBtn').addEventListener('click', emptyTrash);
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerScrim').addEventListener('click', closeDrawer);

  // ---------- Sync & settings ----------
  $('#refreshBtn').addEventListener('click', async () => {
    await api('/api/refresh', { method: 'POST' });
    toast('Refreshing all shows from TVmaze…', 'ok');
    pollStatus(true);
  });

  let pollTimer = null;
  let lastProgress = '';
  let wasBusy = false;
  let lastReload = 0;

  async function pollStatus(soon = false) {
    clearTimeout(pollTimer);
    if (soon) await new Promise((r) => setTimeout(r, 400));
    let busy = false;
    try {
      const st = await api('/api/status');
      state.status = st;
      const sync = st.sync;
      const disc = st.discovery;
      const mdisc = st.movieDiscovery;
      busy = sync.running || Boolean(disc && disc.running) || Boolean(mdisc && mdisc.running);

      const pill = $('#syncPill');
      pill.hidden = !busy;
      if (disc && disc.running) $('#syncText').textContent = `New shows ${disc.done}/${disc.total || '…'}`;
      else if (mdisc && mdisc.running) $('#syncText').textContent = `New movies ${mdisc.done}/${mdisc.total || '…'}`;
      else if (sync.running) $('#syncText').textContent = `Updating ${sync.done}/${sync.total}`;

      const prevExtUrl = state.settings.extSearchUrl;
      const prevInterests = JSON.stringify(state.settings.interests || []);
      const prevKeys = JSON.stringify(state.settings.apiKeys || {});
      if (st.settings) state.settings = { extSearchUrl: '', interests: [], apiKeys: {}, ...st.settings };
      if (state.status && $('#drawer').classList.contains('open')) {
        renderApiKeysSettings(state.settings);
        renderInterestsSettings();
        renderDiscovery(disc, mdisc);
        renderExtSettings(state.settings);
      }
      if (
        (state.settings.extSearchUrl !== prevExtUrl ||
          JSON.stringify(state.settings.interests || []) !== prevInterests ||
          JSON.stringify(state.settings.apiKeys || {}) !== prevKeys) &&
        state.showsLoaded &&
        state.loaded
      ) {
        renderCalendar();
      }
      if (state.showsLoaded && typeof st.trashCount === 'number' && st.trashCount !== state.trash.length) {
        refreshTrash().catch(() => {});
      }

      const progress = `${sync.done}:${disc ? disc.done : 0}:${mdisc ? mdisc.done : 0}:${st.tracked}:${st.moviesCount || 0}`;
      if (busy && progress !== lastProgress && Date.now() - lastReload > 3000) {
        lastProgress = progress;
        lastReload = Date.now();
        await reloadAll();
      } else if (!busy && wasBusy) {
        await reloadAll();
        if ((disc && disc.finishedAt && Date.now() - disc.finishedAt < 15000) || (mdisc && mdisc.finishedAt && Date.now() - mdisc.finishedAt < 15000)) {
          const tvN = (disc && disc.added && disc.added.length) || 0;
          const mvN = (mdisc && mdisc.added && mdisc.added.length) || 0;
          toast(`Discovery done: ${tvN} show${tvN === 1 ? '' : 's'}, ${mvN} movie${mvN === 1 ? '' : 's'} added`, 'ok');
        }
      } else if (state.showsLoaded && state.shows.size === 0 && state.movies.size === 0 && state.loaded) {
        renderCalendar(); // refresh empty-state scan progress
      }
      wasBusy = busy;
    } catch {
      /* server unreachable, retry later */
    }
    if (!document.hidden) pollTimer = setTimeout(pollStatus, busy ? 1500 : 60000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(pollTimer);
    else pollStatus();
  });

  function renderApiKeysSettings(settings) {
    const box = $('#apiKeysBox');
    if (!box) return;
    const ak = (settings && settings.apiKeys) || {};
    const tmdbSet = Boolean(ak.tmdb);
    const tvmazeSet = Boolean(ak.tvmaze);
    box.hidden = false;
    box.innerHTML = `
      <div class="api-keys-head">
        <span class="lan-label">API Keys (TVmaze &amp; TMDB)</span>
        <span class="api-key-badge ${tmdbSet ? 'ok' : 'muted'}">${tmdbSet ? 'TMDB Connected' : 'TMDB Optional'}</span>
      </div>
      <div class="api-key-field">
        <div class="api-key-label-row">
          <span>TMDB API Key <span class="muted">(required for movies)</span></span>
          ${tmdbSet ? `<span class="muted">${esc(ak.tmdbHint || 'Saved')}${ak.tmdbFromEnv ? ' (env)' : ''}</span>` : ''}
        </div>
        <div class="api-key-row">
          <input id="tmdbKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${tmdbSet ? 'Enter new TMDB v3 key or v4 token…' : 'Paste TMDB v3 key or v4 Read Access Token…'}" aria-label="TMDB API Key" />
          <button id="tmdbKeySave" class="btn btn-small btn-ghost" type="button">Save</button>
          ${tmdbSet && !ak.tmdbFromEnv ? '<button id="tmdbKeyClear" class="btn btn-small btn-ghost" type="button" title="Remove saved TMDB key">Clear</button>' : ''}
        </div>
        <div class="api-key-hint">Free key at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">themoviedb.org/settings/api</a></div>
      </div>
      <details class="disc-rules">
        <summary>TVmaze key (optional): ${tvmazeSet ? `Configured (${esc(ak.tvmazeHint || 'Saved')})` : 'Not needed — public API active'}</summary>
        <div class="api-key-field">
          <div class="api-key-row">
            <input id="tvmazeKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${tvmazeSet ? 'Enter new TVmaze API key…' : 'Optional TVmaze user API key…'}" aria-label="TVmaze API Key" />
            <button id="tvmazeKeySave" class="btn btn-small btn-ghost" type="button">Save</button>
            ${tvmazeSet && !ak.tvmazeFromEnv ? '<button id="tvmazeKeyClear" class="btn btn-small btn-ghost" type="button">Clear</button>' : ''}
          </div>
          <div class="api-key-hint">TVmaze search &amp; episode schedules work out of the box without a key.</div>
        </div>
      </details>`;

    const saveTmdb = async (val, clearing = false) => {
      const btn = $('#tmdbKeySave', box);
      if (btn) {
        btn.disabled = true;
        btn.textContent = clearing ? 'Clearing…' : 'Checking…';
      }
      try {
        state.settings = await api('/api/settings', { method: 'POST', body: JSON.stringify({ tmdbApiKey: val }) });
        renderApiKeysSettings(state.settings);
        renderCalendar();
        toast(clearing ? 'TMDB API key removed' : 'TMDB API key verified and saved', 'ok');
      } catch (err) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Save';
        }
        toast(err.message, 'err');
      }
    };
    $('#tmdbKeySave', box).addEventListener('click', () => {
      const v = $('#tmdbKeyInput', box).value.trim();
      if (!v) return toast('Paste your TMDB API key first', 'err');
      saveTmdb(v);
    });
    $('#tmdbKeyInput', box).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = e.target.value.trim();
        if (v) saveTmdb(v);
      }
    });
    $('#tmdbKeyClear', box)?.addEventListener('click', () => saveTmdb('', true));

    const saveTvmaze = async (val, clearing = false) => {
      try {
        state.settings = await api('/api/settings', { method: 'POST', body: JSON.stringify({ tvmazeApiKey: val }) });
        renderApiKeysSettings(state.settings);
        toast(clearing ? 'TVmaze API key cleared' : 'TVmaze API key saved', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    $('#tvmazeKeySave', box)?.addEventListener('click', () => {
      const v = $('#tvmazeKeyInput', box).value.trim();
      if (!v) return toast('Enter a TVmaze API key or leave blank', 'err');
      saveTvmaze(v);
    });
    $('#tvmazeKeyClear', box)?.addEventListener('click', () => saveTvmaze('', true));
  }

  const DISC_GENRES = ['Drama', 'Comedy', 'Crime', 'Thriller', 'Mystery', 'Action', 'Science-Fiction', 'Fantasy', 'Horror', 'Documentary', 'Animation', 'Romance'];
  let discRulesOpen = false;
  let interestsOpen = false;

  function renderInterestsSettings() {
    const box = $('#interestsBox');
    if (!box) return;
    box.hidden = false;
    const selected = new Set((state.settings && state.settings.interests) || []);
    const pool = new Set([...DISC_GENRES, 'Adventure', 'Family', 'Western', 'Music', ...selected]);
    for (const col of [state.shows, state.movies]) {
      for (const s of col.values()) for (const g of s.genres || []) pool.add(g);
    }
    const genres = [...pool].sort((a, b) => a.localeCompare(b));
    const selList = [...selected].sort((a, b) => a.localeCompare(b));
    const summary = selList.length ? selList.join(', ') : 'None selected';
    box.innerHTML = `
      <div class="int-head">
        <div class="int-title"><span class="int-dot"></span><span>My interests</span>${selList.length ? `<span class="int-count">${selList.length}</span>` : ''}</div>
        ${selList.length ? '<button type="button" class="mini-text-btn muted-btn" id="clearInterestsBtn">Clear</button>' : ''}
      </div>
      <div class="int-sub">Highlights matching shows &amp; movies; bounces on premieres</div>
      <details class="disc-rules int-details"${interestsOpen || selList.length ? ' open' : ''}>
        <summary>${esc(summary)}</summary>
        <div class="genre-chips" style="margin-top:8px">
          ${genres.map((g) => `<button type="button" class="ichip${selected.has(g) ? ' on' : ''}" data-int="${esc(g)}">${esc(g)}</button>`).join('')}
        </div>
      </details>`;
    $('.int-details', box).addEventListener('toggle', (e) => {
      interestsOpen = e.currentTarget.open;
    });
    const saveInterests = async (nextList) => {
      const prev = [...selected];
      state.settings = { ...state.settings, interests: nextList };
      renderInterestsSettings();
      renderCalendar();
      try {
        state.settings = await api('/api/settings', { method: 'POST', body: JSON.stringify({ interests: nextList }) });
      } catch (err) {
        state.settings = { ...state.settings, interests: prev };
        renderInterestsSettings();
        renderCalendar();
        toast(err.message, 'err');
      }
    };
    $$('[data-int]', box).forEach((b) =>
      b.addEventListener('click', () => {
        const g = b.dataset.int;
        const next = new Set(selected);
        if (next.has(g)) next.delete(g);
        else next.add(g);
        saveInterests([...next]);
      })
    );
    const clr = $('#clearInterestsBtn', box);
    if (clr) clr.addEventListener('click', () => saveInterests([]));
  }

  function renderDiscovery(disc, mdisc = state.status && state.status.movieDiscovery) {
    const box = $('#discoveryBox');
    if (!disc) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const batch = disc.lastBatch || [];
    const mbatch = (mdisc && mdisc.lastBatch) || [];
    const running = disc.running || Boolean(mdisc && mdisc.running);
    const done = disc.running ? disc.done : mdisc && mdisc.running ? mdisc.done : 0;
    const total = disc.running ? disc.total : mdisc && mdisc.running ? mdisc.total : 0;
    const curName = disc.running ? disc.current : mdisc && mdisc.running ? mdisc.current : '';
    const rules = disc.rules || { englishOnly: false, scriptedOnly: false, minWeight: 0, genres: [] };
    const pct = running && total ? Math.round((done / total) * 100) : 0;
    const sub = running
      ? `Scanning: <b>${done}/${total || '?'}</b>${curName ? ` — ${esc(curName)}` : ''}`
      : disc.lastWeek || (mdisc && mdisc.lastWeek)
      ? `${esc(disc.lastWeek || mdisc.lastWeek)}: <span class="disc-pick">${batch.length} show${batch.length === 1 ? '' : 's'}</span> · <span class="disc-pick">${mbatch.length} movie${mbatch.length === 1 ? '' : 's'}</span>`
      : 'Adds new TV premieres &amp; streaming, TV, or physical movies once / week';
    const ruleSummary = [
      rules.englishOnly ? 'English' : null,
      rules.scriptedOnly ? 'Scripted/Anim' : null,
      rules.minWeight > 0 ? `weight ≥ ${rules.minWeight}` : null,
      rules.genres && rules.genres.length ? `${rules.genres.length} genre${rules.genres.length === 1 ? '' : 's'}` : null,
    ].filter(Boolean);

    box.innerHTML = `
      <div class="disc-row">
        <label class="disc-title" for="discoveryToggle">
          <span class="auto-pill">Auto</span>
          <span>Add new shows &amp; movies once / week</span>
        </label>
        <label class="switch" title="Automatically add brand-new TV shows &amp; movies once per week">
          <input id="discoveryToggle" type="checkbox"${disc.enabled ? ' checked' : ''} />
          <span class="switch-track"></span>
        </label>
      </div>
      <div class="disc-sub">
        <span>${sub}</span>
        <button id="discoveryRunBtn" class="btn btn-small btn-ghost" type="button"${running ? ' disabled' : ''}>${running ? 'Adding…' : 'Check now'}</button>
      </div>
      ${running ? `<div class="progress" style="margin-top:8px"><i style="width:${pct}%"></i></div>` : ''}
      ${!running && mdisc && mdisc.error ? `<div class="disc-err">${esc(mdisc.error)}</div>` : ''}
      ${!running && (batch.length || mbatch.length) ? `<details class="disc-list"><summary>Added this week (${batch.length} shows, ${mbatch.length} movies)</summary>${batch.length ? `<div><b>Shows:</b> ${esc(batch.map((b) => b.name).join(', '))}</div>` : ''}${mbatch.length ? `<div style="margin-top:4px"><b>Movies:</b> ${esc(mbatch.map((b) => b.name).join(', '))}</div>` : ''}</details>` : ''}
      <details class="disc-rules"${discRulesOpen ? ' open' : ''}>
        <summary>Discovery filters: ${ruleSummary.length ? esc(ruleSummary.join(' · ')) : 'All premieres'}</summary>
        <div class="disc-rules-body">
          <div class="disc-checks">
            <label><input type="checkbox" id="ruleEnglish"${rules.englishOnly ? ' checked' : ''} /> English only</label>
            <label><input type="checkbox" id="ruleScripted"${rules.scriptedOnly ? ' checked' : ''} /> Scripted / Animation</label>
          </div>
          <div class="disc-row-inline">
            <span>Min popularity</span>
            <select id="ruleMinWeight">
              <option value="0"${rules.minWeight === 0 ? ' selected' : ''}>Any (0+)</option>
              <option value="50"${rules.minWeight === 50 ? ' selected' : ''}>Popular (50+)</option>
              <option value="75"${rules.minWeight === 75 ? ' selected' : ''}>High (75+)</option>
              <option value="90"${rules.minWeight === 90 ? ' selected' : ''}>Top (90+)</option>
            </select>
          </div>
          <div class="genre-chips">
            ${DISC_GENRES.map((g) => `<button type="button" class="gchip${(rules.genres || []).includes(g) ? ' on' : ''}" data-dg="${esc(g)}">${esc(g)}</button>`).join('')}
          </div>
        </div>
      </details>`;
    $('.disc-rules', box).addEventListener('toggle', (e) => {
      discRulesOpen = e.currentTarget.open;
    });
    const saveRules = async (patch) => {
      try {
        const next = await api('/api/discovery/rules', { method: 'POST', body: JSON.stringify(patch) });
        renderDiscovery(next);
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    $('#ruleEnglish', box).addEventListener('change', (e) => saveRules({ englishOnly: e.target.checked }));
    $('#ruleScripted', box).addEventListener('change', (e) => saveRules({ scriptedOnly: e.target.checked }));
    $('#ruleMinWeight', box).addEventListener('change', (e) => saveRules({ minWeight: Number(e.target.value) }));
    $$('.gchip', box).forEach((b) =>
      b.addEventListener('click', () => {
        const g = b.dataset.dg;
        const cur = new Set(rules.genres || []);
        if (cur.has(g)) cur.delete(g);
        else cur.add(g);
        saveRules({ genres: [...cur] });
      })
    );
    $('#discoveryToggle', box).addEventListener('change', async (e) => {
      try {
        const next = await api('/api/discovery/toggle', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
        toast(next.enabled ? 'Weekly new-show discovery enabled' : 'Weekly auto-discovery paused', 'ok');
        pollStatus(true);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    $('#discoveryRunBtn', box).addEventListener('click', async () => {
      try {
        await api('/api/discovery/run', { method: 'POST' });
        toast('Checking TVmaze for new premieres…', 'ok');
        pollStatus(true);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  function renderExtSettings(settings) {
    const box = $('#extSettingsBox');
    if (!box) return;
    const curUrl = (settings && settings.extSearchUrl) || '';
    box.hidden = false;
    const sampleUrl = extSearchUrl('The Last of Us', { season: 2, number: 1 });
    box.innerHTML = `
      <div class="api-keys-head">
        <span class="lan-label">External Search</span>
        <span class="api-key-badge ${curUrl ? 'ok' : 'muted'}">${curUrl ? 'Configured' : 'Not set'}</span>
      </div>
      <div class="api-key-field">
        <div class="api-key-row">
          <input id="extUrlInput" type="url" autocomplete="off" spellcheck="false" value="${esc(curUrl)}" placeholder="https://example.com/search?q={query}%201080p" aria-label="External Search URL template" />
          <button id="extUrlSave" class="btn btn-small btn-ghost" type="button">Save</button>
          ${curUrl ? '<button id="extUrlClear" class="btn btn-small btn-ghost" type="button">Clear</button>' : ''}
        </div>
        <div class="ext-url-doc">
          <b>What <code>{query}</code> does:</b> Viuhti replaces <code>{query}</code> with the URL-encoded search text for that card:<br>
          • <b>Single TV episode:</b> <code>Show Name S01E02</code><br>
          • <b>Multi-episode / pack:</b> <code>Show Name S01</code><br>
          • <b>Movie:</b> <code>Movie Title 2026</code><br>
          Include any resolution, tags, or sort params directly in your URL (e.g. <code>https://site.com/search?q={query}%201080p</code>). If you omit <code>{query}</code>, the encoded query is appended to the end.
        </div>
        ${sampleUrl ? `<div class="ext-url-preview" title="${esc(sampleUrl)}">Preview: ${esc(sampleUrl)}</div>` : ''}
      </div>`;

    const applyUrl = async (val) => {
      try {
        state.settings = await api('/api/settings', { method: 'POST', body: JSON.stringify({ extSearchUrl: val }) });
        renderExtSettings(state.settings);
        renderCalendar();
        toast(val ? 'External Search URL saved' : 'External Search URL cleared', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    $('#extUrlSave', box).addEventListener('click', () => applyUrl($('#extUrlInput', box).value.trim()));
    $('#extUrlInput', box).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyUrl(e.target.value.trim());
    });
    $('#extUrlClear', box)?.addEventListener('click', () => applyUrl(''));
  }

  // ---------- Toasts ----------
  function toast(msg, type = 'ok', action = null) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `${type === 'err' ? ICON.alert : ICON.check}<span>${esc(msg)}</span>`;
    if (action && action.label) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        el.remove();
        if (action.onClick) action.onClick();
      });
      el.appendChild(btn);
    }
    $('#toasts').appendChild(el);
    setTimeout(() => {
      if (!el.isConnected) return;
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 300);
    }, action ? 5500 : 3200);
  }

  // ---------- Segmented controls ----------
  function bindSeg(id, key, onChange) {
    const seg = $(id);
    const sync = () => $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.value === state[key]));
    sync();
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state[key] = b.dataset.value;
      store.set(key, state[key]);
      sync();
      onChange();
    });
  }
  bindSeg('#mediaSeg', 'media', () => {
    updateFavUi();
    populateGenres();
    renderCalendar(true);
  });
  bindSeg('#filterSeg', 'filter', renderCalendar);
  bindSeg('#timeSeg', 'timeMode', renderCalendar);
  bindSeg('#densitySeg', 'density', renderCalendar);

  function setGenre(g) {
    state.genre = g || '';
    store.set('genre', state.genre);
    $('#genreFilter').value = state.genre;
    $('#genreWrap').classList.toggle('active', Boolean(state.genre));
    renderCalendar();
  }
  $('#genreFilter').addEventListener('change', (e) => setGenre(e.target.value));

  function toggleFavFilter() {
    state.favoritesOnly = !state.favoritesOnly;
    store.set('favOnly', state.favoritesOnly ? '1' : '0');
    updateFavUi();
    renderCalendar();
  }
  $('#favFilterBtn').addEventListener('click', toggleFavFilter);

  // ---------- Week navigation & Month picker ----------
  function shiftWeek(n) {
    state.weekStart = n === 0 ? startOfWeek(new Date()) : addDays(state.weekStart, 7 * n);
    loadWeek().catch((e) => toast(e.message, 'err'));
  }
  $('#prevWeek').addEventListener('click', () => shiftWeek(-1));
  $('#nextWeek').addEventListener('click', () => shiftWeek(1));
  $('#todayBtn').addEventListener('click', () => shiftWeek(0));

  let mpMonth = new Date(state.weekStart.getFullYear(), state.weekStart.getMonth(), 1);
  async function renderMonthPicker() {
    const mp = $('#monthPicker');
    const year = mpMonth.getFullYear();
    const month = mpMonth.getMonth();
    const first = new Date(year, month, 1);
    const gridStart = startOfWeek(first);
    const gridEnd = addDays(gridStart, 41);
    const today = ymd(new Date());
    const selStart = ymd(state.weekStart);
    const selEnd = ymd(addDays(state.weekStart, 6));

    let activeDates = new Set();
    try {
      const data = await api(`/api/schedule?from=${ymd(gridStart)}&to=${ymd(gridEnd)}`);
      if (state.media !== 'movies') {
        for (const e of data.episodes || []) if (e.airdate) activeDates.add(e.airdate);
      }
      if (state.media !== 'shows') {
        for (const m of data.movies || []) if (m.airdate) activeDates.add(m.airdate);
      }
    } catch { /* ignore */ }

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      const k = ymd(d);
      const cls = [
        'mp-day',
        d.getMonth() !== month ? 'out' : '',
        k >= selStart && k <= selEnd ? 'in-week' : '',
        k === today ? 'today' : '',
        activeDates.has(k) ? 'has-ep' : '',
      ]
        .filter(Boolean)
        .join(' ');
      cells.push(`<button type="button" class="${cls}" data-jump="${k}">${d.getDate()}</button>`);
    }
    mp.innerHTML = `
      <div class="mp-head">
        <button type="button" class="icon-btn" id="mpPrev" aria-label="Previous month"><svg viewBox="0 0 24 24"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <span>${esc(fmtDay(first, { month: 'long', year: 'numeric' }))}</span>
        <button type="button" class="icon-btn" id="mpNext" aria-label="Next month"><svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <div class="mp-grid">
        ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w) => `<div class="mp-dow">${w}</div>`).join('')}
        ${cells.join('')}
      </div>`;
    $('#mpPrev', mp).addEventListener('click', () => {
      mpMonth = new Date(year, month - 1, 1);
      renderMonthPicker();
    });
    $('#mpNext', mp).addEventListener('click', () => {
      mpMonth = new Date(year, month + 1, 1);
      renderMonthPicker();
    });
    $$('[data-jump]', mp).forEach((b) =>
      b.addEventListener('click', () => {
        state.weekStart = startOfWeek(new Date(b.dataset.jump + 'T12:00:00'));
        mp.hidden = true;
        $('#weekPickerBtn').setAttribute('aria-expanded', 'false');
        loadWeek().catch((e) => toast(e.message, 'err'));
      })
    );
  }
  $('#weekPickerBtn').addEventListener('click', () => {
    const mp = $('#monthPicker');
    const open = mp.hidden;
    mp.hidden = !open;
    $('#weekPickerBtn').setAttribute('aria-expanded', String(open));
    if (open) {
      mpMonth = new Date(state.weekStart.getFullYear(), state.weekStart.getMonth(), 1);
      renderMonthPicker();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#monthPicker') && !e.target.closest('#weekPickerBtn')) {
      $('#monthPicker').hidden = true;
      $('#weekPickerBtn').setAttribute('aria-expanded', 'false');
    }
    if (wizard.langOpen && !e.target.closest('.wiz-lang-drop')) {
      const refilterFocus = e.target.id === 'wizFilterInput';
      setWizLangOpen(false);
      renderCalendar();
      if (refilterFocus) $('#wizFilterInput')?.focus();
    }
  });

  // ---------- Calendar interactions ----------
  $('#calendar').addEventListener('click', (e) => {
    const dis = e.target.closest('[data-dismiss], [data-remove-card]');
    if (dis) {
      const key = dis.closest('[data-key]')?.dataset.key;
      const g = key ? state.groups.get(key) : null;
      const isDis = Boolean(dis.dataset.dismiss);
      const id = Number(dis.dataset.dismiss || dis.dataset.removeCard);
      const kind = dis.dataset.kind || 'show';
      const item = (kind === 'movie' ? state.movies : state.shows).get(id);
      const name = (g && g.show.name) || (item && item.name) || kind;
      if (isDis) dismissItem(id, name, kind);
      else removeItem(id, name, kind);
      return;
    }
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      toggleFavorite(Number(fav.dataset.fav), fav.dataset.kind || 'show');
      return;
    }
    if (e.target.closest('[data-stop]')) return; // External Search link opens normally
    const card = e.target.closest('.ep, .agenda-row');
    if (card) openModal(card.dataset.key);
  });
  $('#calendar').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.classList.contains('ep') || e.target.classList.contains('agenda-row'))) openModal(e.target.dataset.key);
  });
  $('#modal').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
  });

  // ---------- Keyboard shortcuts ----------
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) closeModal();
      else if (wizard.langOpen) {
        setWizLangOpen(false);
        renderCalendar();
        $('#wizLangBtn')?.focus();
      } else if (!$('#monthPicker').hidden) {
        $('#monthPicker').hidden = true;
        $('#weekPickerBtn').setAttribute('aria-expanded', 'false');
      } else if ($('#drawer').classList.contains('open')) closeDrawer();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (!$('#modal').hidden) {
      return;
    } else if (e.key === 'ArrowLeft') shiftWeek(-1);
    else if (e.key === 'ArrowRight') shiftWeek(1);
    else if (e.key.toLowerCase() === 't') shiftWeek(0);
    else if (e.key.toLowerCase() === 'f') toggleFavFilter();
    else if (e.key.toLowerCase() === 'm') ($('#drawer').classList.contains('open') ? closeDrawer : openDrawer)();
  });

  // Pause premiere bounce CSS keyframes while actively touching/scrolling so mobile stays compositor-only.
  let scrollPauseTimer = 0;
  const markScrolling = () => {
    const root = document.documentElement;
    if (!root.classList.contains('is-scrolling')) root.classList.add('is-scrolling');
    clearTimeout(scrollPauseTimer);
    scrollPauseTimer = setTimeout(() => root.classList.remove('is-scrolling'), 220);
  };
  window.addEventListener('touchstart', markScrolling, { passive: true });
  window.addEventListener('scroll', markScrolling, { passive: true });
  window.addEventListener('wheel', markScrolling, { passive: true });

  // Roll over to the new week automatically if the tab is left open.
  let lastToday = ymd(new Date());
  setInterval(() => {
    const t = ymd(new Date());
    if (t !== lastToday) {
      lastToday = t;
      renderCalendar();
    }
  }, 60000);

  // ---------- Boot ----------
  reloadAll().finally(() => {
    if (!document.hidden) setTimeout(() => pollStatus(), 600);
  });
})();
