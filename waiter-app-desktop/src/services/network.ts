// Desktop network detection — uses browser navigator.onLine + window events.
// Replaces the @capacitor/network dependency used in the Android waiter-app.

export async function getDeviceOnlineStatus(): Promise<boolean> {
  return navigator.onLine
}

export function subscribeToDeviceOnlineStatus(
  listener: (online: boolean) => void,
): () => void {
  const onOnline = () => listener(true)
  const onOffline = () => listener(false)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  return () => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  }
}
