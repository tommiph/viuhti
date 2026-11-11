# Viuhti — Visual Itinerary for Ultimate Home Theater Immersion

A lightweight Node.js (zero-dependency) weekly TV show and movie calendar powered by the [TVmaze API](https://www.tvmaze.com/api) and [The Movie Database (TMDB)](https://www.themoviedb.org/documentation/api).

## Features

- **First-Start Setup Wizard**: Clean two-step onboarding lets you configure optional API keys and bulk-import upcoming shows (Monday of the current week up to 2 months ahead) filtered by multiple languages and genres.
- **Weekly Calendar Grid**: Shows every episode and movie release airing Monday–Sunday with artwork/title fallback, episode code & name, air time (toggle between your local timezone and original network time), and TV/streaming/physical source badges.
- **TVmaze & TMDB Integration**: Uses show branding, channel/streaming colors, episode schedules, and movie release data (`Digital/Streaming`, `Physical`, and `TV Premiere`).
- **API Keys Settings**: Configure your TMDB API key (v3 key or v4 Read Access Token, required for movie search and movie discovery) and optional TVmaze API key directly inside **Settings → API Keys**.
- **Search & Add**: Live TVmaze & TMDB search bar (`/` shortcut) to add or remove shows and movies at any time.
- **Movies Mode (TMDB)**: Toggle **Shows | Both | Movies** to browse brand-new movies released on Digital/Streaming, Physical media, or TV from TMDB, automatically discovered once per week inheriting discovery filters, favorites, genres, and External Search links.
- **Weekly Auto-Discovery**: Once per week, automatically scans TVmaze (`S01E01` premieres) and TMDB (new movie releases) with customizable discovery filters (English-only, Scripted/Animation, min popularity, and genres) inside **Settings**.
- **Trash Can & Restore**: Removed or dismissed items stay recoverable in **Trash** without losing favorites or custom External Search queries.
- **Favorites & My Interests**: Star shows/movies (`F` shortcut) and highlight selected **My interests** genres (with a bouncing animation on premieres).
- **Genre, Source & View Filtering**: Filter by genre, TV vs. Streaming, local vs. network time; switch between **Cards**, **Compact**, and **Up Next** (agenda) views; or click the week range to jump via the **Month Picker**.
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
