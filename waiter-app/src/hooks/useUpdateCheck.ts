import { useState, useEffect } from 'react'
import { API, APP_VERSION } from '../config'

function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const [lMaj, lMin, lPat] = parse(latest)
  const [cMaj, cMin, cPat] = parse(current)
  if (lMaj !== cMaj) return lMaj > cMaj
  if (lMin !== cMin) return lMin > cMin
  return lPat > cPat
}

export interface UpdateInfo {
  version: string
  downloadUrl: string
}

export function useUpdateCheck() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    if (!API.version) return
    let cancelled = false

    fetch(API.version)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data?.waiterAndroid?.version) return
        const { version, downloadUrl } = data.waiterAndroid
        if (isNewerVersion(version, APP_VERSION) && downloadUrl) {
          setUpdate({ version, downloadUrl })
        }
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [])

  return update
}
