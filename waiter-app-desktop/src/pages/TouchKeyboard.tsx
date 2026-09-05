// An on-screen keyboard that belongs to the app, not to Windows.
//
// The Windows touch keyboard closes the instant its input loses focus, and on
// these Windows 10 tills something was closing it after almost every keystroke
// — a waiter had to reopen it letter by letter to type a cancellation reason.
// Rather than keep negotiating with TabTip, the fields that matter stop asking
// for it at all: `readOnly` + `inputMode="none"` means Windows never sees an
// editable text field, so it has nothing to raise and nothing to dismiss. The
// order-code keypad has used that pair on these same terminals for months.
//
// The important property is that this keyboard does not depend on focus in any
// way. It is plain DOM that renders while a field is active and stops when the
// waiter taps Done. Nothing outside the app can take it away mid-word.
import { useEffect, useRef, useState } from 'react'
import { ArrowBigUp, Delete } from 'lucide-react'

export type TouchKeyboardLayout = 'text' | 'numeric'

const TEXT_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
]

const NUMERIC_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
]

type Props = {
  layout: TouchKeyboardLayout
  value: string
  onChange: (next: string) => void
  /** Dismisses the keyboard. The waiter is done with this field. */
  onDone: () => void
  maxLength?: number
}

export default function TouchKeyboard({ layout, value, onChange, onDone, maxLength }: Props) {
  // Shift is sticky for one letter, the way a phone keyboard behaves: a waiter
  // typing a customer's name wants the first letter capitalised and nothing
  // else. Caps lock (double tap) is there for the rare shouty note.
  const [shift, setShift] = useState(layout === 'text')
  const [caps,  setCaps]  = useState(false)

  const upper = shift || caps

  function append(char: string) {
    if (maxLength != null && value.length >= maxLength) return
    onChange(value + (upper ? char.toUpperCase() : char))
    if (shift && !caps) setShift(false)
  }

  function backspace() {
    onChange(value.slice(0, -1))
  }

  // onPointerDown only, and deliberately NOT onTouchStart + onMouseDown.
  //
  // A tap fires touchstart and then a synthesised mousedown, so handling both
  // typed every letter twice — on a touch screen only, which is the one place
  // it matters and the one place a mouse never reveals. preventDefault on
  // touchstart does not save it either: React attaches that event passively, so
  // the call is ignored and the synthesised mouse event still arrives.
  //
  // Pointer events fire once for both a finger and a mouse, and are not
  // passive, so preventDefault holds — which keeps the dialog from scrolling
  // under the waiter's thumb and stops any focus flicker on the way to a click.
  const press = (fn: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); fn() },
  })

  const keyClass =
    'flex-1 min-w-0 select-none rounded-lg border border-gray-300 bg-white py-3 text-lg font-semibold ' +
    'text-gray-800 shadow-sm active:bg-orange-100 active:border-orange-400'

  if (layout === 'numeric') {
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-2">
        <div className="mx-auto grid max-w-[260px] grid-cols-3 gap-1.5">
          {NUMERIC_ROWS.flat().map(d => (
            <button key={d} type="button" className={keyClass} {...press(() => append(d))}>
              {d}
            </button>
          ))}
          <button type="button" className={keyClass} {...press(backspace)} aria-label="Backspace">
            <Delete className="mx-auto h-5 w-5 text-gray-500" />
          </button>
          <button type="button" className={keyClass} {...press(() => append('0'))}>
            0
          </button>
          <button
            type="button"
            className="min-w-0 flex-1 select-none rounded-lg bg-orange-500 py-3 text-sm font-bold text-white shadow-sm active:bg-orange-600"
            {...press(onDone)}>
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5 rounded-xl border border-gray-200 bg-gray-50 p-2">
      {TEXT_ROWS.map((row, i) => (
        <div key={i} className="flex gap-1.5">
          {/* The short rows sit centred under the long ones, like a real
              keyboard, instead of stretching their keys to fill the width. */}
          {i >= 2 && <div className="w-5 flex-shrink-0" />}
          {i === 3 && (
            <button
              type="button"
              className={`${keyClass} max-w-[72px]`}
              {...press(() => { if (shift) { setCaps(c => !c); setShift(false) } else setShift(true) })}
              aria-label="Shift">
              <ArrowBigUp
                className={`mx-auto h-5 w-5 ${caps ? 'text-orange-600' : upper ? 'text-orange-500' : 'text-gray-500'}`}
                fill={caps ? 'currentColor' : 'none'}
              />
            </button>
          )}
          {row.map(k => (
            <button key={k} type="button" className={keyClass} {...press(() => append(k))}>
              {upper ? k.toUpperCase() : k}
            </button>
          ))}
          {i === 3 && (
            <button type="button" className={`${keyClass} max-w-[72px]`} {...press(backspace)} aria-label="Backspace">
              <Delete className="mx-auto h-5 w-5 text-gray-500" />
            </button>
          )}
          {i >= 2 && <div className="w-5 flex-shrink-0" />}
        </div>
      ))}
      <div className="flex gap-1.5">
        <button type="button" className={`${keyClass} max-w-[88px] text-sm`} {...press(() => append('.'))}>
          .
        </button>
        <button type="button" className={`${keyClass} text-sm`} {...press(() => append(' '))}>
          space
        </button>
        <button
          type="button"
          className="max-w-[120px] flex-1 select-none rounded-lg bg-orange-500 py-3 text-sm font-bold text-white shadow-sm active:bg-orange-600"
          {...press(onDone)}>
          Done
        </button>
      </div>
    </div>
  )
}

// A field that is typed with the keyboard above rather than with Windows'.
//
// readOnly + inputMode="none" is the whole trick: Chromium is told not to raise
// a virtual keyboard, and Windows is not shown an editable field to raise one
// for. Every terminal running this is touch-only, so nothing is lost by making
// the box unwritable by other means — the taps come from TouchKeyboard.
//
// Tapping the box activates it; the parent decides which single field is active
// so two keyboards can never be open at once.
export function TouchField({
  label, hint, value, onChange, layout, placeholder, maxLength,
  active, onActivate, onDone, masked = false, inputClassName = '',
}: {
  label: string
  hint?: React.ReactNode
  value: string
  onChange: (next: string) => void
  layout: TouchKeyboardLayout
  placeholder?: string
  maxLength?: number
  active: boolean
  onActivate: () => void
  onDone: () => void
  masked?: boolean
  inputClassName?: string
}) {
  // The box is never focused — that is the whole point — so nothing scrolls it
  // as the text grows past its width. A waiter writing a long reason would be
  // typing into a box that stopped showing what they typed, so keep the tail in
  // view by hand.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = inputRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [value])

  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-gray-600">{label}</label>
      <input
        ref={inputRef}
        type={masked ? 'password' : 'text'}
        inputMode="none"
        readOnly
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onPointerDown={e => { e.preventDefault(); onActivate() }}
        className={`w-full cursor-pointer rounded-xl border px-3 py-2.5 text-sm outline-none ${
          active ? 'border-orange-400 ring-2 ring-orange-200' : 'border-gray-300'
        } ${inputClassName}`}
      />
      {hint}
      {active && (
        <div className="mt-2">
          <TouchKeyboard
            layout={layout}
            value={value}
            onChange={onChange}
            onDone={onDone}
            maxLength={maxLength}
          />
        </div>
      )}
    </div>
  )
}
