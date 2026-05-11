'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Users, CheckCircle, XCircle, Clock, RefreshCw, Plus,
  Trash2, Edit2, Save, X, ChevronDown, ChevronUp, Search,
  ShieldCheck, BadgeCheck, AlertTriangle, Activity, RotateCcw
} from 'lucide-react'
import AdminNav from '@/components/admin/AdminNav'
import { getDaysRemaining, isSubscriptionExpired } from '@/lib/subscriptions'

type User = {
  id: string
  name: string | null
  email: string
  role: string
  isActive: boolean
  isSuperAdmin: boolean
  subscriptionPlan: string | null
  subscriptionActivatedAt: string | null
  subscriptionExpiry: string | null
  createdAt: string
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

function expiryBadge(expiry: string | null) {
  if (!expiry) return null
  const expiryDate = new Date(expiry)
  const daysLeft = getDaysRemaining(expiryDate)
  if (isSubscriptionExpired(expiryDate)) return <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">Expired</span>
  if (daysLeft <= 7) return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">{daysLeft}d left</span>
  return <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold">{daysLeft}d left</span>
}

export default function AdminDashboard() {
  const [users, setUsers] = useState<User[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [loadingPlans, setLoadingPlans] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'users' | 'pricing' | 'sync'>('users')
  const [syncHealth, setSyncHealth] = useState<SyncHealth | null>(null)
  const [loadingSyncHealth, setLoadingSyncHealth] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [editingUser, setEditingUser] = useState<string | null>(null)
  const [editPlan, setEditPlan] = useState('')
  const [editExpiry, setEditExpiry] = useState('')

  // New plan form
  const [showNewPlan, setShowNewPlan] = useState(false)
  const [newPlan, setNewPlan] = useState({ name: '', duration: '', price: '', currency: 'GHS' })
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

  useEffect(() => { loadUsers(); loadPlans() }, [loadUsers, loadPlans])

  async function toggleActive(user: User) {
    setTogglingId(user.id)
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !user.isActive }),
      })
      if (res.ok) {
        const updated = await res.json()
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, ...updated } : u))
      }
    } finally {
      setTogglingId(null)
    }
  }

  async function saveSubscription(userId: string) {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriptionPlan: editPlan || null,
        subscriptionExpiry: editExpiry || null,
      }),
    })
    if (res.ok) {
      const updated = await res.json()
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, ...updated } : u))
      setEditingUser(null)
    }
  }

  function startEditUser(user: User) {
    setEditingUser(user.id)
    setEditPlan(user.subscriptionPlan ?? '')
    setEditExpiry(user.subscriptionExpiry ? user.subscriptionExpiry.slice(0, 10) : '')
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
        setNewPlan({ name: '', duration: '', price: '', currency: 'GHS' })
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

  async function togglePlanActive(plan: Plan) {
    await fetch(`/api/admin/pricing/${plan.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !plan.isActive }),
    })
    loadPlans()
  }

  const filtered = users.filter(u =>
    (u.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase())
  )

  const activeCount = users.filter(u => u.isActive && !u.isSuperAdmin).length
  const inactiveCount = users.filter(u => !u.isActive && !u.isSuperAdmin).length
  const totalCount = users.filter(u => !u.isSuperAdmin).length

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-orange-500" />
        <h1 className="text-lg font-bold">Magnify Admin</h1>
        <span className="ml-auto text-xs text-gray-500">Super Admin Dashboard</span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 px-6 py-5">
        <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
          <p className="text-xs text-gray-400 mb-1">Total Accounts</p>
          <p className="text-3xl font-bold">{totalCount}</p>
        </div>
        <div className="bg-green-950 rounded-2xl p-4 border border-green-900">
          <p className="text-xs text-green-400 mb-1">Active</p>
          <p className="text-3xl font-bold text-green-400">{activeCount}</p>
        </div>
        <div className="bg-red-950 rounded-2xl p-4 border border-red-900">
          <p className="text-xs text-red-400 mb-1">Pending / Inactive</p>
          <p className="text-3xl font-bold text-red-400">{inactiveCount}</p>
        </div>
      </div>

      <AdminNav />

      {/* Tabs */}
      <div className="px-6 flex gap-1 mb-4 flex-wrap">
        <button
          onClick={() => setTab('users')}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${tab === 'users' ? 'bg-orange-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
        >
          <Users className="inline h-4 w-4 mr-1.5" />Accounts
        </button>
        <button
          onClick={() => setTab('pricing')}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${tab === 'pricing' ? 'bg-orange-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
        >
          <BadgeCheck className="inline h-4 w-4 mr-1.5" />Pricing Plans
        </button>
        <button
          onClick={() => { setTab('sync'); loadSyncHealth() }}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors flex items-center gap-1.5 ${tab === 'sync' ? 'bg-orange-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
        >
          <Activity className="h-4 w-4" />Sync Health
          {syncHealth && (syncHealth.stalledRows.length + syncHealth.abandonedRows.length) > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full text-xs font-bold bg-red-600 text-white">
              {syncHealth.stalledRows.length + syncHealth.abandonedRows.length}
            </span>
          )}
        </button>
        <button
          onClick={() => { loadUsers(); loadPlans(); if (tab === 'sync') loadSyncHealth() }}
          className="ml-auto p-2 rounded-xl text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* USERS TAB */}
      {tab === 'users' && (
        <div className="px-6 pb-10">
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500"
              placeholder="Search by name or email..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {loadingUsers ? (
            <div className="flex justify-center py-16"><RefreshCw className="h-6 w-6 animate-spin text-orange-500" /></div>
          ) : (
            <div className="space-y-2">
              {filtered.map(user => (
                <div key={user.id} className={`bg-gray-900 border rounded-2xl p-4 transition-colors ${user.isActive ? 'border-gray-800' : 'border-red-900/60'}`}>
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 h-9 w-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${user.isActive ? 'bg-green-900 text-green-400' : 'bg-red-900 text-red-400'}`}>
                      {(user.name ?? user.email)[0].toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm truncate">{user.name ?? '—'}</p>
                        {user.isSuperAdmin && <span className="text-xs px-2 py-0.5 bg-purple-900 text-purple-300 rounded-full font-semibold">Super Admin</span>}
                        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${user.isActive ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
                          {user.isActive ? 'Active' : 'Inactive'}
                        </span>
                        {user.subscriptionPlan && (
                          <span className="text-xs px-2 py-0.5 bg-blue-900 text-blue-300 rounded-full font-semibold capitalize">{user.subscriptionPlan}</span>
                        )}
                        {expiryBadge(user.subscriptionExpiry)}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{user.email}</p>
                      <p className="text-xs text-gray-600 mt-0.5">Joined {formatDate(user.createdAt)} · {user.role}</p>
                    </div>

                    {/* Action buttons */}
                    {!user.isSuperAdmin && (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => startEditUser(user)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                          title="Set subscription"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => toggleActive(user)}
                          disabled={togglingId === user.id}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50 ${user.isActive ? 'bg-red-900 hover:bg-red-800 text-red-300' : 'bg-green-900 hover:bg-green-800 text-green-300'}`}
                        >
                          {togglingId === user.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : user.isActive ? <XCircle className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}
                          {user.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Subscription editor */}
                  {editingUser === user.id && (
                    <div className="mt-3 pt-3 border-t border-gray-800 flex flex-wrap gap-3 items-end">
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Plan</label>
                        <select
                          value={editPlan}
                          onChange={e => setEditPlan(e.target.value)}
                          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                        >
                          <option value="">None</option>
                          <option value="monthly">Monthly</option>
                          <option value="quarterly">Quarterly (3 months)</option>
                          <option value="yearly">Yearly</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Expiry Date</label>
                        <input
                          type="date"
                          value={editExpiry}
                          onChange={e => setEditExpiry(e.target.value)}
                          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => saveSubscription(user.id)} className="flex items-center gap-1.5 px-3 py-2 bg-orange-600 hover:bg-orange-700 rounded-xl text-sm font-semibold text-white transition-colors">
                          <Save className="h-3.5 w-3.5" /> Save
                        </button>
                        <button onClick={() => setEditingUser(null)} className="p-2 rounded-xl hover:bg-gray-700 text-gray-400 transition-colors">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="text-center py-12 text-gray-500">No accounts found</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* PRICING TAB */}
      {tab === 'pricing' && (
        <div className="px-6 pb-10">
          <div className="flex justify-between items-center mb-4">
            <p className="text-sm text-gray-400">These plans are shown to users on the pricing page.</p>
            <button
              onClick={() => setShowNewPlan(v => !v)}
              className="flex items-center gap-1.5 px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded-xl text-sm font-semibold text-white transition-colors"
            >
              <Plus className="h-4 w-4" /> New Plan
            </button>
          </div>

          {/* New plan form */}
          {showNewPlan && (
            <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 mb-4 space-y-3">
              <p className="text-sm font-semibold text-orange-400">Create New Plan</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Name</label>
                  <input value={newPlan.name} onChange={e => setNewPlan(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Monthly" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Duration (months)</label>
                  <input type="number" value={newPlan.duration} onChange={e => setNewPlan(p => ({ ...p, duration: e.target.value }))} placeholder="1" min="1" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Price</label>
                  <input type="number" value={newPlan.price} onChange={e => setNewPlan(p => ({ ...p, price: e.target.value }))} placeholder="0" min="0" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Currency</label>
                  <input value={newPlan.currency} onChange={e => setNewPlan(p => ({ ...p, currency: e.target.value }))} placeholder="GHS" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500" />
                </div>
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
                <div key={plan.id} className={`bg-gray-900 border rounded-2xl p-4 ${plan.isActive ? 'border-gray-800' : 'border-gray-700 opacity-60'}`}>
                  {editingPlanId === plan.id ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Name</label>
                        <input value={editingPlanData.name ?? plan.name} onChange={e => setEditingPlanData(p => ({ ...p, name: e.target.value }))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Duration (months)</label>
                        <input type="number" value={editingPlanData.duration ?? plan.duration} onChange={e => setEditingPlanData(p => ({ ...p, duration: Number(e.target.value) }))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Price</label>
                        <input type="number" value={editingPlanData.price ?? plan.price} onChange={e => setEditingPlanData(p => ({ ...p, price: Number(e.target.value) }))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Currency</label>
                        <input value={editingPlanData.currency ?? plan.currency} onChange={e => setEditingPlanData(p => ({ ...p, currency: e.target.value }))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500" />
                      </div>
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
                          <p className="font-semibold">{plan.name}</p>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${plan.isActive ? 'bg-green-900 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
                            {plan.isActive ? 'Visible' : 'Hidden'}
                          </span>
                        </div>
                        <p className="text-sm text-gray-400 mt-0.5">
                          {plan.duration} month{plan.duration !== 1 ? 's' : ''} · <span className="text-white font-semibold">{plan.currency} {plan.price.toLocaleString()}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => togglePlanActive(plan)} className="text-xs px-3 py-1.5 rounded-xl hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
                          {plan.isActive ? 'Hide' : 'Show'}
                        </button>
                        <button onClick={() => { setEditingPlanId(plan.id); setEditingPlanData({}) }} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button onClick={() => deletePlan(plan.id)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-950 transition-colors">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {plans.length === 0 && (
                <div className="text-center py-12 text-gray-500">No pricing plans yet. Create one above.</div>
              )}
            </div>
          )}
        </div>
      )}
      {/* SYNC HEALTH TAB */}
      {tab === 'sync' && (
        <div className="px-6 pb-10 space-y-6">
          {loadingSyncHealth ? (
            <div className="flex justify-center py-16"><RefreshCw className="h-6 w-6 animate-spin text-orange-500" /></div>
          ) : !syncHealth ? (
            <div className="text-center py-12 text-gray-500">
              <button onClick={loadSyncHealth} className="px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded-xl text-sm font-semibold text-white">Load Sync Health</button>
            </div>
          ) : (
            <>
              {/* Stalled rows (retries remaining) */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  <p className="text-sm font-semibold text-amber-400">Stalled — retries remaining ({syncHealth.stalledRows.length})</p>
                </div>
                {syncHealth.stalledRows.length === 0 ? (
                  <p className="text-sm text-gray-500">No stalled rows. All outbox rows are clear.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-gray-500 border-b border-gray-800">
                          <th className="pb-2 pr-4">Restaurant</th>
                          <th className="pb-2 pr-4">Entity</th>
                          <th className="pb-2 pr-4">ID</th>
                          <th className="pb-2 pr-4">Op</th>
                          <th className="pb-2 pr-4">Attempts</th>
                          <th className="pb-2 pr-4">Last Error</th>
                          <th className="pb-2">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {syncHealth.stalledRows.map(row => (
                          <tr key={row.id} className="py-2">
                            <td className="py-2 pr-4 text-gray-300">{row.restaurant?.name ?? row.restaurantId ?? '—'}</td>
                            <td className="py-2 pr-4 font-mono text-amber-400">{row.entityType}</td>
                            <td className="py-2 pr-4 font-mono text-gray-400 max-w-[140px] truncate">{row.entityId}</td>
                            <td className="py-2 pr-4 text-gray-400">{row.operation}</td>
                            <td className="py-2 pr-4 text-amber-400 font-bold">{row.attempts}</td>
                            <td className="py-2 pr-4 text-red-400 max-w-[200px] truncate" title={row.lastError ?? ''}>{row.lastError ?? '—'}</td>
                            <td className="py-2">
                              <button
                                onClick={() => forceRetry(row.id)}
                                disabled={retryingId === row.id}
                                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors disabled:opacity-50"
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

              {/* Abandoned rows (exhausted retries) */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <XCircle className="h-4 w-4 text-red-500" />
                  <p className="text-sm font-semibold text-red-400">Abandoned — all retries exhausted ({syncHealth.abandonedRows.length})</p>
                </div>
                {syncHealth.abandonedRows.length === 0 ? (
                  <p className="text-sm text-gray-500">No abandoned rows.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-gray-500 border-b border-gray-800">
                          <th className="pb-2 pr-4">Restaurant</th>
                          <th className="pb-2 pr-4">Entity</th>
                          <th className="pb-2 pr-4">ID</th>
                          <th className="pb-2 pr-4">Last Error</th>
                          <th className="pb-2">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {syncHealth.abandonedRows.map(row => (
                          <tr key={row.id}>
                            <td className="py-2 pr-4 text-gray-300">{row.restaurant?.name ?? row.restaurantId ?? '—'}</td>
                            <td className="py-2 pr-4 font-mono text-red-400">{row.entityType}</td>
                            <td className="py-2 pr-4 font-mono text-gray-400 max-w-[140px] truncate">{row.entityId}</td>
                            <td className="py-2 pr-4 text-red-400 max-w-[240px] truncate" title={row.lastError ?? ''}>{row.lastError ?? '—'}</td>
                            <td className="py-2">
                              <button
                                onClick={() => forceRetry(row.id)}
                                disabled={retryingId === row.id}
                                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-red-950 hover:bg-red-900 text-red-400 hover:text-red-200 transition-colors disabled:opacity-50"
                              >
                                {retryingId === row.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                                Force Retry
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Recent entity apply failures */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="h-4 w-4 text-gray-500" />
                  <p className="text-sm font-semibold text-gray-400">Recent entity apply failures (last 50)</p>
                </div>
                {syncHealth.recentFailures.length === 0 ? (
                  <p className="text-sm text-gray-500">No recorded entity failures.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-gray-500 border-b border-gray-800">
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
                            <td className="py-2 text-gray-500 whitespace-nowrap">{new Date(f.createdAt).toLocaleString()}</td>
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
