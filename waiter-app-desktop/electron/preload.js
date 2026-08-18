const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronDB', {
  /**
   * Run a statement that modifies data (INSERT/UPDATE/DELETE/CREATE).
   * Returns { changes, lastInsertRowid }.
   * @param {string} sql
   * @param {unknown[]} params
   */
  run: (sql, params) => ipcRenderer.invoke('db:run', sql, params),

  /**
   * Query rows. Returns array of row objects.
   * @param {string} sql
   * @param {unknown[]} params
   */
  query: (sql, params) => ipcRenderer.invoke('db:query', sql, params),

  /**
   * Execute a batch of statements in a single transaction.
   * @param {{ statement: string; values: unknown[] }[]} statements
   */
  executeSet: (statements) => ipcRenderer.invoke('db:executeSet', statements),
})

contextBridge.exposeInMainWorld('electronHttp', {
  request: (options) => ipcRenderer.invoke('http:request', options),
})

// Pull config synchronously from main (main sets it via ipcMain.on before window loads)
let resolvedApiBaseUrl = ''
let resolvedAppVersion = ''
try {
  const config = ipcRenderer.sendSync('get:config')
  if (config && config.apiBaseUrl) {
    resolvedApiBaseUrl = config.apiBaseUrl
  }
  if (config && config.appVersion) {
    resolvedAppVersion = config.appVersion
  }
} catch {
  // config injection failed — config.ts will fall back to VITE_API_BASE_URL
}

contextBridge.exposeInMainWorld('electronConfig', { apiBaseUrl: resolvedApiBaseUrl, appVersion: resolvedAppVersion })

contextBridge.exposeInMainWorld('electronApp', {
  // Quit goes through app.quit() so the unsynced-orders guard can intervene.
  quit: () => ipcRenderer.send('app:quit'),
})

contextBridge.exposeInMainWorld('electronPrint', {
  receipt: (html, deviceName) => ipcRenderer.invoke('print:receipt', html, deviceName),
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  printBillRaw: (data) => ipcRenderer.invoke('print:bill-raw', data),
  printTicketRaw: (data) => ipcRenderer.invoke('print:ticket-raw', data),
})
