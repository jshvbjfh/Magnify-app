import { useState } from 'react'
import { Loader2, X, ShieldAlert } from 'lucide-react'
import { validateCancellationPinOffline } from '../services/sync'

// Supervisor PINs exist in both 4-digit (legacy) and 5-digit (current) form.
// PIN_BOXES is display only — the row rests at 5 empty boxes to match the PIN
// the manager UI issues today. MIN_PIN stays the submit threshold so a legacy
// 4-digit PIN still works. Keep in step with ShiftGatePage and EndShiftDialog.
const MIN_PIN = 4
const MAX_PIN = 6
const PIN_BOXES = 5

interface SupervisorPinDialogProps {
  title: string
  prompt: string
  confirmLabel: string
  busyLabel: string
  onClose: () => void
  onApproved: (approvedBy: string) => Promise<void> | void
}

// Generic supervisor-approval gate: validates the same cancellation PIN that
// approves cancelled orders and opens/closes shifts, offline against the bcrypt
// hashes cached by the last pull. Used to guard actions a waiter should not be
// able to take alone — currently signing the device out.
export default function SupervisorPinDialog({
  title, prompt, confirmLabel, busyLabel, onClose, onApproved,
}: SupervisorPinDialogProps) {
  const [code, setCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(nextCode: string) {
    if (nextCode.length < MIN_PIN || saving) return
    setSaving(true)
    setError(null)
    try {
      const { approvedBy } = await validateCancellationPinOffline(nextCode)
      await onApproved(approvedBy)
    } catch (err) {
      setCode('')
      setError((err as Error).message)
      setSaving(false)
    }
    // Deliberately no finally: on success the caller unmounts this dialog, so
    // clearing `saving` would set state on a gone component.
  }

  function press(digit: string) {
    if (saving) return
    setError(null)
    setCode(current => (current + digit).slice(0, MAX_PIN))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl p-7 space-y-5 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-red-500" />
            <h2 className="text-lg font-bold text-gray-900">{title}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={saving}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-sm text-gray-500 font-medium text-center">{prompt}</p>

        <div className="flex justify-center gap-3">
          {Array.from({ length: Math.max(PIN_BOXES, code.length) }, (_, i) => i).map(i => {
            const filled = i < code.length
            return (
              <div key={i}
                className={`w-11 h-13 rounded-xl border-2 flex items-center justify-center text-xl py-2.5 transition-all ${
                  filled ? 'border-orange-500 bg-orange-50 text-orange-500' : 'border-orange-200 bg-gray-50'
                }`}>
                {filled ? '●' : ''}
              </div>
            )
          })}
        </div>

        <div className="grid grid-cols-3 gap-2 max-w-[240px] mx-auto">
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <button key={d} type="button" disabled={saving}
              onClick={() => press(d)}
              className="py-3 rounded-2xl border border-gray-200 bg-gray-50 text-xl font-bold text-gray-800 hover:bg-orange-50 hover:border-orange-200 hover:text-orange-600 active:scale-95 transition-all disabled:opacity-50">
              {d}
            </button>
          ))}
          <button type="button" disabled={saving}
            onClick={() => { setCode(''); setError(null) }}
            className="py-3 rounded-2xl border border-gray-200 bg-gray-50 text-xs font-bold text-gray-400 hover:bg-gray-100 active:scale-95 transition-all disabled:opacity-50">
            Clear
          </button>
          <button type="button" disabled={saving}
            onClick={() => press('0')}
            className="py-3 rounded-2xl border border-gray-200 bg-gray-50 text-xl font-bold text-gray-800 hover:bg-orange-50 hover:border-orange-200 hover:text-orange-600 active:scale-95 transition-all disabled:opacity-50">
            0
          </button>
          <button type="button" disabled={saving}
            onClick={() => setCode(c => c.slice(0, -1))}
            className="py-3 rounded-2xl border border-gray-200 bg-gray-50 text-xl font-bold text-gray-400 hover:bg-gray-100 active:scale-95 transition-all disabled:opacity-50">
            ⌫
          </button>
        </div>

        <button type="button" disabled={saving || code.length < MIN_PIN}
          onClick={() => void submit(code)}
          className="w-full py-3 rounded-2xl bg-red-500 hover:bg-red-600 disabled:opacity-40 disabled:hover:bg-red-500 text-white text-sm font-bold transition-colors active:scale-95">
          {confirmLabel}
        </button>

        {saving && (
          <div className="flex items-center justify-center gap-2 text-sm font-medium text-orange-600">
            <Loader2 className="h-4 w-4 animate-spin" /> {busyLabel}
          </div>
        )}
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 font-medium text-center">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
