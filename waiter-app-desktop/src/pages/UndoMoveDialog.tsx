import { useEffect, useState } from 'react'
import { Loader2, Undo2, X, ArrowRight } from 'lucide-react'
import { getUndoableMoves, undoItemMove, getOrderItems, updateOrder, lineNetAmount, type ItemMove } from '../services/db'
import SupervisorPinDialog from './SupervisorPinDialog'

interface UndoMoveDialogProps {
  onClose: () => void
  // Bumped after a successful undo so the shell can refresh the pending list.
  onUndone: () => void
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : ''
}

// Take back a line that was moved to the wrong table.
//
// A move is approved by a supervisor, so taking one back is too: without that
// this dialog would be a way for anyone to quietly reverse a supervisor's
// decision from the nav bar.
//
// Only reversible moves are listed — getUndoableMoves leaves out anything
// already undone, and anything whose bills have since been settled, because
// putting a line back onto a bill the guest has already paid would change a
// figure that has left the building.
export default function UndoMoveDialog({ onClose, onUndone }: UndoMoveDialogProps) {
  const [moves, setMoves] = useState<ItemMove[] | null>(null)
  const [pending, setPending] = useState<ItemMove | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows = await getUndoableMoves()
        if (!cancelled) setMoves(rows)
      } catch (err) {
        if (!cancelled) { setMoves([]); setError((err as Error).message) }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Totals are rebuilt from each bill's own ACTIVE lines rather than by adding
  // the amount back: the same rule the rest of the till uses, so a reversed
  // move can never leave a bill quoting a figure its lines do not add up to.
  async function retotal(orderId: string) {
    const items = await getOrderItems(orderId)
    const subtotal = items
      .filter(i => i.status === 'ACTIVE')
      .reduce((sum, i) => sum + lineNetAmount(i), 0)
    await updateOrder(orderId, { subtotal_amount: subtotal, vat_amount: 0, total_amount: subtotal })
  }

  async function confirmUndo(approvedBy: string) {
    if (!pending) return
    try {
      const move = await undoItemMove(pending.id)
      await retotal(move.source_order_id)
      await retotal(move.target_order_id)
      setPending(null)
      onUndone()
      onClose()
    } catch (err) {
      setPending(null)
      setError(`${(err as Error).message}${approvedBy ? '' : ''}`)
      setMoves(await getUndoableMoves().catch(() => []))
    }
  }

  if (pending) {
    return (
      <SupervisorPinDialog
        title="Approve undo"
        prompt={`Put ${pending.dish_name} back on ${pending.source_order_number ?? 'its original bill'}. Enter the supervisor PIN to approve.`}
        confirmLabel="Approve"
        busyLabel="Undoing…"
        onClose={() => setPending(null)}
        onApproved={confirmUndo}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Undo2 className="h-4 w-4 text-blue-600" />
            <h3 className="font-bold text-gray-900">Undo a moved item</h3>
          </div>
          <button onClick={onClose}><X className="h-5 w-5 text-gray-400 hover:text-gray-600" /></button>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
            {error}
          </div>
        )}

        {moves === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm font-medium text-orange-600">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading moves…
          </div>
        ) : moves.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm font-semibold text-gray-600">Nothing to undo</p>
            <p className="mt-1 text-xs text-gray-400">
              No item has been moved between open bills. A move can only be taken back while both bills are still unpaid.
            </p>
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {moves.map(move => (
              <div key={move.id} className="rounded-xl border border-gray-200 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">
                      {move.dish_name}{Number(move.qty) > 1 ? ` ×${move.qty}` : ''}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
                      <span className="font-mono">{move.source_order_number ?? '—'}</span>
                      <ArrowRight className="h-3 w-3 flex-shrink-0" />
                      <span className="font-medium text-gray-700">{move.table_name}</span>
                      <span className="font-mono">({move.target_order_number ?? '—'})</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      {timeOf(move.moved_at)}{move.approved_by ? ` · approved by ${move.approved_by}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => { setError(null); setPending(move) }}
                    className="flex flex-shrink-0 items-center gap-1 rounded-xl border border-blue-300 px-3 py-1.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50">
                    <Undo2 className="h-3.5 w-3.5" /> Undo
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
