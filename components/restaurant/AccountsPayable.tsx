'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, X, CheckCircle } from 'lucide-react'

interface DebtItem {
  id: string
  description: string
  amount: number
  purchaseDate: string
}

interface SupplierRow {
  supplierName: string
  supplierPhone: string | null
  totalOwed: number
  openCount: number
  lastActivityAt: string
  items: DebtItem[]
}

interface SummaryData {
  payables: SupplierRow[]
  totalUnpaid: number
  supplierCount: number
  openCount: number
}

const PAYMENT_METHODS = ['Cash', 'Card', 'Mobile Money', 'Bank Transfer']

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

export default function AccountsPayable() {
  const [data, setData] = useState<SummaryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [payMethod, setPayMethod] = useState(PAYMENT_METHODS[0])
  const [confirming, setConfirming] = useState(false)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ supplierName: '', supplierPhone: '', amount: '', date: new Date().toISOString().slice(0, 10), description: '' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/accounts-payable')
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!data || selectedName === null) return
    if (!data.payables.find(r => r.supplierName === selectedName)) setSelectedName(null)
  }, [data, selectedName])

  const selected = data?.payables.find(r => r.supplierName === selectedName) ?? null

  async function confirmPayment(itemId: string) {
    setConfirming(true)
    try {
      const res = await fetch('/api/accounts-payable', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: itemId, paymentMethod: payMethod }),
      })
      if (!res.ok) return
      setFlashId(itemId)
      setPayingId(null)
      setTimeout(async () => {
        setFlashId(null)
        await load()
      }, 800)
    } finally {
      setConfirming(false)
    }
  }

  async function submitForm() {
    setFormError(null)
    if (!form.supplierName.trim()) { setFormError('Supplier name is required'); return }
    if (!form.amount || isNaN(parseFloat(form.amount))) { setFormError('Valid amount is required'); return }
    setSubmitting(true)
    try {
      const res = await fetch('/api/accounts-payable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierName: form.supplierName, supplierPhone: form.supplierPhone, amount: form.amount, date: form.date, description: form.description }),
      })
      if (!res.ok) { setFormError('Failed to record supplier debt'); return }
      setForm({ supplierName: '', supplierPhone: '', amount: '', date: new Date().toISOString().slice(0, 10), description: '' })
      setShowForm(false)
      await load()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Summary cards + add button */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex gap-3 flex-wrap">
          <div className="rounded-xl border border-red-100 bg-red-50 px-5 py-3 min-w-[160px]">
            <p className="text-xs font-semibold uppercase tracking-wide text-red-600">Total Owed</p>
            <p className="mt-1 text-2xl font-bold text-red-700">{fmt(data?.totalUnpaid ?? 0)}</p>
          </div>
          <div className="rounded-xl border bg-white px-5 py-3 min-w-[130px]">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Suppliers</p>
            <p className="mt-1 text-2xl font-bold text-gray-800">{data?.supplierCount ?? 0}</p>
          </div>
          <div className="rounded-xl border bg-white px-5 py-3 min-w-[160px]">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Open Payables</p>
            <p className="mt-1 text-2xl font-bold text-gray-800">{data?.openCount ?? 0}</p>
          </div>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
        >
          {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {showForm ? 'Cancel' : '+ Add Unpaid Purchase'}
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-gray-700">Record Credit Purchase</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Supplier Name *</label>
              <input className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500" value={form.supplierName} onChange={e => setForm(f => ({ ...f, supplierName: e.target.value }))} placeholder="e.g. Fresh Market Ltd" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Phone (optional)</label>
              <input className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500" value={form.supplierPhone} onChange={e => setForm(f => ({ ...f, supplierPhone: e.target.value }))} placeholder="e.g. 078..." />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Amount (RWF) *</label>
              <input type="number" min="0" className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Date</label>
              <input type="date" className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-600">Description (optional)</label>
              <input className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="e.g. 50kg rice, cooking oil..." />
            </div>
          </div>
          {formError && <p className="mt-2 text-xs text-red-600">{formError}</p>}
          <div className="mt-4 flex gap-2">
            <button onClick={submitForm} disabled={submitting} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60">
              {submitting ? 'Recording…' : 'Record Purchase'}
            </button>
            <button onClick={() => { setShowForm(false); setFormError(null) }} className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && data?.payables.length === 0 && (
        <div className="rounded-xl border bg-white py-16 text-center">
          <p className="text-sm font-medium text-gray-500">No outstanding supplier debts</p>
          <p className="mt-1 text-xs text-gray-400">Click "+ Add Unpaid Purchase" to record a credit purchase from a supplier.</p>
        </div>
      )}

      {/* Two-panel layout */}
      {(data?.payables.length ?? 0) > 0 && (
        <div className="flex gap-4 rounded-xl border bg-white overflow-hidden min-h-[420px]">

          {/* Left — supplier list */}
          <div className="w-1/3 border-r overflow-y-auto">
            <p className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b">Suppliers</p>
            {data!.payables.map(row => (
              <button
                key={row.supplierName}
                onClick={() => setSelectedName(row.supplierName)}
                className={`w-full text-left px-4 py-3 border-b last:border-b-0 transition-colors ${selectedName === row.supplierName ? 'bg-red-50' : 'hover:bg-gray-50'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-800 truncate">{row.supplierName}</p>
                    {row.supplierPhone && <p className="text-xs text-gray-400">{row.supplierPhone}</p>}
                    <p className="text-xs text-gray-400">{relativeTime(row.lastActivityAt)}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-bold text-gray-800">{fmt(row.totalOwed)}</p>
                    <p className="text-xs text-gray-400">{row.openCount} purchase{row.openCount !== 1 ? 's' : ''}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Right — detail */}
          <div className="flex-1 overflow-y-auto p-5">
            {!selected ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-gray-400">Select a supplier to view details</p>
              </div>
            ) : (() => {
              const aging = agingLabel(selected.items[0].purchaseDate)
              const days = daysOutstanding(selected.items[0].purchaseDate)
              return (
                <div>
                  <div className="mb-4 flex items-start justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-gray-900">{selected.supplierName}</h2>
                      <p className="text-sm text-gray-500">Outstanding balance: {fmt(selected.totalOwed)}</p>
                      {selected.supplierPhone && <p className="text-xs text-gray-400">{selected.supplierPhone}</p>}
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
                        <th className="pb-2 text-left">Purchased On Credit</th>
                        <th className="pb-2 text-right">Amount</th>
                        <th className="pb-2 text-right">Paid?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.items.map(item => (
                        <tr key={item.id} className={`border-b last:border-b-0 transition-colors ${flashId === item.id ? 'bg-green-50' : ''}`}>
                          <td className="py-3 pr-4 text-xs text-gray-500 whitespace-nowrap">{fmtDate(item.purchaseDate)}</td>
                          <td className="py-3 pr-4 text-gray-700">{item.description}</td>
                          <td className="py-3 pr-4 text-right font-medium text-gray-800 whitespace-nowrap">{fmt(item.amount)}</td>
                          <td className="py-3 text-right">
                            {flashId === item.id ? (
                              <CheckCircle className="ml-auto h-5 w-5 text-green-500" />
                            ) : payingId === item.id ? (
                              <div className="flex items-center justify-end gap-2">
                                <select
                                  value={payMethod}
                                  onChange={e => setPayMethod(e.target.value)}
                                  className="rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-red-500"
                                >
                                  {PAYMENT_METHODS.map(m => <option key={m}>{m}</option>)}
                                </select>
                                <button onClick={() => confirmPayment(item.id)} disabled={confirming} className="rounded bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-60">
                                  {confirming ? '…' : 'Confirm'}
                                </button>
                                <button onClick={() => setPayingId(null)} className="rounded border px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50">Cancel</button>
                              </div>
                            ) : (
                              <button onClick={() => { setPayingId(item.id); setPayMethod(PAYMENT_METHODS[0]) }} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">
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
