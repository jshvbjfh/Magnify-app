import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role?: string
      restaurantId?: string | null
      branchId?: string | null
      trackingMode?: string
      isActive?: boolean
      isSuperAdmin?: boolean
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string
    role?: string
    restaurantId?: string | null
    branchId?: string | null
    trackingMode?: string
    isActive?: boolean
    isSuperAdmin?: boolean
  }
}

export {}
