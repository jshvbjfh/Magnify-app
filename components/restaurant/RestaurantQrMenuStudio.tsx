'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Smartphone, Trash2, Upload } from 'lucide-react'

import { useRestaurantBranch } from '@/contexts/RestaurantBranchContext'
import { getActiveDishVariants, getDishStartingPrice } from '@/lib/dishVariants'
import { getDishMenuTypeLabel } from '@/lib/menuMetadata'
import { calculateGrossFromNet } from '@/lib/restaurantVat'

type MenuItemVariant = {
  id: string
  name: string
  sellingPrice: number
  sortOrder?: number | null
  isActive?: boolean | null
}

type MenuItem = {
  id: string
  name: string
  sellingPrice: number
  category: string | null
  menuType?: string | null
  description?: string | null
  variants?: MenuItemVariant[]
}

type SetupPayload = {
  restaurant?: {
    name?: string
    qrOrderingMode?: 'order' | 'view_only' | 'disabled'
    qrMenuHeroImageUrl?: string | null
  }
}

function getSetupRestaurant(payload: SetupPayload | { error?: string } | null) {
  return payload && 'restaurant' in payload ? payload.restaurant ?? null : null
}

export default function RestaurantQrMenuStudio({ menuItems }: { menuItems: MenuItem[] }) {
  const restaurantBranch = useRestaurantBranch()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [restaurantName, setRestaurantName] = useState('')
  const [qrOrderingMode, setQrOrderingMode] = useState<'order' | 'view_only' | 'disabled'>('disabled')
  const [qrMenuHeroImageUrl, setQrMenuHeroImageUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const previewTypes = Array.from(new Set(menuItems.map((item) => getDishMenuTypeLabel(item.menuType, item.category)).filter(Boolean) as string[])).slice(0, 3)
  const previewCategories = ['All items', ...Array.from(new Set(menuItems.map((item) => item.category).filter(Boolean) as string[])).slice(0, 3)]
  const previewItems = menuItems.slice(0, 3)

  useEffect(() => {
    async function loadConfig() {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch('/api/restaurant/setup', {
          credentials: 'include',
          cache: 'no-store',
        })
        const payload: SetupPayload | { error?: string } | null = await response.json().catch(() => null)

        if (!response.ok) {
          throw new Error((payload as { error?: string } | null)?.error || 'Unable to load QR menu settings.')
        }

        const restaurant = getSetupRestaurant(payload)

        setRestaurantName(restaurant?.name ?? '')
        setQrOrderingMode(restaurant?.qrOrderingMode === 'view_only'
          ? 'view_only'
          : restaurant?.qrOrderingMode === 'order'
            ? 'order'
            : 'disabled')
        setQrMenuHeroImageUrl(typeof restaurant?.qrMenuHeroImageUrl === 'string'
          ? restaurant.qrMenuHeroImageUrl
          : null)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load QR menu settings.')
      } finally {
        setLoading(false)
      }
    }

    void loadConfig()
  }, [restaurantBranch?.branchId])

  async function persistQrMenuHeroImage(nextPath: string | null) {
    setSaving(true)
    setError(null)
    setMessage(null)

    try {
      const response = await fetch('/api/restaurant/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ qrMenuHeroImageUrl: nextPath }),
      })
      const payload: SetupPayload | { error?: string } | null = await response.json().catch(() => null)

      if (!response.ok) {
        throw new Error((payload as { error?: string } | null)?.error || 'Unable to save QR menu image.')
      }

      const restaurant = getSetupRestaurant(payload)

      setQrMenuHeroImageUrl(typeof restaurant?.qrMenuHeroImageUrl === 'string'
        ? restaurant.qrMenuHeroImageUrl
        : null)
      setMessage(nextPath ? 'QR menu header image saved for this branch.' : 'QR menu header image removed.')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save QR menu image.')
    } finally {
      setSaving(false)
    }
  }

  async function handleImageSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setUploading(true)
    setError(null)
    setMessage(null)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch('/api/restaurant/qr-menu-image', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      const payload = await response.json().catch(() => null)

      if (!response.ok) {
        throw new Error(payload?.error || 'Unable to upload QR menu image.')
      }

      await persistQrMenuHeroImage(payload?.path ?? null)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Unable to upload QR menu image.')
    } finally {
      event.target.value = ''
      setUploading(false)
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
      <div className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.26em] text-orange-500">Public QR Menu</p>
            <h3 className="mt-2 text-xl font-bold text-gray-900">Hero Artwork</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-500">
              Upload the branch image that appears at the top of the QR menu after a guest scans a table code.
              The public page keeps Magnify&apos;s orange-to-red flow and lays this artwork over the top section.
            </p>
          </div>
          <div className="rounded-2xl border border-orange-100 bg-orange-50 px-3 py-2 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-orange-500">Branch</p>
            <p className="mt-1 text-sm font-bold text-gray-900">{restaurantBranch?.branchName ?? 'Current branch'}</p>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div className="rounded-2xl border border-dashed border-orange-200 bg-orange-50/60 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageSelection}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading || uploading || saving}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-orange-500 to-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-orange-500/25 transition hover:from-orange-600 hover:to-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Upload className="h-4 w-4" />
                {uploading ? 'Uploading image...' : qrMenuHeroImageUrl ? 'Replace image' : 'Upload image'}
              </button>
              <button
                type="button"
                onClick={() => void persistQrMenuHeroImage(null)}
                disabled={!qrMenuHeroImageUrl || loading || uploading || saving}
                className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                Remove image
              </button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-gray-500">
              Best results: a wide image with strong contrast, sized for mobile first. PNG and JPG work well. Maximum 10MB.
            </p>
          </div>

          {error ? (
            <div className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <p>{error}</p>
            </div>
          ) : null}

          {message ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {message}
            </div>
          ) : null}

          <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-4 text-sm text-gray-600">
            <p className="font-semibold text-gray-800">Guest access mode</p>
            <p className="mt-1">
              {qrOrderingMode === 'order'
                ? 'Guests can browse the menu and place orders from the QR page.'
                : qrOrderingMode === 'view_only'
                  ? 'Guests can browse the QR menu, but ordering stays disabled.'
                  : 'Guest QR ordering is disabled in Settings. The uploaded image will still be ready when you turn QR back on.'}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-700">
          <Smartphone className="h-4 w-4 text-orange-500" />
          Mobile preview
        </div>

        <div className="mx-auto max-w-[380px] rounded-[34px] border border-gray-200 bg-[#fbf7f2] p-3 shadow-[0_24px_60px_rgba(176,72,44,0.12)]">
          <div className="overflow-hidden rounded-[26px] border border-gray-200 bg-white">
            <div className="relative h-64 bg-gradient-to-br from-orange-500 via-red-500 to-red-700">
              {qrMenuHeroImageUrl ? (
                <img
                  src={qrMenuHeroImageUrl}
                  alt="QR menu preview hero"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.22),transparent_42%),linear-gradient(135deg,#f97316_0%,#ef4444_55%,#9f1239_100%)]" />
              )}
              <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/60" />
              <div className="absolute left-4 top-4 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-white backdrop-blur">
                Magnify QR Menu
              </div>
              <div className="absolute inset-x-0 bottom-0 p-4 text-white">
                <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-white/75">Preview</p>
                <h4 className="mt-2 text-3xl font-black tracking-tight">{restaurantName || 'Your restaurant'}</h4>
              </div>
            </div>

            <div className="space-y-4 bg-[#fbf7f2] p-4">
              {previewTypes.length ? (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {previewTypes.map((type, index) => (
                    <span
                      key={type}
                      className={`whitespace-nowrap rounded-full border px-4 py-2 text-xs font-semibold ${
                        index === 0
                          ? 'border-transparent bg-slate-900 text-white'
                          : 'border-slate-200 bg-white text-slate-700'
                      }`}
                    >
                      {type}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="flex gap-2 overflow-x-auto pb-1">
                {previewCategories.map((category, index) => (
                  <span
                    key={category}
                    className={`whitespace-nowrap rounded-full border px-4 py-2 text-xs font-semibold ${
                      index === 0
                        ? 'border-transparent bg-gradient-to-r from-orange-500 to-red-600 text-white shadow-lg shadow-orange-500/20'
                        : 'border-orange-200 bg-white text-orange-600'
                    }`}
                  >
                    {category}
                  </span>
                ))}
              </div>

              <div className="space-y-3">
                {previewItems.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-orange-200 bg-white px-4 py-8 text-center text-sm text-gray-400">
                    Add active dishes to see a richer QR menu preview.
                  </div>
                ) : previewItems.map((item) => {
                  const typeLabel = getDishMenuTypeLabel(item.menuType, item.category)
                  const activeVariants = getActiveDishVariants(item.variants)
                  const startingPrice = getDishStartingPrice(activeVariants, item.sellingPrice)

                  return (
                    <div key={item.id} className="rounded-[22px] border border-orange-100 bg-white px-4 py-4 shadow-[0_18px_40px_rgba(181,75,46,0.08)]">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          {(typeLabel || item.category) ? (
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              {typeLabel ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-700">{typeLabel}</span> : null}
                              {item.category ? <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-600">{item.category}</span> : null}
                            </div>
                          ) : null}
                          <p className="text-lg font-black uppercase tracking-tight text-slate-900">{item.name}</p>
                          {item.description ? (
                            <p className="mt-1 text-xs leading-relaxed text-slate-500">{item.description}</p>
                          ) : null}
                          {activeVariants.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {activeVariants.map((variant) => (
                                <span key={`${item.id}:${variant.id ?? variant.name}`} className="rounded-full border border-orange-200 bg-orange-50 px-2 py-1 text-[10px] font-semibold text-orange-700">
                                  {variant.name} · {calculateGrossFromNet(variant.sellingPrice).toLocaleString()} RWF
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        <p className="shrink-0 text-xl font-black text-[#e24336]">
                          {activeVariants.length > 0 ? `From ${calculateGrossFromNet(startingPrice).toLocaleString()}` : calculateGrossFromNet(item.sellingPrice).toLocaleString()} RWF
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-gray-500">
          Need a live URL preview? Open the Tables screen, tap a table QR button, then choose Preview to see this image on the public page.
        </p>
      </div>
    </div>
  )
}