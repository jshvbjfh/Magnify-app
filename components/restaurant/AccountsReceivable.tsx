'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, X, CheckCircle } from 'lucide-react'

// Where a credit sale came from. 'order' is a bill put on a tab at the till,
// 'buffet' the hotel's breakfast lines, 'manual' a debt typed in below.
type ReceivableSource = 'manual' | 'order' | 'buffet'

interface CreditItem {
  id: string
  source: ReceivableSource
  description: string
  amount: number
  saleDate: string
}

const SOURCE_BADGE: Record<ReceivableSource, { label: string; className: string }> = {
  order: { label: 'Tab', className: 'bg-blue-50 text-blue-600' },
  buffet: { label: 'Buffet', className: 'bg-amber-50 text-amber-700' },
  manual: { label: 'Manual', className: 'bg-gray-100 text-gray-500' },
}

interface ClientRow {
  customerName: string
  customerPhone: string | null
  totalOwed: number
  openCount: number
  lastActivityAt: string
  items: CreditItem[]
}

interface SummaryData {
  receivables: ClientRow[]
  totalUnpaid: number
  clientCount: number
  openCount: number
}

// How the money actually came in. Every one of these maps to a real settlement
// account through normalizePaymentMethod, so what the manager picks here is what
// the ledger debits — Owner Momo lands on 1021, not lumped in with Mobile Money.
const PAYMENT_METHODS = ['Cash', 'Mobile Money', 'Owner Momo', 'Card', 'Bank Transfer']

function agingLabel(firstItemDate: string): { label: string; color: string } {
  const days = Math.floor((Date.now() - new Date(firstItemDate).getTime()) / 86400000)
  if (days <= 30) return { label: 'Current', color: 'text-green-600 bg-green-50' }
  if (days <= 60) return { label: '31–60 days', color: 'text-yellow-600 bg-yellow-50' }
  if (days <= 90) return { label: '61–90 days', color: 'text-orange-600 bg-orange-50' }
  return { label: 'Over 90 days', color: 'text-red-600 bg-red-50' }
}

function daysOutstanding(date: string) {
  return Math.floor((Date.now() - new Date(date).getTime()) / 86400000)
}

function fmt(amount: number) {
  return `${amount.toLocaleString('en-RW')} RWF`
}

function fmtDate(date: string) {
  return new Intl.DateTimeFormat('en-RW', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(date))
}

function relativeTime(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function AccountsReceivable() {
  const [data, setData] = useState<SummaryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [payMethod, setPayMethod] = useState(PAYMENT_METHODS[0])
  const [confirming, setConfirming] = useState(false)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [payError, setPayError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ clientName: '', customerPhone: '', amount: '', date: new Date().toISOString().slice(0, 10), description: '' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/accounts-receivable')
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Reset selected client if they disappear after refresh
  useEffect(() => {
    if (!data || selectedName === null) return
    if (!data.receivables.find(r => r.customerName === selectedName)) setSelectedName(null)
  }, [data, selectedName])

  const selected = data?.receivables.find(r => r.customerName === selectedName) ?? null

  async function confirmPayment(itemId: string) {
    setConfirming(true)
    setPayError(null)
    try {
      const res = await fetch('/api/accounts-receivable', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: itemId, paymentMethod: payMethod }),
      })
      if (!res.ok) {
        // Silence here used to leave the button looking like it worked while
        // the debt stayed open — most often because someone else collected it
        // first.
        const payload = await res.json().catch(() => null)
        setPayError(payload?.error || 'Could not record the payment')
        return
      }
      setFlashId(itemId)
      setPayingId(null)
      // Long enough to actually register that it worked before the row vanishes
      // from under the cursor. 800ms read as a flicker.
      setTimeout(async () => {
        setFlashId(null)
        await load()
      }, 1800)
    } finally {
      setConfirming(false)
    }
  }

  async function submitForm() {
    setFormError(null)
    if (!form.clientName.trim()) { setFormError('Client name is required'); return }
    if (!form.amount || isNaN(parseFloat(form.amount))) { setFormError('Valid amount is required'); return }
    setSubmitting(true)
    try {
      const res = await fetch('/api/accounts-receivable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientName: form.clientName, customerPhone: form.customerPhone, amount: form.amount, date: form.date, description: form.description }),
      })
      if (!res.ok) { setFormError('Failed to record credit sale'); return }
      // Name the client and the amount back. The form closes and the row joins a
      // list that may be long enough to scroll, so "saved" on its own leaves the
      // manager hunting for proof the debt was actually written down.
      const clientName = form.clientName.trim()
      const recorded = `${clientName} owes ${fmt(parseFloat(form.amount))}`
      setForm({ clientName: '', customerPhone: '', amount: '', date: new Date().toISOString().slice(0, 10), description: '' })
      setShowForm(false)
      setSuccess(recorded)
      // Select only AFTER the reload. Naming the client while the list is still
      // the old one trips the "client disappeared" guard below, which would
      // clear the selection before the new row ever arrives.
      await load()
      setSelectedName(clientName)
      window.setTimeout(() => setSuccess(null), 4000)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Summary cards + add button */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex gap-3 flex-wrap">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-5 py-3 min-w-[160px]">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">Total Outstanding</p>
            <p className="mt-1 text-2xl font-bold text-blue-700">{fmt(data?.totalUnpaid ?? 0)}</p>
          </div>
          <div className="rounded-xl border bg-white px-5 py-3 min-w-[130px]">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Clients Owing</p>
            <p className="mt-1 text-2xl font-bold text-gray-800">{data?.clientCount ?? 0}</p>
          </div>
          <div className="rounded-xl border bg-white px-5 py-3 min-w-[160px]">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Credit Sales Open</p>
            <p className="mt-1 text-2xl font-bold text-gray-800">{data?.openCount ?? 0}</p>
          </div>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {showForm ? 'Cancel' : 'Add Credit Sale'}
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-gray-700">Record Credit Sale</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Client Name *</label>
              <input className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" value={form.clientName} onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))} placeholder="e.g. John Doe" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Phone (optional)</label>
              <input className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" value={form.customerPhone} onChange={e => setForm(f => ({ ...f, customerPhone: e.target.value }))} placeholder="e.g. 078..." />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Amount (RWF) *</label>
              <input type="number" min="0" className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Date</label>
              <input type="date" className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-600">Description (optional)</label>
              <input className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="e.g. Grilled chicken, coconut juice..." />
            </div>
          </div>
          {formError && <p className="mt-2 text-xs text-red-600">{formError}</p>}
          <div className="mt-4 flex gap-2">
            <button onClick={submitForm} disabled={submitting} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
              {submitting ? 'Recording…' : 'Record Credit'}
            </button>
            <button onClick={() => { setShowForm(false); setFormError(null) }} className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          </div>
        </div>
      )}

      {/* Confirmation that the debt was written down */}
      {success && (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5">
          <CheckCircle className="h-4 w-4 flex-shrink-0 text-green-600" />
          <p className="text-sm font-medium text-green-800">Credit sale recorded — {success}</p>
        </div>
      )}

      {/* Loading — say what is coming, so the panel is never blank with no reason */}
      {loading && !data && (
        <div className="rounded-xl border bg-white py-16 text-center">
          <p className="text-sm text-gray-400">Loading credit sales…</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && data?.receivables.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white py-16 text-center">
          <p className="text-sm font-medium text-gray-500">Nobody owes you anything right now</p>
          <p className="mt-1 text-xs text-gray-400">A bill put on a tab at the till shows up here by itself.</p>
        </div>
      )}

      {/* Two-panel layout */}
      {(data?.receivables.length ?? 0) > 0 && (
        <div className="flex gap-4 rounded-xl border bg-white overflow-hidden min-h-[420px]">

          {/* Left — client list */}
          <div className="w-1/3 border-r overflow-y-auto">
            <p className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b">Clients</p>
            {data!.receivables.map(row => (
              <button
                key={row.customerName}
                onClick={() => setSelectedName(row.customerName)}
                className={`w-full text-left px-4 py-3 border-b last:border-b-0 transition-colors ${selectedName === row.customerName ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-800 truncate">{row.customerName}</p>
                    {row.customerPhone && <p className="text-xs text-gray-400">{row.customerPhone}</p>}
                    <p className="text-xs text-gray-400">{relativeTime(row.lastActivityAt)}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-bold text-gray-800">{fmt(row.totalOwed)}</p>
                    <p className="text-xs text-gray-400">{row.openCount} credit sale{row.openCount !== 1 ? 's' : ''}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Right — detail */}
          <div className="flex-1 overflow-y-auto p-5">
            {!selected ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-gray-400">Select a client to view details</p>
              </div>
            ) : (() => {
              const aging = agingLabel(selected.items[0].saleDate)
              const days = daysOutstanding(selected.items[0].saleDate)
              return (
                <div>
                  <div className="mb-4 flex items-start justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-gray-900">{selected.customerName}</h2>
                      <p className="text-sm text-gray-500">Outstanding balance: {fmt(selected.totalOwed)}</p>
                      {selected.customerPhone && <p className="text-xs text-gray-400">{selected.customerPhone}</p>}
                    </div>
                    <div className="text-right text-xs text-gray-500">
                      <p>{days} day{days !== 1 ? 's' : ''} outstanding</p>
                      <span className={`inline-block mt-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${aging.color}`}>{aging.label}</span>
                      <p className="mt-1">Last activity: {fmtDate(selected.lastActivityAt)}</p>
                    </div>
                  </div>

                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs font-semibold uppercase tracking-wide text-gray-400">
                        <th className="pb-2 text-left">Date / Time</th>
                        <th className="pb-2 text-left">Description</th>
                        <th className="pb-2 text-right">Amount</th>
                        <th className="pb-2 text-right">Paid?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.items.map(item => (
                        <tr key={item.id} className={`border-b last:border-b-0 transition-colors ${flashId === item.id ? 'bg-green-50' : ''}`}>
                          <td className="py-3 pr-4 text-xs text-gray-500 whitespace-nowrap">{fmtDate(item.saleDate)}</td>
                          <td className="py-3 pr-4 text-gray-700">
                            <span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${(SOURCE_BADGE[item.source] ?? SOURCE_BADGE.manual).className}`}>
                              {(SOURCE_BADGE[item.source] ?? SOURCE_BADGE.manual).label}
                            </span>
                            {item.description}
                          </td>
                          <td className="py-3 pr-4 text-right font-medium text-gray-800 whitespace-nowrap">{fmt(item.amount)}</td>
                          <td className="py-3 text-right">
                            {flashId === item.id ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-600">
                                <CheckCircle className="h-4 w-4" /> Paid
                              </span>
                            ) : payingId === item.id ? (
                              <div className="flex items-center justify-end gap-2">
                                <select
                                  value={payMethod}
                                  onChange={e => setPayMethod(e.target.value)}
                                  className="rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                                >
                                  {PAYMENT_METHODS.map(m => <option key={m}>{m}</option>)}
                                </select>
                                <button onClick={() => confirmPayment(item.id)} disabled={confirming} className="rounded bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-60">
                                  {confirming ? '…' : 'Confirm'}
                                </button>
                                <button onClick={() => { setPayingId(null); setPayError(null) }} className="rounded border px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50">Cancel</button>
                                {payError && <span className="text-xs text-red-600">{payError}</span>}
                              </div>
                            ) : (
                              <button onClick={() => { setPayingId(item.id); setPayMethod(PAYMENT_METHODS[0]); setPayError(null) }} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                                Paid?
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2} />
                        <td className="pt-3 pr-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Total Amount Owed</td>
                        <td className="pt-3 text-right text-sm font-bold text-gray-900">{fmt(selected.totalOwed)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
