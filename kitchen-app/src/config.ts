const SERVER_URL_KEY = 'kitchen_server_url'

export function getServerUrl(): string {
  return (localStorage.getItem(SERVER_URL_KEY) ?? '').trim().replace(/\/$/, '')
}

export function setServerUrl(url: string) {
  localStorage.setItem(SERVER_URL_KEY, url.trim().replace(/\/$/, ''))
}

export const API = {
  login: (): string => {
    const base = getServerUrl()
    return base ? `${base}/api/mobile/auth` : ''
  },
  pending: (): string => {
    const base = getServerUrl()
    return base ? `${base}/api/mobile/kitchen/pending` : ''
  },
  itemStatus: (id: string): string => {
    const base = getServerUrl()
    return base ? `${base}/api/mobile/kitchen/item/${id}` : ''
  },
}
