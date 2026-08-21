import { useState, useEffect } from 'react'
import { Loader2, ArrowRight, LogOut } from 'lucide-react'
import { getConfig, getOrderCodeHolders } from '../services/db'
import { validateOrderCode } from '../services/sync'
import EndShiftDialog from './EndShiftDialog'

export function quitApp() {
  const bridge = (window as Window & { electronApp?: { quit: () => void } }).electronApp
  if (bridge?.quit) bridge.quit()
  else window.close()
}

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

interface WaiterGatePageProps {
  accountName: string
  // Bumps when a sync completes so the "no codes yet" state clears itself
  // once the first pull caches the waiter codes.
  syncVersion: number
  // False when the venue does not run service shifts: there is no shift to end,
  // so the button is replaced by Exit (quit the app) as on the start-shift screen.
  shiftsEnabled: boolean
  // supervisor: this code belongs to a manager / supervisor-PIN holder, who may
  // act on every waiter's table rather than only their own.
  onUnlock: (waiterName: string, supervisor: boolean) => void
  // Called after a supervisor closes the shift — the shell then returns to the
  // start-shift screen.
  onShiftEnded: () => void
}

// Opening page: shown on every launch (and after "Switch waiter") before any
// order can be taken. The waiter identifies themselves with their 4-digit
// order code so every order is attributed to the person who took it.
export default function WaiterGatePage({ accountName, syncVersion, shiftsEnabled, onUnlock, onShiftEnded }: WaiterGatePageProps) {
  const [code,       setCode]       = useState('')
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [hasHolders, setHasHolders] = useState<boolean | null>(null)
  const [restaurantName, setRestaurantName] = useState<string>('')
  const [showEndShift, setShowEndShift] = useState(false)

  // Codes are cached locally by pullSync — if none exist yet (fresh install,
  // or the restaurant hasn't set waiter codes), offer the account fallback
  // instead of locking staff out.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [holders, name] = await Promise.all([getOrderCodeHolders(), getConfig('restaurantName')])
        if (cancelled) return
        setHasHolders(holders.length > 0)
        setRestaurantName(name?.trim() || '')
      } catch {
        if (!cancelled) setHasHolders(false)
      }
    })()
    return () => { cancelled = true }
  }, [syncVersion])

  async function submit(nextCode: string) {
    if (nextCode.length !== 4 || saving) return
    setSaving(true)
    setError(null)
    try {
      const { waiterName, supervisor } = await validateOrderCode(nextCode)
      onUnlock(waiterName, supervisor)
    } catch (err) {
      setCode('')
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  function press(digit: string) {
    if (saving) return
    setError(null)
    setCode(current => {
      const next = (current + digit).slice(0, 4)
      // Auto-submit on the 4th digit — one less tap per shift start.
      if (next.length === 4) void submit(next)
      return next
    })
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden relative">

      {/* Background photo — same treatment as the login page */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('./pic/restaurant-bg.jpg')" }}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-black/50 via-black/40 to-black/50" />
      </div>

      {/* ── Magnify branding — top far-left; Exit — top far-right ── */}
      <div className="relative z-10 flex items-center justify-between px-5 pt-12 pb-4 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <img src="./icon.png" alt="Magnify" className="w-9 h-9 rounded-xl object-contain shadow-lg shadow-orange-500/30 select-none" />
          <span className="text-white font-extrabold text-lg tracking-tight select-none">Magnify</span>
          <span className="text-[10px] font-mono text-gray-300/70 leading-none select-none mt-1">
            v{(window as Window & { electronConfig?: { appVersion?: string } }).electronConfig?.appVersion || '?'}
          </span>
        </div>
        {shiftsEnabled ? (
          <button type="button" onClick={() => setShowEndShift(true)}
            className="flex items-center gap-1.5 text-xs font-semibold text-white bg-red-600/90 hover:bg-red-600 border border-red-500/40 px-3.5 py-2 rounded-xl transition-colors">
            <LogOut className="h-3.5 w-3.5" />
            End Shift
          </button>
        ) : (
          <button type="button" onClick={quitApp}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-200/80 hover:text-white bg-white/10 hover:bg-white/20 border border-white/10 px-3.5 py-2 rounded-xl transition-colors">
            <LogOut className="h-3.5 w-3.5" />
            Exit
          </button>
        )}
      </div>

      {showEndShift && (
        <EndShiftDialog
          onClose={() => setShowEndShift(false)}
          onEnded={() => { setShowEndShift(false); onShiftEnded() }}
        />
      )}

      {/* ── Center card — same design language as the login page ── */}
      <div className="relative z-10 flex-1 flex items-center justify-center px-4 pb-10">
        <div className="w-full max-w-sm bg-white backdrop-blur-md border border-white/20 rounded-3xl shadow-2xl p-8 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">

          <div className="text-center space-y-2">
            <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
              {greeting()}
            </h1>
            {restaurantName && (
              <p className="text-base font-bold text-orange-600">{restaurantName}</p>
            )}
            <p className="text-sm text-gray-500 font-medium">Enter your waiter code to start taking orders.</p>
          </div>

          {/* Code cells — fill up as digits are typed */}
          <div className="flex justify-center gap-3">
            {[0, 1, 2, 3].map(i => {
              const filled = i < code.length
              const isNext = i === code.length && !saving
              return (
                <div key={i}
                  className={`w-12 h-14 rounded-xl border-2 flex items-center justify-center text-2xl transition-all duration-150 ${
                    filled
                      ? 'border-orange-500 bg-orange-50 text-orange-500 scale-105'
                      : isNext
                        ? 'border-orange-400 bg-white shadow-sm'
                        : 'border-orange-200 bg-gray-50'
                  }`}>
                  {filled ? '●' : ''}
                </div>
              )
            })}
          </div>

          <div className="grid grid-cols-3 gap-2 max-w-[250px] mx-auto">
            {['1','2','3','4','5','6','7','8','9'].map(d => (
              <button key={d} type="button" disabled={saving}
                onClick={() => press(d)}
                className="py-3.5 rounded-2xl border border-gray-200 bg-gray-50 text-xl font-bold text-gray-800 hover:bg-orange-50 hover:border-orange-200 hover:text-orange-600 active:scale-95 transition-all disabled:opacity-50">
                {d}
              </button>
            ))}
            <button type="button" disabled={saving}
              onClick={() => { setCode(''); setError(null) }}
              className="py-3.5 rounded-2xl border border-gray-200 bg-gray-50 text-xs font-bold text-gray-400 hover:bg-gray-100 hover:text-gray-600 active:scale-95 transition-all disabled:opacity-50">
              Clear
            </button>
            <button type="button" disabled={saving}
              onClick={() => press('0')}
              className="py-3.5 rounded-2xl border border-gray-200 bg-gray-50 text-xl font-bold text-gray-800 hover:bg-orange-50 hover:border-orange-200 hover:text-orange-600 active:scale-95 transition-all disabled:opacity-50">
              0
            </button>
            <button type="button" disabled={saving}
              onClick={() => setCode(c => c.slice(0, -1))}
              className="py-3.5 rounded-2xl border border-gray-200 bg-gray-50 text-xl font-bold text-gray-400 hover:bg-gray-100 hover:text-gray-600 active:scale-95 transition-all disabled:opacity-50">
              ⌫
            </button>
          </div>

          {saving && (
            <div className="flex items-center justify-center gap-2 text-sm font-medium text-orange-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking code…
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 font-medium text-center">
              {error}
            </div>
          )}

          {hasHolders === false && (
            <button type="button" disabled={saving}
              onClick={() => onUnlock(accountName, false)}
              className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-700 py-2 disabled:opacity-50">
              No waiter codes set up yet — continue as {accountName || 'this account'}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
