const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const http = require('http')
const net = require('net')
const path = require('path')
const fs = require('fs')

// Disable GPU acceleration to prevent silent crashes on older Intel graphics (HD 4000 etc.)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')

// ---------------------------------------------------------------------------
// Startup logging — best-effort diagnostics written to userData/startup.log so
// field issues (window never shows, GPU/render crashes, DB init failures) can be
// inspected without a debugger. Path: %APPDATA%\magnify-pos\startup.log
// ---------------------------------------------------------------------------
const STARTUP_LOG_MAX_BYTES = 512 * 1024

function getStartupLogPath() {
  try {
    return path.join(app.getPath('userData'), 'startup.log')
  } catch {
    return path.join(require('os').tmpdir(), 'magnify-pos-startup.log')
  }
}

function appendStartupLog(message) {
  try {
    const logPath = getStartupLogPath()
    // Keep the log bounded across launches.
    try {
      if (fs.statSync(logPath).size > STARTUP_LOG_MAX_BYTES) fs.rmSync(logPath, { force: true })
    } catch {}
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // Best-effort only — never let logging crash the app.
  }
}

process.on('uncaughtException', (err) => {
  appendStartupLog(`uncaughtException: ${err?.stack || err?.message || err}`)
})
process.on('unhandledRejection', (reason) => {
  appendStartupLog(`unhandledRejection: ${reason?.stack || reason?.message || reason}`)
})

// Process-level crash signals — a GPU process death here is the classic cause of
// a launched-but-invisible window on old Intel graphics.
app.on('child-process-gone', (_e, details) => {
  appendStartupLog(`child-process-gone: type=${details?.type} reason=${details?.reason} exitCode=${details?.exitCode}`)
})
app.on('render-process-gone', (_e, _wc, details) => {
  appendStartupLog(`render-process-gone: reason=${details?.reason} exitCode=${details?.exitCode}`)
})

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
const MIGRATIONS = [
  {
    // Initial schema — all CREATE TABLE IF NOT EXISTS, safe for existing installs.
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS dishes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  selling_price REAL NOT NULL,
  category TEXT,
  menu_type TEXT,
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
  notes TEXT,
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

CREATE TABLE IF NOT EXISTS cancellation_approvers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL
);
`,
  },
  {
    // Idempotent: migration 1's CREATE already bakes in menu_type on fresh
    // installs, so a blind ALTER would crash with "duplicate column name".
    version: 2,
    run: (database) => addColumnIfMissing(database, 'dishes', 'menu_type', 'TEXT'),
  },
  {
    version: 3,
    run: (database) => addColumnIfMissing(database, 'orders', 'sync_error', 'TEXT'),
  },
  {
    version: 4,
    sql: `
CREATE TABLE IF NOT EXISTS order_code_holders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL
);
`,
  },
  {
    // Per-item modifier note (e.g. "no sauce") so it prints on the bill too,
    // not just the kitchen ticket. Migration 1's CREATE bakes it in on fresh
    // installs, so guard the ALTER for existing databases.
    version: 5,
    run: (database) => addColumnIfMissing(database, 'order_items', 'notes', 'TEXT'),
  },
  {
    // MEP (mise en place): per-station prep list, prep catalog for search, and
    // the offline "qty prepared" log queue (id doubles as the server clientLogId).
    version: 6,
    sql: `
CREATE TABLE IF NOT EXISTS mep_items (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  branch_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT,
  remaining REAL DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS mep_catalog (
  target_id TEXT PRIMARY KEY,
  branch_id TEXT,
  name TEXT NOT NULL,
  unit TEXT,
  remaining REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mep_logs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  branch_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  name TEXT,
  quantity REAL NOT NULL,
  made_by TEXT,
  made_at TEXT NOT NULL,
  reversed INTEGER DEFAULT 0,
  pending_undo INTEGER DEFAULT 0,
  synced INTEGER DEFAULT 0,
  sync_error TEXT
);
`,
  },
]

function addColumnIfMissing(database, table, column, definition) {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

function runMigrations(database) {
  database.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
  `)

  const maxRow = database.prepare('SELECT COALESCE(MAX(version), 0) AS max_v FROM schema_migrations').get()
  const maxApplied = maxRow?.max_v ?? 0

  const applyMigration = database.transaction((migration) => {
    if (migration.sql) database.exec(migration.sql)
    if (migration.run) migration.run(database)
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString())
  })

  for (const migration of MIGRATIONS) {
    if (migration.version <= maxApplied) continue
    applyMigration(migration)
  }
}

function initDatabase() {
  // Require inline so electron-builder can correctly bundle it as a native module
  const Database = require('better-sqlite3')
  const dbPath = path.join(app.getPath('userData'), 'magnify_waiter.db')
  db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  runMigrations(db)
}

// ---------------------------------------------------------------------------
// ESC/POS bill printing (network thermal printer path)
// ---------------------------------------------------------------------------

// Send raw bytes to a network printer over TCP (port 9100 by default).
function printViaRawTcp(host, port, buffer) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Printer TCP connection timed out'))
    }, 10000)
    socket.once('error', err => { clearTimeout(timeout); reject(err) })
    socket.connect(parseInt(port) || 9100, host, () => {
      socket.write(buffer, err => {
        clearTimeout(timeout)
        socket.end()
        if (err) reject(err)
        else resolve()
      })
    })
  })
}

// Build a full ESC/POS byte sequence for a customer bill.
// data: { topText, bottomText, server, station, orderNo, orderType,
//         tableName, dt, items[{qty,name,unitPrice,notes}], totalAmount }
function buildBillEscPos(data) {
  // Column count comes from the device's Printers-tab setting (falls back to
  // 32, the classic 58mm width) so alignment matches the physical printer.
  const cfgCols = Number(data.columns)
  const LINE = Number.isFinite(cfgCols) && cfgCols >= 24 && cfgCols <= 64 ? cfgCols : 32
  const ESC = 0x1B, GS = 0x1D
  const parts = []
  const b = bytes => Buffer.from(bytes)
  const t = s => Buffer.from(s + '\n', 'utf8')
  const fmtNum = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  const center = s => {
    if (s.length >= LINE) return s.slice(0, LINE)
    return ' '.repeat(Math.floor((LINE - s.length) / 2)) + s
  }
  const cols = (left, right) => {
    const max = LINE - right.length - 1
    const l = left.length > max ? left.slice(0, Math.max(1, max)) : left
    return l + ' '.repeat(Math.max(1, LINE - l.length - right.length)) + right
  }
  const rule = '-'.repeat(LINE)
  const parse = line => ({
    text: line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/_(.+?)_/g, '$1').trim(),
    hasBold: /\*\*/.test(line),
  })

  // Init + center align
  parts.push(b([ESC, 0x40]))
  parts.push(b([ESC, 0x61, 0x01]))

  // Top template text (supports **bold** markers)
  for (const line of (data.topText || 'RECEIPT').split('\n')) {
    const { text, hasBold } = parse(line)
    if (hasBold) parts.push(b([ESC, 0x45, 0x01]))
    parts.push(t(center(text || '')))
    if (hasBold) parts.push(b([ESC, 0x45, 0x00]))
  }

  // Left-align body
  parts.push(b([ESC, 0x61, 0x00]))
  parts.push(t(rule))
  parts.push(t(`Server: ${data.server || ''}`))
  if (data.station) parts.push(t(`Station: ${data.station}`))
  parts.push(t(rule))
  parts.push(t(cols(`Order #: ${data.orderNo || ''}`, data.orderType || '')))
  if (data.tableName) parts.push(t(`Table: ${data.tableName}`))
  parts.push(t(rule))

  // Items
  for (const item of (data.items || [])) {
    parts.push(t(cols(`${item.qty} ${(item.name || '').toUpperCase()}`, fmtNum(item.unitPrice * item.qty))))
    if (item.notes) parts.push(t(`  > ${item.notes}`))
  }
  parts.push(t(rule))

  // Total in bold
  parts.push(b([ESC, 0x45, 0x01]))
  parts.push(t(cols('TOTAL:', `Rwf ${fmtNum(data.totalAmount || 0)}`)))
  parts.push(b([ESC, 0x45, 0x00]))
  parts.push(t(rule))

  // Center for order ref + datetime
  parts.push(b([ESC, 0x61, 0x01]))
  if (data.orderNo) parts.push(t(center(`>> ${data.orderNo} <<`)))
  if (data.dt) parts.push(t(center(data.dt)))

  // Bottom template text (supports **bold** markers)
  const bottomRaw = (data.bottomText && data.bottomText.trim())
    ? data.bottomText
    : 'Thank you for dining with us!'
  for (const line of bottomRaw.split('\n')) {
    const { text, hasBold } = parse(line)
    if (hasBold) parts.push(b([ESC, 0x45, 0x01]))
    parts.push(t(center(text || '')))
    if (hasBold) parts.push(b([ESC, 0x45, 0x00]))
  }
  parts.push(t(center('Powered by Magnify')))

  // Footer 2 — prints below "Powered by Magnify"; usually blank lines the
  // manager adds in the bill editor to push the footer past the cutter.
  if (data.footer2Text) {
    for (const line of String(data.footer2Text).split('\n')) {
      const { text, hasBold } = parse(line)
      if (hasBold) parts.push(b([ESC, 0x45, 0x01]))
      parts.push(t(center(text || '')))
      if (hasBold) parts.push(b([ESC, 0x45, 0x00]))
    }
  }

  // Feed + full cut.
  // 6 line feeds — was 4, but that left the last printed line (this footer) sitting right at the
  // cutter blade on some printers, so it got cut off and reappeared at the top of the next bill
  // instead of the bottom of this one. Extra feed gives it clearance to fully pass the blade first.
  parts.push(b([ESC, 0x61, 0x00]))
  parts.push(b([0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A]))
  parts.push(b([GS, 0x56, 0x00]))

  return Buffer.concat(parts)
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

  // printers:list — returns available system printers so the UI can map
  // each kitchen/bar station (and the bill printer) to a specific device.
  ipcMain.handle('printers:list', async () => {
    try {
      const wc = mainWindow?.webContents
      if (!wc) return []
      const printers = await wc.getPrintersAsync()
      return printers.map(p => ({
        name: p.name,
        displayName: p.displayName || p.name,
        isDefault: Boolean(p.isDefault),
      }))
    } catch (err) {
      appendStartupLog(`printers:list failed: ${err?.message || err}`)
      return []
    }
  })

  // print:receipt — creates a hidden BrowserWindow, loads HTML, and prints silently.
  // deviceName targets a specific printer; when empty the OS default printer is used.
  ipcMain.handle('print:receipt', (_event, html, deviceName) => {
    return new Promise((resolve, reject) => {
      const printWin = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      })
      let settled = false
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { if (!printWin.isDestroyed()) printWin.destroy() } catch {}
        fn(arg)
      }
      // Guard: never let a hung renderer/printer leave the job (and the hidden
      // window) stuck forever — reject after 20s so the UI can surface an error.
      const timer = setTimeout(() => finish(reject, new Error('Print timed out')), 20000)
      printWin.webContents.on('did-fail-load', (_e, code, desc) =>
        finish(reject, new Error(`Receipt load failed: ${desc} (${code})`)))
      printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      printWin.webContents.once('did-finish-load', async () => {
        const printOptions = { silent: true, printBackground: true, margins: { marginType: 'none' } }
        if (deviceName && typeof deviceName === 'string') printOptions.deviceName = deviceName
        // Bills (data-doc="bill") size the page snugly to their content plus a
        // small tail for the tear-off — no fixed minimum, so a short bill doesn't
        // feed a long blank strip of paper. The script returns the chosen page
        // height in mm (or null for non-bill docs e.g. kitchen tickets, which
        // keep their own fixed @page size).
        try {
          const heightMm = await printWin.webContents.executeJavaScript(`(function(){
            try {
              if (document.body.getAttribute('data-doc') !== 'bill') return null;
              var content = document.getElementById('bill-content');
              if (!content) return null;
              var PX_TO_MM = 25.4 / 96;
              // scrollHeight includes body padding; getBoundingClientRect only
              // gives the pre element's bottom, missing the 4mm bottom padding.
              // Add 35mm so the last line exits the print head (~20mm) before tear.
              var endMm = document.body.scrollHeight * PX_TO_MM;
              var h = Math.max(40, Math.ceil(endMm + 35));
              document.body.style.height = h + 'mm';
              var s = document.createElement('style');
              s.textContent = '@page{margin:0;size:80mm ' + h + 'mm}';
              document.head.appendChild(s);
              return h;
            } catch (e) { return null; }
          })()`)
          if (typeof heightMm === 'number' && isFinite(heightMm) && heightMm > 0) {
            // Electron pageSize is in microns (1mm = 1000µm).
            printOptions.pageSize = { width: 80000, height: Math.round(heightMm * 1000) }
          }
        } catch { /* fall back to the HTML's own @page size */ }
        printWin.webContents.print(
          printOptions,
          (success, errType) => {
            if (success) finish(resolve, { ok: true })
            else finish(reject, new Error(errType ?? 'print failed'))
          }
        )
      })
    })
  })

  // print:bill-raw — sends a structured bill as ESC/POS bytes over TCP to a
  // network thermal printer. Bypasses the Windows GDI driver so bold and
  // auto-cut work correctly without printer-driver configuration.
  // data: { ip, port, topText, bottomText, server, station, orderNo, orderType,
  //         tableName, dt, items[{qty,name,unitPrice,notes}], totalAmount }
  ipcMain.handle('print:bill-raw', async (_event, data) => {
    try {
      const { ip, port, ...billData } = data || {}
      if (!ip) return { ok: false, error: 'No printer IP configured' }
      const buffer = buildBillEscPos(billData)
      await printViaRawTcp(ip, parseInt(port) || 9100, buffer)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // get:config — preload reads this synchronously to inject window.electronConfig
  ipcMain.on('get:config', (event) => {
    event.returnValue = { apiBaseUrl, appVersion: app.getVersion() }
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null

const DEV_SERVER_PORTS = [5174, 5175, 5176, 5177, 5178]
const DEV_SERVER_TIMEOUT_MS = 15000
const DEV_SERVER_RETRY_MS = 300

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function canReachDevServer(url) {
  return new Promise(resolve => {
    const request = http.get(url, response => {
      response.resume()
      resolve(true)
    })

    request.on('error', () => resolve(false))
    request.setTimeout(1000, () => {
      request.destroy()
      resolve(false)
    })
  })
}

async function resolveDevServerUrl() {
  const configuredUrl = process.env.VITE_DEV_SERVER_URL
  const candidates = configuredUrl
    ? [configuredUrl]
    : DEV_SERVER_PORTS.map(port => `http://localhost:${port}`)

  const deadline = Date.now() + DEV_SERVER_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await canReachDevServer(candidate)) return candidate
    }
    await wait(DEV_SERVER_RETRY_MS)
  }

  return candidates[0]
}

// Global UI scale for the whole POS — shrinks every button, text and element
// uniformly so more fits on screen. 0.67 ≈ the "150→100" reduction. Tune here.
const UI_ZOOM = 0.67

async function createWindow() {
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

  mainWindow.webContents.on('did-finish-load', () => {
    appendStartupLog('Renderer did-finish-load')
    // Apply the global UI scale once the page is loaded (persists per load).
    mainWindow.webContents.setZoomFactor(UI_ZOOM)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) =>
    appendStartupLog(`Renderer did-fail-load code=${code} desc=${desc} url=${url}`))
  mainWindow.webContents.on('render-process-gone', (_e, details) =>
    appendStartupLog(`webContents render-process-gone reason=${details?.reason} exitCode=${details?.exitCode}`))
  mainWindow.on('unresponsive', () => appendStartupLog('Main window unresponsive'))

  // In development load Vite dev server; in production load built index.html
  if (!app.isPackaged) {
    const devUrl = await resolveDevServerUrl()
    appendStartupLog(`Loading dev server URL: ${devUrl}`)
    await mainWindow.loadURL(devUrl)
    mainWindow.webContents.openDevTools()
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist', 'index.html')
    appendStartupLog(`Loading file: ${indexPath}`)
    mainWindow.loadFile(indexPath)
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

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('update-available', (info) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send('update-status', `Downloading update v${info.version}…`)
      }
    })

    autoUpdater.on('update-downloaded', (info) => {
      const win = BrowserWindow.getAllWindows()[0]
      dialog.showMessageBox(win ?? undefined, {
        type: 'info',
        title: 'Update Ready',
        message: `Magnify POS v${info.version} is ready to install.`,
        detail: 'The app will restart to apply the update.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
    })

    autoUpdater.on('error', () => {
      // Network or GitHub error — silent, do not crash the app
    })

    autoUpdater.checkForUpdates().catch(() => {})
  } catch {
    // electron-updater not available in dev
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Single-instance lock — prevent multiple processes from spawning on one click
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Focus the existing window if a second instance is attempted
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    appendStartupLog(`=== Launch v${app.getVersion()} packaged=${app.isPackaged} platform=${process.platform} arch=${process.arch} ===`)
    try {
      loadRuntimeEnv()
      appendStartupLog(`Runtime env loaded. apiBaseUrl=${apiBaseUrl}`)
      initDatabase()
      appendStartupLog('Database initialized')
      registerIpcHandlers()
      await createWindow()
      appendStartupLog('Main window created')
      setupAutoUpdater()
    } catch (err) {
      appendStartupLog(`Startup failed: ${err?.stack || err?.message || err}`)
      throw err
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
