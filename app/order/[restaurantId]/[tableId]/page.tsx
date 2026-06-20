'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, ChefHat, Loader2, Minus, Plus, ShoppingCart, X } from 'lucide-react'

import QrMenuPageContent, { type QrMenuDish, type QrMenuDishVariant, type QrMenuTypeSelection } from '@/components/QrMenuPageContent'
import { buildDishVariantLabel } from '@/lib/dishVariants'
import { calculateGrossFromNet } from '@/lib/restaurantVat'

type DishVariant = QrMenuDishVariant
type Dish = QrMenuDish

type CartItem = {
  key: string
  dishId: string
  dishName: string
  dishPrice: number
  qty: number
  dishVariantId?: string | null
  dishVariantName?: string | null
}

function buildCartKey(dishId: string, dishVariantId?: string | null) {
  return dishVariantId ? `${dishId}:${dishVariantId}` : dishId
}

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
  const [qrOrderingMode, setQrOrderingMode] = useState<'order' | 'view_only' | 'disabled'>('order')
  const [qrMenuHeroImageUrl, setQrMenuHeroImageUrl] = useState<string | null>(null)
  const [selectedMenuType, setSelectedMenuType] = useState<QrMenuTypeSelection>('all')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/order/${restaurantId}?tableId=${encodeURIComponent(tableId)}`)
        const data = await res.json()
        if (!res.ok) {
          setError('Menu not found')
          return
        }

        setRestaurantName(data.restaurant.name)
        setQrOrderingMode(
          data.restaurant.qrOrderingMode === 'view_only'
            ? 'view_only'
            : data.restaurant.qrOrderingMode === 'disabled'
              ? 'disabled'
              : 'order',
        )
        setQrMenuHeroImageUrl(typeof data.restaurant.qrMenuHeroImageUrl === 'string' ? data.restaurant.qrMenuHeroImageUrl : null)
        setDishes(data.dishes)

        const tableRes = await fetch(`/api/order/${restaurantId}/table/${tableId}`)
        if (tableRes.ok) {
          const tablePayload = await tableRes.json()
          setTableName(tablePayload.name)
        }
      } catch {
        setError('Failed to load menu')
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [restaurantId, tableId])

  function addToCart(dish: Dish, variant?: DishVariant) {
    if (qrOrderingMode !== 'order') return

    const cartKey = buildCartKey(dish.id, variant?.id)
    const dishName = buildDishVariantLabel(dish.name, variant?.name)
    const dishPrice = variant?.sellingPrice ?? dish.sellingPrice

    setCart((current) => {
      const existing = current.find((item) => item.key === cartKey)
      if (existing) {
        return current.map((item) => item.key === cartKey ? { ...item, qty: item.qty + 1 } : item)
      }

      return [
        ...current,
        {
          key: cartKey,
          dishId: dish.id,
          dishName,
          dishPrice,
          qty: 1,
          dishVariantId: variant?.id ?? null,
          dishVariantName: variant?.name ?? null,
        },
      ]
    })
  }

  function removeFromCart(dishId: string, dishVariantId?: string | null) {
    if (qrOrderingMode !== 'order') return

    const cartKey = buildCartKey(dishId, dishVariantId)
    setCart((current) => {
      const existing = current.find((item) => item.key === cartKey)
      if (!existing) return current
      if (existing.qty === 1) return current.filter((item) => item.key !== cartKey)
      return current.map((item) => item.key === cartKey ? { ...item, qty: item.qty - 1 } : item)
    })
  }

  function getQty(dishId: string, dishVariantId?: string | null) {
    return cart.find((item) => item.key === buildCartKey(dishId, dishVariantId))?.qty ?? 0
  }

  function getDishQty(dishId: string) {
    return cart.filter((item) => item.dishId === dishId).reduce((sum, item) => sum + item.qty, 0)
  }

  const totalItems = cart.reduce((sum, item) => sum + item.qty, 0)
  const subtotalPrice = cart.reduce((sum, item) => sum + item.qty * item.dishPrice, 0)
  const totalPrice = calculateGrossFromNet(subtotalPrice)

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
          items: cart.map((item) => ({
            dishId: item.dishId,
            dishVariantId: item.dishVariantId,
            qty: item.qty,
          })),
        }),
      })

      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setError(payload?.error || 'Failed to place order. Please try again.')
        return
      }

      setSubmitted(true)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#fbf7f2] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
      </div>
    )
  }

  if (error && !restaurantName) {
    return (
      <div className="min-h-screen bg-[#fbf7f2] flex items-center justify-center p-4">
        <div className="text-center">
          <ChefHat className="mx-auto mb-3 h-12 w-12 text-gray-300" />
          <p className="text-gray-500">{error}</p>
        </div>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-[#fbf7f2] flex items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-8 text-center shadow-xl">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <CheckCircle2 className="h-9 w-9 text-green-500" />
          </div>
          <h2 className="text-xl font-bold text-gray-900">Order Placed!</h2>
          <p className="text-sm text-gray-500">Your order has been sent to the kitchen. A waiter will be with you shortly.</p>
          <div className="space-y-1 rounded-xl bg-gray-50 p-3 text-left">
            {cart.map((item) => (
              <div key={item.key} className="flex justify-between text-sm">
                <span className="text-gray-700">{item.qty}× {item.dishName}</span>
                <span className="text-gray-500">{(item.qty * item.dishPrice).toLocaleString()} RWF</span>
              </div>
            ))}
            <div className="mt-2 space-y-1 border-t border-gray-200 pt-2 text-sm">
              <div className="flex justify-between font-bold">
                <span>Total</span>
                <span className="text-orange-600">{totalPrice.toLocaleString()} RWF</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setCart([])
              setSubmitted(false)
              setCustomerName('')
            }}
            className="w-full rounded-xl bg-orange-500 py-2.5 text-sm font-semibold text-white hover:bg-orange-600"
          >
            Order More
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <QrMenuPageContent
        restaurantName={restaurantName}
        headerDetail={`Table ${tableName || tableId}`}
        qrOrderingMode={qrOrderingMode}
        qrMenuHeroImageUrl={qrMenuHeroImageUrl}
        dishes={dishes}
        selectedMenuType={selectedMenuType}
        selectedCategory={selectedCategory}
        onSelectMenuType={setSelectedMenuType}
        onSelectCategory={setSelectedCategory}
        orderState={{
          getQty,
          getDishQty,
          onAddToCart: addToCart,
          onRemoveFromCart: removeFromCart,
        }}
      />

      {qrOrderingMode === 'order' && totalItems > 0 && !showCart ? (
        <button
          type="button"
          onClick={() => setShowCart(true)}
          className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-2xl bg-gradient-to-r from-orange-500 to-red-600 px-6 py-3 font-semibold text-white shadow-[0_18px_40px_rgba(193,82,48,0.35)] transition-all hover:from-orange-600 hover:to-red-700"
        >
          <div className="relative">
            <ShoppingCart className="h-5 w-5" />
            <span className="absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">{totalItems}</span>
          </div>
          <span>View Cart</span>
          <span className="rounded-lg bg-white/20 px-2 py-0.5 text-sm">{totalPrice.toLocaleString()} RWF</span>
        </button>
      ) : null}

      {qrOrderingMode === 'order' && showCart ? (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50">
          <div className="max-h-[80vh] overflow-y-auto rounded-t-[30px] bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 p-4">
              <h3 className="font-bold text-gray-900">Your Order</h3>
              <button type="button" onClick={() => setShowCart(false)}>
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>
            <div className="space-y-3 p-4">
              {cart.map((item) => (
                <div key={item.key} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => removeFromCart(item.dishId, item.dishVariantId)}
                      className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-600"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="w-5 text-center text-sm font-bold">{item.qty}</span>
                    <button
                      type="button"
                      onClick={() => setCart((current) => current.map((row) => row.key === item.key ? { ...row, qty: row.qty + 1 } : row))}
                      className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-100 text-orange-600"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <span className="mx-3 flex-1 text-sm text-gray-800">{item.dishName}</span>
                  <span className="text-sm font-semibold text-gray-700">{(item.qty * item.dishPrice).toLocaleString()} RWF</span>
                </div>
              ))}
              <div className="space-y-1 border-t border-gray-100 pt-3">
                <div className="flex justify-between font-bold"><span>Total</span><span className="text-orange-600">{totalPrice.toLocaleString()} RWF</span></div>
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Your name (optional)</label>
                <input
                  value={customerName}
                  onChange={(event) => setCustomerName(event.target.value)}
                  placeholder="e.g. John"
                  className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>
              {error ? <p className="text-xs text-red-500">{error}</p> : null}
              <button
                type="button"
                onClick={placeOrder}
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-orange-500 to-red-600 py-3 font-bold text-white hover:from-orange-600 hover:to-red-700 disabled:opacity-60"
              >
                {submitting ? <><Loader2 className="h-4 w-4 animate-spin" />Placing Order...</> : 'Place Order'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
