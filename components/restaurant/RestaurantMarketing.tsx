'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Megaphone, Brain, Sparkles, TrendingUp, TrendingDown, AlertTriangle,
  Target, Flame, Zap, Users, Calendar, RefreshCw, ChevronDown, ChevronUp,
  Copy, Check, Award, MessageSquare, Instagram, Mail, FileText,
  ArrowRight, Lightbulb, Star, BarChart2, Clock, X, Plus, Save,
  PlayCircle, CheckCircle
} from 'lucide-react'

// ─── Types ─────────────────────────────────────────────────────────────────

type Diagnosis = {
  problemCategory: string
  problemTitle: string
  problemSummary: string
  keyObservations: string[]
  urgency: 'low' | 'medium' | 'high'
  recommendedGoal: string
  topOpportunity: string
  magicQuestion: string
}

type PromotionStep = { channel: string; action: string }

type Campaign = {
  campaignName: string
  campaignType: string
  tagline: string
  goal: string
  strategy: string
  duration: string
  promotionPlan: PromotionStep[]
  specificOffer: string
  bestDay: string
  expectedImpact: string
  successMetric: string
  lowCostTip: string
  instagramCaption: string
  smsTemplate: string
  weeklyReasons: string[]
  savedAt?: string
  result?: string
}

type MarketingData = {
  weeklyTrend: { week: string; revenue: number }[]
  dayTrend: { day: string; revenue: number }[]
  hourTrend: { hour: string; revenue: number }[]
  topDishes: { name: string; revenue: number; orders: number; category: string }[]
  bottomDishes: { name: string; revenue: number; orders: number; category: string }[]
  allDishStats: { name: string; revenue: number; orders: number; category: string }[]
  rev30: number
  prevRev30: number
  revTrendPct: number | null
  campaigns: Campaign[]
  salesCount30d: number
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '0'
}

const CAMPAIGN_TYPES = [
  { id: 'comeback',   label: 'Come Back',      icon: <Users className="h-4 w-4" />,      color: 'blue',   desc: 'Re-engage lost customers' },
  { id: 'buzz',       label: 'Buzz',            icon: <Flame className="h-4 w-4" />,      color: 'orange', desc: 'Create excitement & hype' },
  { id: 'value',      label: 'Value',           icon: <Zap className="h-4 w-4" />,        color: 'green',  desc: 'Attract price-sensitive guests' },
  { id: 'experience', label: 'Experience',      icon: <Star className="h-4 w-4" />,       color: 'purple', desc: 'Events, themed nights' },
  { id: 'viral',      label: 'Viral Social',    icon: <Instagram className="h-4 w-4" />, color: 'pink',   desc: 'Online buzz & new reach' },
  { id: 'slowday',    label: 'Slow Day Boost',  icon: <Calendar className="h-4 w-4" />,  color: 'amber',  desc: 'Turn dead days around' },
]

const URGENCY_COLOR: Record<string, string> = {
  low:    'bg-green-100 text-green-700',
  medium: 'bg-amber-100 text-amber-700',
  high:   'bg-red-100 text-red-700',
}

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  Awareness:   <Megaphone className="h-4 w-4 text-blue-500" />,
  Excitement:  <Flame className="h-4 w-4 text-orange-500" />,
  Value:       <Zap className="h-4 w-4 text-green-500" />,
  Experience:  <Star className="h-4 w-4 text-purple-500" />,
  Competition: <Target className="h-4 w-4 text-red-500" />,
  Growth:      <TrendingUp className="h-4 w-4 text-teal-500" />,
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 transition-colors text-gray-500"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// ─── Campaign Card ───────────────────────────────────────────────────────────

function CampaignCard({ campaign, onSave, saved }: { campaign: Campaign; onSave: () => void; saved: boolean }) {
  const [expanded, setExpanded] = useState(true)
  const [contentType, setContentType] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [generatedContent, setGeneratedContent] = useState<Record<string, string>>({})

  async function generateContent(type: string) {
    setContentType(type)
    if (generatedContent[type]) return
    setContentLoading(true)
    try {
      const res = await fetch('/api/restaurant/marketing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'generate_content',
          context: { campaign, contentType: type },
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setGeneratedContent(prev => ({ ...prev, [type]: data.result }))
      }
    } finally {
      setContentLoading(false)
    }
  }

  const channelIcon: Record<string, React.ReactNode> = {
    Instagram: <Instagram className="h-3.5 w-3.5" />,
    'In-store': <Megaphone className="h-3.5 w-3.5" />,
    'WhatsApp/SMS': <MessageSquare className="h-3.5 w-3.5" />,
    Email: <Mail className="h-3.5 w-3.5" />,
    TikTok: <PlayCircle className="h-3.5 w-3.5" />,
  }

  return (
    <div className="rounded-xl border border-orange-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-orange-500 to-red-500 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-white font-bold text-base">{campaign.campaignName}</h3>
            <p className="text-orange-100 text-xs mt-0.5 italic">"{campaign.tagline}"</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {!saved && (
              <button
                onClick={onSave}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-orange-600 rounded-lg text-xs font-semibold hover:bg-orange-50 transition-colors"
              >
                <Save className="h-3.5 w-3.5" />
                Save
              </button>
            )}
            {saved && (
              <span className="flex items-center gap-1 px-2 py-1 bg-white/20 text-white rounded-lg text-xs font-semibold">
                <CheckCircle className="h-3 w-3" /> Saved
              </span>
            )}
            <button
              onClick={() => setExpanded(e => !e)}
              className="text-white/80 hover:text-white"
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="p-5 space-y-4">
          {/* Goal + Strategy */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-orange-50 rounded-lg p-3">
              <p className="text-xs font-bold text-orange-700 uppercase tracking-wide mb-1">Goal</p>
              <p className="text-sm text-gray-700">{campaign.goal}</p>
            </div>
            <div className="bg-blue-50 rounded-lg p-3">
              <p className="text-xs font-bold text-blue-700 uppercase tracking-wide mb-1">Strategy</p>
              <p className="text-sm text-gray-700">{campaign.strategy}</p>
            </div>
          </div>

          {/* Key details */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Duration', value: campaign.duration, icon: <Clock className="h-3.5 w-3.5 text-gray-400" /> },
              { label: 'Best Day', value: campaign.bestDay, icon: <Calendar className="h-3.5 w-3.5 text-gray-400" /> },
              { label: 'Expected', value: campaign.expectedImpact, icon: <TrendingUp className="h-3.5 w-3.5 text-green-500" /> },
              { label: 'Success = ', value: campaign.successMetric, icon: <Target className="h-3.5 w-3.5 text-blue-500" /> },
            ].map(item => (
              <div key={item.label} className="bg-gray-50 rounded-lg p-3">
                <div className="flex items-center gap-1.5 mb-1">
                  {item.icon}
                  <p className="text-xs font-semibold text-gray-500">{item.label}</p>
                </div>
                <p className="text-xs font-medium text-gray-800">{item.value}</p>
              </div>
            ))}
          </div>

          {/* The Offer */}
          <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <Flame className="h-4 w-4 text-orange-500" />
              <p className="text-xs font-bold text-orange-700 uppercase tracking-wide">The Hook / Offer</p>
            </div>
            <p className="text-sm font-semibold text-gray-800">{campaign.specificOffer}</p>
          </div>

          {/* Promotion Plan */}
          <div>
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Promotion Plan</p>
            <div className="space-y-2">
              {campaign.promotionPlan?.map((step, i) => (
                <div key={i} className="flex items-start gap-2.5 bg-gray-50 rounded-lg px-3 py-2">
                  <span className="flex-shrink-0 mt-0.5 text-gray-400">
                    {channelIcon[step.channel] ?? <ArrowRight className="h-3.5 w-3.5" />}
                  </span>
                  <div>
                    <span className="text-xs font-bold text-gray-600">{step.channel}: </span>
                    <span className="text-xs text-gray-700">{step.action}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Weekly Reasons to Visit */}
          {campaign.weeklyReasons?.length > 0 && (
            <div className="bg-purple-50 rounded-lg p-3">
              <p className="text-xs font-bold text-purple-700 uppercase tracking-wide mb-2">Ongoing Reasons to Visit</p>
              <ul className="space-y-1">
                {campaign.weeklyReasons.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-gray-700">
                    <Star className="h-3.5 w-3.5 text-purple-400 flex-shrink-0 mt-0.5" />
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Low-cost tip */}
          <div className="flex items-start gap-2.5 bg-green-50 rounded-lg p-3">
            <Lightbulb className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-bold text-green-700 mb-0.5">Budget-friendly tip</p>
              <p className="text-xs text-gray-700">{campaign.lowCostTip}</p>
            </div>
          </div>

          {/* One-click Content Generator */}
          <div>
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">One-Click Marketing Content</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {[
                { id: 'instagram', label: 'Instagram Caption', icon: <Instagram className="h-3.5 w-3.5" /> },
                { id: 'sms', label: 'SMS / WhatsApp', icon: <MessageSquare className="h-3.5 w-3.5" /> },
                { id: 'email', label: 'Email', icon: <Mail className="h-3.5 w-3.5" /> },
                { id: 'poster', label: 'Poster Text', icon: <FileText className="h-3.5 w-3.5" /> },
              ].map(ct => (
                <button
                  key={ct.id}
                  onClick={() => generateContent(ct.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    contentType === ct.id
                      ? 'bg-orange-500 text-white border-orange-500'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-orange-300 hover:text-orange-600'
                  }`}
                >
                  {ct.icon}
                  {ct.label}
                </button>
              ))}
            </div>

            {/* Ready-to-use templates (always shown) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {campaign.instagramCaption && (
                <div className="bg-gradient-to-br from-pink-50 to-purple-50 border border-pink-200 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <Instagram className="h-3.5 w-3.5 text-pink-500" />
                      <p className="text-xs font-bold text-pink-700">Instagram Caption</p>
                    </div>
                    <CopyButton text={campaign.instagramCaption} />
                  </div>
                  <p className="text-xs text-gray-700 whitespace-pre-wrap">{campaign.instagramCaption}</p>
                </div>
              )}
              {campaign.smsTemplate && (
                <div className="bg-gradient-to-br from-green-50 to-teal-50 border border-green-200 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <MessageSquare className="h-3.5 w-3.5 text-green-500" />
                      <p className="text-xs font-bold text-green-700">SMS / WhatsApp</p>
                    </div>
                    <CopyButton text={campaign.smsTemplate} />
                  </div>
                  <p className="text-xs text-gray-700">{campaign.smsTemplate}</p>
                </div>
              )}
            </div>

            {/* AI-generated content */}
            {contentType && (generatedContent[contentType] || contentLoading) && (
              <div className="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-orange-500" />
                    Generated {contentType.charAt(0).toUpperCase() + contentType.slice(1)} Copy
                  </p>
                  {generatedContent[contentType] && <CopyButton text={generatedContent[contentType]} />}
                </div>
                {contentLoading && !generatedContent[contentType] ? (
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Generating...
                  </div>
                ) : (
                  <p className="text-xs text-gray-700 whitespace-pre-wrap">{generatedContent[contentType]}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function RestaurantMarketing({ onAskJesse }: { onAskJesse?: () => void }) {
  const [data, setData] = useState<MarketingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [diagnosing, setDiagnosing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null)
  const [activeCampaign, setActiveCampaign] = useState<Campaign | null>(null)
  const [selectedCampaignType, setSelectedCampaignType] = useState<string>('buzz')
  const [savedCampaigns, setSavedCampaigns] = useState<Campaign[]>([])
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [view, setView] = useState<'diagnose' | 'build' | 'history'>('diagnose')
  const [error, setError] = useState<string | null>(null)
  const [restaurantName, setRestaurantName] = useState<string>('')

  useEffect(() => {
    loadData()
    // Try to get restaurant name
    fetch('/api/restaurant/server-info', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d?.name) setRestaurantName(d.name) })
      .catch(() => {})
  }, [])

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/restaurant/marketing', { credentials: 'include' })
      const d = await res.json()
      if (d.error) { setError(d.error); return }
      setData(d)
      if (d.campaigns?.length) setSavedCampaigns(d.campaigns)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function runDiagnosis() {
    if (!data) return
    setDiagnosing(true)
    setError(null)
    try {
      const res = await fetch('/api/restaurant/marketing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'diagnose',
          context: {
            weeklyTrend: data.weeklyTrend,
            dayTrend: data.dayTrend,
            topDishes: data.topDishes,
            bottomDishes: data.bottomDishes,
            rev30: data.rev30,
            prevRev30: data.prevRev30,
            revTrendPct: data.revTrendPct,
            salesCount30d: data.salesCount30d,
          },
        }),
      })
      const result = await res.json()
      if (result.ok) setDiagnosis(result.result)
      else setError(result.error ?? 'Diagnosis failed')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setDiagnosing(false)
    }
  }

  async function generateCampaign() {
    if (!diagnosis) return
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/restaurant/marketing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'generate_campaign',
          context: { diagnosis, campaignType: selectedCampaignType, restaurantName },
        }),
      })
      const result = await res.json()
      if (result.ok) {
        setActiveCampaign(result.result)
        setView('build')
      } else {
        setError(result.error ?? 'Campaign generation failed')
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  async function saveCampaign(campaign: Campaign) {
    const key = campaign.campaignName
    if (savedIds.has(key)) return
    try {
      await fetch('/api/restaurant/marketing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'save_campaign', campaignData: campaign }),
      })
      setSavedIds(prev => new Set([...prev, key]))
      setSavedCampaigns(prev => [{ ...campaign, savedAt: new Date().toISOString() }, ...prev])
    } catch { /* silent */ }
  }

  const revIsDown = data?.revTrendPct !== null && data?.revTrendPct !== undefined && data.revTrendPct < 0
  const revIsUp = data?.revTrendPct !== null && data?.revTrendPct !== undefined && data.revTrendPct > 0

  const bestDay = data?.dayTrend?.slice().sort((a, b) => b.revenue - a.revenue)[0]
  const worstDay = data?.dayTrend?.slice().sort((a, b) => a.revenue - b.revenue)[0]

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="h-8 w-8 text-orange-400 animate-spin" />
          <p className="text-sm text-gray-500">Loading marketing data...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-gradient-to-r from-orange-500 to-red-600 rounded-xl p-5 text-white">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 bg-white/20 rounded-xl">
              <Megaphone className="h-6 w-6 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold">AI Marketing Strategist</h2>
              <p className="text-orange-100 text-sm mt-0.5">
                Jesse diagnoses your growth problem and builds a complete campaign plan.
              </p>
            </div>
          </div>
          <button
            onClick={loadData}
            className="flex-shrink-0 p-2 rounded-lg bg-white/20 hover:bg-white/30 transition-colors"
            title="Refresh data"
          >
            <RefreshCw className="h-4 w-4 text-white" />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {[
          { id: 'diagnose', label: 'Diagnose', icon: <Brain className="h-3.5 w-3.5" /> },
          { id: 'build',    label: 'Campaign Builder', icon: <Sparkles className="h-3.5 w-3.5" /> },
          { id: 'history',  label: 'History', icon: <BarChart2 className="h-3.5 w-3.5" /> },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setView(tab.id as any)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold transition-all ${
              view === tab.id ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── DIAGNOSE TAB ───────────────────────────────────────────────────── */}
      {view === 'diagnose' && (
        <div className="space-y-5">
          {/* Snapshot cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-xs text-gray-500 font-medium">Revenue (30d)</p>
              <p className="text-xl font-bold text-gray-900 mt-1">{fmt(data?.rev30 ?? 0)}</p>
              {data?.revTrendPct !== null && data?.revTrendPct !== undefined && (
                <div className={`flex items-center gap-1 mt-1 text-xs font-semibold ${revIsDown ? 'text-red-500' : 'text-green-500'}`}>
                  {revIsDown ? <TrendingDown className="h-3.5 w-3.5" /> : <TrendingUp className="h-3.5 w-3.5" />}
                  {data.revTrendPct > 0 ? '+' : ''}{data.revTrendPct}% vs prev 30d
                </div>
              )}
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-xs text-gray-500 font-medium">Orders (30d)</p>
              <p className="text-xl font-bold text-gray-900 mt-1">{data?.salesCount30d ?? 0}</p>
              <p className="text-xs text-gray-400 mt-1">dish sales recorded</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-xs text-gray-500 font-medium">Best Day</p>
              <p className="text-lg font-bold text-gray-900 mt-1">{bestDay?.day ?? '—'}</p>
              <p className="text-xs text-gray-400 mt-1">{bestDay ? fmt(bestDay.revenue) + ' revenue' : 'No data'}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-xs text-gray-500 font-medium">Slowest Day</p>
              <p className="text-lg font-bold text-gray-900 mt-1">{worstDay?.day ?? '—'}</p>
              <p className="text-xs text-gray-400 mt-1">{worstDay ? fmt(worstDay.revenue) + ' revenue' : 'No data'}</p>
            </div>
          </div>

          {/* Top dishes */}
          {data?.topDishes && data.topDishes.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Top Performing Dishes (30d)</p>
              <div className="space-y-2">
                {data.topDishes.map((d, i) => {
                  const maxRev = data.topDishes[0].revenue
                  const pct = maxRev > 0 ? (d.revenue / maxRev) * 100 : 0
                  return (
                    <div key={i} className="flex items-center gap-3">
                      <span className="text-xs font-bold text-gray-400 w-4">{i + 1}</span>
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-sm font-medium text-gray-800">{d.name}</span>
                          <span className="text-xs text-gray-500">{d.orders} orders · {fmt(d.revenue)}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-orange-400 to-red-500 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Weekly trend */}
          {data?.weeklyTrend && data.weeklyTrend.length > 1 && (
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Weekly Revenue Trend</p>
              <div className="flex items-end gap-1 h-20">
                {data.weeklyTrend.map((w, i) => {
                  const max = Math.max(...data.weeklyTrend.map(x => x.revenue), 1)
                  const h = Math.max((w.revenue / max) * 100, 4)
                  const isLast = i === data.weeklyTrend.length - 1
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1 group relative">
                      <div
                        className={`w-full rounded-t transition-all ${isLast ? 'bg-orange-500' : 'bg-orange-200 group-hover:bg-orange-300'}`}
                        style={{ height: `${h}%` }}
                      />
                      <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap pointer-events-none z-10">
                        {fmt(w.revenue)}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-xs text-gray-400">{data.weeklyTrend[0]?.week}</span>
                <span className="text-xs text-orange-500 font-semibold">This week</span>
              </div>
            </div>
          )}

          {/* AI Diagnosis Block */}
          {!diagnosis ? (
            <div className="bg-gradient-to-br from-orange-50 to-red-50 border border-orange-200 rounded-xl p-6 text-center">
              <Brain className="h-10 w-10 text-orange-400 mx-auto mb-3" />
              <h3 className="font-bold text-gray-900 mb-1">Let Jesse Diagnose Your Restaurant</h3>
              <p className="text-sm text-gray-600 mb-4">
                Jesse will analyze your sales trends, dish performance, and timing patterns to identify exactly what's holding growth back — then recommend the right campaign.
              </p>
              <button
                onClick={runDiagnosis}
                disabled={diagnosing}
                className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-orange-500 to-red-600 text-white rounded-xl font-semibold text-sm hover:from-orange-600 hover:to-red-700 disabled:opacity-60 transition-all shadow-md"
              >
                {diagnosing ? (
                  <><RefreshCw className="h-4 w-4 animate-spin" /> Analysing...</>
                ) : (
                  <><Brain className="h-4 w-4" /> Run Diagnosis</>
                )}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Diagnosis result */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-orange-100 rounded-lg">
                      {CATEGORY_ICON[diagnosis.problemCategory] ?? <Brain className="h-4 w-4 text-orange-500" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-gray-900">{diagnosis.problemTitle}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${URGENCY_COLOR[diagnosis.urgency]}`}>
                          {diagnosis.urgency} urgency
                        </span>
                      </div>
                      <p className="text-xs text-orange-600 font-medium mt-0.5">{diagnosis.problemCategory} Problem</p>
                    </div>
                  </div>
                  <button
                    onClick={runDiagnosis}
                    className="flex-shrink-0 p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
                    title="Re-run diagnosis"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="p-5 space-y-4">
                  <p className="text-sm text-gray-700">{diagnosis.problemSummary}</p>

                  <div>
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Key Observations</p>
                    <ul className="space-y-1.5">
                      {diagnosis.keyObservations?.map((obs, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                          <CheckCircle className="h-3.5 w-3.5 text-orange-400 mt-0.5 flex-shrink-0" />
                          {obs}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="bg-blue-50 rounded-lg p-3">
                      <p className="text-xs font-bold text-blue-700 mb-1">Recommended Goal</p>
                      <p className="text-sm text-gray-700">{diagnosis.recommendedGoal}</p>
                    </div>
                    <div className="bg-amber-50 rounded-lg p-3">
                      <p className="text-xs font-bold text-amber-700 mb-1">Top Opportunity</p>
                      <p className="text-sm text-gray-700">{diagnosis.topOpportunity}</p>
                    </div>
                  </div>

                  {/* Magic Question */}
                  <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg p-3">
                    <div className="flex items-start gap-2">
                      <Sparkles className="h-4 w-4 text-purple-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-bold text-purple-700 mb-0.5">The Question to Answer</p>
                        <p className="text-sm font-medium text-gray-800 italic">"{diagnosis.magicQuestion}"</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Campaign type picker */}
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <p className="text-sm font-bold text-gray-900 mb-3">Now, choose a campaign type:</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
                  {CAMPAIGN_TYPES.map(ct => (
                    <button
                      key={ct.id}
                      onClick={() => setSelectedCampaignType(ct.id)}
                      className={`flex items-start gap-2 p-3 rounded-lg border text-left transition-all ${
                        selectedCampaignType === ct.id
                          ? 'border-orange-400 bg-orange-50 shadow-sm'
                          : 'border-gray-200 hover:border-orange-200 hover:bg-orange-50/40'
                      }`}
                    >
                      <span className={`mt-0.5 ${selectedCampaignType === ct.id ? 'text-orange-500' : 'text-gray-400'}`}>{ct.icon}</span>
                      <div>
                        <p className={`text-xs font-bold ${selectedCampaignType === ct.id ? 'text-orange-700' : 'text-gray-700'}`}>{ct.label}</p>
                        <p className="text-xs text-gray-500">{ct.desc}</p>
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  onClick={generateCampaign}
                  disabled={generating}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-gradient-to-r from-orange-500 to-red-600 text-white rounded-xl font-semibold text-sm hover:from-orange-600 hover:to-red-700 disabled:opacity-60 transition-all shadow-md"
                >
                  {generating ? (
                    <><RefreshCw className="h-4 w-4 animate-spin" /> Building your campaign...</>
                  ) : (
                    <><Sparkles className="h-4 w-4" /> Build Campaign Plan</>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── BUILD / CAMPAIGN TAB ───────────────────────────────────────────── */}
      {view === 'build' && (
        <div className="space-y-4">
          {!activeCampaign ? (
            <div className="bg-gray-50 rounded-xl border border-gray-200 p-8 text-center">
              <Sparkles className="h-10 w-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-500 mb-4">No campaign generated yet.</p>
              <button
                onClick={() => setView('diagnose')}
                className="inline-flex items-center gap-2 px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-semibold hover:bg-orange-600 transition-colors"
              >
                <Brain className="h-4 w-4" />
                Go to Diagnose tab to build one
              </button>
            </div>
          ) : (
            <CampaignCard
              campaign={activeCampaign}
              onSave={() => saveCampaign(activeCampaign)}
              saved={savedIds.has(activeCampaign.campaignName)}
            />
          )}
        </div>
      )}

      {/* ── HISTORY TAB ──────────────────────────────────────────────────────── */}
      {view === 'history' && (
        <div className="space-y-4">
          {savedCampaigns.length === 0 ? (
            <div className="bg-gray-50 rounded-xl border border-gray-200 p-8 text-center">
              <Award className="h-10 w-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-500 mb-1">No saved campaigns yet.</p>
              <p className="text-xs text-gray-400">Generate and save campaigns — they'll appear here.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-gray-700">{savedCampaigns.length} saved campaign{savedCampaigns.length !== 1 ? 's' : ''}</p>
              </div>

              {/* Campaign performance tracker */}
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Campaign Results Tracker</p>
                <div className="space-y-2">
                  {savedCampaigns.map((c, i) => (
                    <div key={i} className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-gray-800">{c.campaignName}</p>
                        <p className="text-xs text-gray-500">
                          {c.savedAt ? new Date(c.savedAt).toLocaleDateString() : 'Saved'} · {c.expectedImpact}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {c.result ? (
                          <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full font-semibold">{c.result}</span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full">In Progress</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                {savedCampaigns.map((c, i) => (
                  <CampaignCard
                    key={i}
                    campaign={c}
                    onSave={() => {}}
                    saved={true}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
