'use client'

import { createContext, useContext, type ReactNode } from 'react'

type RestaurantBranchContextValue = {
  restaurantId: string | null
  branchId: string | null
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