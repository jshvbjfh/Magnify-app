'use client'
import { useState, useEffect, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { Plus, Trash2, ChefHat, X, Edit2, ToggleLeft, ToggleRight, Sparkles, Search, ChevronDown } from 'lucide-react'
import { useRestaurantBranch } from '@/contexts/RestaurantBranchContext'
import { estimateFifoCostForQuantity } from '@/lib/fifoCosting'
import { calculateGrossFromNet, calculateVatFromNet } from '@/lib/restaurantVat'
import { buildRestaurantSnapshotScope, loadRestaurantDeviceSnapshot, mergeRestaurantDeviceSnapshot } from '@/lib/restaurantDeviceSnapshot'

type Ingredient = { id: string; name: string; unit: string; unitCost: number | null; quantity: number }
type DishIngredient = { id: string; ingredientId: string; quantityRequired: number; ingredient: Ingredient }
type Dish = { id: string; name: string; sellingPrice: number; category: string | null; isActive: boolean; ingredients: DishIngredient[] }
type PurchaseLayer = { id: string; ingredientId: string; remainingQuantity: number; unitCost: number; purchasedAt: string; createdAt: string }

type RestaurantMenuSnapshot = {
  updatedAt: string
  dishes: Dish[]
  ingredients: Ingredient[]
  purchases: PurchaseLayer[]
}

const CATEGORIES = ['Mains','Sides','Drinks','Desserts','Breakfast','Specials']

export default function RestaurantMenu({ onAskJesse }: { onAskJesse?: () => void }) {
  const { data: session } = useSession()
  const restaurantBranch = useRestaurantBranch()
  const [dishes, setDishes] = useState<Dish[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [purchases, setPurchases] = useState<PurchaseLayer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editDish, setEditDish] = useState<Dish | null>(null)
  const [selectedDish, setSelectedDish] = useState<Dish | null>(null)
  const [form, setForm] = useState({ name:'', sellingPrice:'', category:'' })
  const [recipeForm, setRecipeForm] = useState({ ingredientId:'', quantityRequired:'' })
  const [ingSearch, setIngSearch] = useState('')
  const [ingDropOpen, setIngDropOpen] = useState(false)
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState<string | null>(null)
  const [showingCachedSnapshot, setShowingCachedSnapshot] = useState(false)
  const ingSearchRef = useRef<HTMLDivElement>(null)
  const sellingPriceNumber = Number(form.sellingPrice || 0)
  const previewVatAmount = calculateVatFromNet(sellingPriceNumber)
  const previewMenuPrice = calculateGrossFromNet(sellingPriceNumber)
  const snapshotScopeId = buildRestaurantSnapshotScope({
    restaurantId: restaurantBranch?.restaurantId ?? (session?.user as any)?.restaurantId ?? null,
    branchId: restaurantBranch?.branchId ?? (session?.user as any)?.branchId ?? null,
    fallbackUserId: session?.user?.id ?? null,
  })
  const snapshotStorageScope = snapshotScopeId ? `restaurant-menu:${snapshotScopeId}` : null

  function persistSnapshot(nextDishes: Dish[], nextIngredients: Ingredient[], nextPurchases: PurchaseLayer[]) {
    if (!snapshotStorageScope) return
    const snapshot = mergeRestaurantDeviceSnapshot<RestaurantMenuSnapshot>(snapshotStorageScope, {
      dishes: nextDishes,
      ingredients: nextIngredients,
      purchases: nextPurchases,
    })
    if (!snapshot) return
    setSnapshotUpdatedAt(snapshot.updatedAt)
    setShowingCachedSnapshot(false)
  }

  // close ingredient dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ingSearchRef.current && !ingSearchRef.current.contains(e.target as Node)) setIngDropOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const ingSuggestions = ingredients.filter(i => {
    const q = ingSearch.trim().toLowerCase()
    return !q || i.name.toLowerCase().includes(q) || i.unit.toLowerCase().includes(q)
  })

  async function load() {
    setLoading(dishes.length === 0 && ingredients.length === 0 && purchases.length === 0)
    try {
      const [d, i, p] = await Promise.all([
        fetch('/api/restaurant/dishes').then(r => r.json()),
        fetch('/api/restaurant/ingredients').then(r => r.json()),
        fetch('/api/restaurant/inventory-purchases').then(r => r.json()),
      ])
      const nextDishes = Array.isArray(d) ? d : []
      const nextIngredients = Array.isArray(i) ? i : []
      const nextPurchases = Array.isArray(p) ? p : []
      setDishes(nextDishes)
      setIngredients(nextIngredients)
      setPurchases(nextPurchases)
      setSelectedDish((current) => current ? nextDishes.find((dish) => dish.id === current.id) ?? null : null)
      persistSnapshot(nextDishes, nextIngredients, nextPurchases)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    if (!snapshotStorageScope) return

    const snapshot = loadRestaurantDeviceSnapshot<RestaurantMenuSnapshot>(snapshotStorageScope)
    if (!snapshot) return

    const nextDishes = Array.isArray(snapshot.dishes) ? snapshot.dishes : []
    const nextIngredients = Array.isArray(snapshot.ingredients) ? snapshot.ingredients : []
    const nextPurchases = Array.isArray(snapshot.purchases) ? snapshot.purchases : []
    setDishes(nextDishes)
    setIngredients(nextIngredients)
    setPurchases(nextPurchases)
    setSelectedDish((current) => current ? nextDishes.find((dish) => dish.id === current.id) ?? null : null)
    setSnapshotUpdatedAt(snapshot.updatedAt ?? null)
    setShowingCachedSnapshot(true)
    setLoading(false)
  }, [snapshotStorageScope])
  useEffect(()=>{load()},[])

  async function saveDish(e: React.FormEvent) {
    e.preventDefault()
    if (editDish) {
      await fetch(`/api/restaurant/dishes/${editDish.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:form.name,sellingPrice:Number(form.sellingPrice),category:form.category||null})})
    } else {
      await fetch('/api/restaurant/dishes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:form.name,sellingPrice:Number(form.sellingPrice),category:form.category||null})})
    }
    setShowForm(false); setEditDish(null); setForm({name:'',sellingPrice:'',category:''}); load()
  }

  async function deleteDish(id: string) {
    if (!confirm('Delete this dish?')) return
    await fetch(`/api/restaurant/dishes/${id}`,{method:'DELETE'})
    if (selectedDish?.id===id) setSelectedDish(null)
    load()
  }

  async function toggleActive(dish: Dish) {
    await fetch(`/api/restaurant/dishes/${dish.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({isActive:!dish.isActive})})
    load()
  }

  async function addIngredient(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedDish||!recipeForm.ingredientId||!recipeForm.quantityRequired) return
    await fetch(`/api/restaurant/dishes/${selectedDish.id}/ingredients`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ingredientId:recipeForm.ingredientId,quantityRequired:Number(recipeForm.quantityRequired)})})
    setRecipeForm({ingredientId:'',quantityRequired:''}); setIngSearch(''); setIngDropOpen(false); load()
    // refresh selected dish
    const updated = await fetch('/api/restaurant/dishes').then(r=>r.json())
    setSelectedDish(updated.find((d:Dish)=>d.id===selectedDish.id)||null)
  }

  async function removeIngredient(dishId: string, ingredientId: string) {
    await fetch(`/api/restaurant/dishes/${dishId}/ingredients`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({ingredientId})})
    const updated = await fetch('/api/restaurant/dishes').then(r=>r.json())
    const all: Dish[] = Array.isArray(updated)?updated:[]
    setDishes(all)
    setSelectedDish(all.find(d=>d.id===dishId)||null)
  }

  function openEdit(dish: Dish) { setEditDish(dish); setForm({name:dish.name,sellingPrice:String(dish.sellingPrice),category:dish.category||''}); setShowForm(true) }

  function estimateIngredientCost(ingredient: Ingredient, quantityRequired: number) {
    return estimateFifoCostForQuantity(
      purchases.filter((purchase) => purchase.ingredientId === ingredient.id),
      quantityRequired,
      ingredient.unitCost,
    )
  }

  const foodCost = (dish: Dish) => dish.ingredients.reduce((sum, row) => sum + estimateIngredientCost(row.ingredient, row.quantityRequired).totalCost, 0)
  const margin = (dish: Dish) => { const fc=foodCost(dish); return dish.sellingPrice>0?((dish.sellingPrice-fc)/dish.sellingPrice*100):0 }

  const filteredDishes = dishes.filter(d => {
    const q = search.trim().toLowerCase()
    const matchesSearch = !q || d.name.toLowerCase().includes(q) || (d.category??'').toLowerCase().includes(q)
    const matchesCat = !filterCat || d.category === filterCat
    return matchesSearch && matchesCat
  })
  const snapshotUpdatedLabel = snapshotUpdatedAt
    ? new Date(snapshotUpdatedAt).toLocaleString('en-RW', { dateStyle: 'medium', timeStyle: 'short' })
    : null

  return (
    <div className="space-y-5">
      {showingCachedSnapshot && snapshotUpdatedLabel ? (
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-semibold">Showing last synced menu snapshot from this device</p>
          <p className="mt-1 text-xs opacity-90">Last synced snapshot: {snapshotUpdatedLabel}</p>
        </div>
      ) : null}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">Restaurant Menu</h2>
        <div className="flex items-center gap-2">
          <button onClick={onAskJesse} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-white hover:bg-orange-50 transition-colors">
            <Sparkles className="h-3.5 w-3.5"/> Ask Jesse AI
          </button>
          <button onClick={()=>{setShowForm(true);setEditDish(null);setForm({name:'',sellingPrice:'',category:''})}}
          className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
            <Plus className="h-4 w-4" /> Add Menu Item
          </button>
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-gray-900">{editDish?'Edit Menu Item':'New Menu Item'}</h3>
              <button onClick={()=>{setShowForm(false);setEditDish(null)}}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button>
            </div>
            <form onSubmit={saveDish} className="space-y-3">
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Menu Item Name</label>
                <input required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-orange-400 outline-none" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Grilled Tilapia"/></div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Selling Price Before VAT (RWF)</label>
                <input required type="number" min="0" step="any" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-orange-400 outline-none" value={form.sellingPrice} onChange={e=>setForm(f=>({...f,sellingPrice:e.target.value}))} placeholder="5000"/></div>
              <div className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-3 text-sm text-orange-900">
                <p className="font-semibold">Price shown on the menu</p>
                <p className="mt-1 text-lg font-bold">{previewMenuPrice.toLocaleString()} RWF</p>
                <p className="mt-1 text-xs text-orange-700">{sellingPriceNumber.toLocaleString()} + ({sellingPriceNumber.toLocaleString()} × 18%) = {previewMenuPrice.toLocaleString()} RWF</p>
                <p className="text-xs text-orange-700">VAT included: {previewVatAmount.toLocaleString()} RWF</p>
              </div>
              <div><label className="text-xs font-semibold text-gray-600 mb-1 block">Category</label>
                <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-orange-400 outline-none" value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}>
                  <option value="">Select category</option>
                  {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
                </select></div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={()=>{setShowForm(false);setEditDish(null)}} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                <button type="submit" className="flex-1 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium py-2 rounded-lg transition-colors">{editDish?'Save Changes':'Create Menu Item'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">Loading...</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

          {/* Dish list */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
            <div className="p-4 border-b border-gray-100 space-y-2">
              <div className="flex items-center gap-2">
                <ChefHat className="h-4 w-4 text-orange-500 flex-shrink-0"/>
                <h3 className="font-semibold text-gray-800">Menu Items ({filteredDishes.length}{filteredDishes.length !== dishes.length ? ` of ${dishes.length}` : ''})</h3>
              </div>
              {/* Search + filter row */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none"/>
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search menu items…"
                    className="w-full pl-7 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-orange-400 bg-gray-50"
                  />
                </div>
                <select
                  value={filterCat}
                  onChange={e => setFilterCat(e.target.value)}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-orange-400 bg-gray-50 text-gray-600">
                  <option value="">All categories</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            {dishes.length===0 ? (
              <p className="p-8 text-center text-gray-400 text-sm">No menu items yet. Add your first one.</p>
            ) : filteredDishes.length===0 ? (
              <p className="p-8 text-center text-gray-400 text-sm">No dishes match your search.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 p-3 max-h-[500px] overflow-y-auto">
                {filteredDishes.map(dish=>{
                  const fc=foodCost(dish); const mgn=margin(dish)
                  return (
                  <div key={dish.id}
                    className={`rounded-xl overflow-hidden cursor-pointer border-2 transition-all shadow-sm hover:shadow-md ${selectedDish?.id===dish.id?'border-sky-400 ring-2 ring-sky-100':'border-transparent hover:border-sky-200'}`}
                    onClick={()=>{ setSelectedDish(dish); setIngSearch(''); setRecipeForm({ingredientId:'',quantityRequired:''}) }}>
                    {/* Sky-blue image section */}
                    <div className="bg-sky-200 h-20 flex items-center justify-center relative">
                      <ChefHat className="h-9 w-9 text-sky-500"/>
                      {!dish.isActive && <span className="absolute top-1.5 left-1.5 text-xs bg-white/80 text-gray-500 px-1.5 py-0.5 rounded-full">Inactive</span>}
                      <div className="absolute top-1 right-1 flex items-center gap-0.5">
                        <button onClick={e=>{e.stopPropagation();toggleActive(dish)}} title={dish.isActive?'Deactivate':'Activate'}
                          className="p-1 rounded-full bg-white/70 hover:bg-white">{dish.isActive?<ToggleRight className="h-3.5 w-3.5 text-green-500"/>:<ToggleLeft className="h-3.5 w-3.5 text-gray-400"/>}</button>
                        <button onClick={e=>{e.stopPropagation();openEdit(dish)}} className="p-1 rounded-full bg-white/70 hover:bg-white"><Edit2 className="h-3.5 w-3.5 text-sky-600"/></button>
                        <button onClick={e=>{e.stopPropagation();deleteDish(dish.id)}} className="p-1 rounded-full bg-white/70 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5 text-red-400"/></button>
                      </div>
                    </div>
                    {/* Info section */}
                    <div className="bg-white px-3 py-2.5">
                      <p className="text-sm font-bold text-blue-700 truncate">{dish.name}</p>
                      {dish.category && <p className="text-xs text-sky-500 font-medium">{dish.category}</p>}
                      <div className="mt-1 text-xs">
                        <span className="text-gray-700 font-semibold">{calculateGrossFromNet(dish.sellingPrice).toLocaleString()} RWF</span>
                        <span className="ml-2 text-[11px] font-medium text-orange-500">incl. VAT</span>
                        {dish.ingredients.length>0&&<div className="flex items-center gap-2 mt-0.5">
                          <span className="text-gray-400">Cost: {fc.toFixed(0)}</span>
                          <span className={`font-semibold ${mgn>=60?'text-green-600':mgn>=40?'text-amber-600':'text-red-600'}`}>{mgn.toFixed(0)}%</span>
                        </div>}
                      </div>
                    </div>
                  </div>
                )})}
              </div>
            )}
          </div>

          {/* Recipe builder */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
            <div className="p-4 border-b border-gray-100">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-gray-800">
                  {selectedDish ? `Recipe: ${selectedDish.name}` : 'Select a menu item to edit its recipe'}
                </h3>
                {selectedDish && (
                  <div className="text-right">
                    <span className="text-sm font-bold text-orange-500">{calculateGrossFromNet(selectedDish.sellingPrice).toLocaleString()} RWF</span>
                    <p className="text-[11px] text-gray-400">Base price {selectedDish.sellingPrice.toLocaleString()} RWF</p>
                  </div>
                )}
              </div>
            </div>
            {!selectedDish ? (
              <p className="p-8 text-center text-gray-400 text-sm">Click on a menu item to view and edit its recipe ingredients.</p>
            ) : (
              <div className="p-4 space-y-4">
                <form onSubmit={addIngredient} className="flex gap-2 bg-gray-50 p-3 rounded-xl">
                  {/* Ingredient search combobox */}
                  <div ref={ingSearchRef} className="relative flex-1">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none"/>
                      <input
                        type="text"
                        placeholder="Search or browse ingredients…"
                        value={ingSearch}
                        onFocus={() => setIngDropOpen(true)}
                        onChange={e => {
                          setIngSearch(e.target.value)
                          setIngDropOpen(true)
                          setRecipeForm(f => ({ ...f, ingredientId: '' }))
                        }}
                        className={`w-full pl-7 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-orange-400 outline-none bg-white ${
                          recipeForm.ingredientId ? 'pr-14 border-orange-400 ring-2 ring-orange-100' : 'pr-8 border-gray-300'
                        }`}
                      />
                      {/* Clear button — only when an ingredient is selected */}
                      {recipeForm.ingredientId && (
                        <button type="button"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => { setIngSearch(''); setRecipeForm(f => ({ ...f, ingredientId: '' })); setIngDropOpen(true) }}
                          className="absolute right-6 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-500 transition-colors">
                          <X className="h-3.5 w-3.5"/>
                        </button>
                      )}
                      {/* Chevron toggle — always visible */}
                      <button type="button"
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => setIngDropOpen(o => !o)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-transform">
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${ingDropOpen ? 'rotate-180' : ''}`}/>
                      </button>
                    </div>
                    {ingDropOpen && (
                      <ul className="absolute z-30 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {ingSuggestions.length === 0 ? (
                          <li className="px-3 py-2 text-xs text-gray-400">No ingredients found</li>
                        ) : ingSuggestions.map(i => (
                          <li key={i.id}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => {
                              setRecipeForm(f => ({ ...f, ingredientId: i.id }))
                              setIngSearch(`${i.name} (${i.unit})`)
                              setIngDropOpen(false)
                            }}
                            className={`px-3 py-2 text-sm cursor-pointer hover:bg-orange-50 ${
                              recipeForm.ingredientId === i.id ? 'bg-orange-50 font-medium text-orange-700' : 'text-gray-700'
                            }`}>
                            <span className="font-medium">{i.name}</span>
                            <span className="text-xs text-gray-400 ml-1">({i.unit})</span>
                            {i.unitCost != null && <span className="text-xs text-gray-400 ml-1">· {i.unitCost.toLocaleString()} RWF/{i.unit}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <input required type="number" min="0" step="any" placeholder="Qty" value={recipeForm.quantityRequired}
                    onChange={e=>setRecipeForm(f=>({...f,quantityRequired:e.target.value}))}
                    className="w-20 border border-gray-300 rounded-lg px-2 py-2 text-sm focus:ring-2 focus:ring-orange-400 outline-none"/>
                  <button type="submit" className="bg-orange-500 hover:bg-orange-600 text-white px-3 py-2 rounded-lg transition-colors">
                    <Plus className="h-4 w-4"/>
                  </button>
                </form>
                {ingredients.length===0&&<p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">No ingredients yet. Add them in the Inventory tab first.</p>}
                {selectedDish.ingredients.length===0 ? (
                  <p className="text-sm text-gray-400 text-center py-4">No ingredients in recipe yet.</p>
                ) : (
                  <div className="space-y-2">
                    {selectedDish.ingredients.map(r=>{
                      const lineEstimate = estimateIngredientCost(r.ingredient, r.quantityRequired)
                      const effectiveUnitCost = lineEstimate.effectiveUnitCost ?? r.ingredient.unitCost ?? 0
                      return (
                      <div key={r.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2.5">
                        <div>
                          <p className="text-sm font-medium text-gray-800">{r.ingredient.name}</p>
                          <p className="text-xs text-gray-500">
                            {r.quantityRequired} {r.ingredient.unit} x {effectiveUnitCost.toLocaleString()} RWF = <span className="font-semibold text-gray-700">{lineEstimate.totalCost.toFixed(0)} RWF</span>
                            {lineEstimate.allocations.length > 1 && <span className="ml-1 font-medium text-amber-600">FIFO blend</span>}
                          </p>
                        </div>
                        <button onClick={()=>removeIngredient(selectedDish.id,r.ingredientId)} className="p-1 rounded hover:bg-red-50">
                          <Trash2 className="h-4 w-4 text-red-400"/>
                        </button>
                      </div>
                    )})}
                    <div className="pt-2 border-t border-gray-100 flex justify-between text-sm">
                      <span className="text-gray-500 font-medium">Total Food Cost:</span>
                      <span className="font-bold text-gray-900">{foodCost(selectedDish).toFixed(0)} RWF</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500 font-medium">Gross Margin:</span>
                      <span className={`font-bold ${margin(selectedDish)>=60?'text-green-600':margin(selectedDish)>=40?'text-amber-600':'text-red-600'}`}>{margin(selectedDish).toFixed(1)}%</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
