'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Search, Printer, Loader2 } from 'lucide-react'

// One page carrying every station's menu, opened from inside a station and
// scrolled straight to that station's section. The Menu tab itself is scoped to
// whichever station you are switched to, so this is the only place a manager
// can read the whole restaurant's menu in one go — and compare stations without
// switching back and forth.

type Dish = {
  id: string
  name: string
  category: string | null
  sellingPrice: number
  isActive: boolean
  branchId: string
}

type Branch = { id: string; name: string; isMain: boolean; isActive: boolean }

type StationMenu = {
  branchId: string
  branchName: string
  categories: { name: string; dishes: Dish[] }[]
  dishCount: number
}

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString('en-RW', { maximumFractionDigits: 0 })
}

/** DOM id for a station section, used as the scroll target. */
function sectionId(branchId: string) {
  return `station-menu-${branchId}`
}

export default function AllStationsMenu({
  open,
  onClose,
  currentBranchId,
}: {
  open: boolean
  onClose: () => void
  currentBranchId: string | null
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dishes, setDishes] = useState<Dish[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [query, setQuery] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const didScrollRef = useRef(false)

  useEffect(() => {
    if (!open) { didScrollRef.current = false; return }
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      fetch('/api/restaurant/dishes?scope=restaurant', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/restaurant/branches', { credentials: 'include', cache: 'no-store' }),
    ])
      .then(async ([dishRes, branchRes]) => {
        if (!dishRes.ok || !branchRes.ok) throw new Error('load failed')
        const [dishData, branchData] = await Promise.all([dishRes.json(), branchRes.json()])
        if (cancelled) return
        setDishes(Array.isArray(dishData) ? dishData : [])
        // The endpoint has returned a bare array and a wrapped object at
        // different times; accept either rather than rendering nothing.
        const list = Array.isArray(branchData) ? branchData : (branchData?.branches ?? [])
        setBranches(Array.isArray(list) ? list : [])
      })
      .catch(() => { if (!cancelled) setError('Could not load the menu. Try again.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  // Close on Escape, and stop the page behind from scrolling while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  const stations: StationMenu[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byBranch = new Map<string, Dish[]>()
    for (const dish of dishes) {
      if (!showInactive && !dish.isActive) continue
      if (q && !dish.name.toLowerCase().includes(q) && !(dish.category ?? '').toLowerCase().includes(q)) continue
      const list = byBranch.get(dish.branchId) ?? []
      list.push(dish)
      byBranch.set(dish.branchId, list)
    }

    // Branch order comes from the API (main first, then alphabetical) so the
    // page reads the same way every time.
    return branches
      .map((branch) => {
        const branchDishes = byBranch.get(branch.id) ?? []
        const byCategory = new Map<string, Dish[]>()
        for (const dish of branchDishes) {
          const key = (dish.category ?? '').trim() || 'Uncategorised'
          const list = byCategory.get(key) ?? []
          list.push(dish)
          byCategory.set(key, list)
        }
        const categories = Array.from(byCategory.entries())
          .map(([name, list]) => ({ name, dishes: list.sort((a, b) => a.name.localeCompare(b.name)) }))
          .sort((a, b) => (a.name === 'Uncategorised' ? 1 : b.name === 'Uncategorised' ? -1 : a.name.localeCompare(b.name)))
        return { branchId: branch.id, branchName: branch.name, categories, dishCount: branchDishes.length }
      })
      // Stations with nothing on them are dropped rather than rendered as empty
      // headings. The main "All" branch in particular holds no dishes of its
      // own, and an empty "All Menu" section is pure noise. They are counted
      // below instead so a station missing its menu is still discoverable.
      .filter((station) => station.dishCount > 0)
  }, [dishes, branches, query, showInactive])

  const emptyStationNames = useMemo(() => {
    const withDishes = new Set(stations.map((s) => s.branchId))
    return branches.filter((b) => !withDishes.has(b.id)).map((b) => b.name)
  }, [branches, stations])

  // Jump to the station this was opened from, once the sections exist. Only on
  // the first render after opening — re-scrolling on every filter keystroke
  // would yank the page away from whatever the user was reading.
  useEffect(() => {
    if (!open || loading || didScrollRef.current || !currentBranchId) return
    const target = document.getElementById(sectionId(currentBranchId))
    if (!target) return
    didScrollRef.current = true
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [open, loading, currentBranchId, stations])

  if (!open) return null

  const totalDishes = stations.reduce((sum, s) => sum + s.dishCount, 0)

  return (
    <div className="fixed inset-0 z-50 bg-black/50 p-3 sm:p-6" onClick={onClose}>
      <div
        className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div className="flex items-center gap-3">
            {/* The only way out, besides Escape and clicking the backdrop. A
                labelled Back reads as leaving a page; a corner ✕ reads as
                dismissing a dialog, and this is a page. */}
            <button
              onClick={onClose}
              className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <div>
              <h3 className="text-lg font-bold text-gray-900">Full Menu</h3>
              <p className="text-xs text-gray-500">
                Every station in this restaurant{totalDishes > 0 ? ` · ${fmt(totalDishes)} items` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search dishes"
                className="w-44 rounded-lg border border-gray-200 py-1.5 pl-8 pr-3 text-xs outline-none focus:border-orange-300"
              />
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-gray-600">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="accent-orange-500" />
              Show hidden
            </label>
            <button
              onClick={() => window.print()}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              <Printer className="h-3.5 w-3.5" /> Print
            </button>
          </div>
        </div>

        {/* Station jump links — a long page is unusable without them */}
        {stations.length > 1 && (
          <div className="flex gap-2 overflow-x-auto border-b border-gray-100 px-5 py-2.5">
            {stations.map((station) => (
              <button
                key={station.branchId}
                onClick={() => document.getElementById(sectionId(station.branchId))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className={`flex-shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  station.branchId === currentBranchId
                    ? 'border-orange-300 bg-orange-50 text-orange-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {station.branchName}
                <span className="ml-1.5 text-gray-400">{station.dishCount}</span>
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the full menu…
            </div>
          ) : error ? (
            <p className="py-16 text-center text-sm text-red-600">{error}</p>
          ) : stations.length === 0 ? (
            <p className="py-16 text-center text-sm text-gray-400">
              {query ? `Nothing matches “${query}”.` : 'No menu items yet.'}
            </p>
          ) : (
            <div className="space-y-8">
              {stations.map((station) => (
                <section key={station.branchId} id={sectionId(station.branchId)} className="scroll-mt-3">
                  <div className="mb-3 flex items-baseline gap-2 border-b-2 border-orange-500 pb-1.5">
                    <h4 className="text-base font-bold text-gray-900">{station.branchName} Menu</h4>
                    <span className="text-xs text-gray-400">{station.dishCount} items</span>
                  </div>

                  {station.categories.length === 0 ? (
                    <p className="py-3 text-sm text-gray-400">No items on this station&apos;s menu.</p>
                  ) : (
                    <div className="space-y-4">
                      {station.categories.map((category) => (
                        <div key={category.name}>
                          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-orange-600">{category.name}</p>
                          <ul className="divide-y divide-gray-100">
                            {category.dishes.map((dish) => (
                              <li key={dish.id} className="flex items-baseline justify-between gap-4 py-1.5">
                                <span className={`text-sm ${dish.isActive ? 'text-gray-800' : 'text-gray-400 line-through'}`}>
                                  {dish.name}
                                  {!dish.isActive && <span className="ml-2 text-[10px] font-semibold uppercase text-gray-400">hidden</span>}
                                </span>
                                <span className="flex-shrink-0 text-sm font-semibold tabular-nums text-gray-900">{fmt(dish.sellingPrice)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              ))}

              {emptyStationNames.length > 0 && (
                <p className="border-t border-gray-100 pt-4 text-xs text-gray-400">
                  {query
                    ? `No matches on: ${emptyStationNames.join(', ')}.`
                    : `No menu items yet on: ${emptyStationNames.join(', ')}.`}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
