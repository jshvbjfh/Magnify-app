const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require('electron')

// Forces Windows to draw the native title bar (icon/text/min/max/close) in its
// dark-mode colors regardless of the user's system theme, so it stays black
// instead of following a light Windows theme.
nativeTheme.themeSource = 'dark'

// No native File/Edit/View menu — the POS UI is the whole app.
Menu.setApplicationMenu(null)
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
  branch_id TEXT,
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
  {
    // Station snapshot at order-creation time, so a dish reassigned to a
    // different station while an order sits open/unpaid can't retroactively
    // misattribute the sale. Migration 1's CREATE bakes it in on fresh
    // installs, so guard the ALTER for existing databases.
    version: 7,
    run: (database) => addColumnIfMissing(database, 'order_items', 'branch_id', 'TEXT'),
  },
  {
    // Shifts (service sessions) — a supervisor opens/closes the venue for the
    // day. Every order rung up while a shift is open is stamped with its id and
    // business_date, so a table paid after midnight still counts on the shift's
    // day. Kept local + synced to the server like orders.
    version: 8,
    sql: `
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  opened_at TEXT NOT NULL,
  opened_by_name TEXT,
  opened_by_staff_id TEXT,
  closed_at TEXT,
  closed_by_name TEXT,
  closed_by_staff_id TEXT,
  source_device_id TEXT,
  synced INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
    run: (database) => {
      addColumnIfMissing(database, 'orders', 'shift_id', 'TEXT')
      addColumnIfMissing(database, 'orders', 'business_date', 'TEXT')
    },
  },
  {
    // Covers: how many people sat at the table. The waiter can leave it blank,
    // so null means "not recorded" — the manager's average-per-cover skips
    // those orders rather than counting them as zero guests.
    version: 9,
    run: (database) => addColumnIfMissing(database, 'orders', 'guest_count', 'INTEGER'),
  },
  {
    // Credit (Accounts Receivable) settlement: who owes for the tab, and how to
    // reach them. The phone is optional — a name alone is often enough — so null
    // means "not taken", never "no phone".
    //
    // This is version 10 here but version 9 in the Android app: the two keep
    // their own local databases and their migration lists drifted when
    // guest_count was added here only. The columns are identical, which is what
    // the shared sync code actually depends on.
    version: 10,
    run: (database) => {
      addColumnIfMissing(database, 'orders', 'ar_customer_name', 'TEXT')
      addColumnIfMissing(database, 'orders', 'ar_customer_phone', 'TEXT')
    },
  },
  {
    // Which app took the order, and whether its kitchen tickets have reached
    // paper from THIS terminal.
    //
    // `source` is 'tablet' or 'desktop', stamped at creation and synced. The
    // tablet cannot print — no spooler, no raw socket, no print plugin — so a
    // ticket for an order it took never reaches the kitchen on its own. The
    // till uses this to find the pending orders that still need pushing. Null
    // on every order taken before this existed, which reads as "not from a
    // tablet": correct for history, and it stops the feature offering to
    // reprint the past.
    //
    // `tickets_pushed_at` is deliberately LOCAL and never synced — it records
    // that this terminal's printers produced the slips. Two tills at one venue
    // each keep their own answer, because paper coming out of one says nothing
    // about the other.
    //
    // Numbered 11, and it must stay above the AR migration for ever. Tills in
    // the field applied that 10 on 2026-08-17, before these branches met. The
    // runner skips anything at or below the highest version already recorded,
    // so a second migration claiming 10 is silently ignored and the app then
    // writes a column nothing created: "table orders has no column named
    // source", and sync stops. Numbers here are install history, not branch
    // history, and a number spent on any device can never be reused.
    version: 11,
    run: (database) => {
      addColumnIfMissing(database, 'orders', 'source', 'TEXT')
      addColumnIfMissing(database, 'orders', 'tickets_pushed_at', 'TEXT')
    },
  },
  {
    // Per-line discount, and the pointer left behind when one order is joined
    // into another.
    //
    // discount_percent is 0-100, set here against a supervisor PIN and printed
    // on the bill. Null everywhere it was never set, which every money path
    // reads as "no discount".
    //
    // merged_into_id names the order this one was absorbed into. The row stays,
    // its status becomes MERGED and its items move across, so the join is
    // auditable and an order number a guest was already quoted still resolves.
    //
    // 12 is the next free number on THIS app; Android numbers the same
    // migration 11, because this list gained guest_count that Android never
    // had. Never reuse a number a device has already recorded — doing so is
    // silently skipped, and the app then writes a column nothing created.
    version: 12,
    run: (database) => {
      addColumnIfMissing(database, 'order_items', 'discount_percent', 'REAL')
      addColumnIfMissing(database, 'orders', 'merged_into_id', 'TEXT')
    },
  },
  {
    // Supervisor standing, carried on the order code itself. 1 means this
    // person's 4-digit code unlocks every waiter's table on the Pending tab
    // rather than only their own.
    //
    // Defaults to 0, so a device that has not pulled since this shipped treats
    // everyone as an ordinary waiter — the locks stay on until the server says
    // otherwise, which is the safe direction to fail.
    version: 13,
    run: (database) => addColumnIfMissing(database, 'order_code_holders', 'is_supervisor', 'INTEGER NOT NULL DEFAULT 0'),
  },
  {
    // Settlement detail, and the numbered kitchen/bar slips.
    //
    // settled_by_name is who closed the bill when that is not simply the waiter
    // who took it — a supervisor settling another waiter's table. Never written
    // over created_by_name, which stays the waiter's, so the sale stays theirs.
    //
    // no_charge_reason / comped_amount belong to a 'No Charge' settlement: the
    // bill closes at zero, the reason is mandatory at the till, and the menu
    // value is kept here because the order's own totals are zeroed.
    //
    // kitchen_tickets records every slip fired at a station. seq restarts at 1
    // each business day per station and is assigned here, offline, because a
    // ticket must print the moment it is fired whether or not the internet is
    // up. synced=0 rows are pushed to the server so the manager sees the same
    // numbers the cooks are holding.
    version: 14,
    run: (database) => {
      addColumnIfMissing(database, 'orders', 'settled_by_name', 'TEXT')
      addColumnIfMissing(database, 'orders', 'no_charge_reason', 'TEXT')
      addColumnIfMissing(database, 'orders', 'comped_amount', 'REAL')
      database.exec(`
CREATE TABLE IF NOT EXISTS kitchen_tickets (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  branch_id TEXT,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  printed_at TEXT NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS kitchen_tickets_day_idx ON kitchen_tickets (branch_id, business_date, seq);
CREATE INDEX IF NOT EXISTS kitchen_tickets_synced_idx ON kitchen_tickets (synced);
`)
    },
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

// Send raw bytes to a locally-installed Windows printer queue (USB/serial
// thermal printers on the "Generic / Text Only" driver). The driver passes
// RAW-datatype jobs through untouched, so ESC/POS styling (font sizes, bold,
// barcodes, auto-cut) works exactly as it does over TCP. Delivery goes through
// a small PowerShell helper that P/Invokes winspool.drv — no native Node
// module, so nothing extra to rebuild or install with the app.
const RAW_PRINT_PS1 = `param([string]$PrinterName, [string]$DataFile, [string]$DocName = 'Magnify Receipt')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class MagnifyRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
  public static void Send(string printer, string file, string docName) {
    byte[] bytes = File.ReadAllBytes(file);
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("Printer not found: " + printer);
    try {
      DOCINFOA di = new DOCINFOA();
      di.pDocName = docName;
      di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        int written;
        bool ok = WritePrinter(h, bytes, bytes.Length, out written);
        EndPagePrinter(h);
        if (!ok || written != bytes.Length) throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
[MagnifyRawPrint]::Send($PrinterName, $DataFile, $DocName)
`

function printRawToWindowsQueue(printerName, buffer, docName = 'Magnify Bill') {
  return new Promise((resolve, reject) => {
    const os = require('os')
    const { execFile } = require('child_process')
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const scriptPath = path.join(os.tmpdir(), `magnify-rawprint-${stamp}.ps1`)
    const dataPath = path.join(os.tmpdir(), `magnify-bill-${stamp}.bin`)
    const cleanup = () => {
      try { fs.rmSync(scriptPath, { force: true }) } catch {}
      try { fs.rmSync(dataPath, { force: true }) } catch {}
    }
    try {
      fs.writeFileSync(scriptPath, RAW_PRINT_PS1, 'utf8')
      fs.writeFileSync(dataPath, buffer)
    } catch (err) {
      cleanup()
      return reject(err)
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
       '-File', scriptPath, '-PrinterName', printerName, '-DataFile', dataPath,
       '-DocName', docName],
      { timeout: 20000, windowsHide: true },
      (err, _stdout, stderr) => {
        cleanup()
        if (err) {
          // Surface the first PowerShell error line — it names the real cause
          // (printer offline, not found) instead of a generic exit code.
          const detail = String(stderr || '').split('\n').find(l => l.trim()) || err.message
          reject(new Error(detail.trim()))
        } else resolve()
      }
    )
  })
}

// Bill layout lives in its own module so the exact paper output can be
// rendered and checked with plain node — the doubled-character column math
// and the ASCII folding both had to be verified against real 58mm output.
const { buildBillEscPos, buildWidthRuler } = require('./billEscpos')
// Build a full ESC/POS byte sequence for one kitchen/bar ticket.
//
// Why this exists: tickets used to print only through Electron's GDI path
// (webContents.print of an HTML slip). A thermal printer installed on the
// "Generic / Text Only" driver — the same setup the bill already needed raw
// ESC/POS for — cannot render a GDI page at all: it feeds the paper and prints
// nothing. That is the blank-ticket bug. Kitchen tickets now take the identical
// raw path the bill takes, so the characters reach the printer directly.
//
// data: { branchName, station ('KITCHEN'|'BAR'), copy ('station'|'waiter'),
//         server, orderType, tableName, dateStr, timeStr, ticketNo, orderNo,
//         items[{qty,name,note}], columns }
function buildTicketEscPos(data) {
  const cfgCols = Number(data.columns)
  const LINE = Number.isFinite(cfgCols) && cfgCols >= 24 && cfgCols <= 64 ? cfgCols : 32
  const ESC = 0x1B, GS = 0x1D
  const parts = []
  const b = bytes => Buffer.from(bytes)
  const t = s => Buffer.from(s + '\n', 'utf8')

  const cols = (left, right, width = LINE) => {
    if (!right) return [left]
    if (left.length + 1 + right.length <= width) {
      return [left + ' '.repeat(width - left.length - right.length) + right]
    }
    const lines = []
    let rest = left
    while (rest.length > width) { lines.push(rest.slice(0, width)); rest = rest.slice(width) }
    if (rest && rest.length + 1 + right.length <= width) {
      lines.push(rest + ' '.repeat(width - rest.length - right.length) + right)
    } else {
      if (rest) lines.push(rest)
      lines.push(' '.repeat(Math.max(0, width - right.length)) + right)
    }
    return lines
  }
  const rule = '-'.repeat(LINE)
  const bold = on => b([ESC, 0x45, on ? 0x01 : 0x00])
  const size = n => b([GS, 0x21, n])
  const isWaiter = data.copy === 'waiter'
  const station = data.station === 'BAR' ? 'BAR' : 'KITCHEN'

  parts.push(b([ESC, 0x40]))          // init
  parts.push(b([ESC, 0x61, 0x01]))    // centre

  // Station name, double size — a cook reads this from across the pass.
  parts.push(size(0x11), bold(true))
  parts.push(t(String(data.branchName || 'KITCHEN').toUpperCase()))
  parts.push(size(0x00))
  parts.push(t(isWaiter ? '--- WAITER CHECKLIST ---' : `--- ${station} COPY ---`))
  parts.push(bold(false))

  // Body, left aligned
  parts.push(b([ESC, 0x61, 0x00]))
  parts.push(t(rule))
  parts.push(bold(true))
  for (const s of cols(`Server: ${data.server || '-'}`, station)) parts.push(t(s))
  parts.push(bold(false))
  parts.push(b([ESC, 0x61, 0x01]))
  parts.push(bold(true), t(data.orderType || 'Dine In'), bold(false))
  parts.push(b([ESC, 0x61, 0x00]))
  for (const s of cols(data.dateStr || '', data.timeStr || '')) parts.push(t(s))
  parts.push(t(rule))
  if (data.tableName) {
    // Table doubles in height: it is the one field that decides where the food goes.
    parts.push(bold(true), size(0x01))
    parts.push(t(`Table: ${data.tableName}`))
    parts.push(size(0x00), bold(false))
    parts.push(t(rule))
  }

  // Items — double height so they read at a glance on a busy pass. Doubled
  // characters occupy two columns, hence the halved wrap width.
  for (const item of (data.items || [])) {
    parts.push(bold(true), size(0x01))
    const label = `${isWaiter ? '[ ] ' : ''}${item.qty}x ${String(item.name || '').toUpperCase()}`
    for (const s of cols(label, '', Math.floor(LINE / 2))) parts.push(t(s))
    parts.push(size(0x00), bold(false))
    if (item.note) parts.push(t(`  > ${item.note}`))
  }
  parts.push(t(rule))

  // Ticket + order reference, centred.
  parts.push(b([ESC, 0x61, 0x01]))
  parts.push(t('*'.repeat(LINE)))
  parts.push(bold(true), size(0x01))
  // ticketNo already reads "KOT #0006" / "BOT #0002" — the station's own daily
  // slip number, assigned by the till. Older payloads sent a bare per-order
  // index, so those still get the "Ticket #:" caption they were written for.
  parts.push(t(/^(KOT|BOT) /.test(String(data.ticketNo ?? '')) ? String(data.ticketNo) : `Ticket #: ${data.ticketNo ?? ''}`))
  parts.push(size(0x00), bold(false))
  if (data.orderNo) parts.push(t(`Order #: ${data.orderNo}`))
  parts.push(t('*'.repeat(LINE)))

  // Feed past the tear bar, then full cut — same clearance the bill uses.
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

  // print:bill-raw — sends a structured bill as ESC/POS bytes, either over TCP
  // to a network thermal printer (data.ip) or straight into a local Windows
  // print queue as a RAW job (data.printerName — USB thermal printers on the
  // "Generic / Text Only" driver). Both bypass GDI rendering so font sizing,
  // bold, barcodes and auto-cut work without printer-driver configuration.
  // data: { ip?, port?, printerName?, topText, bottomText, server, station,
  //         orderNo, orderType, tableName, dt,
  //         items[{qty,name,unitPrice,notes}], totalAmount }
  // widthTest: true prints the column ruler instead — same transport, so staff
  // can find the printer's real character width from the Printers tab.
  ipcMain.handle('print:bill-raw', async (_event, data) => {
    try {
      const { ip, port, printerName, ...billData } = data || {}
      const buffer = billData.widthTest ? buildWidthRuler() : buildBillEscPos(billData)
      if (ip) await printViaRawTcp(ip, parseInt(port) || 9100, buffer)
      else if (printerName) await printRawToWindowsQueue(printerName, buffer, 'Magnify Bill')
      else return { ok: false, error: 'No printer configured' }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // print:ticket-raw — same raw delivery as the bill, for one kitchen/bar
  // ticket. Required on "Generic / Text Only" thermal printers, which print a
  // blank slip when handed a GDI-rendered page.
  ipcMain.handle('print:ticket-raw', async (_event, data) => {
    try {
      const { ip, port, printerName, ...ticketData } = data || {}
      const buffer = buildTicketEscPos(ticketData)
      if (ip) await printViaRawTcp(ip, parseInt(port) || 9100, buffer)
      else if (printerName) await printRawToWindowsQueue(printerName, buffer, 'Magnify Ticket')
      else return { ok: false, error: 'No printer configured' }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // get:config — preload reads this synchronously to inject window.electronConfig
  ipcMain.on('get:config', (event) => {
    event.returnValue = { apiBaseUrl, appVersion: app.getVersion() }
  })

  // app:quit — in-app Exit button. Goes through app.quit() so the
  // unsynced-orders before-quit guard still gets its say.
  ipcMain.on('app:quit', () => {
    app.quit()
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
    // Stay hidden until the window is maximized and painted — otherwise the
    // till flashes a small 1280x800 window for a beat before filling the screen.
    show: false,
    title: 'Magnify POS',
    icon: path.join(__dirname, '..', 'public', 'icon.ico'),
    backgroundColor: '#000000',
    // Strips the caption down to just the min/max/close buttons — no icon, no
    // title text. The app supplies its own draggable strip + branding in the
    // page itself (index.html drag div + header top-padding on each page).
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#000000',
      symbolColor: '#ffffff',
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  // Always open full-screen-sized. Field tills are opened by staff who never
  // resize the window, so a half-screen POS costs them buttons every shift.
  const showMaximized = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    mainWindow.maximize()
    mainWindow.show()
    mainWindow.focus()
  }
  mainWindow.once('ready-to-show', showMaximized)
  // Unsynced-orders check belongs here, while the window still exists: cancel
  // simply leaves the till open, so a declined quit can never strand the app as
  // a windowless process.
  mainWindow.on('close', (event) => {
    if (forceQuit || !db) return
    if (okToDiscardUnsynced(mainWindow)) {
      forceQuit = true
      return
    }
    event.preventDefault()
  })
  mainWindow.on('closed', () => {
    appendStartupLog('Main window closed')
    mainWindow = null
  })
  // The POS is only usable full-size, so "restore down" is never what staff
  // want — snap straight back. Covers the caption's restore button, a title-bar
  // double-click and a drag off the top edge. Minimize is left alone on purpose:
  // staff still need to reach the desktop, and it returns maximized.
  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.maximize()
  })
  // Safety net: if the page never reaches ready-to-show (dev server down, bad
  // build, blank load) the window would stay invisible forever with show:false.
  // Force it visible so the till shows an error page instead of nothing.
  setTimeout(showMaximized, 10000)
  mainWindow.webContents.on('did-fail-load', showMaximized)

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

// Orders left behind by a previous login belong to another restaurant, and
// pushSync filters those out on purpose — they can never reach the server, so
// counting them would block every quit for ever. Count only what this session
// can still push, exactly as the push does.
function countPushableUnsyncedOrders() {
  if (!db) return 0
  try {
    const restaurantId = db
      .prepare("SELECT value FROM restaurant_config WHERE key = 'restaurantId'")
      .get()?.value?.trim()
    return restaurantId
      ? db.prepare('SELECT COUNT(*) AS cnt FROM orders WHERE synced = 0 AND restaurant_id = ?').get(restaurantId)?.cnt ?? 0
      : db.prepare('SELECT COUNT(*) AS cnt FROM orders WHERE synced = 0').get()?.cnt ?? 0
  } catch {
    // If we can't query, never block the close.
    return 0
  }
}

// True when it's safe to go ahead and close. Synchronous on purpose: both
// 'close' and 'before-quit' only honour preventDefault() synchronously.
function okToDiscardUnsynced(win) {
  const unsyncedCount = countPushableUnsyncedOrders()
  if (unsyncedCount === 0) return true
  appendStartupLog(`Close requested with ${unsyncedCount} unsynced order(s) — prompting`)
  return dialog.showMessageBoxSync(win, {
    type: 'warning',
    title: 'Unsynced Orders',
    message: `You have ${unsyncedCount} unsynced order${unsyncedCount === 1 ? '' : 's'}.`,
    detail: 'They have not reached the server yet — quitting now risks losing them.',
    buttons: ['Cancel', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
  }) === 1
}

// Secondary net for quits that don't start at the window (auto-update restart,
// Windows shutdown). It prompts only while a live window can parent the dialog:
// with no window there is nothing to cancel back to, and blocking here is what
// stranded the process invisibly — the window is already destroyed by the time
// before-quit runs, so the prompt never appeared and the quit stayed cancelled.
app.on('before-quit', (event) => {
  if (forceQuit || !db) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  // Mark it settled here so the window close that follows this quit does not
  // ask the same question a second time.
  if (okToDiscardUnsynced(mainWindow)) {
    forceQuit = true
    return
  }
  event.preventDefault()
})

// ---------------------------------------------------------------------------
// Auto-updater (optional — gracefully skip if not configured)
// ---------------------------------------------------------------------------
function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater')

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    // Every updater event goes to startup.log — field tills have no console,
    // so this log is the only way to diagnose "the app doesn't update".
    // Routine checking/up-to-date lines log only once per run: with 5-minute
    // re-checks they would otherwise drown the log in hundreds of lines a day.
    let routineLogged = false
    autoUpdater.on('checking-for-update', () => {
      if (!routineLogged) appendStartupLog('Updater: checking for update')
    })
    autoUpdater.on('update-not-available', (info) => {
      if (!routineLogged) appendStartupLog(`Updater: up to date (latest is v${info?.version ?? '?'})`)
      routineLogged = true
    })

    let lastLoggedPct = 100
    autoUpdater.on('update-available', (info) => {
      appendStartupLog(`Updater: v${info.version} available — downloading`)
      lastLoggedPct = -25
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send('update-status', `Downloading update v${info.version}…`)
      }
    })

    // Coarse progress (quarter steps) so the log shows a stalled download
    // without growing unbounded.
    autoUpdater.on('download-progress', (p) => {
      const pct = Math.floor(p.percent)
      if (pct >= lastLoggedPct + 25) {
        lastLoggedPct = pct
        appendStartupLog(`Updater: downloading ${pct}%`)
      }
    })

    autoUpdater.on('update-downloaded', (info) => {
      appendStartupLog(`Updater: v${info.version} downloaded — prompting to restart`)
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

    autoUpdater.on('error', (err) => {
      // Network or GitHub error — log but never crash the app
      appendStartupLog(`Updater: error — ${err?.message || err}`)
    })

    const check = () => autoUpdater.checkForUpdates().catch(() => {})
    check()
    // Tills stay open across shifts, so a launch-only check misses releases
    // published while the app is running. Re-check every 5 minutes so new
    // releases reach the floor almost immediately.
    setInterval(check, 5 * 60 * 1000)
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
    // Bring the running till to the front. If its window is gone — closed while
    // the process stayed alive — rebuild one instead of doing nothing: a
    // windowless process still holds the single-instance lock, so every later
    // launch quits silently and the till looks dead while sitting in Task
    // Manager. Touching the destroyed window here also threw, so even the
    // focus attempt died before reaching show().
    if (!mainWindow || mainWindow.isDestroyed()) {
      appendStartupLog('second-instance: no live window — recreating')
      void createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isMaximized()) mainWindow.maximize()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
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
      // Never linger as an invisible process — it would keep the single-instance
      // lock and make every later launch quit without ever showing a window.
      try {
        dialog.showErrorBox('Magnify POS could not start', String(err?.message || err))
      } catch {}
      app.exit(1)
      return
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
