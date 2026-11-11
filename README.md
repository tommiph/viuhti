# Viuhti — Visual Itinerary for Ultimate Home Theater Immersion

A zero-dependency Node.js personal TV & movie release calendar paired with a **100% local Deep Taste DNA recommendation engine**, powered by the [TVmaze API](https://www.tvmaze.com/api) and [The Movie Database (TMDB)](https://www.themoviedb.org/documentation/api).

Everything runs directly on your own machine (with optional LAN access for phones) and stores your library, settings, and trained taste profile locally inside `data/` — no cloud accounts, no shared tracking, and no `npm install` required.

---

## Deep Taste DNA (Local AI & Discover Tab)

Switch to the dedicated **Discover** tab (`D` shortcut) to explore personalized show and movie recommendations computed entirely locally on your PC by [`lib/recommender.js`](lib/recommender.js):

- **Private Local Modeling (`data/taste.json` & `data/taste-cache/`)**: Each installation builds its own independent Taste DNA model strictly from your local activity — combining strong positive signals (favorites, checked-off episodes/movies, manual/Discover adds, `♥ Loved` ratings, and `My interests` genres) with negative patterns learned automatically from your `Hidden` list and `× Not for me` rejections.
- **TF-IDF Log-Odds Scoring Across Deep Features**: Goes beyond broad genre matching by extracting weighted terms across **narrative keywords & themes** (both explicit TMDB keywords and built-in story theme analysis on descriptions), **creators/showrunners/directors**, **lead cast**, **networks & studios**, **formats**, **languages**, and **release eras**, while automatically dampening generic noisy tags (like `"Drama"` or `"English"` when they appear in both loved and hidden items).
- **Dual-Mode Engine (Works With or Without a TMDB Key)**:
  - **TVmaze-Only Mode (Zero API Keys Required)**: Scores TVmaze's curated catalog (`/shows?page=0..1`), upcoming schedule (`/schedule/full`), cast & crew (`/shows/:id?embed[]=cast&embed[]=crew`), and narrative themes right out of the box.
  - **TVmaze + TMDB Deep Mode (When TMDB Key Is Set)**: Automatically cross-links TV shows via IMDb/TVDB IDs, pulls TMDB keywords & studios, walks multi-anchor collaborative co-watch graphs (`recommendations` & `similar`), runs targeted `/discover/tv` and `/discover/movie` queries for hidden gems and upcoming releases, and resolves TMDB TV picks back to TVmaze when added to your calendar.
- **Cold-Start Friendly**: New installs with empty libraries start with a **Quick Rate** strip (`♥ Love`, `✓ Seen`, `× Skip`) seeded from live TVmaze/TMDB trends so even a few clicks immediately calibrate tailored picks.
- **Exploration Lenses & Interactive Taste Profile Studio**:
  - Switch between **Deep Mix**, **Hidden Gems**, **Airing Soon**, and **Bingeable** (completed ended series), filter by **All / TV Shows / Movies**, or focus dynamically with **Because you loved…** anchored to any favorite or tracked show/movie.
  - Open **Taste Profile** to inspect your learned **Strong Affinities** and **Learned Avoidances** chips — click any trait to boost or mute it on the fly.
  - Every card explains *why* it matches you (`Match %`, co-watch consensus, creator/cast overlaps, themes) and gives four distinct actions: **`+ Calendar`**, **`♥ Loved`**, **`✓ Seen`** (excludes cleanly without penalizing similar shows), and **`× Not for me`** (hides & penalizes matching traits).

---

## Calendar & Home-Theater Features

- **Five Calendar Views + Month Picker**: Switch via the icon view bar between **Day** (open episode/movie descriptions and per-episode checkboxes), **Cards**, **Compact**, **Month** (dense show names & event labels), and **Up Next** (rolling **14-day window** `[today .. today + 13]` on the current week).
- **Episode & Movie Check-Offs (`data/watched.json`)**: Toggle watched/grabbed status per card, per individual episode in Day view or the Episode Modal, and track partial multi-episode progress (`1/2 ✓`). Toggle **Hide seen** (`W` shortcut) to keep only unwatched episodes and movies in view without touching your Hidden list.
- **Sync Activity Digest (`data/digest.json`)**: Displays a dismissible summary banner whenever automatic refreshes add new TV shows/movies or detect upcoming TVmaze schedule changes, with expandable history inside **Settings → Sync Activity Digest**.
- **Premiere Alerts (Browser + Webhooks)**: Optional browser notifications for today's Favorited and Interest premieres, plus once-daily webhook dispatches (`Settings → Premiere Alerts`) supporting **ntfy.sh**, **Discord**, **Slack**, and generic JSON endpoints (with a built-in **Test** button).
- **Twice-Monthly Sync (2 Weeks Ahead) & Format Exclusions**: Automatically scans twice per calendar month (`days 1–15` and `16–end`) across the next two weeks for new TVmaze shows and TMDB movie releases (`Digital/Streaming`, `Physical`, `TV Premiere`), plus hourly TVmaze entry checks and manual **Refresh from TVmaze**. Filter sync rules by languages, genres, minimum popularity, and **Excluded TV formats** (`Talk Show`, `News`, `Sports`, `Game Show`, `Reality`, `Variety`).
- **Hidden Items & 25% Opacity View (`data/hidden.json`)**: Hide unwanted shows or movies permanently without any list cap so automated updates never re-add them. Manage items in the **Hidden** tab, or enable **Show hidden items (25% opacity)** to inspect and unhide them inline on the calendar.
- **Multi-Dimensional Filtering**: Filter live by **Shows | Both | Movies**, **All | TV | Streaming | Disc**, **All genres**, **All services** (network/streaming channel), **Favorites** (`F`), **Hide seen** (`W`), and **My time | Network** timezone display.
- **`.ics` Calendar Feed & One-Click Backups**:
  - Subscribe or download live RFC 5545 calendar events at `/api/calendar.ics` (supports `?media=shows|both|movies`, `?favorites=1`, and `?download=1`).
  - Export and restore complete portable JSON backups inside **Settings → Calendar Feed (.ics) & Backup** (preserving shows, movies, hidden items, watched state, sync rules, and Discover Taste DNA — with API keys & webhooks stripped by default unless checked).
- **Graxobolt — 3D Neural Content Galaxy (`G` Tab)**:
  - Lazy-loaded Three.js WebGL2 interactive 3D universe with theme-synced volumetric nebulas, neural synapse filaments, lightning arc expansions, and synthesized Web Audio sci-fi sound effects (with Mute toggle).
  - Enter from your full **Taste Nebula**, search/warp to any show, movie, actor, creator, or theme nebula, or launch directly from any Episode Modal, Discover Card, or Search Result (`⚡ 3D`). With **⚡ Auto-Dive** on, clicking any star, person, or theme nebula plunges the camera into its **first-person Seed POV** and re-seeds the constellation outward ahead of you (`V` toggles **POV / Overview**; toggle Auto-Dive off to inspect or **Expand (+1 Hop)** inline).
- **10 Visual Themes**: Switch anytime in **Settings** across 5 dark and 5 light themes (`Midnight`, `Grand Bistro`, `Departure Board`, `Silver Screen`, `Broadsheet`, `Blueprint`, `Swiss Atelier`, `Cyber Arcade`, `Greenhouse`, and `Comic Press`).
- **External Search Customization**: Configure a custom `{query}` search URL template globally in Settings plus per-title custom query overrides in the detail modal.
- **First-Start Setup & Windows Background Startup**: Includes a guided onboarding wizard on fresh installs and Windows silent login scripts (`scripts/install-startup.cmd` / `npm run startup:install`, removed via `scripts/uninstall-startup.cmd`).

---

## Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| `/` | Focus TVmaze & TMDB search bar |
| `D` | Switch between **Calendar** and **Discover** tabs |
| `G` | Open / exit **Graxobolt** 3D Galaxy tab (`1` / `2` / `3` also switch main tabs) |
| `WASD` / `Q` `E` / `V` / `R` | Fly (`Shift` Warp boost), Up/Down, toggle POV/Overview, and Reset camera inside **Graxobolt** |
| `←` / `→` | Previous / next day, week, or month |
| `T` | Jump to today / current week |
| `F` | Toggle **Favorites** filter (Calendar tab) |
| `W` | Toggle **Hide seen** filter (Calendar tab) |
| `M` | Open / close **Settings & Hidden** drawer |
| `Esc` | Close modal, dropdowns, or drawer |

---

## Project Layout

- [`server.js`](server.js) — HTTP server, static UI hosting, API routes, `.ics` generator, backup export/import, and periodic sync loop
- `lib/` — Modular zero-dependency backend (`store.js`, `tvmaze.js`, `tmdb.js`, `discovery.js`, `movies.js`, `hidden.js`, `watched.js`, `digest.js`, `alerts.js`, `recommender.js`, `galaxy.js`)
- `public/` — Frontend (`index.html`, `styles.css`, `themes.css`, `app.js`, `graxobolt.mjs`, `vendor/three/`, `favicon.svg`) designed for desktop and mobile (`390px+`)
- `data/` — Runtime user database, caches, Taste DNA state, and local settings (**ignored by Git via `.gitignore`**)

---

## Running

Requires **Node.js 18+** (no external packages or `npm install` required).

```bash
node server.js
```

Or:

```bash
npm start
```

By default Viuhti binds to `0.0.0.0` starting on port `4280` (automatically probing upward if occupied; override with `PORT=5000`, `PORT=0`, or `HOST=127.0.0.1` for localhost-only).

### Accessing from your phone

On startup the console prints your LAN URL (e.g., `http://192.168.0.x:4280`). Open that address on any phone on the same Wi-Fi network. On Windows, make sure inbound local connections to `node.exe` are allowed in Windows Defender Firewall for your private/home network profile.
