'use client'

import Image from 'next/image'
import { useEffect } from 'react'
import { ChefHat, Minus, Plus } from 'lucide-react'

import { getActiveDishVariants, getDishStartingPrice } from '@/lib/dishVariants'
import { MENU_TYPE_OPTIONS, MENU_TYPE_SECTION_ORDER, getDishMenuTypeKey, getDishMenuTypeLabel } from '@/lib/menuMetadata'

export type QrMenuDishVariant = {
  id: string
  name: string
  sellingPrice: number
  sortOrder?: number | null
  isActive?: boolean | null
}

export type QrMenuDish = {
  id: string
  name: string
  sellingPrice: number
  category: string | null
  menuType?: string | null
  description?: string | null
  variants?: QrMenuDishVariant[]
}

export type QrOrderingMode = 'order' | 'view_only' | 'disabled'
export type QrMenuTypeSelection = 'all' | (typeof MENU_TYPE_SECTION_ORDER)[number]

type QrMenuOrderState = {
  getQty: (dishId: string, dishVariantId?: string | null) => number
  getDishQty: (dishId: string) => number
  onAddToCart?: (dish: QrMenuDish, variant?: QrMenuDishVariant) => void
  onRemoveFromCart?: (dishId: string, dishVariantId?: string | null) => void
}

type QrMenuPageContentProps = {
  restaurantName: string
  headerDetail: string
  qrOrderingMode: QrOrderingMode
  qrMenuHeroImageUrl: string | null
  dishes: QrMenuDish[]
  selectedMenuType: QrMenuTypeSelection
  selectedCategory: string
  onSelectMenuType?: (value: QrMenuTypeSelection) => void
  onSelectCategory?: (value: string) => void
  orderState?: QrMenuOrderState
  embedded?: boolean
}

export default function QrMenuPageContent({
  restaurantName,
  headerDetail,
  qrOrderingMode,
  qrMenuHeroImageUrl,
  dishes,
  selectedMenuType,
  selectedCategory,
  onSelectMenuType,
  onSelectCategory,
  orderState,
  embedded = false,
}: QrMenuPageContentProps) {
  const availableMenuTypes = Array.from(new Set(dishes.map((dish) => getDishMenuTypeKey(dish.menuType, dish.category)))).sort(
    (left, right) => MENU_TYPE_SECTION_ORDER.indexOf(left) - MENU_TYPE_SECTION_ORDER.indexOf(right),
  )

  const dishesForSelectedType = selectedMenuType === 'all'
    ? dishes
    : dishes.filter((dish) => getDishMenuTypeKey(dish.menuType, dish.category) === selectedMenuType)

  const categories = [...new Set(dishesForSelectedType.map((dish) => dish.category || 'Other'))]

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
    if (!onSelectMenuType) return
    if (selectedMenuType !== 'all' && !availableMenuTypes.includes(selectedMenuType)) {
      onSelectMenuType('all')
    }
  }, [availableMenuTypes, onSelectMenuType, selectedMenuType])

  useEffect(() => {
    if (!onSelectCategory) return
    if (selectedCategory !== 'all' && !categories.includes(selectedCategory)) {
      onSelectCategory('all')
    }
  }, [categories, onSelectCategory, selectedCategory])

  const availabilityLabel = qrOrderingMode === 'order'
    ? 'Ordering open'
    : qrOrderingMode === 'view_only'
      ? 'View only'
      : 'Ask staff'

  const getQty = orderState?.getQty ?? (() => 0)
  const getDishQty = orderState?.getDishQty ?? (() => 0)

  return (
    <div className={`${embedded ? 'bg-[#fbf7f2] pb-6' : 'min-h-screen bg-[#fbf7f2] pb-32'} text-slate-900`}>
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
              <p className="mt-2 text-sm text-slate-500">{headerDetail}</p>
            </div>
            <div className="inline-flex items-center rounded-2xl border border-orange-100 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-700">
              {availabilityLabel}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">VAT added at billing</span>
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
        </div>
      </div>

      {availableMenuTypes.length > 0 || categories.length > 0 ? (
        <div className="sticky top-0 z-20 mt-4 border-y border-orange-100 bg-[#fbf7f2]/95 backdrop-blur">
          <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 sm:px-6">
            {availableMenuTypes.length > 0 ? (
              <div className="flex gap-3 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => onSelectMenuType?.('all')}
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
                    onClick={() => onSelectMenuType?.(typeKey)}
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
                  onClick={() => onSelectCategory?.('all')}
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
                    onClick={() => onSelectCategory?.(category)}
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
            <ChefHat className="mx-auto mb-2 h-10 w-10" />
            <p>No menu items available</p>
          </div>
        ) : menuSections.length === 0 ? (
          <div className="rounded-[28px] border border-dashed border-orange-200 bg-white px-6 py-14 text-center text-gray-400 shadow-sm">
            <ChefHat className="mx-auto mb-2 h-10 w-10" />
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
                                <p className="text-2xl font-black text-[#e24336]">{variants.length > 0 ? `From ${startingPrice.toLocaleString()}` : dish.sellingPrice.toLocaleString()} RWF</p>
                                <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-orange-400">excl. VAT</p>
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
                                            <p className="text-xs font-semibold text-orange-600">{variant.sellingPrice.toLocaleString()} RWF</p>
                                          </div>
                                          {qrOrderingMode === 'order' ? (
                                            <div className="flex items-center gap-2">
                                              {variantQty > 0 ? (
                                                <>
                                                  <button type="button" onClick={() => orderState?.onRemoveFromCart?.(dish.id, variant.id)} className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-orange-600 transition hover:bg-orange-100">
                                                    <Minus className="h-4 w-4" />
                                                  </button>
                                                  <span className="w-5 text-center text-sm font-bold text-gray-800">{variantQty}</span>
                                                </>
                                              ) : null}
                                              <button type="button" onClick={() => orderState?.onAddToCart?.(dish, variant)} className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-r from-orange-500 to-red-600 text-white shadow-lg shadow-orange-500/20 transition hover:from-orange-600 hover:to-red-700">
                                                <Plus className="h-4 w-4" />
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
                                        <button type="button" onClick={() => orderState?.onRemoveFromCart?.(dish.id)} className="flex h-9 w-9 items-center justify-center rounded-full bg-orange-100 text-orange-600 transition hover:bg-orange-200">
                                          <Minus className="h-4 w-4" />
                                        </button>
                                        <span className="w-6 text-center text-sm font-bold text-gray-800">{qty}</span>
                                      </>
                                    ) : null}
                                    <button type="button" onClick={() => orderState?.onAddToCart?.(dish)} className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-r from-orange-500 to-red-600 text-white shadow-lg shadow-orange-500/20 transition hover:from-orange-600 hover:to-red-700">
                                      <Plus className="h-4 w-4" />
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
    </div>
  )
}