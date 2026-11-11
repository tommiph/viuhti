# Viuhti — Visual Itinerary for Ultimate Home Theater Immersion

A lightweight Node.js (zero-dependency) weekly TV show and movie calendar powered by the [TVmaze API](https://www.tvmaze.com/api) and [The Movie Database (TMDB)](https://www.themoviedb.org/documentation/api).

## Features

- **First-Start Setup Wizard**: Clean two-step onboarding lets you configure optional API keys and bulk-import upcoming shows (Monday of the current week up to 2 months ahead) filtered by multiple languages and genres.
- **Five Calendar Views**: Switch cleanly via the icon-only view selector between **Day** (full open episode/movie descriptions), **Cards**, **Compact**, **Month** (compact show names & labels), and **Up Next** (today & upcoming agenda), plus a **Month Picker** calendar jumper.
- **10 Visual Themes**: Choose from 10 distinct dark & light styles inside **Settings** (Midnight, Grand Bistro, Departure Board, Silver Screen, Broadsheet, Blueprint, Swiss Atelier, Cyber Arcade, Greenhouse, and Comic Press).
- **TVmaze & TMDB Integration**: Uses show branding, channel/streaming colors, episode schedules, and movie release data (`Digital/Streaming`, `Physical`, and `TV Premiere`).
- **API Keys Settings**: Configure your TMDB API key (v3 key or v4 Read Access Token, required for movie search and movie discovery) and optional TVmaze API key directly inside **Settings → API Keys**.
- **Search & Add**: Live TVmaze & TMDB search bar (`/` shortcut) to add, hide, or unhide shows and movies at any time.
- **Movies Mode (TMDB)**: Toggle **Shows | Both | Movies** to browse movies released on Digital/Streaming, Physical media, or TV from TMDB, inheriting sync filters, favorites, genres, and External Search links.
- **Twice-Monthly TVmaze & TMDB Sync (2 Weeks Ahead)**: Automatically checks twice per calendar month (`days 1–15` and `16–end`) looking two weeks ahead for new or updated TVmaze shows and TMDB movie releases (plus hourly TVmaze entry update checks and manual **Refresh from TVmaze**), configurable by language, genres, type, and popularity in **Settings**.
- **Hidden Items & 25% Opacity View**: Hide any show or movie permanently without a list cap so automated TVmaze/TMDB updates never re-add it. Manage/unhide anytime in the **Hidden** tab, or enable **Show hidden items (25% opacity)** in **Settings** to display hidden items inline at 25% opacity with quick Unhide actions.
- **Favorites & My Interests**: Star shows/movies (`F` shortcut) and highlight selected **My interests** genres (with a bouncing badge animation on all premieres).
- **Genre, Source & Time Filtering**: Filter by genre, TV vs. Streaming vs. Disc, and local vs. network time.
- **External Search Customization**: Configure any custom search URL template (using `{query}` placeholder with any desired resolution/quality tags directly inside the URL) and per-show custom title overrides inside **Settings → External Search**.
- **Windows Background Startup**: Run `scripts/install-startup.cmd` (or `npm run startup:install`) to auto-start silently on Windows login (`scripts/uninstall-startup.cmd` to remove).
- **Responsive & Fast**: Keyboard navigation (`←` / `→` weeks, `T` today, `F` favorites, `/` search, `M` settings drawer, `Esc` close), local disk cache in `data/`, and LAN access for phones.

## Running

Requires **Node.js 18+** (no `npm install` needed).

```bash
node server.js
```

Or:

```bash
npm start
```

By default the server listens on all local network interfaces (`0.0.0.0`) on the first free local port starting at `4280` (override with `PORT=5000`, `PORT=0` for an OS-assigned ephemeral port, or `HOST=127.0.0.1` for localhost-only).

### Accessing from your phone

When started, the console prints the local network URL (for example `http://192.168.1.x:4280`). Open that URL on a phone connected to the same Wi-Fi / router. On Windows, ensure inbound connections to Node.js are allowed in Windows Defender Firewall for your active network profile.
