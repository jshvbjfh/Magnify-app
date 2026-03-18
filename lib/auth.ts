import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { compare } from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { findOwnedRestaurant } from '@/lib/restaurantAccess'

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        const user = await prisma.user.findUnique({ where: { email: credentials.email } })
        if (!user) return null

        const ok = await compare(credentials.password, user.password)
        if (!ok) return null

        // For admin users, restaurantId comes from the owned Restaurant record
        let restaurantId = (user as any).restaurantId ?? null
        if (!restaurantId && user.role === 'admin') {
          const owned = await findOwnedRestaurant(user.id)
          restaurantId = owned?.id ?? null
        }

        return { id: user.id, email: user.email, name: user.name, role: user.role, businessType: user.businessType ?? 'general', trackingMode: (user as any).trackingMode ?? 'simple', restaurantId }
      }
    })
  ],
  session: { strategy: 'jwt' as const },
  pages: { signIn: '/login' },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
		;(token as any).id = (user as any).id
		;(token as any).role = (user as any).role
		;(token as any).businessType = (user as any).businessType ?? 'general'
		;(token as any).trackingMode = (user as any).trackingMode ?? 'simple'
		;(token as any).restaurantId = (user as any).restaurantId ?? null
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
		;(session.user as any).id = (token as any).id
		;(session.user as any).role = (token as any).role
		;(session.user as any).businessType = (token as any).businessType ?? 'general'
		;(session.user as any).trackingMode = (token as any).trackingMode ?? 'simple'
		;(session.user as any).restaurantId = (token as any).restaurantId ?? null
      }
      return session
    }
  }
}
