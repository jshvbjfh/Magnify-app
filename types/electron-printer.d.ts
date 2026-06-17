interface ElectronPrinterAPI {
  listPrinters: () => Promise<{ name: string; isDefault: boolean }[]>
  getSettings: () => Promise<{
    enabled: boolean
    type: 'system' | 'network'
    printerName: string
    networkHost: string
    networkPort: number
  }>
  saveSettings: (s: object) => Promise<boolean>
  printKitchenTicket: (data: object) => Promise<{ ok: boolean; reason?: string }>
  printCustomerBill: (html: string) => Promise<{ ok: boolean; reason?: string }>
  testPrint: () => Promise<{ ok: boolean; reason?: string }>
}

declare global {
  interface Window {
    electronPrinter?: ElectronPrinterAPI
  }
}

export {}
