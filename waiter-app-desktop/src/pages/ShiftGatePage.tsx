import { useState, useEffect } from 'react'
import { Loader2, Power, Lock, PlayCircle, CheckCircle2, ArrowLeft } from 'lucide-react'
import { startShift } from '../services/shifts'
import { quitApp } from './WaiterGatePage'
import type { Shift } from '../services/db'

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function formatStarted(iso: string) {
  const d = new Date(iso)
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
}

interface ShiftGatePageProps {
  restaurantName: string
  onShiftStarted: () => void
}

type Stage = 'idle' | 'pin' | 'success'

// Shown before any orders can be taken when no shift is open. First a plain
// "Start Shift" button; pressing it asks for the supervisor code (the same code
// that approves order cancellations); on success it confirms the start time,
// then hands off to the waiter-code screen.
export default function ShiftGatePage({ restaurantName, onShiftStarted }: ShiftGatePageProps) {
  const [stage, setStage] = useState<Stage>('idle')
  const [code, setCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [startedShift, setStartedShift] = useState<Shift | null>(null)

  // After the success confirmation, move on to the waiter-code screen.
  useEffect(() => {
    if (stage !== 'success') return
    const t = setTimeout(() => onShiftStarted(), 1900)
    return () => clearTimeout(t)
  }, [stage, onShiftStarted])

  async function submit(nextCode: string) {
    if (nextCode.length !== 5 || saving) return
    setSaving(true)
    setError(null)
    try {
      const shift = await startShift(nextCode)
      setStartedShift(shift)
      setStage('success')
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
      // Supervisor/approver PIN is 5 digits (same code that cancels orders).
      const next = (current + digit).slice(0, 5)
      if (next.length === 5) void submit(next)
      return next
    })
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden relative">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('./pic/restaurant-bg.jpg')" }}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-black/50 via-black/40 to-black/50" />
      </div>

      {/* Branding top-left; Exit (quit) top-right — you quit from the closed state. */}
      <div className="relative z-10 flex items-center justify-between px-5 pt-12 pb-4 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <img src="./icon.png" alt="Magnify" className="w-9 h-9 rounded-xl object-contain shadow-lg shadow-orange-500/30 select-none" />
          <span className="text-white font-extrabold text-lg tracking-tight select-none">Magnify</span>
          <span className="text-[10px] font-mono text-gray-300/70 leading-none select-none mt-1">
            v{(window as Window & { electronConfig?: { appVersion?: string } }).electronConfig?.appVersion || '?'}
          </span>
        </div>
        <button type="button" onClick={quitApp}
          className="flex items-center gap-1.5 text-xs font-semibold text-gray-200/80 hover:text-white bg-white/10 hover:bg-white/20 border border-white/10 px-3.5 py-2 rounded-xl transition-colors">
          <Power className="h-3.5 w-3.5" />
          Exit
        </button>
      </div>

      <div className="relative z-10 flex-1 flex items-center justify-center px-4 pb-10">
        <div className="w-full max-w-sm bg-white backdrop-blur-md border border-white/20 rounded-3xl shadow-2xl p-8 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">

          {/* ── Stage 1: the Start Shift button ── */}
          {stage === 'idle' && (
            <>
              <div className="text-center space-y-2">
                <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
                  {greeting()}
                </h1>
                {restaurantName && <p className="text-base font-bold text-orange-600">{restaurantName}</p>}
                <p className="text-sm text-gray-500 font-medium">No shift is open yet. Start today's shift to begin taking orders.</p>
              </div>
              <button type="button" onClick={() => { setStage('pin'); setCode(''); setError(null) }}
                className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-orange-500 hover:bg-orange-600 text-white text-base font-bold shadow-lg shadow-orange-500/30 active:scale-[0.98] transition-all">
                <PlayCircle className="h-5 w-5" />
                Start Shift
              </button>
            </>
          )}

          {/* ── Stage 2: supervisor code ── */}
          {stage === 'pin' && (
            <>
              <div className="text-center space-y-2">
                <div className="mx-auto w-12 h-12 rounded-2xl bg-orange-50 border border-orange-200 flex items-center justify-center">
                  <Lock className="h-5 w-5 text-orange-500" />
                </div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
                  {greeting()}
                </h1>
                <p className="text-sm text-gray-500 font-medium">Enter the supervisor code to start the shift.</p>
              </div>

              <div className="flex justify-center gap-2">
                {[0, 1, 2, 3, 4].map(i => {
                  const filled = i < code.length
                  const isNext = i === code.length && !saving
                  return (
                    <div key={i}
                      className={`w-11 h-14 rounded-xl border-2 flex items-center justify-center text-2xl transition-all duration-150 ${
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
                  <Loader2 className="h-4 w-4 animate-spin" /> Starting shift…
                </div>
              )}
              {error && (
                <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 font-medium text-center">
                  {error}
                </div>
              )}

              <button type="button" disabled={saving}
                onClick={() => { setStage('idle'); setCode(''); setError(null) }}
                className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600 py-1 disabled:opacity-50">
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </button>
            </>
          )}

          {/* ── Stage 3: success confirmation ── */}
          {stage === 'success' && (
            <div className="text-center space-y-3 py-4 animate-in fade-in zoom-in-95 duration-300">
              <div className="mx-auto w-14 h-14 rounded-full bg-green-50 border border-green-200 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-green-600" />
              </div>
              <h1 className="text-2xl font-bold text-gray-900">Shift started</h1>
              {startedShift && (
                <p className="text-sm font-semibold text-gray-600">{formatStarted(startedShift.opened_at)}</p>
              )}
              {startedShift?.opened_by_name && (
                <p className="text-xs text-gray-400">by {startedShift.opened_by_name}</p>
              )}
              <div className="flex items-center justify-center gap-2 text-xs font-medium text-orange-600 pt-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening order screen…
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
