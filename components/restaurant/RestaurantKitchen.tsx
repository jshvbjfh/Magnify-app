'use client'
import { useState, useEffect } from 'react'
import { ChefHat, RefreshCw, Plus, X, AlertTriangle, Sparkles } from 'lucide-react'

type WasteLog = { id:string; ingredient:{name:string;unit:string}; quantityWasted:number; reason:string; date:string; calculatedCost:number; notes:string|null }
type Ingredient = { id:string; name:string; unit:string; quantity:number; reorderLevel:number }

const REASONS = ['Spoilage','Overproduction','Theft','Dropped','Expired','Other']

export default function RestaurantKitchen({ onAskJesse }: { onAskJesse?: () => void }) {
  const [wasteLogs, setWasteLogs] = useState<WasteLog[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ingredientId:'',quantityWasted:'',reason:'Spoilage',notes:'',date:new Date().toISOString().split('T')[0]})

  async function load() {
    setLoading(true)
    const [w,i] = await Promise.all([fetch('/api/restaurant/waste').then(r=>r.json()),fetch('/api/restaurant/ingredients').then(r=>r.json())])
    setWasteLogs(Array.isArray(w)?w:[])
    setIngredients(Array.isArray(i)?i:[])
    setLoading(false)
  }
  useEffect(()=>{load()},[])

  async function logWaste(e:React.FormEvent) {
    e.preventDefault(); setSaving(true)
    const res = await fetch('/api/restaurant/waste',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ingredientId:form.ingredientId,quantityWasted:Number(form.quantityWasted),reason:form.reason.toLowerCase(),notes:form.notes||null,date:form.date})})
    setSaving(false)
    if(res.ok){setShowForm(false);setForm({ingredientId:'',quantityWasted:'',reason:'Spoilage',notes:'',date:new Date().toISOString().split('T')[0]});load()}
  }

  const totalWasteCost = wasteLogs.reduce((s,w)=>s+w.calculatedCost,0)
  const lowStock = ingredients.filter(i=>i.quantity<=i.reorderLevel)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Kitchen — Waste Tracker</h2>
          <p className="text-sm text-gray-500">Total waste logged: <span className="font-semibold text-red-600">{totalWasteCost.toLocaleString('en-RW',{maximumFractionDigits:0})} RWF</span></p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 rounded-lg hover:bg-gray-100"><RefreshCw className={loading?'h-4 w-4 text-gray-400 animate-spin':'h-4 w-4 text-gray-400'}/></button>
          <button onClick={onAskJesse} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-white hover:bg-orange-50 transition-colors">
            <Sparkles className="h-3.5 w-3.5"/> Ask Jesse
          </button>
          <button onClick={()=>setShowForm(true)} className="flex items-center gap-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"><Plus className="h-4 w-4"/> Log Waste</button>
        </div>
      </div>

      {lowStock.length>0&&(
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0"/>
          <div className="text-sm text-red-700"><span className="font-semibold">Low stock alert: </span>{lowStock.map(i=>i.name+' ('+i.quantity+' '+i.unit+')').join(', ')}</div>
        </div>
      )}

      {showForm&&(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between"><h3 className="font-bold text-gray-900">Log Waste</h3><button onClick={()=>setShowForm(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button></div>
            <form onSubmit={logWaste} className="space-y-3">
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Ingredient</label><select required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-400" value={form.ingredientId} onChange={e=>setForm(f=>({...f,ingredientId:e.target.value}))}><option value="">Select ingredient</option>{ingredients.map(i=><option key={i.id} value={i.id}>{i.name} (stock: {i.quantity} {i.unit})</option>)}</select></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Quantity Wasted</label><input required type="number" min="0.01" step="any" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-400" value={form.quantityWasted} onChange={e=>setForm(f=>({...f,quantityWasted:e.target.value}))}/></div>
                <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Reason</label><select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-400" value={form.reason} onChange={e=>setForm(f=>({...f,reason:e.target.value}))}>{REASONS.map(r=><option key={r} value={r}>{r}</option>)}</select></div>
              </div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Date</label><input type="date" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-400" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}/></div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Notes (optional)</label><input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-400" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="e.g. Left in fridge too long"/></div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={()=>setShowForm(false)} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving||!form.ingredientId||!form.quantityWasted} className="flex-1 bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">{saving?'Saving...':'Log Waste'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">Loading...</div>
      ) : wasteLogs.length===0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <ChefHat className="h-10 w-10 text-gray-300 mx-auto mb-3"/>
          <p className="font-medium text-gray-600">No waste logged yet</p>
          <p className="text-sm text-gray-400 mt-1">Log waste to track costs, deduct from inventory, and monitor waste %.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200"><tr>{['Date','Ingredient','Qty','Reason','Cost','Notes'].map(h=><th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-gray-50">
              {wasteLogs.map(w=>(
                <tr key={w.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-500 text-xs">{new Date(w.date).toLocaleDateString('en-RW',{day:'2-digit',month:'short'})}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{w.ingredient.name}</td>
                  <td className="px-4 py-3 text-gray-600">{w.quantityWasted} {w.ingredient.unit}</td>
                  <td className="px-4 py-3"><span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full capitalize">{w.reason}</span></td>
                  <td className="px-4 py-3 font-semibold text-red-600">{w.calculatedCost.toLocaleString('en-RW',{maximumFractionDigits:0})} RWF</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{w.notes||'—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
