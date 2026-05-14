import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { initDB } from './services/db'
import {
  addAuthInvalidationListener,
  getTokenExpiryMs,
  getValidatedSession,
  logout,
} from './services/auth'
import {
  flushBufferedLogs,
  logError,
  logInfo,
  logWarn,
  normalizeErrorForLog,
} from './services/logger'
import LoginPage from './pages/LoginPage'
import StartupLogPage from './pages/StartupLogPage'
import WaiterShell from './pages/WaiterShell'
import type { WaiterUser } from './services/auth'
import './index.css'

const MAX_DB_ATTEMPTS = 4
const DB_RETRY_DELAY_MS = 800
const MAX_TIMEOUT_MS = 2_147_483_647

export default function App() {
  const [dbReady, setDbReady]   = useState(false)
  const [dbError, setDbError]   = useState(false)
  const [user, setUser]         = useState<WaiterUser | null>(null)
  const [showStartupLog, setShowStartupLog] = useState(false)
  const sessionExpiryTimerRef   = useRef<number | null>(null)

  const clearSessionExpiryTimer = useCallback(() => {
    if (sessionExpiryTimerRef.current == null) return

    window.clearTimeout(sessionExpiryTimerRef.current)
    sessionExpiryTimerRef.current = null
  }, [])

  const forceSignedOutState = useCallback(() => {
    clearSessionExpiryTimer()
    setUser(null)
  }, [clearSessionExpiryTimer])

  const scheduleSessionExpiry = useCallback((token: string) => {
    clearSessionExpiryTimer()

    const expiryMs = getTokenExpiryMs(token)
    if (expiryMs == null) {
      void logout().finally(() => setUser(null))
      return
    }

    const timeoutMs = expiryMs - Date.now()
    if (timeoutMs <= 0) {
      void logout().finally(() => setUser(null))
      return
    }

    const nextTimeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS)

    sessionExpiryTimerRef.current = window.setTimeout(() => {
      if (timeoutMs > MAX_TIMEOUT_MS) {
        scheduleSessionExpiry(token)
        return
      }

      void logout().finally(() => setUser(null))
    }, nextTimeoutMs)
  }, [clearSessionExpiryTimer])

  const hydrateStoredSession = useCallback(async () => {
    const storedSession = await getValidatedSession()

    if (!storedSession) {
      forceSignedOutState()
      return null
    }

    setUser(storedSession.user)
    scheduleSessionExpiry(storedSession.token)
    return storedSession.user
  }, [forceSignedOutState, scheduleSessionExpiry])

  const boot = useCallback(async () => {
    setDbError(false)
    setDbReady(false)
    await logInfo('startup', 'Boot sequence started', { maxAttempts: MAX_DB_ATTEMPTS })

    // Retry loop — Android SQLite plugin occasionally needs a moment on first launch
    let lastErr: unknown
    for (let attempt = 1; attempt <= MAX_DB_ATTEMPTS; attempt++) {
      try {
        await initDB()
        await flushBufferedLogs()
        await logInfo('startup', 'SQLite initialized', { attempt })
        const restoredUser = await hydrateStoredSession()
        if (restoredUser) {
          await logInfo('startup', 'Stored session restored', {
            userId: restoredUser.id,
            role: restoredUser.role,
            restaurantId: restoredUser.restaurantId,
            branchId: restoredUser.branchId,
          })
        } else {
          await logWarn('startup', 'No valid stored session found')
        }
        setDbReady(true)
        return
      } catch (err) {
        lastErr = err
        await logWarn('startup', 'Boot attempt failed', {
          attempt,
          error: normalizeErrorForLog(err),
        })
        if (attempt < MAX_DB_ATTEMPTS) {
          await new Promise(r => setTimeout(r, DB_RETRY_DELAY_MS * attempt))
        }
      }
    }

    console.error('DB init failed after retries:', lastErr)
    await logError('startup', 'DB init failed after retries', {
      error: normalizeErrorForLog(lastErr),
    })
    setDbError(true)
  }, [hydrateStoredSession])

  useEffect(() => { boot() }, [boot])

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      void logError('runtime', 'Unhandled window error', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: normalizeErrorForLog(event.error),
      })
    }

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      void logError('runtime', 'Unhandled promise rejection', {
        reason: normalizeErrorForLog(event.reason),
      })
    }

    window.addEventListener('error', handleWindowError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)

    return () => {
      window.removeEventListener('error', handleWindowError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = addAuthInvalidationListener(() => {
      forceSignedOutState()
    })

    return () => {
      unsubscribe()
      clearSessionExpiryTimer()
    }
  }, [clearSessionExpiryTimer, forceSignedOutState])

  useEffect(() => {
    if (!dbReady) return

    const revalidateStoredSession = () => {
      if (document.visibilityState === 'hidden') return
      void hydrateStoredSession()
    }

    window.addEventListener('focus', revalidateStoredSession)
    document.addEventListener('visibilitychange', revalidateStoredSession)

    return () => {
      window.removeEventListener('focus', revalidateStoredSession)
      document.removeEventListener('visibilitychange', revalidateStoredSession)
    }
  }, [dbReady, hydrateStoredSession])

  const handleLogin = useCallback(async () => {
    const restoredUser = await hydrateStoredSession()
    if (restoredUser) {
      await logInfo('auth', 'Session activated after login', {
        userId: restoredUser.id,
        restaurantId: restoredUser.restaurantId,
        branchId: restoredUser.branchId,
      })
    } else {
      await logWarn('auth', 'Post-login session hydration returned no stored user')
    }
  }, [hydrateStoredSession])

  const handleLogout = useCallback(async () => {
    await logInfo('auth', 'Manual logout requested', {
      userId: user?.id ?? null,
      restaurantId: user?.restaurantId ?? null,
      branchId: user?.branchId ?? null,
    })
    await logout()
    forceSignedOutState()
  }, [forceSignedOutState, user])

  if (dbError) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-red-500/20 flex items-center justify-center">
          <span className="text-red-400 font-black text-2xl">!</span>
        </div>
        <p className="text-white font-semibold">Could not start the database</p>
        <p className="text-gray-400 text-sm">Close and reopen the app. If it keeps failing, reinstall.</p>
        <button
          onClick={boot}
          className="flex items-center gap-2 mt-2 px-5 py-2.5 rounded-xl bg-orange-500 text-white text-sm font-semibold"
        >
          <RefreshCw className="h-4 w-4" />
          Try again
        </button>
      </div>
    )
  }

  if (!dbReady) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-orange-500 flex items-center justify-center shadow-lg shadow-orange-500/30">
          <span className="text-white font-black text-2xl">M</span>
        </div>
        <Loader2 className="h-6 w-6 animate-spin text-orange-400" />
        <p className="text-gray-400 text-sm">Starting Magnify…</p>
      </div>
    )
  }

  if (!user) {
    if (showStartupLog) {
      return <StartupLogPage onClose={() => setShowStartupLog(false)} />
    }

    return <LoginPage onLogin={handleLogin} onOpenLogs={() => setShowStartupLog(true)} />
  }

  return <WaiterShell user={user} onLogout={handleLogout} />
}
