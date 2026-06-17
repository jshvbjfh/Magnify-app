const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronPrinter', {
  listPrinters:      ()       => ipcRenderer.invoke('printer:list-system'),
  getSettings:       ()       => ipcRenderer.invoke('printer:get-settings'),
  saveSettings:      (s)      => ipcRenderer.invoke('printer:save-settings', s),
  printKitchenTicket:(data)   => ipcRenderer.invoke('printer:print-kitchen', data),
  printCustomerBill: (html)   => ipcRenderer.invoke('printer:print-bill', html),
  testPrint:         ()       => ipcRenderer.invoke('printer:test'),
})
