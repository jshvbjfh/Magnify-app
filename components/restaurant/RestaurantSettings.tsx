'use client'
import { useState, useEffect } from 'react'
import { Save, CheckCircle2, FileText, ReceiptText, UtensilsCrossed, Layers } from 'lucide-react'

export default function RestaurantSettings() {
  const [billHeader, setBillHeader] = useState('')
  const [restaurantName, setRestaurantName] = useState('')
  const [trackingMode, setTrackingMode] = useState<'simple' | 'dish_tracking'>('simple')
  const [fifoEnabled, setFifoEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [savingMode, setSavingMode] = useState(false)
  const [savedMode, setSavedMode] = useState(false)
  const [savingFifo, setSavingFifo] = useState(false)
  const [savedFifo, setSavedFifo] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/restaurant/setup', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        setRestaurantName(data.restaurant?.name ?? '')
        setBillHeader(data.restaurant?.billHeader ?? '')
      })
    fetch('/api/user/profile', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (data.trackingMode) setTrackingMode(data.trackingMode)
        if (typeof data.fifoEnabled === 'boolean') setFifoEnabled(data.fifoEnabled)
      })
      .finally(() => setLoading(false))
  }, [])

  async function save() {
    setSaving(true)
    try {
      await fetch('/api/restaurant/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: restaurantName, billHeader }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } finally {
      setSaving(false)
    }
  }

  async function saveTrackingMode(mode: 'simple' | 'dish_tracking') {
    setSavingMode(true)
    setTrackingMode(mode)
    try {
      await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ trackingMode: mode }),
      })
      setSavedMode(true)
      // Notify RestaurantShell to update nav immediately
      window.dispatchEvent(new CustomEvent('trackingModeChanged', { detail: { trackingMode: mode } }))
      setTimeout(() => setSavedMode(false), 2500)
    } finally {
      setSavingMode(false)
    }
  }

  async function saveFifo(enabled: boolean) {
    setSavingFifo(true)
    setFifoEnabled(enabled)
    try {
      await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ fifoEnabled: enabled }),
      })
      setSavedFifo(true)
      setTimeout(() => setSavedFifo(false), 2500)
    } finally {
      setSavingFifo(false)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center py-24 text-gray-400 text-sm">Loading…</div>
  )

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">

      {/* ── LEFT: Receipt settings ── */}
      <div className="space-y-6">

        {/* Restaurant name */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-base font-bold text-gray-900">Restaurant name</h2>
          <input
            value={restaurantName}
            onChange={e => setRestaurantName(e.target.value)}
            placeholder="My Restaurant"
            className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent"
          />
        </div>

        {/* Bill header */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-orange-500" />
            <h2 className="text-base font-bold text-gray-900">Receipt / Bill header</h2>
          </div>
          <p className="text-sm text-gray-500">
            This text appears at the top of every printed bill. Include your business name, address, phone, MoMo code, bank account, etc.
          </p>
          <textarea
            value={billHeader}
            onChange={e => setBillHeader(e.target.value)}
            rows={7}
            placeholder={`e.g.\nSUNSET GRILL\n123 Kigali Heights, KG 7 Ave\nTel: +250 788 000 000\nMoMo: *182*1*1*0788000000#\nTIN: 123456789`}
            className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm font-mono outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent resize-y leading-relaxed"
          />
          <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-4">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Preview on bill</p>
            <pre className="text-xs font-mono text-gray-700 whitespace-pre-wrap leading-relaxed">
              {billHeader.trim() || '(no header set)'}
            </pre>
          </div>
        </div>

        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 bg-gray-900 hover:bg-gray-700 disabled:opacity-60 text-white font-semibold px-6 py-3 rounded-2xl transition-colors shadow-sm"
        >
          {saved ? <CheckCircle2 className="h-4 w-4 text-green-400" /> : <Save className="h-4 w-4" />}
          {saved ? 'Saved!' : saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      {/* ── RIGHT: Tracking mode ── */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
        <div>
          <h2 className="text-base font-bold text-gray-900">Restaurant Tracking Mode</h2>
          <p className="text-sm text-gray-500 mt-1">Controls which features are shown in your sidebar. You can switch at any time.</p>
        </div>

        <div className="space-y-3">
          {/* Simple */}
          <button type="button" onClick={() => saveTrackingMode('simple')}
            className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
              trackingMode === 'simple' ? 'border-orange-500 bg-orange-50' : 'border-gray-200 bg-white hover:border-gray-300'
            }`}>
            <div className="flex items-start gap-3">
              <div className={`p-2 rounded-lg flex-shrink-0 ${trackingMode === 'simple' ? 'bg-orange-100' : 'bg-gray-100'}`}>
                <ReceiptText className={`h-5 w-5 ${trackingMode === 'simple' ? 'text-orange-600' : 'text-gray-500'}`} />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className={`text-sm font-bold ${trackingMode === 'simple' ? 'text-orange-700' : 'text-gray-800'}`}>Simple — Financial Records Only</p>
                  {trackingMode === 'simple' && <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">{savingMode ? 'Saving…' : savedMode ? 'Saved!' : 'Active'}</span>}
                </div>
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                  AI records purchases and expenses straight into transactions and financial reports. No dish or ingredient setup needed.
                </p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {['Transactions', 'Income & Expenses', 'AI receipt scanning', 'Financial reports'].map(tag => (
                    <span key={tag} className="text-[10px] bg-green-50 border border-green-200 text-green-700 rounded-full px-2 py-0.5">✅ {tag}</span>
                  ))}
                  {['Dish menu', 'Ingredient tracking'].map(tag => (
                    <span key={tag} className="text-[10px] bg-gray-50 border border-gray-200 text-gray-400 rounded-full px-2 py-0.5">❌ {tag}</span>
                  ))}
                </div>
              </div>
            </div>
          </button>

          {/* Dish tracking */}
          <button type="button" onClick={() => saveTrackingMode('dish_tracking')}
            className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
              trackingMode === 'dish_tracking' ? 'border-orange-500 bg-orange-50' : 'border-gray-200 bg-white hover:border-gray-300'
            }`}>
            <div className="flex items-start gap-3">
              <div className={`p-2 rounded-lg flex-shrink-0 ${trackingMode === 'dish_tracking' ? 'bg-orange-100' : 'bg-gray-100'}`}>
                <UtensilsCrossed className={`h-5 w-5 ${trackingMode === 'dish_tracking' ? 'text-orange-600' : 'text-gray-500'}`} />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className={`text-sm font-bold ${trackingMode === 'dish_tracking' ? 'text-orange-700' : 'text-gray-800'}`}>Dish Tracking — Full Kitchen Control</p>
                  {trackingMode === 'dish_tracking' && <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">{savingMode ? 'Saving…' : savedMode ? 'Saved!' : 'Active'}</span>}
                </div>
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                  Full menu builder with dishes, ingredients, and quantities. Every order auto-deducts stock. Includes Tables, Kitchen display, Orders, and Waste tracking.
                </p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {['Everything in Simple', 'Dish menu builder', 'Ingredient per dish', 'Auto stock deduction', 'Waste tracking', 'Tables & Kitchen'].map(tag => (
                    <span key={tag} className="text-[10px] bg-green-50 border border-green-200 text-green-700 rounded-full px-2 py-0.5">✅ {tag}</span>
                  ))}
                </div>
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* ── FIFO Costing ── */}
      {trackingMode === 'dish_tracking' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-orange-500" />
            <h2 className="text-base font-bold text-gray-900">Inventory Costing Method</h2>
          </div>
          <p className="text-sm text-gray-500">
            Controls how ingredient costs are calculated when a dish is sold.
          </p>
          <div className="space-y-3">
            {/* Simple averaging */}
            <button type="button" onClick={() => saveFifo(false)}
              className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
                !fifoEnabled ? 'border-orange-500 bg-orange-50' : 'border-gray-200 bg-white hover:border-gray-300'
              }`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className={`text-sm font-bold ${!fifoEnabled ? 'text-orange-700' : 'text-gray-800'}`}>
                    Average Cost <span className="font-normal text-xs">(default)</span>
                    {!fifoEnabled && <span className="ml-2 text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">{savingFifo ? 'Saving…' : savedFifo ? 'Saved!' : 'Active'}</span>}
                  </p>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    Uses the current unit cost on each ingredient. Simple and fast — good for restaurants that don't record purchase batches.
                  </p>
                </div>
              </div>
            </button>

            {/* FIFO */}
            <button type="button" onClick={() => saveFifo(true)}
              className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
                fifoEnabled ? 'border-orange-500 bg-orange-50' : 'border-gray-200 bg-white hover:border-gray-300'
              }`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className={`text-sm font-bold ${fifoEnabled ? 'text-orange-700' : 'text-gray-800'}`}>
                    FIFO — First In, First Out
                    {fifoEnabled && <span className="ml-2 text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">{savingFifo ? 'Saving…' : savedFifo ? 'Saved!' : 'Active'}</span>}
                  </p>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    Costs each dish using the oldest purchase batch first. Gives you the most <strong>accurate real profit</strong> per dish — industry standard for restaurants that track purchase prices over time.
                  </p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {['Most accurate profit', 'Tracks price changes', 'Industry standard'].map(tag => (
                      <span key={tag} className="text-[10px] bg-green-50 border border-green-200 text-green-700 rounded-full px-2 py-0.5">✅ {tag}</span>
                    ))}
                    <span className="text-[10px] bg-amber-50 border border-amber-200 text-amber-700 rounded-full px-2 py-0.5">⚠️ Requires recording all purchases</span>
                  </div>
                </div>
              </div>
            </button>
          </div>
        </div>
      )}

    </div>
  )
}
