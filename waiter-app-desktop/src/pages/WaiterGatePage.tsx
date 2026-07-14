import { useState, useEffect } from 'react'
import { Loader2, ArrowRight } from 'lucide-react'
import { getOrderCodeHolders } from '../services/db'
import { validateOrderCode } from '../services/sync'

interface WaiterGatePageProps {
  accountName: string
  // Bumps when a sync completes so the "no codes yet" state clears itself
  // once the first pull caches the waiter codes.
  syncVersion: number
  onUnlock: (waiterName: string) => void
}

// Opening page: shown on every launch (and after "Switch waiter") before any
// order can be taken. The waiter identifies themselves with their 4-digit
// order code so every order is attributed to the person who took it.
export default function WaiterGatePage({ accountName, syncVersion, onUnlock }: WaiterGatePageProps) {
  const [code,       setCode]       = useState('')
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [hasHolders, setHasHolders] = useState<boolean | null>(null)

  // Codes are cached locally by pullSync — if none exist yet (fresh install,
  // or the restaurant hasn't set waiter codes), offer the account fallback
  // instead of locking staff out.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const holders = await getOrderCodeHolders()
        if (!cancelled) setHasHolders(holders.length > 0)
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
      const { waiterName } = await validateOrderCode(nextCode)
      onUnlock(waiterName)
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
    <div className="h-screen flex flex-col bg-gray-900 overflow-hidden">

      {/* ── Magnify branding — top far-left ── */}
      <div className="flex items-center gap-2.5 px-5 py-4 flex-shrink-0">
        <div className="w-9 h-9 rounded-xl bg-orange-500 flex items-center justify-center shadow-lg shadow-orange-500/30 select-none">
          <span className="text-white font-black text-lg leading-none">M</span>
        </div>
        <span className="text-white font-extrabold text-lg tracking-tight select-none">Magnify</span>
        <span className="text-[10px] font-mono text-gray-500 leading-none select-none mt-1">
          v{(window as Window & { electronConfig?: { appVersion?: string } }).electronConfig?.appVersion || '?'}
        </span>
      </div>

      {/* ── Center card ── */}
      <div className="flex-1 flex items-center justify-center px-4 pb-10">
        <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl p-7 space-y-5">
          <div className="text-center space-y-1">
            <h1 className="text-xl font-extrabold text-gray-900">Welcome</h1>
            <p className="text-sm text-gray-500">Enter your waiter code to start taking orders.</p>
          </div>

          <input
            type="password"
            inputMode="none"
            readOnly
            maxLength={4}
            value={code}
            placeholder="● ● ● ●"
            className="w-full border border-gray-300 rounded-xl px-3 py-3 text-center text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-orange-400"
          />

          <div className="grid grid-cols-3 gap-2 max-w-[240px] mx-auto">
            {['1','2','3','4','5','6','7','8','9'].map(d => (
              <button key={d} type="button" disabled={saving}
                onClick={() => press(d)}
                className="py-3 rounded-xl border border-gray-300 text-xl font-semibold text-gray-800 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50">
                {d}
              </button>
            ))}
            <button type="button" disabled={saving}
              onClick={() => { setCode(''); setError(null) }}
              className="py-3 rounded-xl border border-gray-300 text-xs font-semibold text-gray-500 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50">
              Clear
            </button>
            <button type="button" disabled={saving}
              onClick={() => press('0')}
              className="py-3 rounded-xl border border-gray-300 text-xl font-semibold text-gray-800 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50">
              0
            </button>
            <button type="button" disabled={saving}
              onClick={() => setCode(c => c.slice(0, -1))}
              className="py-3 rounded-xl border border-gray-300 text-xl font-semibold text-gray-800 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50">
              ⌫
            </button>
          </div>

          {saving && (
            <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
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
              onClick={() => onUnlock(accountName)}
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
