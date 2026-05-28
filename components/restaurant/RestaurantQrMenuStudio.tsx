'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Smartphone, Trash2, Upload } from 'lucide-react'

import QrMenuPageContent, { type QrMenuDish } from '@/components/QrMenuPageContent'
import { useRestaurantBranch } from '@/contexts/RestaurantBranchContext'

type MenuItem = QrMenuDish & { isActive?: boolean | null }

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
  const [qrMenuItems, setQrMenuItems] = useState<MenuItem[]>(menuItems)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pasteUrl, setPasteUrl] = useState('')

  useEffect(() => {
    setQrMenuItems(menuItems)
  }, [menuItems])

  useEffect(() => {
    let cancelled = false

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

        if (cancelled) return

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
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load QR menu settings.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadConfig()

    return () => {
      cancelled = true
    }
  }, [restaurantBranch?.branchId])

  useEffect(() => {
    let cancelled = false

    async function loadRestaurantWideMenu() {
      try {
        const response = await fetch('/api/restaurant/dishes?scope=restaurant', {
          credentials: 'include',
          cache: 'no-store',
        })
        const payload: MenuItem[] | { error?: string } | null = await response.json().catch(() => null)

        if (!response.ok || !Array.isArray(payload) || cancelled) {
          return
        }

        setQrMenuItems(payload.filter((item) => item?.isActive !== false))
      } catch {
        // Keep the current branch preview items as a fallback if the global QR menu fetch fails.
      }
    }

    void loadRestaurantWideMenu()

    return () => {
      cancelled = true
    }
  }, [menuItems, restaurantBranch?.restaurantId])

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
      if (fileInputRef.current) fileInputRef.current.value = ''
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
              The public QR menu combines active dishes from every branch in this restaurant and keeps Magnify&apos;s orange-to-red flow under this artwork.
            </p>
          </div>
          <div className="rounded-2xl border border-orange-100 bg-orange-50 px-3 py-2 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-orange-500">QR Scope</p>
            <p className="mt-1 text-sm font-bold text-gray-900">All branches</p>
            <p className="mt-1 text-[11px] text-gray-500">Artwork from {restaurantBranch?.branchName ?? 'current branch'}</p>
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
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.value = ''
                    fileInputRef.current.click()
                  }
                }}
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

          <div className="rounded-2xl border border-gray-200 bg-gray-50/60 p-4 space-y-2">
            <p className="text-xs font-semibold text-gray-700">Or paste a public image URL</p>
            <div className="flex gap-2">
              <input
                type="url"
                value={pasteUrl}
                onChange={e => setPasteUrl(e.target.value)}
                placeholder="https://example.com/your-image.jpg"
                className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-orange-300"
              />
              <button
                type="button"
                disabled={!pasteUrl.trim().startsWith('https://') || saving}
                onClick={() => { void persistQrMenuHeroImage(pasteUrl.trim()); setPasteUrl('') }}
                className="rounded-xl border border-orange-200 bg-white px-3 py-2 text-xs font-semibold text-orange-600 hover:bg-orange-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Use URL
              </button>
            </div>
            <p className="text-[11px] text-gray-400">Upload to Imgur or any public host, then paste the direct image link here. Must start with https://</p>
          </div>

          {qrMenuHeroImageUrl && !qrMenuHeroImageUrl.startsWith('https://') && (
            <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
              <div>
                <p className="font-semibold">Image only visible locally</p>
                <p className="mt-0.5 text-xs">This image was uploaded on your local machine and won&apos;t appear on the live Vercel QR page. Upload a new image from the live manager portal, or paste a public HTTPS image URL above.</p>
              </div>
            </div>
          )}

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
            <div className="pointer-events-none max-h-[720px] overflow-y-auto">
              <QrMenuPageContent
                restaurantName={restaurantName || 'Your restaurant'}
                headerDetail="Preview layout · All prices already include VAT."
                qrOrderingMode={qrOrderingMode}
                qrMenuHeroImageUrl={qrMenuHeroImageUrl}
                dishes={qrMenuItems}
                selectedMenuType="all"
                selectedCategory="all"
                embedded
              />
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