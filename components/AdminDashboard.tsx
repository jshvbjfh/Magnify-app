'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  RefreshCw, Search, ShieldOff, CheckCircle, UserPlus,
  CreditCard, Users, Edit2, Save, X, BadgeCheck,
  Plus, Trash2, Activity, AlertTriangle, RotateCcw, XCircle, Clock,
} from 'lucide-react'
import AdminNav from '@/components/admin/AdminNav'

// --- Types ---
type User = {
  id: string
  name: string | null
  email: string
  role: string
  isActive: boolean
  isSuperAdmin: boolean
  createdAt: string
  licenseExpiry: string | null
  licenseActive: boolean
}

type Plan = {
  id: string
  name: string
  duration: number
  price: number
  currency: string
  isActive: boolean
}

type OutboxRow = {
  id: string
  entityType: string
  entityId: string
  operation: string
  attempts: number
  lastError: string | null
  restaurantId: string | null
  updatedAt: string
  restaurant: { name: string } | null
}

type FailureEvent = {
  id: string
  restaurantId: string
  message: string
  createdAt: string
  restaurant: { name: string } | null
}

type SyncHealth = {
  stalledRows: OutboxRow[]
  abandonedRows: OutboxRow[]
  recentFailures: FailureEvent[]
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function isExpired(expiry: string | null) {
  if (!expiry) return false
  return new Date(expiry) < new Date()
}

function planLabel(u: User) {
  if (!u.licenseExpiry) return 'Not assigned'
  return isExpired(u.licenseExpiry) ? 'Expired' : 'Active'
}

function avatar(u: User) {
  const colors = [
    'bg-green-700', 'bg-blue-700', 'bg-purple-700', 'bg-orange-700',
    'bg-teal-700', 'bg-red-800', 'bg-indigo-700', 'bg-pink-700',
  ]
  const idx = (u.name ?? u.email).charCodeAt(0) % colors.length
  return colors[idx]
}

// --- Component ---
export default function AdminDashboard() {
  const [users, setUsers] = useState<User[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'clients' | 'new' | 'billing' | 'pricing' | 'sync'>('clients')
  const [syncHealth, setSyncHealth] = useState<SyncHealth | null>(null)
  const [loadingSyncHealth, setLoadingSyncHealth] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [editingUser, setEditingUser] = useState<string | null>(null)
  const [editExpiry, setEditExpiry] = useState('')
  const [loadingPlans, setLoadingPlans] = useState(false)
  const [showNewPlan, setShowNewPlan] = useState(false)
  const [newPlan, setNewPlan] = useState({ name: '', duration: '', price: '', currency: 'RWF' })
  const [savingPlan, setSavingPlan] = useState(false)
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const [editingPlanData, setEditingPlanData] = useState<Partial<Plan>>({})

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true)
    try {
      const res = await fetch('/api/admin/users')
      if (res.ok) setUsers(await res.json())
    } finally {
      setLoadingUsers(false)
    }
  }, [])

  const loadPlans = useCallback(async () => {
    setLoadingPlans(true)
    try {
      const res = await fetch('/api/admin/pricing')
      if (res.ok) setPlans(await res.json())
    } finally {
      setLoadingPlans(false)
    }
  }, [])

  const loadSyncHealth = useCallback(async () => {
    setLoadingSyncHealth(true)
    try {
      const res = await fetch('/api/admin/sync-health')
      if (res.ok) setSyncHealth(await res.json())
    } finally {
      setLoadingSyncHealth(false)
    }
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

  async function toggleActive(user: User) {
    setTogglingId(user.id)
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !user.isActive }),
      })
      if (res.ok) {
        setUsers(prev => prev.map(u => u.id === user.id
          ? { ...u, isActive: !user.isActive, licenseActive: !user.isActive }
          : u
        ))
      }
    } finally {
      setTogglingId(null)
    }
  }

  async function saveExpiry(userId: string) {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseExpiry: editExpiry || null }),
    })
    if (res.ok) {
      setUsers(prev => prev.map(u => u.id === userId
        ? { ...u, licenseExpiry: editExpiry ? new Date(editExpiry).toISOString() : null }
        : u
      ))
      setEditingUser(null)
    }
  }

  async function createPlan() {
    if (!newPlan.name || !newPlan.duration || !newPlan.price) return
    setSavingPlan(true)
    try {
      const res = await fetch('/api/admin/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newPlan.name,
          duration: Number(newPlan.duration),
          price: Number(newPlan.price),
          currency: newPlan.currency,
        }),
      })
      if (res.ok) {
        setNewPlan({ name: '', duration: '', price: '', currency: 'RWF' })
        setShowNewPlan(false)
        loadPlans()
      }
    } finally {
      setSavingPlan(false)
    }
  }

  async function savePlan(id: string) {
    const res = await fetch(`/api/admin/pricing/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingPlanData),
    })
    if (res.ok) { setEditingPlanId(null); loadPlans() }
  }

  async function deletePlan(id: string) {
    if (!confirm('Delete this pricing plan?')) return
    await fetch(`/api/admin/pricing/${id}`, { method: 'DELETE' })
    loadPlans()
  }

  async function forceRetry(outboxId: string) {
    setRetryingId(outboxId)
    try {
      await fetch('/api/admin/sync-health', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outboxId }),
      })
      await loadSyncHealth()
    } finally {
      setRetryingId(null)
    }
  }

  // --- Derived counts ---
  const allManagers   = users.filter(u => !u.isSuperAdmin)
  // Pending = not yet activated (isActive false, licenseActive still true = never activated)
  const pendingUsers  = allManagers.filter(u => !u.isActive && u.licenseActive)
  // Billing = blocked / subscription ended (isActive false, licenseActive false = explicitly ended)
  const billingUsers  = allManagers.filter(u => !u.isActive && !u.licenseActive)
  const clientUsers   = allManagers.filter(u => u.isActive)

  const tabUsers = tab === 'clients' ? clientUsers
    : tab === 'new' ? pendingUsers
    : tab === 'billing' ? billingUsers
    : []

  const filtered = tabUsers.filter(u =>
    (u.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase())
  )

  function handleTabChange(t: typeof tab) {
    setTab(t)
    if (t === 'pricing' && plans.length === 0) loadPlans()
    if (t === 'sync') loadSyncHealth()
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">

      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center gap-3">
        <div className="flex items-center gap-2 flex-1">
          <div className="h-7 w-7 rounded-lg bg-orange-600 flex items-center justify-center flex-shrink-0">
            <ShieldOff className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight">Magnify Admin</h1>
            <p className="text-[11px] text-gray-500 leading-tight">
              Manager accounts control access for every linked owner, waiter and kitchen user
            </p>
          </div>
        </div>
        <AdminNav />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-0 border-b border-gray-800">
        <div className="px-6 py-5 border-r border-gray-800">
          <p className="text-xs text-gray-500 mb-1">Manager Accounts</p>
          <p className="text-3xl font-bold">{allManagers.length}</p>
        </div>
        <div className="px-6 py-5 border-r border-gray-800 bg-red-950/40">
          <p className="text-xs text-red-400 mb-1">New A/C</p>
          <p className="text-3xl font-bold text-red-300">{pendingUsers.length}</p>
        </div>
        <div className="px-6 py-5 bg-orange-950/30">
          <p className="text-xs text-orange-400 mb-1">Ended Subscriptions</p>
          <p className="text-3xl font-bold text-orange-300">{billingUsers.length}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-1 flex-wrap">
        {([
          { key: 'clients',  label: 'Clients',      count: clientUsers.length,  icon: <Users className="h-3.5 w-3.5" /> },
          { key: 'new',      label: 'New A/C',       count: pendingUsers.length, icon: <UserPlus className="h-3.5 w-3.5" /> },
          { key: 'billing',  label: 'Billing',       count: billingUsers.length, icon: <CreditCard className="h-3.5 w-3.5" /> },
          { key: 'pricing',  label: 'Plans',         count: null,                icon: <BadgeCheck className="h-3.5 w-3.5" /> },
          { key: 'sync',     label: 'Sync Health',   count: syncHealth ? (syncHealth.stalledRows.length + syncHealth.abandonedRows.length) : null, icon: <Activity className="h-3.5 w-3.5" /> },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => handleTabChange(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              tab === t.key
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            {t.icon}
            {t.label}
            {t.count !== null && t.count > 0 && (
              <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                t.key === 'new' ? 'bg-red-700 text-white' :
                t.key === 'billing' ? 'bg-orange-700 text-white' :
                'bg-gray-600 text-white'
              }`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
        <button
          onClick={() => { loadUsers(); if (tab === 'sync') loadSyncHealth() }}
          className="ml-auto p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* --- CLIENTS / NEW A/C / BILLING tabs --- */}
      {(tab === 'clients' || tab === 'new' || tab === 'billing') && (
        <div className="px-4 pb-10">
          {/* Search */}
          <div className="relative my-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-600" />
            <input
              className="w-full bg-gray-900 border border-gray-800 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-orange-600"
              placeholder="Search by name or email..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {loadingUsers ? (
            <div className="flex justify-center py-16">
              <RefreshCw className="h-6 w-6 animate-spin text-orange-500" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 text-gray-600 text-sm">
              {tab === 'new' ? 'No pending accounts — all caught up.' :
               tab === 'billing' ? 'No ended subscriptions.' :
               'No active accounts found.'}
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map(user => (
                <div key={user.id} className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
                  <div className="flex items-start gap-3">
                    {/* Avatar */}
                    <div className={`mt-0.5 h-9 w-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${avatar(user)}`}>
                      {(user.name ?? user.email)[0].toUpperCase()}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm">{user.name ?? '—'}</p>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                          user.isActive ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'
                        }`}>
                          {user.isActive ? 'Active' : 'Pending'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{user.email}</p>
                      <p className="text-xs text-gray-600 mt-0.5">
                        Joined {formatDate(user.createdAt)} · Manager account
                      </p>
                      <p className="text-xs text-gray-600 mt-0.5">
                        Plan: {planLabel(user)} · Expires {formatDate(user.licenseExpiry)}
                      </p>
                      <p className="text-[11px] text-gray-700 mt-1">
                        Blocking this manager account also blocks every linked owner, waiter and kitchen login for this restaurant.
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Set expiry */}
                      <button
                        onClick={() => { setEditingUser(u => u === user.id ? null : user.id); setEditExpiry(user.licenseExpiry?.slice(0, 10) ?? '') }}
                        className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-gray-700 transition-colors"
                        title="Set expiry"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>

                      {/* Block / Activate */}
                      {user.isActive ? (
                        <button
                          onClick={() => toggleActive(user)}
                          disabled={togglingId === user.id}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-red-950 hover:bg-red-900 text-red-400 hover:text-red-200 border border-red-900 transition-colors disabled:opacity-50"
                        >
                          {togglingId === user.id
                            ? <RefreshCw className="h-3 w-3 animate-spin" />
                            : <ShieldOff className="h-3 w-3" />}
                          Block business
                        </button>
                      ) : (
                        <button
                          onClick={() => toggleActive(user)}
                          disabled={togglingId === user.id}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-green-950 hover:bg-green-900 text-green-400 hover:text-green-200 border border-green-900 transition-colors disabled:opacity-50"
                        >
                          {togglingId === user.id
                            ? <RefreshCw className="h-3 w-3 animate-spin" />
                            : <CheckCircle className="h-3 w-3" />}
                          Activate
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expiry editor */}
                  {editingUser === user.id && (
                    <div className="mt-3 pt-3 border-t border-gray-800 flex items-end gap-3 flex-wrap">
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">License Expiry</label>
                        <input
                          type="date"
                          value={editExpiry}
                          onChange={e => setEditExpiry(e.target.value)}
                          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-orange-500"
                        />
                      </div>
                      <button
                        onClick={() => saveExpiry(user.id)}
                        className="flex items-center gap-1.5 px-3 py-2 bg-orange-600 hover:bg-orange-700 rounded-xl text-sm font-semibold text-white transition-colors"
                      >
                        <Save className="h-3.5 w-3.5" /> Save
                      </button>
                      <button onClick={() => setEditingUser(null)} className="p-2 rounded-xl hover:bg-gray-700 text-gray-500 transition-colors">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* --- PRICING tab --- */}
      {tab === 'pricing' && (
        <div className="px-4 pb-10 pt-4">
          <div className="flex justify-between items-center mb-4">
            <p className="text-sm text-gray-500">Pricing plans shown to users on the pricing page.</p>
            <button
              onClick={() => setShowNewPlan(v => !v)}
              className="flex items-center gap-1.5 px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded-xl text-sm font-semibold text-white transition-colors"
            >
              <Plus className="h-4 w-4" /> New Plan
            </button>
          </div>

          {showNewPlan && (
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 mb-4 space-y-3">
              <p className="text-sm font-semibold text-orange-400">Create New Plan</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: 'Name', key: 'name', type: 'text', placeholder: 'e.g. Monthly' },
                  { label: 'Duration (months)', key: 'duration', type: 'number', placeholder: '1' },
                  { label: 'Price', key: 'price', type: 'number', placeholder: '0' },
                  { label: 'Currency', key: 'currency', type: 'text', placeholder: 'RWF' },
                ].map(f => (
                  <div key={f.key}>
                    <label className="text-xs text-gray-500 block mb-1">{f.label}</label>
                    <input
                      type={f.type}
                      placeholder={f.placeholder}
                      value={(newPlan as any)[f.key]}
                      onChange={e => setNewPlan(p => ({ ...p, [f.key]: e.target.value }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-orange-500"
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={createPlan} disabled={savingPlan} className="flex items-center gap-1.5 px-4 py-2 bg-green-700 hover:bg-green-600 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-50">
                  <Save className="h-3.5 w-3.5" /> {savingPlan ? 'Saving...' : 'Create'}
                </button>
                <button onClick={() => setShowNewPlan(false)} className="px-3 py-2 rounded-xl hover:bg-gray-700 text-gray-400 text-sm transition-colors">Cancel</button>
              </div>
            </div>
          )}

          {loadingPlans ? (
            <div className="flex justify-center py-16"><RefreshCw className="h-6 w-6 animate-spin text-orange-500" /></div>
          ) : (
            <div className="space-y-3">
              {plans.map(plan => (
                <div key={plan.id} className={`bg-gray-900 border rounded-2xl p-4 ${plan.isActive ? 'border-gray-800' : 'border-gray-800 opacity-50'}`}>
                  {editingPlanId === plan.id ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        { label: 'Name', key: 'name', type: 'text', val: editingPlanData.name ?? plan.name },
                        { label: 'Duration (months)', key: 'duration', type: 'number', val: String(editingPlanData.duration ?? plan.duration) },
                        { label: 'Price', key: 'price', type: 'number', val: String(editingPlanData.price ?? plan.price) },
                        { label: 'Currency', key: 'currency', type: 'text', val: editingPlanData.currency ?? plan.currency },
                      ].map(f => (
                        <div key={f.key}>
                          <label className="text-xs text-gray-500 block mb-1">{f.label}</label>
                          <input
                            type={f.type}
                            value={f.val}
                            onChange={e => setEditingPlanData(p => ({ ...p, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value }))}
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-orange-500"
                          />
                        </div>
                      ))}
                      <div className="col-span-2 sm:col-span-4 flex gap-2">
                        <button onClick={() => savePlan(plan.id)} className="flex items-center gap-1.5 px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded-xl text-sm font-semibold text-white transition-colors">
                          <Save className="h-3.5 w-3.5" /> Save
                        </button>
                        <button onClick={() => setEditingPlanId(null)} className="px-3 py-2 rounded-xl hover:bg-gray-700 text-gray-400 text-sm transition-colors">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-sm">{plan.name}</p>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${plan.isActive ? 'bg-green-900 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
                            {plan.isActive ? 'Visible' : 'Hidden'}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {plan.duration} month{plan.duration !== 1 ? 's' : ''} · <span className="text-white font-semibold">{plan.currency} {plan.price.toLocaleString()}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => fetch(`/api/admin/pricing/${plan.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !plan.isActive }) }).then(() => loadPlans())}
                          className="text-xs px-3 py-1.5 rounded-xl hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                        >
                          {plan.isActive ? 'Hide' : 'Show'}
                        </button>
                        <button onClick={() => { setEditingPlanId(plan.id); setEditingPlanData({}) }} className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-gray-700 transition-colors">
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => deletePlan(plan.id)} className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-950 transition-colors">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {plans.length === 0 && <div className="text-center py-12 text-gray-600 text-sm">No pricing plans yet.</div>}
            </div>
          )}
        </div>
      )}

      {/* --- SYNC HEALTH tab --- */}
      {tab === 'sync' && (
        <div className="px-4 pb-10 pt-4 space-y-6">
          {loadingSyncHealth ? (
            <div className="flex justify-center py-16"><RefreshCw className="h-6 w-6 animate-spin text-orange-500" /></div>
          ) : !syncHealth ? (
            <div className="text-center py-12">
              <button onClick={loadSyncHealth} className="px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded-xl text-sm font-semibold text-white">Load Sync Health</button>
            </div>
          ) : (
            <>
              {[
                { label: `Stalled — retries remaining (${syncHealth.stalledRows.length})`, rows: syncHealth.stalledRows, color: 'text-amber-400', icon: <AlertTriangle className="h-4 w-4 text-amber-500" /> },
                { label: `Abandoned — all retries exhausted (${syncHealth.abandonedRows.length})`, rows: syncHealth.abandonedRows, color: 'text-red-400', icon: <XCircle className="h-4 w-4 text-red-500" /> },
              ].map(section => (
                <div key={section.label}>
                  <div className="flex items-center gap-2 mb-3">{section.icon}<p className={`text-sm font-semibold ${section.color}`}>{section.label}</p></div>
                  {section.rows.length === 0 ? (
                    <p className="text-sm text-gray-600">All clear.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-gray-600 border-b border-gray-800">
                            <th className="pb-2 pr-4">Restaurant</th>
                            <th className="pb-2 pr-4">Entity</th>
                            <th className="pb-2 pr-4">Op</th>
                            <th className="pb-2 pr-4">Attempts</th>
                            <th className="pb-2 pr-4">Last Error</th>
                            <th className="pb-2">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                          {section.rows.map(row => (
                            <tr key={row.id}>
                              <td className="py-2 pr-4 text-gray-300">{row.restaurant?.name ?? row.restaurantId ?? '—'}</td>
                              <td className="py-2 pr-4 font-mono text-amber-400">{row.entityType}</td>
                              <td className="py-2 pr-4 text-gray-400">{row.operation}</td>
                              <td className="py-2 pr-4 text-amber-400 font-bold">{row.attempts}</td>
                              <td className="py-2 pr-4 text-red-400 max-w-[200px] truncate" title={row.lastError ?? ''}>{row.lastError ?? '—'}</td>
                              <td className="py-2">
                                <button
                                  onClick={() => forceRetry(row.id)}
                                  disabled={retryingId === row.id}
                                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                                >
                                  {retryingId === row.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                                  Retry
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}

              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="h-4 w-4 text-gray-600" />
                  <p className="text-sm font-semibold text-gray-500">Recent entity failures (last 50)</p>
                </div>
                {syncHealth.recentFailures.length === 0 ? (
                  <p className="text-sm text-gray-600">No recorded failures.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-gray-600 border-b border-gray-800">
                          <th className="pb-2 pr-4">Restaurant</th>
                          <th className="pb-2 pr-4">Message</th>
                          <th className="pb-2">Time</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {syncHealth.recentFailures.map(f => (
                          <tr key={f.id}>
                            <td className="py-2 pr-4 text-gray-300 whitespace-nowrap">{f.restaurant?.name ?? f.restaurantId}</td>
                            <td className="py-2 pr-4 text-red-400 max-w-[360px] truncate" title={f.message}>{f.message}</td>
                            <td className="py-2 text-gray-600 whitespace-nowrap">{new Date(f.createdAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
