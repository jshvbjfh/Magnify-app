'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BadgeAlert, LayoutGrid } from 'lucide-react'

const navItems = [
  { href: '/admin', label: 'Accounts & Pricing', icon: LayoutGrid },
  { href: '/admin/subscriptions/expired', label: 'Expired Subs', icon: BadgeAlert },
]

export default function AdminNav() {
  const pathname = usePathname()

  return (
    <div className="px-6 flex gap-2 mb-4 flex-wrap">
      {navItems.map(({ href, label, icon: Icon }) => {
        const active = pathname === href
        return (
          <Link
            key={href}
            href={href}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors inline-flex items-center gap-1.5 ${active ? 'bg-orange-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        )
      })}
    </div>
  )
}