'use client'

import { createContext, useContext, type ReactNode } from 'react'

type RestaurantBranchContextValue = {
  restaurantId: string | null
  branchId: string | null
  branchName: string | null
  branchType: 'kitchen' | 'bar' | null
  // Main is the whole-restaurant lens: pages scoped per station show every
  // station's data instead of just its own when this is set.
  branchIsMain: boolean
}

const RestaurantBranchContext = createContext<RestaurantBranchContextValue | null>(null)

export function RestaurantBranchProvider({
  value,
  children,
}: {
  value: RestaurantBranchContextValue
  children: ReactNode
}) {
  return (
    <RestaurantBranchContext.Provider value={value}>
      {children}
    </RestaurantBranchContext.Provider>
  )
}

export function useRestaurantBranch() {
  return useContext(RestaurantBranchContext)
}

export function BranchBadge() {
  const ctx = useContext(RestaurantBranchContext)
  if (!ctx?.branchName) return null
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 border border-orange-200 px-2.5 py-0.5 text-xs font-medium text-orange-700">
      <span className="h-1.5 w-1.5 rounded-full bg-orange-400 flex-shrink-0" />
      {ctx.branchName}
    </span>
  )
}