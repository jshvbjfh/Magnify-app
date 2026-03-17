'use client'
import { useState, useEffect } from 'react'
import { Plus, AlertTriangle, X, Package, Sparkles, ShoppingCart, Search } from 'lucide-react'

type Ingredient = { id: string; name: string; unit: string; unitCost: number | null; quantity: number; reorderLevel: number; category: string | null }
type Purchase = { id: string; ingredientId: string; supplier: string | null; quantityPurchased: number; remainingQuantity: number; unitCost: number; totalCost: number; purchasedAt: string; ingredient: { name: string; unit: string } }

const UNITS = ['kg','g','liter','ml','piece','bottle','bag','box','bunch','can','sachet']
const fmt = (n: number) => n.toLocaleString('en-RW', { maximumFractionDigits: 0 })

export default function RestaurantInventory({ onAskJesse }: { onAskJesse?: () => void }) {
  const [tab, setTab] = useState<'ingredients' | 'purchases'>('ingredients')
  const [items, setItems] = useState<Ingredient[]>([])
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [recordFinancial, setRecordFinancial] = useState(false)
  const [form, setForm] = useState({ name:'',unit:'kg',unitCost:'',quantity:'',reorderLevel:'',category:'' })
  // Purchase form
  const [showPurchaseForm, setShowPurchaseForm] = useState(false)
  const [pForm, setPForm] = useState({ ingredientId: '', supplier: '', quantityPurchased: '', unitCost: '', purchasedAt: new Date().toISOString().slice(0, 10) })
  const [pSaving, setPSaving] = useState(false)

  async function load() {
    setLoading(true)
    const data = await fetch('/api/restaurant/ingredients').then(r=>r.json())
    setItems(Array.isArray(data)?data:[])
    setLoading(false)
  }

  async function loadPurchases() {
    setLoading(true)
    const data = await fetch('/api/restaurant/inventory-purchases').then(r=>r.json())
    setPurchases(Array.isArray(data)?data:[])
    setLoading(false)
  }

  useEffect(()=>{load()},[])
  useEffect(()=>{ if(tab==='purchases') loadPurchases() },[tab])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    await fetch('/api/restaurant/ingredients',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:form.name,unit:form.unit,unitCost:form.unitCost?Number(form.unitCost):null,quantity:Number(form.quantity||0),reorderLevel:Number(form.reorderLevel||0),category:form.category||null})})
    if (recordFinancial && form.unitCost && Number(form.unitCost) > 0 && Number(form.quantity) > 0) {
      const totalCost = Number(form.unitCost) * Number(form.quantity)
      await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: `Inventory purchase - ${form.name} (${form.quantity} ${form.unit})`,
          amount: totalCost,
          direction: 'out',
          categoryType: 'expense',
          accountName: 'Inventory Purchase',
          paymentMethod: 'Cash'
        })
      })
    }
    setShowForm(false); setRecordFinancial(false); setForm({name:'',unit:'kg',unitCost:'',quantity:'',reorderLevel:'',category:''}); load()
  }

  async function savePurchase(e: React.FormEvent) {
    e.preventDefault()
    if (!pForm.ingredientId || !pForm.quantityPurchased || !pForm.unitCost) return
    setPSaving(true)
    try {
      const res = await fetch('/api/restaurant/inventory-purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ingredientId: pForm.ingredientId,
          supplier: pForm.supplier || null,
          quantityPurchased: Number(pForm.quantityPurchased),
          unitCost: Number(pForm.unitCost),
          purchasedAt: pForm.purchasedAt,
        })
      })
      if (!res.ok) { const err = await res.json(); alert(err.error || 'Save failed'); return }
      setShowPurchaseForm(false)
      setPForm({ ingredientId: '', supplier: '', quantityPurchased: '', unitCost: '', purchasedAt: new Date().toISOString().slice(0, 10) })
      load()          // refresh ingredient qty
      loadPurchases() // refresh list
    } finally {
      setPSaving(false)
    }
  }

  const [ingSearch, setIngSearch] = useState('')
  const [ingFilterStatus, setIngFilterStatus] = useState<'all'|'low'|'ok'>('all')
  const [purSearch, setPurSearch] = useState('')

  const lowStock = items.filter(i=>i.quantity<=i.reorderLevel)
  const totalValue = items.reduce((s,i)=>s+i.quantity*(i.unitCost??0),0)
  const totalPurchaseCost = purchases.reduce((s,p)=>s+p.totalCost,0)

  const filteredItems = items.filter(i => {
    const q = ingSearch.trim().toLowerCase()
    const matchQ = !q || i.name.toLowerCase().includes(q) || (i.category??'').toLowerCase().includes(q) || i.unit.toLowerCase().includes(q)
    const isLow = i.quantity <= i.reorderLevel
    const matchS = ingFilterStatus==='all' || (ingFilterStatus==='low'&&isLow) || (ingFilterStatus==='ok'&&!isLow)
    return matchQ && matchS
  })

  const filteredPurchases = purchases.filter(p => {
    const q = purSearch.trim().toLowerCase()
    return !q || p.ingredient.name.toLowerCase().includes(q) || (p.supplier??'').toLowerCase().includes(q)
  })
  const selectedIngredient = items.find(i=>i.id===pForm.ingredientId)
  const estimatedTotal = selectedIngredient && pForm.quantityPurchased && pForm.unitCost
    ? Number(pForm.quantityPurchased) * Number(pForm.unitCost) : null

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">Ingredient Inventory</h2>
        <div className="flex items-center gap-2">
          <button onClick={onAskJesse} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-white hover:bg-orange-50 transition-colors">
            <Sparkles className="h-3.5 w-3.5"/> Ask Jesse
          </button>
          {tab === 'ingredients' ? (
            <button onClick={()=>setShowForm(true)} className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              <Plus className="h-4 w-4" /> Add Ingredient
            </button>
          ) : (
            <button onClick={()=>setShowPurchaseForm(true)} className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              <ShoppingCart className="h-4 w-4" /> Record Purchase
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1">
        {([['ingredients','Ingredients'],['purchases','Purchase History']] as const).map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${tab===id?'bg-orange-500 text-white shadow-sm':'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── INGREDIENTS TAB ──────────────────────────────── */}
      {tab === 'ingredients' && (<>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
            <p className="text-xs text-gray-500">Total Ingredients</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{items.length}</p>
          </div>
          <div className={`bg-white rounded-xl border p-4 shadow-sm text-center ${lowStock.length>0?'border-red-200':'border-gray-200'}`}>
            <p className="text-xs text-gray-500">Low Stock Alerts</p>
            <p className={`text-2xl font-bold mt-1 ${lowStock.length>0?'text-red-600':'text-gray-900'}`}>{lowStock.length}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
            <p className="text-xs text-gray-500">Total Stock Value</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{fmt(totalValue)} RWF</p>
          </div>
        </div>

        {lowStock.length>0&&(
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0"/>
            <div className="text-sm text-red-700">
              <span className="font-semibold">Low stock: </span>
              {lowStock.map(i=>`${i.name} (${i.quantity} ${i.unit})`).join(', ')}
            </div>
          </div>
        )}

        {/* Ingredient search + status filter */}
        {!loading && items.length>0 && (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none"/>
              <input value={ingSearch} onChange={e=>setIngSearch(e.target.value)}
                placeholder="Search ingredients…"
                className="w-full pl-7 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-orange-400 bg-gray-50"/>
            </div>
            <select value={ingFilterStatus} onChange={e=>setIngFilterStatus(e.target.value as any)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-orange-400 bg-gray-50 text-gray-600">
              <option value="all">All status</option>
              <option value="low">Low stock</option>
              <option value="ok">OK only</option>
            </select>
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">Loading...</div>
        ) : items.length===0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <Package className="h-10 w-10 text-gray-300 mx-auto mb-3"/>
            <p className="font-medium text-gray-600">No ingredients yet</p>
            <p className="text-sm text-gray-400 mt-1">Add ingredients so you can build dish recipes and track stock.</p>
          </div>
        ) : filteredItems.length===0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-6 text-center text-sm text-gray-400">No ingredients match your search.</div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {(ingSearch||ingFilterStatus!=='all')&&<p className="px-4 py-2 text-xs text-gray-400 border-b border-gray-100">Showing {filteredItems.length} of {items.length} ingredients</p>}
            <div className="overflow-x-auto"><table className="w-full text-sm min-w-[600px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>{['Ingredient','Unit','Cost/Unit','Qty in Stock','Stock Value','Reorder At','Status'].map(h=><th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredItems.map(item=>{
                  const isLow=item.quantity<=item.reorderLevel
                  return (
                    <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{item.name}{item.category&&<span className="ml-2 text-xs text-gray-400">{item.category}</span>}</td>
                      <td className="px-4 py-3 text-gray-600">{item.unit}</td>
                      <td className="px-4 py-3 text-gray-700">{item.unitCost!=null?`${fmt(item.unitCost)} RWF`:''}</td>
                      <td className="px-4 py-3 font-semibold text-gray-900">{item.quantity}</td>
                      <td className="px-4 py-3 text-gray-700">{fmt((item.unitCost??0)*item.quantity)} RWF</td>
                      <td className="px-4 py-3 text-gray-600">{item.reorderLevel}</td>
                      <td className="px-4 py-3">
                        {isLow ? <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">Low Stock</span>
                                : <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">OK</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table></div>
          </div>
        )}
      </>)}

      {/* ── PURCHASES TAB ────────────────────────────────── */}
      {tab === 'purchases' && (<>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
            <p className="text-xs text-gray-500">Total Batches</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{purchases.length}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
            <p className="text-xs text-gray-500">Total Spent</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{fmt(totalPurchaseCost)} RWF</p>
          </div>
          <div className="bg-orange-50 rounded-xl border border-orange-100 p-4 shadow-sm text-center">
            <p className="text-xs text-orange-600 font-semibold">FIFO Batch Tracking</p>
            <p className="text-xs text-gray-500 mt-1">Enable in Settings → Costing</p>
          </div>
        </div>

        {/* Purchase search */}
        {!loading && purchases.length>0 && (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none"/>
            <input value={purSearch} onChange={e=>setPurSearch(e.target.value)}
              placeholder="Search by ingredient or supplier…"
              className="w-full pl-7 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-orange-400 bg-gray-50"/>
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">Loading...</div>
        ) : purchases.length===0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <ShoppingCart className="h-10 w-10 text-gray-300 mx-auto mb-3"/>
            <p className="font-medium text-gray-600">No purchases recorded yet</p>
            <p className="text-sm text-gray-400 mt-1">Record ingredient purchases to track actual costs and enable FIFO costing.</p>
          </div>
        ) : filteredPurchases.length===0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-6 text-center text-sm text-gray-400">No purchases match your search.</div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {purSearch && <p className="px-4 py-2 text-xs text-gray-400 border-b border-gray-100">Showing {filteredPurchases.length} of {purchases.length} purchases</p>}
            <div className="overflow-x-auto"><table className="w-full text-sm min-w-[580px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>{['Date','Ingredient','Supplier','Qty Bought','Unit Cost','Total Cost','Remaining'].map(h=><th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredPurchases.map(p=>(
                  <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-gray-500 text-xs">{new Date(p.purchasedAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{p.ingredient.name}</td>
                    <td className="px-4 py-3 text-gray-500">{p.supplier||'—'}</td>
                    <td className="px-4 py-3 text-gray-700">{p.quantityPurchased} {p.ingredient.unit}</td>
                    <td className="px-4 py-3 text-gray-700">{fmt(p.unitCost)} RWF</td>
                    <td className="px-4 py-3 font-semibold text-gray-900">{fmt(p.totalCost)} RWF</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${p.remainingQuantity<=0?'bg-gray-100 text-gray-400':'bg-green-100 text-green-700'}`}>
                        {p.remainingQuantity} {p.ingredient.unit}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </>)}

      {/* ── ADD INGREDIENT MODAL ──────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-gray-900">Add Ingredient</h3>
              <button onClick={()=>setShowForm(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button>
            </div>
            <form onSubmit={save} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2"><label className="text-xs font-semibold text-gray-600 mb-1 block">Ingredient Name</label>
                  <input required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Tomatoes"/></div>
                <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Unit</label>
                  <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={form.unit} onChange={e=>setForm(f=>({...f,unit:e.target.value}))}>
                    {UNITS.map(u=><option key={u} value={u}>{u}</option>)}
                  </select></div>
                <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Cost per Unit (RWF)</label>
                  <input type="number" min="0" step="any" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={form.unitCost} onChange={e=>setForm(f=>({...f,unitCost:e.target.value}))} placeholder="500"/></div>
                <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Current Qty</label>
                  <input type="number" min="0" step="any" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={form.quantity} onChange={e=>setForm(f=>({...f,quantity:e.target.value}))} placeholder="0"/></div>
                <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Reorder Level</label>
                  <input type="number" min="0" step="any" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={form.reorderLevel} onChange={e=>setForm(f=>({...f,reorderLevel:e.target.value}))} placeholder="5"/></div>
                <div className="col-span-2"><label className="text-xs font-semibold text-gray-600 mb-1 block">Category (optional)</label>
                  <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))} placeholder="e.g. Produce, Proteins, Dairy"/></div>
              </div>
              <div className="flex items-center justify-between bg-orange-50 border border-orange-200 rounded-lg px-3 py-2.5">
                <div>
                  <p className="text-xs font-semibold text-gray-800">Record in Financial Reports</p>
                  <p className="text-xs text-gray-500 mt-0.5">Also log this as a purchase expense in Transactions</p>
                </div>
                <button type="button" onClick={()=>setRecordFinancial(v=>!v)}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none ${recordFinancial?'bg-orange-500':'bg-gray-300'}`}>
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${recordFinancial?'translate-x-4':'translate-x-0.5'}`}/>
                </button>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={()=>{setShowForm(false);setRecordFinancial(false)}} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                <button type="submit" className="flex-1 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium py-2 rounded-lg transition-colors">Add Ingredient</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── RECORD PURCHASE MODAL ────────────────────────── */}
      {showPurchaseForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-gray-900">Record Purchase</h3>
              <button onClick={()=>setShowPurchaseForm(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button>
            </div>
            <form onSubmit={savePurchase} className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-gray-600 mb-1 block">Ingredient *</label>
                <select required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={pForm.ingredientId} onChange={e=>setPForm(f=>({...f,ingredientId:e.target.value}))}>
                  <option value="">Select ingredient…</option>
                  {items.map(i=><option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600 mb-1 block">Supplier (optional)</label>
                <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={pForm.supplier} onChange={e=>setPForm(f=>({...f,supplier:e.target.value}))} placeholder="e.g. Fresh Market"/>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Quantity *</label>
                  <input required type="number" min="0.001" step="any" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={pForm.quantityPurchased} onChange={e=>setPForm(f=>({...f,quantityPurchased:e.target.value}))} placeholder="10"/>
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Unit Cost (RWF) *</label>
                  <input required type="number" min="0" step="any" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={pForm.unitCost} onChange={e=>setPForm(f=>({...f,unitCost:e.target.value}))} placeholder="500"/>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600 mb-1 block">Purchase Date</label>
                <input type="date" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400" value={pForm.purchasedAt} onChange={e=>setPForm(f=>({...f,purchasedAt:e.target.value}))}/>
              </div>
              {estimatedTotal !== null && (
                <div className="bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 flex items-center justify-between">
                  <span className="text-sm text-gray-600">Total Cost</span>
                  <span className="font-bold text-orange-700">{fmt(estimatedTotal)} RWF</span>
                </div>
              )}
              <p className="text-xs text-gray-400">Stock quantity will increase and an expense will be recorded in transactions.</p>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={()=>setShowPurchaseForm(false)} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                <button type="submit" disabled={pSaving} className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white text-sm font-medium py-2 rounded-lg transition-colors">
                  {pSaving ? 'Saving…' : 'Record Purchase'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}


