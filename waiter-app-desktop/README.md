# Magnify POS — Desktop Waiter Terminal

Standalone Electron desktop app for Windows. Runs on the POS machine (separate from the admin desktop).

## Setup

### Prerequisites

1. **Node.js** 18+ (https://nodejs.org)
2. **Windows Build Tools** — required for `better-sqlite3` native module:
   ```
   npm install --global windows-build-tools
   ```
   Or install "Desktop development with C++" workload from Visual Studio Installer.

### Install & Run (Development)

```bash
cd waiter-app-desktop
npm install
npm run dev
```

The Vite dev server starts first, then Electron opens and loads it.

### Build Installer

```bash
npm run electron:build
```

Output: `dist-electron/Magnify POS Setup X.X.X.exe`

## Configuration

`runtime.env` (lives next to the app binary after packaging):

```
WAITER_API_BASE_URL=https://magnify-app-tau.vercel.app
```

Change this to point at a different server without rebuilding.

## Architecture

```
electron/main.js      — Electron main process
                        • Reads runtime.env
                        • Opens better-sqlite3 at userData/magnify_waiter.db
                        • Handles db:run / db:query / db:executeSet IPC
                        • Before-quit guard: warns if unsynced orders exist
                        • Auto-updater

electron/preload.js   — Context bridge
                        • Exposes window.electronDB (IPC wrappers)
                        • Exposes window.electronConfig.apiBaseUrl

src/services/db.ts    — SQLite layer (calls window.electronDB)
src/services/http.ts  — HTTP layer (native fetch, no Capacitor)
src/services/network.ts — Online detection (navigator.onLine)
src/services/auth.ts  — Login, session, token (identical to waiter-app)
src/services/logger.ts — App log buffer (identical to waiter-app)
src/services/sync.ts  — Pull/push sync (identical to waiter-app)

src/pages/            — All page components (identical to waiter-app)
```

## SQLite Database

- Location: `%APPDATA%\Magnify POS\magnify_waiter.db`
- Schema: identical to Android waiter-app — same orders table, same sync protocol
- WAL mode enabled for reliability

## Safety Features

- **Before-quit guard**: dialog warns if unsynced orders exist when closing
- **Unsynced badge**: POS tab shows count of unsynced orders
- **Idempotent sync**: push uses server-side upsert, safe to retry
- **Empty-pull guard**: never wipes local menu/tables on empty API response
