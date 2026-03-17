'use client'

import { useEffect, useState } from 'react'
import { RefreshCw, Sparkles, AlertTriangle, TrendingUp, TrendingDown, UtensilsCrossed, Key, ExternalLink, Eye, EyeOff, CheckCircle, MessageCircle } from 'lucide-react'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'

type AIChart = {
  title: string
  type: 'bar' | 'line'
  xKey: string
  yKey: string
  data: Array<Record<string, string | number>>
  note?: string
}

type AITable = {
  title: string
  columns: string[]
  rows: Array<Array<string | number>>
}

type AIInsights = {
  headline: string
  comments: string[]
  advice: string[]
  charts: AIChart[]
  tables: AITable[]
}

function fmt(n: number) {
  return n?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '0'
}

// â”€â”€â”€ GEMINI KEY SETUP CARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function GeminiSetup({ onKeySaved }: { onKeySaved: () => void }) {
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    if (!key.trim()) return
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiApiKey: key.trim() }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to save key')
      }
      setSaved(true)
      setTimeout(() => onKeySaved(), 1200)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto mt-12 rounded-2xl border border-orange-200 bg-white shadow-md p-8 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center">
          <Key className="h-6 w-6 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">Set up Gemini AI</h2>
          <p className="text-sm text-gray-500">Required for AI-powered analytics</p>
        </div>
      </div>

      <p className="text-sm text-gray-600">
        Jesse AI uses Google Gemini to analyse your restaurant data. Enter your free Gemini API key below to enable AI analytics, chat, and insights.
      </p>

      <a
        href="https://aistudio.google.com/app/apikey"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-600 hover:text-orange-700 underline underline-offset-2"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Get a free Gemini API key from Google AI Studio
      </a>

      <div className="space-y-2">
        <label className="block text-sm font-semibold text-gray-700">Gemini API Key</label>
        <div className="relative">
          <input
            type={show ? 'text' : 'password'}
            value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder="AIza..."
            className="w-full border border-gray-300 rounded-xl px-4 pr-11 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
          />
          <button
            type="button"
            onClick={() => setShow(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {err && <p className="text-xs text-red-600">{err}</p>}
      </div>

      <button
        onClick={save}
        disabled={saving || !key.trim() || saved}
        className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white font-semibold text-sm py-2.5 rounded-xl transition-colors"
      >
        {saved ? (
          <><CheckCircle className="h-4 w-4" /> Key saved â€” loading analytics...</>
        ) : saving ? (
          <><RefreshCw className="h-4 w-4 animate-spin" /> Saving...</>
        ) : (
          'Save & Generate Analytics'
        )}
      </button>
    </div>
  )
}

export default function RestaurantAnalytics({ onAskJesse }: { onAskJesse?: () => void }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [insights, setInsights] = useState<AIInsights | null>(null)
  const [generatedAt, setGeneratedAt] = useState<string>('')
  const [summary, setSummary] = useState<any>(null)
  const [alerts, setAlerts] = useState<string[]>([])

  // First check if key is configured
  useEffect(() => {
    fetch('/api/config', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        setHasKey(Boolean(d.hasGeminiKey))
        if (d.hasGeminiKey) loadInsights()
      })
      .catch(() => setHasKey(false))
  }, [])

  async function loadInsights() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/analytics/ai', { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to generate AI analytics')
      setInsights(data.ai)
      setGeneratedAt(data.generatedAt)
      setSummary(data.dataset?.summary || null)
      setAlerts(data.dataset?.spendingAlerts || [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Key not yet determined
  if (hasKey === null) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-4 border-orange-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // No key configured
  if (!hasKey) {
    return <GeminiSetup onKeySaved={() => { setHasKey(true); loadInsights() }} />
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-gray-500">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-orange-400 to-red-600 flex items-center justify-center animate-pulse">
          <UtensilsCrossed className="h-7 w-7 text-white" />
        </div>
        <p className="text-sm font-semibold">Jesse AI is analysing your restaurant...</p>
        <p className="text-xs text-gray-400">Reading sales, menu, inventory & transactions â€” 5â€“15 seconds</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center space-y-3 max-w-lg mx-auto mt-8">
        <AlertTriangle className="h-8 w-8 text-red-500 mx-auto" />
        <p className="text-sm font-semibold text-red-700">AI Analytics Failed</p>
        <p className="text-xs text-red-600 bg-white/70 rounded-lg px-3 py-2">{error}</p>
        <div className="flex justify-center gap-3 pt-1">
          <button
            onClick={loadInsights}
            className="inline-flex items-center gap-2 rounded-md bg-red-100 border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-200"
          >
            <RefreshCw className="h-4 w-4" /> Try Again
          </button>
        </div>
      </div>
    )
  }

  if (!insights) return null

  const netProfit = summary?.netProfit ?? 0
  const isProfit = netProfit >= 0

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="rounded-xl border border-orange-200 bg-orange-50/60 p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-orange-700">
            <Sparkles className="h-5 w-5" />
            <span className="text-sm font-semibold uppercase tracking-wide">Jesse AI Analytics</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadInsights}
              className="inline-flex items-center gap-1.5 rounded-md border border-orange-300 bg-white px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-50 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Regenerate
            </button>
            {onAskJesse && (
              <button
                onClick={() => {
                  // Store analytics summary so Jesse has full context
                  if (insights) {
                    localStorage.setItem('jesseAnalyticsContext', JSON.stringify({
                      headline: insights.headline,
                      comments: insights.comments,
                      advice: insights.advice,
                      summary,
                      alerts,
                      generatedAt,
                    }))
                  }
                  // Signal the chat to open with analytics context
                  window.dispatchEvent(new CustomEvent('openJesseWithContext', {
                    detail: { prompt: "Let\'s talk about my analytics. What do you see?" }
                  }))
                  onAskJesse()
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-orange-400 bg-gradient-to-r from-orange-500 to-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:from-orange-600 hover:to-red-700 transition-colors shadow-sm"
              >
                <MessageCircle className="h-3.5 w-3.5" />
                Ask Jesse
              </button>
            )}
          </div>
        </div>
        <h2 className="text-xl font-bold text-gray-900">{insights.headline}</h2>
        <p className="mt-1 text-xs text-gray-500">Generated: {new Date(generatedAt).toLocaleString()}</p>
      </div>

      {/* Financial Vitals */}
      {summary && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Total Revenue', value: fmt(summary.totalIncome) + ' RWF', color: 'text-gray-900' },
            { label: 'Gross Profit', value: fmt(summary.grossProfit) + ' RWF', sub: summary.grossMargin + '% margin', color: 'text-orange-700' },
            {
              label: isProfit ? 'Net Profit' : 'Net Loss',
              value: fmt(Math.abs(netProfit)) + ' RWF',
              sub: summary.netMargin + '% net margin',
              color: isProfit ? 'text-green-700' : 'text-red-600',
              icon: isProfit ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />,
            },
            { label: 'Total Expenses', value: fmt(summary.totalExpense) + ' RWF', color: 'text-gray-700' },
          ].map(({ label, value, sub, color, icon }) => (
            <div key={label} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">{label}</div>
              <div className={`flex items-center gap-1 text-lg font-bold ${color}`}>
                {icon}{value}
              </div>
              {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
            </div>
          ))}
        </section>
      )}

      {/* Spending Alerts */}
      {alerts.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-center gap-2 mb-2 text-amber-700">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm font-semibold uppercase tracking-wide">Alerts</span>
          </div>
          <ul className="space-y-1 text-sm text-amber-900">
            {alerts.map((a, i) => <li key={i} className="rounded bg-white/60 px-3 py-2">âš  {a}</li>)}
          </ul>
        </section>
      )}

      {/* AI Observations */}
      {insights.comments.length > 0 && (
        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">AI Observations</h3>
          <ul className="space-y-2 text-sm text-gray-700">
            {insights.comments.map((c, i) => (
              <li key={i} className="flex gap-2 rounded-md bg-gray-50 p-3">
                <span className="shrink-0 text-orange-500 font-bold">â†’</span>
                {c}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* AI Charts */}
      {insights.charts.map((chart, idx) => (
        <section key={idx} className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-1 text-base font-semibold text-gray-900">{chart.title}</h3>
          {chart.note && <p className="mb-3 text-xs text-orange-600 italic">{chart.note}</p>}
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              {chart.type === 'line' ? (
                <LineChart data={chart.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey={chart.xKey} tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: any) => [fmt(Number(v)) + ' RWF', chart.yKey]} />
                  <Line type="monotone" dataKey={chart.yKey} stroke="#f97316" strokeWidth={2} dot={false} />
                </LineChart>
              ) : (
                <BarChart data={chart.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey={chart.xKey} tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: any) => [fmt(Number(v)) + ' RWF', chart.yKey]} />
                  <Bar dataKey={chart.yKey} fill="#f97316" radius={[4, 4, 0, 0]} />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </section>
      ))}

      {/* AI Tables */}
      {insights.tables.map((table, idx) => (
        <section key={idx} className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-base font-semibold text-gray-900">{table.title}</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {table.columns.map((col) => (
                    <th key={col} className="px-3 py-2 text-left font-medium text-gray-700">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {table.rows.map((row, rIdx) => (
                  <tr key={rIdx} className="hover:bg-gray-50">
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className="px-3 py-2 text-gray-700">{typeof cell === 'number' ? fmt(cell) : String(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {/* AI Recommendations */}
      {insights.advice.length > 0 && (
        <section className="rounded-xl border border-green-200 bg-green-50 p-5">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-green-700">AI Recommendations</h3>
          <ol className="space-y-2 text-sm text-green-900">
            {insights.advice.map((a, i) => (
              <li key={i} className="flex gap-3 rounded-md bg-white/70 p-3">
                <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-orange-100 text-xs font-bold text-orange-700">{i + 1}</span>
                {a}
              </li>
            ))}
          </ol>
        </section>
      )}

    </div>
  )
}

