'use client'
import Image from 'next/image'
import { useState, useEffect } from 'react'
import { ShoppingCart, Plus, Minus, X, ChefHat, CheckCircle2, Loader2 } from 'lucide-react'
import { buildDishVariantLabel, getActiveDishVariants, getDishStartingPrice } from '@/lib/dishVariants'
import { MENU_TYPE_OPTIONS, MENU_TYPE_SECTION_ORDER, getDishMenuTypeKey, getDishMenuTypeLabel } from '@/lib/menuMetadata'
import { calculateGrossFromNet, calculateVatFromNet } from '@/lib/restaurantVat'

type DishVariant = { id: string; name: string; sellingPrice: number; sortOrder?: number | null }
type Dish = { id: string; name: string; sellingPrice: number; category: string | null; menuType?: string | null; description?: string | null; variants?: DishVariant[] }
type CartItem = {
  key: string
  dishId: string
  dishName: string
  dishPrice: number
  qty: number
  dishVariantId?: string | null
  dishVariantName?: string | null
}
type MenuTypeSelection = 'all' | (typeof MENU_TYPE_SECTION_ORDER)[number]

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
  const [selectedMenuType, setSelectedMenuType] = useState<MenuTypeSelection>('all')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/order/${restaurantId}?tableId=${encodeURIComponent(tableId)}`)
        const data = await res.json()
        if (!res.ok) { setError('Menu not found'); return }
        setRestaurantName(data.restaurant.name)
        setQrOrderingMode(
          data.restaurant.qrOrderingMode === 'view_only'
            ? 'view_only'
            : data.restaurant.qrOrderingMode === 'disabled'
              ? 'disabled'
              : 'order'
        )
        setQrMenuHeroImageUrl(typeof data.restaurant.qrMenuHeroImageUrl === 'string' ? data.restaurant.qrMenuHeroImageUrl : null)
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

  function addToCart(dish: Dish, variant?: DishVariant) {
    if (qrOrderingMode !== 'order') return
    const cartKey = buildCartKey(dish.id, variant?.id)
    const dishName = buildDishVariantLabel(dish.name, variant?.name)
    const dishPrice = variant?.sellingPrice ?? dish.sellingPrice
    setCart(prev => {
      const existing = prev.find((item) => item.key === cartKey)
      if (existing) return prev.map((item) => item.key === cartKey ? { ...item, qty: item.qty + 1 } : item)
      return [...prev, {
        key: cartKey,
        dishId: dish.id,
        dishName,
        dishPrice,
        qty: 1,
        dishVariantId: variant?.id ?? null,
        dishVariantName: variant?.name ?? null,
      }]
    })
  }

  function removeFromCart(dishId: string, dishVariantId?: string | null) {
    if (qrOrderingMode !== 'order') return
    const cartKey = buildCartKey(dishId, dishVariantId)
    setCart(prev => {
      const existing = prev.find((item) => item.key === cartKey)
      if (!existing) return prev
      if (existing.qty === 1) return prev.filter((item) => item.key !== cartKey)
      return prev.map((item) => item.key === cartKey ? { ...item, qty: item.qty - 1 } : item)
    })
  }

  function getQty(dishId: string, dishVariantId?: string | null) {
    return cart.find((item) => item.key === buildCartKey(dishId, dishVariantId))?.qty ?? 0
  }

  function getDishQty(dishId: string) {
    return cart.filter((item) => item.dishId === dishId).reduce((sum, item) => sum + item.qty, 0)
  }

  const totalItems = cart.reduce((s, i) => s + i.qty, 0)
  const subtotalPrice = cart.reduce((s, i) => s + i.qty * i.dishPrice, 0)
  const vatAmount = calculateVatFromNet(subtotalPrice)
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

  const availableMenuTypes = Array.from(new Set(dishes.map((dish) => getDishMenuTypeKey(dish.menuType, dish.category)))).sort(
    (left, right) => MENU_TYPE_SECTION_ORDER.indexOf(left) - MENU_TYPE_SECTION_ORDER.indexOf(right),
  )

  const dishesForSelectedType = selectedMenuType === 'all'
    ? dishes
    : dishes.filter((dish) => getDishMenuTypeKey(dish.menuType, dish.category) === selectedMenuType)

  const categories = [...new Set(dishesForSelectedType.map(d => d.category || 'Other'))]

  const visibleTypeKeys = selectedMenuType === 'all'
    ? availableMenuTypes
    : availableMenuTypes.filter((typeKey) => typeKey === selectedMenuType)

  const menuSections = visibleTypeKeys.map((typeKey) => {
    const dishesForType = dishes.filter((dish) => getDishMenuTypeKey(dish.menuType, dish.category) === typeKey)
    const categoriesForType = [...new Set(dishesForType.map((dish) => dish.category || 'Other'))]
    const visibleCategoriesForType = selectedCategory === 'all'
      ? categoriesForType
      : categoriesForType.filter((category) => category === selectedCategory)

    return {
      typeKey,
      typeLabel: typeKey === 'other'
        ? 'Other'
        : MENU_TYPE_OPTIONS.find((option) => option.value === typeKey)?.label ?? 'Other',
      categories: visibleCategoriesForType.map((category) => ({
        name: category,
        dishes: dishesForType.filter((dish) => (dish.category || 'Other') === category),
      })).filter((categorySection) => categorySection.dishes.length > 0),
    }
  }).filter((typeSection) => typeSection.categories.length > 0)

  useEffect(() => {
    if (selectedMenuType !== 'all' && !availableMenuTypes.includes(selectedMenuType)) {
      setSelectedMenuType('all')
    }
  }, [availableMenuTypes, selectedMenuType])

  useEffect(() => {
    if (selectedCategory !== 'all' && !categories.includes(selectedCategory)) {
      setSelectedCategory('all')
    }
  }, [categories, selectedCategory])

  if (loading) return (
    <div className="min-h-screen bg-[#fbf7f2] flex items-center justify-center">
      <Loader2 className="h-8 w-8 text-orange-500 animate-spin"/>
    </div>
  )

  if (error && !restaurantName) return (
    <div className="min-h-screen bg-[#fbf7f2] flex items-center justify-center p-4">
      <div className="text-center">
        <ChefHat className="h-12 w-12 text-gray-300 mx-auto mb-3"/>
        <p className="text-gray-500">{error}</p>
      </div>
    </div>
  )

  if (submitted) return (
    <div className="min-h-screen bg-[#fbf7f2] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full text-center space-y-4">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
          <CheckCircle2 className="h-9 w-9 text-green-500"/>
        </div>
        <h2 className="text-xl font-bold text-gray-900">Order Placed!</h2>
        <p className="text-gray-500 text-sm">Your order has been sent to the kitchen. A waiter will be with you shortly.</p>
        <div className="bg-gray-50 rounded-xl p-3 text-left space-y-1">
          {cart.map(i => (
            <div key={i.key} className="flex justify-between text-sm">
              <span className="text-gray-700">{i.qty}× {i.dishName}</span>
              <span className="text-gray-500">{calculateGrossFromNet(i.qty * i.dishPrice).toLocaleString()} RWF</span>
            </div>
          ))}
          <div className="border-t border-gray-200 pt-2 mt-2 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Price before VAT</span>
              <span>{subtotalPrice.toLocaleString()} RWF</span>
            </div>
            <div className="flex justify-between text-orange-600">
              <span>VAT (18%)</span>
              <span>{vatAmount.toLocaleString()} RWF</span>
            </div>
            <div className="flex justify-between font-bold">
              <span>Total</span>
              <span className="text-orange-600">{totalPrice.toLocaleString()} RWF</span>
            </div>
          </div>
        </div>
        <button onClick={() => { setCart([]); setSubmitted(false); setCustomerName('') }}
          className="w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-2.5 rounded-xl text-sm">
          Order More
        </button>
      </div>
    </div>
  )

  const visibleCategories = selectedCategory === 'all'
    ? categories
    : categories.filter((category) => category === selectedCategory)

  const availabilityLabel = qrOrderingMode === 'order'
    ? 'Ordering open'
    : qrOrderingMode === 'view_only'
      ? 'View only'
      : 'Ask staff'

  return (
    <div className="min-h-screen bg-[#fbf7f2] pb-32 text-slate-900">
      <section className="relative h-[280px] overflow-hidden bg-gradient-to-br from-orange-500 via-red-500 to-red-700 sm:h-[360px]">
        {qrMenuHeroImageUrl ? (
          <Image
            src={qrMenuHeroImageUrl}
            alt={`${restaurantName} QR menu hero`}
            fill
            priority
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.2),transparent_42%),linear-gradient(135deg,#f97316_0%,#ef4444_55%,#991b1b_100%)]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/60" />
        <div className="absolute left-4 top-4 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white backdrop-blur sm:left-6 sm:top-6">
          Magnify QR Menu
        </div>
      </section>

      <div className="relative z-10 mx-auto -mt-12 max-w-3xl px-4 sm:-mt-16 sm:px-6">
        <div className="rounded-[28px] border border-white/70 bg-white/95 p-5 shadow-[0_24px_60px_rgba(181,67,48,0.18)] backdrop-blur sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-orange-500">Table service</p>
              <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">{restaurantName}</h1>
              <p className="mt-2 text-sm text-slate-500">Table {tableName || tableId} · All prices already include VAT.</p>
            </div>
            <div className="inline-flex items-center rounded-2xl border border-orange-100 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-700">
              {availabilityLabel}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">VAT included</span>
            {qrOrderingMode === 'view_only' ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                Guests can browse, but staff still take orders.
              </span>
            ) : null}
            {qrOrderingMode === 'disabled' ? (
              <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-semibold text-gray-600">
                QR ordering is disabled. Please ask staff for service.
              </span>
            ) : null}
          </div>

          {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}
        </div>
      </div>

      {availableMenuTypes.length > 0 || categories.length > 0 ? (
        <div className="sticky top-0 z-20 mt-4 border-y border-orange-100 bg-[#fbf7f2]/95 backdrop-blur">
          <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 sm:px-6">
            {availableMenuTypes.length > 0 ? (
              <div className="flex gap-3 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setSelectedMenuType('all')}
                  className={`whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                    selectedMenuType === 'all'
                      ? 'border-transparent bg-slate-900 text-white shadow-lg shadow-slate-900/20'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                  }`}
                >
                  All types
                </button>
                {availableMenuTypes.map((typeKey) => (
                  <button
                    key={typeKey}
                    type="button"
                    onClick={() => setSelectedMenuType(typeKey)}
                    className={`whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                      selectedMenuType === typeKey
                        ? 'border-transparent bg-slate-900 text-white shadow-lg shadow-slate-900/20'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                    }`}
                  >
                    {typeKey === 'other' ? 'Other' : MENU_TYPE_OPTIONS.find((option) => option.value === typeKey)?.label ?? 'Other'}
                  </button>
                ))}
              </div>
            ) : null}

            {categories.length > 0 ? (
              <div className="flex gap-3 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setSelectedCategory('all')}
                  className={`whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                    selectedCategory === 'all'
                      ? 'border-transparent bg-gradient-to-r from-orange-500 to-red-600 text-white shadow-lg shadow-orange-500/20'
                      : 'border-orange-200 bg-white text-orange-600 hover:border-orange-300'
                  }`}
                >
                  All categories
                </button>
                {categories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setSelectedCategory(category)}
                    className={`whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                      selectedCategory === category
                        ? 'border-transparent bg-gradient-to-r from-orange-500 to-red-600 text-white shadow-lg shadow-orange-500/20'
                        : 'border-orange-200 bg-white text-orange-600 hover:border-orange-300'
                    }`}
                  >
                    {category}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <main className="mx-auto max-w-3xl px-4 pb-10 pt-6 sm:px-6">
        {dishes.length === 0 ? (
          <div className="rounded-[28px] border border-dashed border-orange-200 bg-white px-6 py-14 text-center text-gray-400 shadow-sm">
            <ChefHat className="h-10 w-10 mx-auto mb-2"/>
            <p>No menu items available</p>
          </div>
        ) : menuSections.length === 0 ? (
          <div className="rounded-[28px] border border-dashed border-orange-200 bg-white px-6 py-14 text-center text-gray-400 shadow-sm">
            <ChefHat className="h-10 w-10 mx-auto mb-2"/>
            <p>No menu items match the current filters.</p>
          </div>
        ) : (
          <div className="space-y-12">
            {menuSections.map((typeSection) => (
              <div key={typeSection.typeKey} className="space-y-8">
                {selectedMenuType === 'all' ? (
                  <div className="flex items-end justify-between gap-3 border-b border-dashed border-slate-300 pb-3">
                    <h2 className="text-2xl font-black uppercase tracking-tight text-slate-900">{typeSection.typeLabel}</h2>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                      {typeSection.categories.reduce((total, categorySection) => total + categorySection.dishes.length, 0)} items
                    </span>
                  </div>
                ) : null}

                {typeSection.categories.map((categorySection) => (
                  <section key={`${typeSection.typeKey}:${categorySection.name}`} className="space-y-4">
                    <div className="flex items-end justify-between gap-3 border-b border-orange-200 pb-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-orange-400">{typeSection.typeLabel}</p>
                        <h3 className="text-2xl font-black uppercase tracking-tight text-[#d73a32]">{categorySection.name}</h3>
                      </div>
                      <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-orange-400">
                        {categorySection.dishes.length} items
                      </span>
                    </div>

                    <div className="space-y-4">
                      {categorySection.dishes.map((dish) => {
                        const typeLabel = getDishMenuTypeLabel(dish.menuType, dish.category)
                        const variants = getActiveDishVariants(dish.variants)
                        const qty = getDishQty(dish.id)
                        const startingPrice = getDishStartingPrice(variants, dish.sellingPrice)

                        return (
                          <article key={dish.id} className="rounded-[26px] border border-orange-100 bg-white p-4 shadow-[0_20px_40px_rgba(188,83,54,0.08)] sm:p-5">
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0 flex-1">
                                {typeLabel ? <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">{typeLabel}</p> : null}
                                <h3 className="text-xl font-black uppercase tracking-tight text-slate-900">{dish.name}</h3>
                                {dish.description ? (
                                  <p className="mt-2 text-sm leading-relaxed text-slate-500">{dish.description}</p>
                                ) : null}
                              </div>
                              <div className="shrink-0 text-right">
                                <p className="text-2xl font-black text-[#e24336]">{variants.length > 0 ? `From ${calculateGrossFromNet(startingPrice).toLocaleString()}` : calculateGrossFromNet(dish.sellingPrice).toLocaleString()} RWF</p>
                                <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-orange-400">VAT included</p>
                              </div>
                            </div>

                            {variants.length > 0 ? (
                              <div className="mt-5 space-y-3 border-t border-orange-100 pt-4">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400">Choose a size</div>
                                  {qty > 0 ? <span className="rounded-full bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-600">{qty} in cart</span> : null}
                                </div>
                                <div className="grid gap-2 sm:grid-cols-2">
                                  {variants.map((variant) => {
                                    const variantQty = getQty(dish.id, variant.id)
                                    return (
                                      <div key={`${dish.id}:${variant.id}`} className="rounded-2xl border border-orange-100 bg-orange-50/40 px-3 py-3">
                                        <div className="flex items-start justify-between gap-3">
                                          <div>
                                            <p className="text-sm font-bold text-slate-900">{variant.name}</p>
                                            <p className="text-xs font-semibold text-orange-600">{calculateGrossFromNet(variant.sellingPrice).toLocaleString()} RWF</p>
                                          </div>
                                          {qrOrderingMode === 'order' ? (
                                            <div className="flex items-center gap-2">
                                              {variantQty > 0 ? (
                                                <>
                                                  <button onClick={() => removeFromCart(dish.id, variant.id)} className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-orange-600 transition hover:bg-orange-100">
                                                    <Minus className="h-4 w-4"/>
                                                  </button>
                                                  <span className="w-5 text-center text-sm font-bold text-gray-800">{variantQty}</span>
                                                </>
                                              ) : null}
                                              <button onClick={() => addToCart(dish, variant)} className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-r from-orange-500 to-red-600 text-white shadow-lg shadow-orange-500/20 transition hover:from-orange-600 hover:to-red-700">
                                                <Plus className="h-4 w-4"/>
                                              </button>
                                            </div>
                                          ) : (
                                            <span className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-500">
                                              {qrOrderingMode === 'view_only' ? 'View only' : 'Ask staff'}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            ) : (
                              <div className="mt-5 flex items-center justify-between gap-3 border-t border-orange-100 pt-4">
                                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400">Add to order</div>
                                {qrOrderingMode === 'order' ? (
                                  <div className="flex items-center gap-2">
                                    {qty > 0 ? (
                                      <>
                                        <button onClick={() => removeFromCart(dish.id)}
                                          className="flex h-9 w-9 items-center justify-center rounded-full bg-orange-100 text-orange-600 transition hover:bg-orange-200">
                                          <Minus className="h-4 w-4"/>
                                        </button>
                                        <span className="w-6 text-center text-sm font-bold text-gray-800">{qty}</span>
                                      </>
                                    ) : null}
                                    <button onClick={() => addToCart(dish)}
                                      className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-r from-orange-500 to-red-600 text-white shadow-lg shadow-orange-500/20 transition hover:from-orange-600 hover:to-red-700">
                                      <Plus className="h-4 w-4"/>
                                    </button>
                                  </div>
                                ) : (
                                  <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-500">
                                    {qrOrderingMode === 'view_only' ? 'View only' : 'Ask staff'}
                                  </span>
                                )}
                              </div>
                            )}
                          </article>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            ))}
          </div>
        )}
      </main>

      {qrOrderingMode === 'order' && totalItems > 0 && !showCart && (
        <button onClick={() => setShowCart(true)}
          className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-2xl bg-gradient-to-r from-orange-500 to-red-600 px-6 py-3 font-semibold text-white shadow-[0_18px_40px_rgba(193,82,48,0.35)] transition-all hover:from-orange-600 hover:to-red-700">
          <div className="relative">
            <ShoppingCart className="h-5 w-5"/>
            <span className="absolute -top-2 -right-2 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">{totalItems}</span>
          </div>
          <span>View Cart</span>
          <span className="bg-white/20 rounded-lg px-2 py-0.5 text-sm">{totalPrice.toLocaleString()} RWF</span>
        </button>
      )}

      {qrOrderingMode === 'order' && showCart && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50">
          <div className="max-h-[80vh] overflow-y-auto rounded-t-[30px] bg-white">
            <div className="flex items-center justify-between p-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-900">Your Order</h3>
              <button onClick={() => setShowCart(false)}><X className="h-5 w-5 text-gray-400"/></button>
            </div>
            <div className="p-4 space-y-3">
              {cart.map(item => (
                <div key={item.key} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button onClick={() => removeFromCart(item.dishId, item.dishVariantId)}
                      className="w-7 h-7 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center">
                      <Minus className="h-3.5 w-3.5"/>
                    </button>
                    <span className="font-bold text-sm w-5 text-center">{item.qty}</span>
                    <button onClick={() => setCart((current) => current.map((row) => row.key === item.key ? { ...row, qty: row.qty + 1 } : row))}
                      className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center">
                      <Plus className="h-3.5 w-3.5"/>
                    </button>
                  </div>
                  <span className="flex-1 text-sm text-gray-800 mx-3">{item.dishName}</span>
                  <span className="text-sm font-semibold text-gray-700">{calculateGrossFromNet(item.qty * item.dishPrice).toLocaleString()} RWF</span>
                </div>
              ))}
              <div className="border-t border-gray-100 pt-3 space-y-1">
                <div className="flex justify-between text-sm text-gray-500"><span>Price before VAT</span><span>{subtotalPrice.toLocaleString()} RWF</span></div>
                <div className="flex justify-between text-sm text-orange-600"><span>VAT (18%)</span><span>{vatAmount.toLocaleString()} RWF</span></div>
                <div className="flex justify-between font-bold">
                  <span>Total</span>
                  <span className="text-orange-600">{totalPrice.toLocaleString()} RWF</span>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Your name (optional)</label>
                <input value={customerName} onChange={e => setCustomerName(e.target.value)}
                  placeholder="e.g. John"
                  className="mt-1 w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"/>
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              <button onClick={placeOrder} disabled={submitting}
                className="w-full bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 disabled:opacity-60 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2">
                {submitting ? <><Loader2 className="h-4 w-4 animate-spin"/>Placing Order...</> : 'Place Order'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
