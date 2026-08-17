import { useState } from 'react'
import { Loader2, Power, Lock } from 'lucide-react'
import { startShift } from '../services/shifts'
import { quitApp } from './WaiterGatePage'
import { APP_VERSION } from '../config'

// Supervisor PINs exist in both 4-digit (legacy) and 5-digit (current) form.
// PIN_BOXES is display only — the row rests at 5 empty boxes because that is
// what the manager UI issues today, so a supervisor with a current PIN isn't
// told to enter four digits. It is deliberately NOT the submit threshold:
// MIN_PIN stays at 4 so a legacy 4-digit PIN can still open the shift (the
// 5th box simply goes unused), and the row grows to MAX_PIN as digits arrive.
const MIN_PIN = 4
const MAX_PIN = 6
const PIN_BOXES = 5

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

interface ShiftGatePageProps {
  restaurantName: string
  onShiftStarted: () => void
}

// Shown before any orders can be taken when no shift is open. A supervisor opens
// the day with their PIN (the same code that approves cancellations). Once open,
// the app moves on to the waiter-code screen.
export default function ShiftGatePage({ restaurantName, onShiftStarted }: ShiftGatePageProps) {
  const [code, setCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // This validates the supervisor's *cancellation* PIN (not the 4-digit order
  // code). The manager UI enforces 5 digits today, but PINs set before order
  // codes and cancellation PINs were split are 4 digits and still in use — so
  // accept any length in range and let bcrypt decide. Auto-submitting at a fixed
  // length would lock out whichever generation of PIN it didn't match.
  async function submit(nextCode: string) {
    if (nextCode.length < MIN_PIN || saving) return
    setSaving(true)
    setError(null)
    try {
      await startShift(nextCode)
      onShiftStarted()
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
    setCode(current => (current + digit).slice(0, MAX_PIN))
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
            v{APP_VERSION}
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

          <div className="text-center space-y-2">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-orange-50 border border-orange-200 flex items-center justify-center">
              <Lock className="h-5 w-5 text-orange-500" />
            </div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
              {greeting()}
            </h1>
            {restaurantName && <p className="text-base font-bold text-orange-600">{restaurantName}</p>}
            <p className="text-sm text-gray-500 font-medium">No shift is open. A supervisor must start today's shift.</p>
          </div>

          <div className="flex justify-center gap-3">
            {Array.from({ length: Math.max(PIN_BOXES, code.length) }, (_, i) => i).map(i => {
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

          <button type="button" disabled={saving || code.length < MIN_PIN}
            onClick={() => void submit(code)}
            className="w-full py-3.5 rounded-2xl bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:hover:bg-orange-500 text-white text-sm font-bold transition-colors active:scale-95">
            Start shift
          </button>

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

          <p className="text-center text-[11px] text-gray-400 font-medium">
            Enter the supervisor PIN to open the venue for the day.
          </p>
        </div>
      </div>
    </div>
  )
}
