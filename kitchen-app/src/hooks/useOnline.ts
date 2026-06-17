import { useState, useEffect } from 'react'
import { Network } from '@capacitor/network'

export function useOnline() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )

  useEffect(() => {
    let disposed = false

    void Network.getStatus()
      .then(s => { if (!disposed) setIsOnline(s.connected) })
      .catch(() => { /* fall back to navigator.onLine */ })

    let removeListener: (() => Promise<void>) | null = null
    void Network.addListener('networkStatusChange', s => {
      if (!disposed) setIsOnline(s.connected)
    }).then(handle => {
      removeListener = () => handle.remove()
    })

    const onOnline = () => { if (!disposed) setIsOnline(true) }
    const onOffline = () => { if (!disposed) setIsOnline(false) }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      disposed = true
      void removeListener?.()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  return { isOnline }
}
