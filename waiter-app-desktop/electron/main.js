const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------
let apiBaseUrl = 'https://magnify-app-tau.vercel.app'

function loadRuntimeEnv() {
  // In packaged builds, extraResources lands next to app.asar
  const candidates = [
    path.join(process.resourcesPath ?? '', 'runtime.env'),
    path.join(__dirname, '..', 'runtime.env'),
    path.join(app.getAppPath(), 'runtime.env'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const text = fs.readFileSync(candidate, 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq < 0) continue
        const key = trimmed.slice(0, eq).trim()
        const value = trimmed.slice(eq + 1).trim()
        if (key === 'WAITER_API_BASE_URL' && value) {
          apiBaseUrl = value
        }
      }
      break
    }
  }
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------
let db = null

// Schema mirrors the Android waiter-app SQLite schema exactly so orders sync correctly.
const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS dishes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  selling_price REAL NOT NULL,
  category TEXT,
  is_active INTEGER DEFAULT 1,
  branch_id TEXT,
  restaurant_id TEXT
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seats INTEGER,
  status TEXT DEFAULT 'available',
  branch_id TEXT,
  restaurant_id TEXT
);

CREATE TABLE IF NOT EXISTS restaurant_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  branch_id TEXT,
  table_id TEXT,
  table_name TEXT,
  order_number TEXT,
  status TEXT DEFAULT 'PENDING',
  payment_method TEXT,
  subtotal_amount REAL DEFAULT 0,
  vat_amount REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  created_by_name TEXT,
  served_at TEXT,
  paid_at TEXT,
  canceled_at TEXT,
  cancel_reason TEXT,
  synced INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  dish_id TEXT NOT NULL,
  dish_name TEXT NOT NULL,
  dish_price REAL NOT NULL,
  qty INTEGER NOT NULL,
  status TEXT DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);
`

function initDatabase() {
  // Require inline so electron-builder can correctly bundle it as a native module
  const Database = require('better-sqlite3')
  const dbPath = path.join(app.getPath('userData'), 'magnify_waiter.db')
  db = new Database(dbPath)
  db.exec(SCHEMA_SQL)
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  // db:run — executes a single write statement
  ipcMain.handle('db:run', (_event, sql, params = []) => {
    try {
      const stmt = db.prepare(sql)
      const result = stmt.run(...params)
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
    } catch (err) {
      throw new Error(`db:run failed: ${err.message}\nSQL: ${sql}`)
    }
  })

  // db:query — returns rows as array of objects
  ipcMain.handle('db:query', (_event, sql, params = []) => {
    try {
      const stmt = db.prepare(sql)
      return stmt.all(...params)
    } catch (err) {
      throw new Error(`db:query failed: ${err.message}\nSQL: ${sql}`)
    }
  })

  // db:executeSet — batch writes in a single transaction
  // statements: { statement: string; values: unknown[] }[]
  ipcMain.handle('db:executeSet', (_event, statements) => {
    if (!Array.isArray(statements) || statements.length === 0) {
      return { changes: 0 }
    }
    // Filter out bare transaction control that Capacitor used to send
    const filtered = statements.filter(({ statement }) => {
      const upper = statement.trim().toUpperCase()
      return upper !== 'BEGIN' && upper !== 'COMMIT' && upper !== 'ROLLBACK'
    })
    const runBatch = db.transaction((stmts) => {
      let totalChanges = 0
      for (const { statement, values = [] } of stmts) {
        const result = db.prepare(statement).run(...values)
        totalChanges += result.changes
      }
      return totalChanges
    })
    try {
      const changes = runBatch(filtered)
      return { changes }
    } catch (err) {
      throw new Error(`db:executeSet failed: ${err.message}`)
    }
  })

  // http:request — proxies HTTP/HTTPS through the main process, bypassing CORS
  ipcMain.handle('http:request', (_event, { method, url, headers, body, timeoutMs = 15000 }) => {
    return new Promise((resolve, reject) => {
      const https = require('https')
      const httpLib = require('http')
      let parsed
      try { parsed = new URL(url) } catch (err) { return reject(new Error(`Invalid URL: ${url}`)) }

      const isHttps = parsed.protocol === 'https:'
      const lib = isHttps ? https : httpLib
      const reqHeaders = Object.assign({}, headers)
      if (body && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
        reqHeaders['Content-Length'] = Buffer.byteLength(body)
      }

      const options = {
        method: (method || 'GET').toUpperCase(),
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: reqHeaders,
      }

      const req = lib.request(options, (res) => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const respHeaders = {}
          for (const [k, v] of Object.entries(res.headers)) {
            respHeaders[k] = Array.isArray(v) ? v.join(', ') : v
          }
          resolve({ status: res.statusCode, headers: respHeaders, data: Buffer.concat(chunks).toString('utf8') })
        })
      })

      const timer = setTimeout(() => req.destroy(new Error('Request timed out')), timeoutMs)
      req.on('error', (err) => { clearTimeout(timer); reject(err) })
      req.on('close', () => clearTimeout(timer))
      if (body) req.write(body)
      req.end()
    })
  })

  // get:config — preload reads this synchronously to inject window.electronConfig
  ipcMain.on('get:config', (event) => {
    event.returnValue = { apiBaseUrl }
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Magnify POS',
    icon: path.join(__dirname, '..', 'public', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  // In development load Vite dev server; in production load built index.html
  if (!app.isPackaged) {
    const devUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5174'
    mainWindow.loadURL(devUrl)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }
}

// ---------------------------------------------------------------------------
// Before-quit guard: warn if unsynced orders exist
// ---------------------------------------------------------------------------
let forceQuit = false

app.on('before-quit', async (event) => {
  if (forceQuit || !db) return

  let unsyncedCount = 0
  try {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM orders WHERE synced = 0').get()
    unsyncedCount = row?.cnt ?? 0
  } catch {
    // If we can't query, don't block quit
    return
  }

  if (unsyncedCount > 0) {
    event.preventDefault()
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Unsynced Orders',
      message: `You have ${unsyncedCount} unsynced order${unsyncedCount === 1 ? '' : 's'}.`,
      detail: 'These orders have not been sent to the server yet. If you close now, they may be lost if this device fails before reconnecting.\n\nAre you sure you want to quit?',
      buttons: ['Cancel', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response === 1) {
      forceQuit = true
      app.quit()
    }
  }
})

// ---------------------------------------------------------------------------
// Auto-updater (optional — gracefully skip if not configured)
// ---------------------------------------------------------------------------
function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // Not configured or no network — silent failure
    })
  } catch {
    // electron-updater not available in dev
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  loadRuntimeEnv()
  initDatabase()
  registerIpcHandlers()
  createWindow()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
