'use client'
import { useState, useEffect } from 'react'
import { ShoppingCart, Plus, Minus, X, ChefHat, CheckCircle2, Loader2 } from 'lucide-react'

type Dish = { id: string; name: string; sellingPrice: number; category: string | null }
type CartItem = Dish & { qty: number }

export default function CustomerOrderPage({ params }: { params: { restaurantId: string; tableId: string } }) {
  const { restaurantId, tableId } = params

  const [restaurantName, setRestaurantName] = useState('')
  const [tableName, setTableName] = useState('')
  const [dishes, setDishes] = useState<Dish[]>([])
  const [cart, setCart] = useState<CartItem[]>([])
  const [customerName, setCustomerName] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const [showCart, setShowCart] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/order/${restaurantId}`)
        const data = await res.json()
        if (!res.ok) { setError('Menu not found'); return }
        setRestaurantName(data.restaurant.name)
        setDishes(data.dishes)

        // Get table name
        const tableRes = await fetch(`/api/order/${restaurantId}/table/${tableId}`)
        if (tableRes.ok) {
          const t = await tableRes.json()
          setTableName(t.name)
        }
      } catch {
        setError('Failed to load menu')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [restaurantId, tableId])

  function addToCart(dish: Dish) {
    setCart(prev => {
      const existing = prev.find(i => i.id === dish.id)
      if (existing) return prev.map(i => i.id === dish.id ? { ...i, qty: i.qty + 1 } : i)
      return [...prev, { ...dish, qty: 1 }]
    })
  }

  function removeFromCart(dishId: string) {
    setCart(prev => {
      const existing = prev.find(i => i.id === dishId)
      if (!existing) return prev
      if (existing.qty === 1) return prev.filter(i => i.id !== dishId)
      return prev.map(i => i.id === dishId ? { ...i, qty: i.qty - 1 } : i)
    })
  }

  function getQty(dishId: string) {
    return cart.find(i => i.id === dishId)?.qty ?? 0
  }

  const totalItems = cart.reduce((s, i) => s + i.qty, 0)
  const totalPrice = cart.reduce((s, i) => s + i.qty * i.sellingPrice, 0)

  async function placeOrder() {
    if (cart.length === 0) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`/api/order/${restaurantId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tableId,
          tableName,
          customerName: customerName.trim() || undefined,
          items: cart.map(i => ({ dishId: i.id, dishName: i.name, dishPrice: i.sellingPrice, qty: i.qty })),
        }),
      })
      if (!res.ok) { setError('Failed to place order. Please try again.'); return }
      setSubmitted(true)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Group dishes by category
  const categories = [...new Set(dishes.map(d => d.category || 'Other'))]

  if (loading) return (
    <div className="min-h-screen bg-orange-50 flex items-center justify-center">
      <Loader2 className="h-8 w-8 text-orange-500 animate-spin"/>
    </div>
  )

  if (error && !restaurantName) return (
    <div className="min-h-screen bg-orange-50 flex items-center justify-center p-4">
      <div className="text-center">
        <ChefHat className="h-12 w-12 text-gray-300 mx-auto mb-3"/>
        <p className="text-gray-500">{error}</p>
      </div>
    </div>
  )

  if (submitted) return (
    <div className="min-h-screen bg-orange-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full text-center space-y-4">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
          <CheckCircle2 className="h-9 w-9 text-green-500"/>
        </div>
        <h2 className="text-xl font-bold text-gray-900">Order Placed!</h2>
        <p className="text-gray-500 text-sm">Your order has been sent to the kitchen. A waiter will be with you shortly.</p>
        <div className="bg-gray-50 rounded-xl p-3 text-left space-y-1">
          {cart.map(i => (
            <div key={i.id} className="flex justify-between text-sm">
              <span className="text-gray-700">{i.qty}× {i.name}</span>
              <span className="text-gray-500">{(i.qty * i.sellingPrice).toLocaleString()} RWF</span>
            </div>
          ))}
          <div className="border-t border-gray-200 pt-2 mt-2 flex justify-between font-bold text-sm">
            <span>Total</span>
            <span className="text-orange-600">{totalPrice.toLocaleString()} RWF</span>
          </div>
        </div>
        <button onClick={() => { setCart([]); setSubmitted(false); setCustomerName('') }}
          className="w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-2.5 rounded-xl text-sm">
          Order More
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50 pb-32">
      {/* Header */}
      <div className="bg-gradient-to-r from-orange-500 to-red-500 text-white px-4 pt-8 pb-6">
        <div className="flex items-center gap-2 mb-1">
          <ChefHat className="h-5 w-5"/>
          <h1 className="font-bold text-lg">{restaurantName}</h1>
        </div>
        <p className="text-orange-100 text-sm">Table: <span className="font-semibold text-white">{tableName || tableId}</span></p>
      </div>

      {/* Menu */}
      <div className="px-4 pt-4 space-y-6">
        {dishes.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <ChefHat className="h-10 w-10 mx-auto mb-2"/>
            <p>No menu items available</p>
          </div>
        )}
        {categories.map(cat => (
          <div key={cat}>
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">{cat}</h2>
            <div className="space-y-2">
              {dishes.filter(d => (d.category || 'Other') === cat).map(dish => {
                const qty = getQty(dish.id)
                return (
                  <div key={dish.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-3 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 text-sm">{dish.name}</p>
                      <p className="text-orange-600 font-bold text-sm">{dish.sellingPrice.toLocaleString()} RWF</p>
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      {qty > 0 ? (
                        <>
                          <button onClick={() => removeFromCart(dish.id)}
                            className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center">
                            <Minus className="h-3.5 w-3.5"/>
                          </button>
                          <span className="w-5 text-center font-bold text-sm text-gray-800">{qty}</span>
                        </>
                      ) : null}
                      <button onClick={() => addToCart(dish)}
                        className="w-7 h-7 rounded-full bg-orange-500 text-white flex items-center justify-center">
                        <Plus className="h-3.5 w-3.5"/>
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Floating cart button */}
      {totalItems > 0 && !showCart && (
        <button onClick={() => setShowCart(true)}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-orange-500 hover:bg-orange-600 text-white font-semibold px-6 py-3 rounded-2xl shadow-xl flex items-center gap-3 transition-all">
          <div className="relative">
            <ShoppingCart className="h-5 w-5"/>
            <span className="absolute -top-2 -right-2 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">{totalItems}</span>
          </div>
          <span>View Cart</span>
          <span className="bg-white/20 rounded-lg px-2 py-0.5 text-sm">{totalPrice.toLocaleString()} RWF</span>
        </button>
      )}

      {/* Cart sheet */}
      {showCart && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50">
          <div className="bg-white rounded-t-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-900">Your Order</h3>
              <button onClick={() => setShowCart(false)}><X className="h-5 w-5 text-gray-400"/></button>
            </div>
            <div className="p-4 space-y-3">
              {cart.map(item => (
                <div key={item.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button onClick={() => removeFromCart(item.id)}
                      className="w-7 h-7 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center">
                      <Minus className="h-3.5 w-3.5"/>
                    </button>
                    <span className="font-bold text-sm w-5 text-center">{item.qty}</span>
                    <button onClick={() => addToCart(item)}
                      className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center">
                      <Plus className="h-3.5 w-3.5"/>
                    </button>
                  </div>
                  <span className="flex-1 text-sm text-gray-800 mx-3">{item.name}</span>
                  <span className="text-sm font-semibold text-gray-700">{(item.qty * item.sellingPrice).toLocaleString()} RWF</span>
                </div>
              ))}
              <div className="border-t border-gray-100 pt-3 flex justify-between font-bold">
                <span>Total</span>
                <span className="text-orange-600">{totalPrice.toLocaleString()} RWF</span>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Your name (optional)</label>
                <input value={customerName} onChange={e => setCustomerName(e.target.value)}
                  placeholder="e.g. John"
                  className="mt-1 w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"/>
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              <button onClick={placeOrder} disabled={submitting}
                className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2">
                {submitting ? <><Loader2 className="h-4 w-4 animate-spin"/>Placing Order…</> : '🍽️ Place Order'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
