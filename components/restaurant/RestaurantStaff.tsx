'use client'
import { useState, useEffect } from 'react'
import { Plus, Users, Clock, X, CheckCircle2, Sparkles, UserCheck, Copy, Trash2, Eye, EyeOff, Wifi, ChefHat, Crown } from 'lucide-react'

type Employee = { id:string; name:string; role:string; payType:string; payRate:number; isActive:boolean; phone:string|null }
type Shift = { id:string; employee:{name:string}; date:string; hoursWorked:number; calculatedWage:number; notes:string|null }
type Waiter = { id:string; name:string; email:string; createdAt:string }
type Restaurant = { id:string; name:string; joinCode:string }

const ROLES = ['Chef','Sous Chef','Waiter','Cashier','Manager','Host','Dishwasher','Bartender']
const PAY_TYPES = ['hourly','daily','monthly']

export default function RestaurantStaff({ onAskJesse }: { onAskJesse?: () => void }) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [shifts, setShifts] = useState<Shift[]>([])
  const [waiters, setWaiters] = useState<Waiter[]>([])
  const [restaurant, setRestaurant] = useState<Restaurant|null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [tab, setTab] = useState<'employees'|'shifts'|'waiters'|'kitchen'|'owner'>('employees')
  const [showEmpForm, setShowEmpForm] = useState(false)
  const [showShiftForm, setShowShiftForm] = useState(false)
  const [showWaiterForm, setShowWaiterForm] = useState(false)
  const [showKitchenForm, setShowKitchenForm] = useState(false)
  const [shiftSuccess, setShiftSuccess] = useState(false)
  const [waiterSuccess, setWaiterSuccess] = useState(false)
  const [kitchenSuccess, setKitchenSuccess] = useState(false)
  const [ownerAccounts, setOwnerAccounts] = useState<Waiter[]>([])
  const [showOwnerForm, setShowOwnerForm] = useState(false)
  const [ownerForm, setOwnerForm] = useState({name:'',email:'',password:''})
  const [ownerSuccess, setOwnerSuccess] = useState(false)
  const [lastCreatedOwner, setLastCreatedOwner] = useState<{name:string;email:string;password:string}|null>(null)
  const [ownerCredCopied, setOwnerCredCopied] = useState<'email'|'password'|null>(null)
  const [codeCopied, setCodeCopied] = useState(false)
  const [kitchenAccounts, setKitchenAccounts] = useState<Waiter[]>([])
  const [kitchenForm, setKitchenForm] = useState({name:'',email:'',password:''})
  const [lastCreated, setLastCreated] = useState<{name:string;email:string;password:string}|null>(null)
  const [lastCreatedKitchen, setLastCreatedKitchen] = useState<{name:string;email:string;password:string}|null>(null)
  const [credCopied, setCredCopied] = useState<'email'|'password'|null>(null)
  const [kitchenCredCopied, setKitchenCredCopied] = useState<'email'|'password'|null>(null)
  const [urlCopied, setUrlCopied] = useState(false)
  const [waiterUrl, setWaiterUrl] = useState<string>('')
  const [showPasswords, setShowPasswords] = useState<Record<string,boolean>>({})
  const [empForm, setEmpForm] = useState({name:'',role:'Waiter',payType:'daily',payRate:'',phone:''})
  const [shiftForm, setShiftForm] = useState({employeeId:'',date:new Date().toISOString().split('T')[0],hoursWorked:'8',notes:''})
  const [waiterForm, setWaiterForm] = useState({name:'',email:'',password:''})

  async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
    try {
      const res = await fetch(url, init)
      const text = await res.text()
      if (!text.trim()) return null
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  async function load() {
    setLoading(true)
    setLoadError(null)
    const [e, s] = await Promise.all([
      fetchJson<Employee[]>('/api/restaurant/employees', { credentials: 'include' }),
      fetchJson<Shift[]>('/api/restaurant/shifts', { credentials: 'include' }),
    ])
    setEmployees(Array.isArray(e) ? e : [])
    setShifts(Array.isArray(s) ? s : [])
    if (!e || !s) {
      setLoadError('Some staff data could not be loaded. Check the local server connection and refresh again.')
    }
    setLoading(false)
  }

  async function loadWaiters() {
    const data = await fetchJson<{ waiters?: Waiter[]; restaurant?: Restaurant }>('/api/restaurant/waiters', { credentials:'include' })
    if (!data) {
      setLoadError('Waiter accounts could not be loaded from the local server.')
      return
    }
    setWaiters(Array.isArray(data.waiters) ? data.waiters : [])
    if (data.restaurant) setRestaurant(data.restaurant)
  }

  async function loadKitchenAccounts() {
    const data = await fetchJson<{ kitchenUsers?: Waiter[] }>('/api/restaurant/kitchen', { credentials:'include' })
    if (!data) {
      setLoadError('Kitchen accounts could not be loaded from the local server.')
      return
    }
    setKitchenAccounts(Array.isArray(data.kitchenUsers) ? data.kitchenUsers : [])
  }

  async function loadOwnerAccounts() {
    const data = await fetchJson<{ waiters?: Waiter[]; restaurant?: Restaurant }>('/api/restaurant/waiters', { credentials:'include' })
    if (!data) {
      setLoadError('Owner accounts could not be loaded from the local server.')
      return
    }
    const all: Waiter[] = Array.isArray(data.waiters) ? data.waiters : []
    setOwnerAccounts(all.filter(w => (w as any).role === 'owner'))
    setWaiters(all.filter(w => (w as any).role === 'waiter'))
    if (data.restaurant) setRestaurant(data.restaurant)
  }

  useEffect(()=>{
    load()
    loadWaiters()
    loadKitchenAccounts()
    loadOwnerAccounts()
    fetchJson<{ waiterUrl?: string }>('/api/restaurant/server-info').then(d=>{ if(d?.waiterUrl) setWaiterUrl(d.waiterUrl) })
  },[])

  async function saveEmployee(e:React.FormEvent) {
    e.preventDefault()
    setActionError(null)
    const res = await fetch('/api/restaurant/employees',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({name:empForm.name,role:empForm.role,payType:empForm.payType,payRate:Number(empForm.payRate),phone:empForm.phone||null})})
    if (!res.ok) {
      const payload = await res.json().catch(() => null)
      setActionError(payload?.error || 'Failed to create employee.')
      return
    }
    setShowEmpForm(false); setEmpForm({name:'',role:'Waiter',payType:'daily',payRate:'',phone:''}); load()
  }

  async function toggleEmployee(emp:Employee) {
    await fetch('/api/restaurant/employees/'+emp.id,{method:'PATCH',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({isActive:!emp.isActive})})
    load()
  }

  async function logShift(e:React.FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/restaurant/shifts',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({employeeId:shiftForm.employeeId,date:shiftForm.date,hoursWorked:Number(shiftForm.hoursWorked),notes:shiftForm.notes||null})})
    if(res.ok){setShiftSuccess(true);setTimeout(()=>setShiftSuccess(false),3000);setShowShiftForm(false);setShiftForm({employeeId:'',date:new Date().toISOString().split('T')[0],hoursWorked:'8',notes:''});load()}
  }

  async function saveWaiter(e:React.FormEvent) {
    e.preventDefault()
    setActionError(null)
    const snapshot = { ...waiterForm }
    const res = await fetch('/api/restaurant/waiters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(waiterForm),credentials:'include'})
    if(res.ok){
      setLastCreated({ name: snapshot.name, email: snapshot.email, password: snapshot.password })
      setWaiterSuccess(true);setTimeout(()=>setWaiterSuccess(false),3000)
      setShowWaiterForm(false);setWaiterForm({name:'',email:'',password:''})
      loadOwnerAccounts()
      return
    }
    const payload = await res.json().catch(() => null)
    setActionError(payload?.error || 'Failed to create waiter account.')
  }

  async function saveKitchenAccount(e:React.FormEvent) {
    e.preventDefault()
    setActionError(null)
    const snapshot = { ...kitchenForm }
    const res = await fetch('/api/restaurant/kitchen',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(kitchenForm),credentials:'include'})
    if(res.ok){
      setLastCreatedKitchen({ name: snapshot.name, email: snapshot.email, password: snapshot.password })
      setKitchenSuccess(true);setTimeout(()=>setKitchenSuccess(false),3000)
      setShowKitchenForm(false);setKitchenForm({name:'',email:'',password:''})
      loadKitchenAccounts()
      return
    }
    const payload = await res.json().catch(() => null)
    setActionError(payload?.error || 'Failed to create kitchen account.')
  }

  async function deleteKitchenAccount(id:string) {
    if(!confirm('Remove this kitchen account?')) return
    await fetch('/api/restaurant/kitchen/'+id,{method:'DELETE',credentials:'include'})
    loadKitchenAccounts()
  }

  async function saveOwnerAccount(e:React.FormEvent) {
    e.preventDefault()
    setActionError(null)
    const snapshot = { ...ownerForm }
    const res = await fetch('/api/restaurant/waiters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...ownerForm,role:'owner'}),credentials:'include'})
    if(res.ok){
      setLastCreatedOwner({ name: snapshot.name, email: snapshot.email, password: snapshot.password })
      setOwnerSuccess(true);setTimeout(()=>setOwnerSuccess(false),3000)
      setShowOwnerForm(false);setOwnerForm({name:'',email:'',password:''})
      loadOwnerAccounts()
      return
    }
    const payload = await res.json().catch(() => null)
    setActionError(payload?.error || 'Failed to create owner account.')
  }

  async function deleteOwnerAccount(id:string) {
    if(!confirm('Remove this owner account?')) return
    await fetch('/api/restaurant/waiters/'+id,{method:'DELETE',credentials:'include'})
    loadOwnerAccounts()
  }

  function copyOwnerCredential(type: 'email'|'password', value: string) {
    navigator.clipboard.writeText(value)
    setOwnerCredCopied(type)
    setTimeout(()=>setOwnerCredCopied(null), 2000)
  }

  function copyKitchenCredential(type: 'email'|'password', value: string) {
    navigator.clipboard.writeText(value)
    setKitchenCredCopied(type)
    setTimeout(()=>setKitchenCredCopied(null), 2000)
  }

  function copyCredential(type: 'email'|'password', value: string) {
    navigator.clipboard.writeText(value)
    setCredCopied(type)
    setTimeout(()=>setCredCopied(null), 2000)
  }

  async function deleteWaiter(id:string) {
    if(!confirm('Remove this waiter account?')) return
    await fetch('/api/restaurant/waiters/'+id,{method:'DELETE',credentials:'include'})
    loadWaiters()
  }

  function copyJoinCode() {
    if(restaurant) navigator.clipboard.writeText(restaurant.joinCode)
    setCodeCopied(true); setTimeout(()=>setCodeCopied(false),2000)
  }

  function copyWaiterUrl() {
    if(waiterUrl) navigator.clipboard.writeText(waiterUrl)
    setUrlCopied(true); setTimeout(()=>setUrlCopied(false),2000)
  }

  const totalLaborThisMonth = shifts.filter(s=>new Date(s.date).getMonth()===new Date().getMonth()).reduce((sum,s)=>sum+s.calculatedWage,0)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-lg font-bold text-gray-800">Staff Management</h2>
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <button onClick={onAskJesse} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-white hover:bg-orange-50 transition-colors">
            <Sparkles className="h-3.5 w-3.5"/> Ask Jesse
          </button>
          {tab==='employees'&&<button onClick={()=>setShowEmpForm(true)} className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"><Plus className="h-4 w-4"/> Add Employee</button>}
          {tab==='shifts'&&<button onClick={()=>setShowShiftForm(true)} disabled={employees.length===0} className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"><Clock className="h-4 w-4"/> Log Shift</button>}
          {tab==='waiters'&&<button onClick={()=>setShowWaiterForm(true)} className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"><Plus className="h-4 w-4"/> Add Waiter</button>}
          {tab==='kitchen'&&<button onClick={()=>setShowKitchenForm(true)} className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"><Plus className="h-4 w-4"/> Add Kitchen Account</button>}
          {tab==='owner'&&<button onClick={()=>setShowOwnerForm(true)} className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"><Plus className="h-4 w-4"/> Add Owner Account</button>}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500">Active Staff</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{employees.filter(e=>e.isActive).length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500">Total Employees</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{employees.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500">Labor This Month</p>
          <p className="text-lg font-bold text-gray-900 mt-1">{totalLaborThisMonth.toLocaleString('en-RW',{maximumFractionDigits:0})} RWF</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-xl bg-gray-100 p-1 sm:grid-cols-3 lg:flex lg:w-fit">
        <button onClick={()=>setTab('employees')} className={tab==='employees'?'px-4 py-2 rounded-lg text-sm font-medium bg-white shadow text-gray-900 text-center':'px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700 text-center'}>
          <Users className="h-4 w-4 inline mr-1.5"/>Employees
        </button>
        <button onClick={()=>setTab('shifts')} className={tab==='shifts'?'px-4 py-2 rounded-lg text-sm font-medium bg-white shadow text-gray-900 text-center':'px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700 text-center'}>
          <Clock className="h-4 w-4 inline mr-1.5"/>Shifts
        </button>
        <button onClick={()=>setTab('waiters')} className={tab==='waiters'?'px-4 py-2 rounded-lg text-sm font-medium bg-white shadow text-gray-900 text-center':'px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700 text-center'}>
          <UserCheck className="h-4 w-4 inline mr-1.5"/>Waiter Accounts
        </button>
        <button onClick={()=>setTab('kitchen')} className={tab==='kitchen'?'px-4 py-2 rounded-lg text-sm font-medium bg-white shadow text-gray-900 text-center':'px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700 text-center'}>
          <ChefHat className="h-4 w-4 inline mr-1.5"/>Kitchen Accounts
        </button>
        <button onClick={()=>setTab('owner')} className={tab==='owner'?'px-4 py-2 rounded-lg text-sm font-medium bg-white shadow text-gray-900 text-center':'px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700 text-center'}>
          <Crown className="h-4 w-4 inline mr-1.5"/>Owner Account
        </button>
      </div>

      {shiftSuccess&&<div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-sm font-medium px-4 py-3 rounded-xl"><CheckCircle2 className="h-4 w-4"/>Shift logged! Wage expense recorded automatically.</div>}
      {waiterSuccess&&<div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-sm font-medium px-4 py-3 rounded-xl"><CheckCircle2 className="h-4 w-4"/>Waiter account created! They can now log in.</div>}
      {kitchenSuccess&&<div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-sm font-medium px-4 py-3 rounded-xl"><CheckCircle2 className="h-4 w-4"/>Kitchen account created! They can now log in.</div>}
      {ownerSuccess&&<div className="flex items-center gap-2 bg-purple-50 border border-purple-200 text-purple-700 text-sm font-medium px-4 py-3 rounded-xl"><CheckCircle2 className="h-4 w-4"/>Owner account created! The boss can now log in.</div>}
      {loadError&&<div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-sm font-medium px-4 py-3 rounded-xl"><Wifi className="h-4 w-4"/>{loadError}</div>}
      {actionError&&<div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl"><X className="h-4 w-4"/>{actionError}</div>}

      {showOwnerForm&&(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="bg-purple-100 p-1.5 rounded-lg"><Crown className="h-4 w-4 text-purple-600"/></div>
                <h3 className="font-bold text-gray-900">Create Owner Account</h3>
              </div>
              <button onClick={()=>setShowOwnerForm(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button>
            </div>
            <p className="text-xs text-gray-500 bg-purple-50 border border-purple-100 px-3 py-2 rounded-lg">
              The owner gets a <strong>read-only</strong> view of revenue, top dishes, waste, and low stock. They cannot change any settings.
            </p>
            <form onSubmit={saveOwnerAccount} className="space-y-3">
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Full Name</label><input required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-purple-400" value={ownerForm.name} onChange={e=>setOwnerForm(f=>({...f,name:e.target.value}))} placeholder="Jean-Paul"/></div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Email</label><input required type="email" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-purple-400" value={ownerForm.email} onChange={e=>setOwnerForm(f=>({...f,email:e.target.value}))} placeholder="owner@example.com"/></div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Password</label><input required type="text" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-purple-400" value={ownerForm.password} onChange={e=>setOwnerForm(f=>({...f,password:e.target.value}))} placeholder="min 8 characters"/></div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={()=>setShowOwnerForm(false)} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                <button type="submit" className="flex-1 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold py-2 rounded-lg transition-colors">Create Owner Account</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEmpForm&&(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between"><h3 className="font-bold text-gray-900">Add Employee</h3><button onClick={()=>setShowEmpForm(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button></div>
            <form onSubmit={saveEmployee} className="space-y-3">
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Full Name</label><input required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={empForm.name} onChange={e=>setEmpForm(f=>({...f,name:e.target.value}))} placeholder="Jane Doe"/></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Role</label><select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={empForm.role} onChange={e=>setEmpForm(f=>({...f,role:e.target.value}))}>{ROLES.map(r=><option key={r} value={r}>{r}</option>)}</select></div>
                <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Pay Type</label><select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={empForm.payType} onChange={e=>setEmpForm(f=>({...f,payType:e.target.value}))}>{PAY_TYPES.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
              </div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Pay Rate (RWF)</label><input required type="number" min="0" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={empForm.payRate} onChange={e=>setEmpForm(f=>({...f,payRate:e.target.value}))} placeholder={empForm.payType==='hourly'?'Per hour':empForm.payType==='daily'?'Per day':'Per month'}/></div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Phone (optional)</label><input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={empForm.phone} onChange={e=>setEmpForm(f=>({...f,phone:e.target.value}))} placeholder="+250 ..."/></div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={()=>setShowEmpForm(false)} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium py-2 rounded-lg transition-colors">Add Employee</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showShiftForm&&(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between"><h3 className="font-bold text-gray-900">Log Shift</h3><button onClick={()=>setShowShiftForm(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button></div>
            <form onSubmit={logShift} className="space-y-3">
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Employee</label><select required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={shiftForm.employeeId} onChange={e=>setShiftForm(f=>({...f,employeeId:e.target.value}))}><option value="">Select employee</option>{employees.filter(e=>e.isActive).map(e=><option key={e.id} value={e.id}>{e.name} ({e.role})</option>)}</select></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Date</label><input required type="date" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={shiftForm.date} onChange={e=>setShiftForm(f=>({...f,date:e.target.value}))}/></div>
                <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Hours Worked</label><input required type="number" min="0.5" max="24" step="0.5" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={shiftForm.hoursWorked} onChange={e=>setShiftForm(f=>({...f,hoursWorked:e.target.value}))}/></div>
              </div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Notes (optional)</label><input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={shiftForm.notes} onChange={e=>setShiftForm(f=>({...f,notes:e.target.value}))} placeholder="e.g. Covered for sick leave"/></div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={()=>setShowShiftForm(false)} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={!shiftForm.employeeId} className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">Log Shift</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showWaiterForm&&(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between"><h3 className="font-bold text-gray-900">Create Waiter Account</h3><button onClick={()=>setShowWaiterForm(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button></div>
            <form onSubmit={saveWaiter} className="space-y-3">
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Full Name</label><input required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={waiterForm.name} onChange={e=>setWaiterForm(f=>({...f,name:e.target.value}))} placeholder="Jane Doe"/></div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Email</label><input required type="email" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={waiterForm.email} onChange={e=>setWaiterForm(f=>({...f,email:e.target.value}))} placeholder="jane@restaurant.com"/></div>
              <div>
                <label className="text-xs font-semibold text-gray-600 mb-1 block">Password</label>
                <div className="relative">
                  <input required type={showPasswords['new']?'text':'password'} minLength={6} className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={waiterForm.password} onChange={e=>setWaiterForm(f=>({...f,password:e.target.value}))} placeholder="Min 6 characters"/>
                  <button type="button" onClick={()=>setShowPasswords(p=>({...p,new:!p['new']}))} className="absolute right-2 top-2 text-gray-400 hover:text-gray-600">{showPasswords['new']?<EyeOff className="h-4 w-4"/>:<Eye className="h-4 w-4"/>}</button>
                </div>
              </div>
              <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">The waiter will log in with these credentials and see a simplified waiter view.</p>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={()=>setShowWaiterForm(false)} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium py-2 rounded-lg transition-colors">Create Account</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showKitchenForm&&(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between"><h3 className="font-bold text-gray-900">Create Kitchen Account</h3><button onClick={()=>setShowKitchenForm(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button></div>
            <form onSubmit={saveKitchenAccount} className="space-y-3">
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Full Name</label><input required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={kitchenForm.name} onChange={e=>setKitchenForm(f=>({...f,name:e.target.value}))} placeholder="Kitchen Staff"/></div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Email</label><input required type="email" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={kitchenForm.email} onChange={e=>setKitchenForm(f=>({...f,email:e.target.value}))} placeholder="kitchen@restaurant.com"/></div>
              <div>
                <label className="text-xs font-semibold text-gray-600 mb-1 block">Password</label>
                <div className="relative">
                  <input required type={showPasswords['kitchen']?'text':'password'} minLength={6} className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={kitchenForm.password} onChange={e=>setKitchenForm(f=>({...f,password:e.target.value}))} placeholder="Min 6 characters"/>
                  <button type="button" onClick={()=>setShowPasswords(p=>({...p,kitchen:!p['kitchen']}))} className="absolute right-2 top-2 text-gray-400 hover:text-gray-600">{showPasswords['kitchen']?<EyeOff className="h-4 w-4"/>:<Eye className="h-4 w-4"/>}</button>
                </div>
              </div>
              <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">The kitchen staff will log in and see a live order board — no access to financials or menus.</p>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={()=>setShowKitchenForm(false)} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium py-2 rounded-lg transition-colors">Create Account</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">Loading...</div>
      ) : tab==='employees' ? (
        employees.length===0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center"><Users className="h-10 w-10 text-gray-300 mx-auto mb-3"/><p className="font-medium text-gray-600">No employees yet</p><p className="text-sm text-gray-400 mt-1">Add staff to track wages and labor costs.</p></div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200"><tr>{['Name','Role','Pay Type','Rate (RWF)','Phone','Status'].map(h=><th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-gray-50">
                {employees.map(emp=>(
                  <tr key={emp.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{emp.name}</td>
                    <td className="px-4 py-3 text-gray-600">{emp.role}</td>
                    <td className="px-4 py-3 text-gray-600 capitalize">{emp.payType}</td>
                    <td className="px-4 py-3 text-gray-700">{emp.payRate.toLocaleString()}</td>
                    <td className="px-4 py-3 text-gray-500">{emp.phone||'—'}</td>
                    <td className="px-4 py-3">
                      <button onClick={()=>toggleEmployee(emp)} className={emp.isActive?'text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium':'text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium'}>{emp.isActive?'Active':'Inactive'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : tab==='shifts' ? (
        shifts.length===0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center"><Clock className="h-10 w-10 text-gray-300 mx-auto mb-3"/><p className="font-medium text-gray-600">No shifts logged yet</p><p className="text-sm text-gray-400 mt-1">Log shifts to track labor costs automatically.</p></div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200"><tr>{['Date','Employee','Hours','Wage','Notes'].map(h=><th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-gray-50">
                {shifts.map(s=>(
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-500 text-xs">{new Date(s.date).toLocaleDateString('en-RW',{day:'2-digit',month:'short',year:'numeric'})}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{s.employee.name}</td>
                    <td className="px-4 py-3 text-gray-600">{s.hoursWorked}h</td>
                    <td className="px-4 py-3 font-semibold text-orange-700">{s.calculatedWage.toLocaleString('en-RW',{maximumFractionDigits:0})} RWF</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{s.notes||'—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : tab==='waiters' ? (
        /* Waiter Accounts tab */
        <div className="space-y-4">
          {lastCreated && (
            <div className="bg-green-50 border-2 border-green-400 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600"/>
                  <p className="font-bold text-green-800">Waiter account created! Save these credentials.</p>
                </div>
                <button onClick={()=>setLastCreated(null)} className="text-gray-400 hover:text-gray-600 transition-colors"><X className="h-4 w-4"/></button>
              </div>
              <p className="text-sm text-green-700">Give <strong>{lastCreated.name}</strong> these login details:</p>
              <div className="grid grid-cols-1 gap-2">
                <div className="bg-white rounded-lg border border-green-200 px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-0.5">Email</p>
                    <p className="font-mono font-semibold text-gray-900">{lastCreated.email}</p>
                  </div>
                  <button onClick={()=>copyCredential('email', lastCreated!.email)} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200 transition-colors">
                    {credCopied==='email'?'Copied!':'Copy'}
                  </button>
                </div>
                <div className="bg-white rounded-lg border border-green-200 px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-0.5">Password</p>
                    <p className="font-mono font-semibold text-gray-900">{lastCreated.password}</p>
                  </div>
                  <button onClick={()=>copyCredential('password', lastCreated!.password)} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200 transition-colors">
                    {credCopied==='password'?'Copied!':'Copy'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-green-600">⚠ This is the only time the password is visible. Note it down!</p>
            </div>
          )}
          {waiterUrl && (
            <div className="bg-gradient-to-r from-orange-500 to-red-600 rounded-xl p-5 text-white shadow-md">
              <div className="flex items-center gap-2 mb-3">
                <Wifi className="h-5 w-5"/>
                <p className="font-bold text-sm">Waiter Login URL</p>
              </div>
              <p className="text-xs opacity-80 mb-2">Give this address to your waiters. They open it in any browser on the same WiFi.</p>
              <div className="bg-white/20 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
                <p className="font-black text-lg tracking-wide break-all">{waiterUrl}</p>
                <button onClick={copyWaiterUrl} className="flex-shrink-0 flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-white text-orange-600 hover:bg-orange-50 transition-colors">
                  <Copy className="h-3.5 w-3.5"/>{urlCopied?'Copied!':'Copy'}
                </button>
              </div>
            </div>
          )}
          {waiters.length===0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
              <UserCheck className="h-10 w-10 text-gray-300 mx-auto mb-3"/>
              <p className="font-medium text-gray-600">No waiter accounts yet</p>
              <p className="text-sm text-gray-400 mt-1">Create accounts for your waiters to let them take orders.</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>{['Name','Email','Created','Actions'].map(h=><th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {waiters.map(w=>(
                    <tr key={w.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{w.name}</td>
                      <td className="px-4 py-3 text-gray-500">{w.email}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{new Date(w.createdAt).toLocaleDateString('en-RW',{day:'2-digit',month:'short',year:'numeric'})}</td>
                      <td className="px-4 py-3">
                        <button onClick={()=>deleteWaiter(w.id)} className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium">
                          <Trash2 className="h-3.5 w-3.5"/>Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : tab === 'owner' ? (
        /* Owner Accounts tab */
        <div className="space-y-4">
          {lastCreatedOwner && (
            <div className="bg-purple-50 border-2 border-purple-400 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-purple-600"/>
                  <p className="font-bold text-purple-800">Owner account created! Save these credentials.</p>
                </div>
                <button onClick={()=>setLastCreatedOwner(null)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4"/></button>
              </div>
              <p className="text-sm text-purple-700">Give <strong>{lastCreatedOwner.name}</strong> these login details:</p>
              <div className="grid grid-cols-1 gap-2">
                <div className="bg-white rounded-lg border border-purple-200 px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-0.5">Email</p>
                    <p className="font-mono font-semibold text-gray-900">{lastCreatedOwner.email}</p>
                  </div>
                  <button onClick={()=>copyOwnerCredential('email', lastCreatedOwner!.email)} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-purple-100 text-purple-700 hover:bg-purple-200 transition-colors">
                    {ownerCredCopied==='email'?'Copied!':'Copy'}
                  </button>
                </div>
                <div className="bg-white rounded-lg border border-purple-200 px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-0.5">Password</p>
                    <p className="font-mono font-semibold text-gray-900">{lastCreatedOwner.password}</p>
                  </div>
                  <button onClick={()=>copyOwnerCredential('password', lastCreatedOwner!.password)} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-purple-100 text-purple-700 hover:bg-purple-200 transition-colors">
                    {ownerCredCopied==='password'?'Copied!':'Copy'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-purple-600">⚠ This is the only time the password is visible. Note it down!</p>
            </div>
          )}
          {ownerAccounts.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
              <Crown className="h-10 w-10 text-gray-300 mx-auto mb-3"/>
              <p className="font-medium text-gray-600">No owner account yet</p>
              <p className="text-sm text-gray-400 mt-1">Create an account for the boss to view live performance — read-only.</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>{['Name','Email','Created',''].map(h=><th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {ownerAccounts.map(o=>(
                    <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900 flex items-center gap-2"><Crown className="h-3.5 w-3.5 text-purple-400"/>{o.name}</td>
                      <td className="px-4 py-3 text-gray-500">{o.email}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{new Date(o.createdAt).toLocaleDateString('en-RW',{day:'2-digit',month:'short',year:'numeric'})}</td>
                      <td className="px-4 py-3">
                        <button onClick={()=>deleteOwnerAccount(o.id)} className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium"><Trash2 className="h-3.5 w-3.5"/>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        /* Kitchen Accounts tab */
        <div className="space-y-4">
          {lastCreatedKitchen && (
            <div className="bg-green-50 border-2 border-green-400 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600"/>
                  <p className="font-bold text-green-800">Kitchen account created! Save these credentials.</p>
                </div>
                <button onClick={()=>setLastCreatedKitchen(null)} className="text-gray-400 hover:text-gray-600 transition-colors"><X className="h-4 w-4"/></button>
              </div>
              <p className="text-sm text-green-700">Give <strong>{lastCreatedKitchen.name}</strong> these login details:</p>
              <div className="grid grid-cols-1 gap-2">
                <div className="bg-white rounded-lg border border-green-200 px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-0.5">Email</p>
                    <p className="font-mono font-semibold text-gray-900">{lastCreatedKitchen.email}</p>
                  </div>
                  <button onClick={()=>copyKitchenCredential('email', lastCreatedKitchen!.email)} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200 transition-colors">
                    {kitchenCredCopied==='email'?'Copied!':'Copy'}
                  </button>
                </div>
                <div className="bg-white rounded-lg border border-green-200 px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-0.5">Password</p>
                    <p className="font-mono font-semibold text-gray-900">{lastCreatedKitchen.password}</p>
                  </div>
                  <button onClick={()=>copyKitchenCredential('password', lastCreatedKitchen!.password)} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200 transition-colors">
                    {kitchenCredCopied==='password'?'Copied!':'Copy'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-green-600">⚠ This is the only time the password is visible. Note it down!</p>
            </div>
          )}
          {waiterUrl && (
            <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-xl p-5 text-white shadow-md">
              <div className="flex items-center gap-2 mb-3">
                <ChefHat className="h-5 w-5"/>
                <p className="font-bold text-sm">Kitchen Login URL</p>
              </div>
              <p className="text-xs opacity-70 mb-2">Kitchen staff open this URL in a browser on the kitchen computer and log in with their credentials.</p>
              <div className="bg-white/10 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
                <p className="font-black text-lg tracking-wide break-all">{waiterUrl}</p>
                <button onClick={copyWaiterUrl} className="flex-shrink-0 flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-white text-gray-800 hover:bg-gray-100 transition-colors">
                  <Copy className="h-3.5 w-3.5"/>{urlCopied?'Copied!':'Copy'}
                </button>
              </div>
            </div>
          )}
          {kitchenAccounts.length===0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
              <ChefHat className="h-10 w-10 text-gray-300 mx-auto mb-3"/>
              <p className="font-medium text-gray-600">No kitchen accounts yet</p>
              <p className="text-sm text-gray-400 mt-1">Create an account for kitchen staff to view live orders.</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>{['Name','Email','Created','Actions'].map(h=><th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {kitchenAccounts.map(k=>(
                    <tr key={k.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{k.name}</td>
                      <td className="px-4 py-3 text-gray-500">{k.email}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{new Date(k.createdAt).toLocaleDateString('en-RW',{day:'2-digit',month:'short',year:'numeric'})}</td>
                      <td className="px-4 py-3">
                        <button onClick={()=>deleteKitchenAccount(k.id)} className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium">
                          <Trash2 className="h-3.5 w-3.5"/>Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
