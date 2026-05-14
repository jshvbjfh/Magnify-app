import { Network } from '@capacitor/network'

function getBrowserOnlineStatus() {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine
}

export async function getDeviceOnlineStatus() {
  try {
    const status = await Network.getStatus()
    return Boolean(status.connected)
  } catch {
    return getBrowserOnlineStatus()
  }
}

export function subscribeToDeviceOnlineStatus(listener: (isOnline: boolean) => void) {
  const handleOnline = () => listener(true)
  const handleOffline = () => listener(false)

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
  }

  let removePluginListener: (() => void) | null = null

  void Network.addListener('networkStatusChange', (status) => {
    listener(Boolean(status.connected))
  }).then((handle) => {
    removePluginListener = () => {
      void handle.remove()
    }
  }).catch(() => {
    removePluginListener = null
  })

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }

    removePluginListener?.()
  }
}