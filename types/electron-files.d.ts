interface ElectronFilesAPI {
  saveAndReveal: (filename: string, dataBase64: string) => Promise<{ ok: boolean; path?: string; reason?: string }>
}

declare global {
  interface Window {
    electronFiles?: ElectronFilesAPI
  }
}

export {}
