'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, X, CheckCircle } from 'lucide-react'

// Where a credit sale came from. 'order' is a bill put on a tab at the till,
// 'buffet' the hotel's breakfast lines, 'manual' a debt typed in below.
type ReceivableSource = 'manual' | 'order' | 'buffet'

interface CreditItem {
  id: string
  source: ReceivableSource
  /** What was eaten — the dishes, not the order number. */
  description: string
  /** Order number and table, for looking the bill up if it is disputed. */
  reference: string | null
  amount: number
  saleDate: string
}

// Where the debt came from, in a word, under the description. It reads as a
// plain sub-line rather than a coloured chip — the row already carries an
// orange header above and an action button beside it, and a third colour there
// competes with the button the manager is meant to press.
const SOURCE_LABEL: Record<ReceivableSource, string> = {
  order: 'Put on a tab at the till',
  buffet: 'Hotel buffet — settled by the hotel',
  manual: 'Recorded by hand',
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

      {/* Title and the one action, on a line of their own */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Credit Sales</h2>
          <p className="mt-0.5 text-sm text-gray-500">Select a client to view everything sold on credit, with the current amount they still owe.</p>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600"
        >
          {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {showForm ? 'Cancel' : 'Add Credit Sale'}
        </button>
      </div>

      {/* Three totals, equal width. Total Outstanding is the whole business and
          does not move when a client is selected; the other two count it. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-orange-200 bg-orange-50 px-5 py-4">
          <p className="text-sm font-semibold text-orange-700">Total Outstanding</p>
          <p className="mt-1.5 text-3xl font-bold text-orange-900">{fmt(data?.totalUnpaid ?? 0)}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
          <p className="text-sm font-medium text-gray-500">Clients Owing</p>
          <p className="mt-1.5 text-3xl font-bold text-gray-900">{data?.clientCount ?? 0}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
          <p className="text-sm font-medium text-gray-500">Credit Sales Open</p>
          <p className="mt-1.5 text-3xl font-bold text-gray-900">{data?.openCount ?? 0}</p>
        </div>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-gray-700">Record Credit Sale</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Client Name *</label>
              <input className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" value={form.clientName} onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))} placeholder="e.g. John Doe" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Phone (optional)</label>
              <input className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" value={form.customerPhone} onChange={e => setForm(f => ({ ...f, customerPhone: e.target.value }))} placeholder="e.g. 078..." />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Amount (RWF) *</label>
              <input type="number" min="0" className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Date</label>
              <input type="date" className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-600">Description (optional)</label>
              <input className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="e.g. Grilled chicken, coconut juice..." />
            </div>
          </div>
          {formError && <p className="mt-2 text-xs text-red-600">{formError}</p>}
          <div className="mt-4 flex gap-2">
            <button onClick={submitForm} disabled={submitting} className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-60">
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

      {/* Two panels: who owes, and what they owe it for */}
      {(data?.receivables.length ?? 0) > 0 && (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">

          {/* Left — client list. Each card is its own tile, the way the whole
              screen reads: a stack of debts, biggest first. */}
          <div className="rounded-xl border border-gray-200 bg-white p-3 lg:w-[340px] lg:flex-shrink-0">
            <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Clients</p>
            <div className="flex flex-col gap-2">
              {data!.receivables.map(row => (
                <button
                  key={row.customerName}
                  onClick={() => setSelectedName(row.customerName)}
                  className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                    selectedName === row.customerName
                      ? 'border-orange-400 bg-orange-50'
                      : 'border-gray-200 bg-white hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-base font-semibold text-gray-900">{row.customerName}</p>
                    <p className="flex-shrink-0 text-base font-bold text-gray-900">{fmt(row.totalOwed)}</p>
                  </div>
                  {row.customerPhone && <p className="mt-1 text-xs text-gray-500">{row.customerPhone}</p>}
                  <div className="mt-1 flex items-baseline justify-between gap-3">
                    <p className="text-xs text-gray-500">{fmtDate(row.lastActivityAt)}</p>
                    <p className="flex-shrink-0 text-xs text-gray-500">{row.openCount} credit sale{row.openCount !== 1 ? 's' : ''}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Right — detail */}
          <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-gray-200 bg-white">
            {!selected ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-gray-400">Select a client to view details</p>
              </div>
            ) : (() => {
              const aging = agingLabel(selected.items[0].saleDate)
              const days = daysOutstanding(selected.items[0].saleDate)
              return (
                <div>
                  <div className="flex items-start justify-between gap-4 px-6 py-5">
                    <div className="min-w-0">
                      <h3 className="text-xl font-bold text-gray-900">{selected.customerName}</h3>
                      <p className="mt-0.5 text-sm text-gray-600">Outstanding balance: {fmt(selected.totalOwed)}</p>
                      {selected.customerPhone && <p className="text-xs text-gray-400">{selected.customerPhone}</p>}
                    </div>
                    <div className="flex-shrink-0 space-y-1 text-right text-sm text-gray-600">
                      <p>{days} day{days !== 1 ? 's' : ''} outstanding</p>
                      <p><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${aging.color}`}>{aging.label}</span></p>
                      <p className="text-xs text-gray-500">Last activity: {fmtDate(selected.lastActivityAt)}</p>
                    </div>
                  </div>

                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-orange-500 text-xs font-bold uppercase tracking-wide text-white">
                        <th className="px-6 py-3 text-left">Date / Time</th>
                        <th className="py-3 pr-4 text-left">Sold On Credit</th>
                        <th className="py-3 pr-4 text-right">Amount</th>
                        <th className="py-3 pr-6 text-left">Paid?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.items.map((item, idx) => (
                        <tr key={item.id} className={`border-b border-gray-100 last:border-b-0 transition-colors ${flashId === item.id ? 'bg-green-50' : idx % 2 === 0 ? 'bg-white' : 'bg-orange-50/40'}`}>
                          <td className="px-6 py-4 text-xs text-gray-500 whitespace-nowrap align-top">{fmtDate(item.saleDate)}</td>
                          <td className="py-4 pr-4 align-top">
                            <p className="font-semibold text-gray-900">{item.description}</p>
                            <p className="mt-0.5 text-xs text-gray-500">
                              {[item.reference, SOURCE_LABEL[item.source] ?? SOURCE_LABEL.manual].filter(Boolean).join(' · ')}
                            </p>
                          </td>
                          <td className="py-4 pr-4 text-right font-semibold text-gray-900 whitespace-nowrap align-top">{fmt(item.amount)}</td>
                          <td className="py-4 pr-6 align-top">
                            {flashId === item.id ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-600">
                                <CheckCircle className="h-4 w-4" /> Paid
                              </span>
                            ) : payingId === item.id ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  value={payMethod}
                                  onChange={e => setPayMethod(e.target.value)}
                                  className="rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-orange-400"
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
                              <button onClick={() => { setPayingId(item.id); setPayMethod(PAYMENT_METHODS[0]); setPayError(null) }} className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-600">
                                Paid?
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {/* The client's total again, at the foot. The same number as
                        the header — a long list means whichever end you are at,
                        the balance is next to you. */}
                    <tfoot>
                      <tr className="bg-gray-900 font-bold text-white">
                        <td className="px-6 py-4" />
                        <td className="py-4 pr-4 text-right text-sm">Total Amount Owed</td>
                        <td className="py-4 pr-4 text-right text-base whitespace-nowrap">{fmt(selected.totalOwed)}</td>
                        <td className="py-4 pr-6" />
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
