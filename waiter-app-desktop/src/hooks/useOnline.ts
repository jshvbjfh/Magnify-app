import { useState, useEffect } from 'react'
import { getDeviceOnlineStatus, subscribeToDeviceOnlineStatus } from '../services/network'

export function useOnline() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine
  )

  useEffect(() => {
    let isDisposed = false

    void getDeviceOnlineStatus().then((status) => {
      if (!isDisposed) {
        setIsOnline(status)
      }
    })

    const unsubscribe = subscribeToDeviceOnlineStatus((status) => {
      if (!isDisposed) {
        setIsOnline(status)
      }
    })

    return () => {
      isDisposed = true
      unsubscribe()
    }
  }, [])

  return { isOnline }
}
